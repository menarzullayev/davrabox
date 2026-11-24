import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/tenant.js';
import { PRIVACY_RETENTION_LOCK, PrivacyRetentionJob, retentionSettings } from '../src/privacy/retention.job.js';
import { ERASED_EMAIL, PrivacyService } from '../src/privacy/privacy.service.js';
import type { ObjectEraser, PrivacyIdentity } from '../src/privacy/ports.js';

// Integration against real Postgres with a controllable clock. Object storage and the identity provider are doubles.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 8 });
const owner = new Pool({ connectionString: adminUrl, max: 3 });
const sfx = Math.random().toString(36).slice(2, 8);
const slug = `prv-ret-${sfx}`;
const DAY = 86_400_000;

class FakeObjects implements ObjectEraser {
  files: string[] = [];
  recordings: string[] = [];
  fail = false;
  async deleteFileObject(key: string) {
    if (this.fail) throw new Error('storage down');
    this.files.push(key);
  }
  async deleteRecordingObject(key: string) {
    if (this.fail) throw new Error('storage down');
    this.recordings.push(key);
  }
}
const objects = new FakeObjects();
const idp: PrivacyIdentity & { erased: string[] } = {
  erased: [],
  async eraseUser(sub) {
    this.erased.push(sub);
  },
};
let now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (days: number) => iso(now - days * DAY);
const orgIds: string[] = [];
const job = (over: Partial<ConstructorParameters<typeof PrivacyRetentionJob>[2]> = {}, objs: ObjectEraser | null = objects) =>
  new PrivacyRetentionJob(pool, { objects: objs, now: () => now, onlyOrgs: orgIds, erasure: new PrivacyService(pool, { idp, objects: objs, now: () => now }) }, { recordingsDays: 90, filesDays: 90, signupEventsDays: 90, meetingsDays: 365, ...over });

let orgId = '';
let host = '';
async function meeting(createdDaysAgo: number, scheduledDaysFromNow: number | null = null): Promise<string> {
  const r = await owner.query(
    `INSERT INTO meetings (org_id, code, title, host_user_id, created_at, scheduled_at) VALUES ($1,$2,'m',$3,$4,$5) RETURNING id`,
    [orgId, String(50000000000 + Math.floor(Math.random() * 9e9)), host, ago(createdDaysAgo), scheduledDaysFromNow === null ? null : iso(now + scheduledDaysFromNow * DAY)],
  );
  return r.rows[0].id;
}
async function file(meetingId: string, daysAgo: number): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = `${orgId}/${meetingId}/${id}`;
  await owner.query(
    `INSERT INTO meeting_files (id, org_id, meeting_id, uploader_id, name, size_bytes, mime, sha256, object_key, wrapped_key, created_at)
     VALUES ($1,$2,$3,$4,'f',1,'application/octet-stream',$5,$6,'w',$7)`,
    [id, orgId, meetingId, host, 'a'.repeat(64), key, ago(daysAgo)],
  );
  return { id, key };
}
async function recording(meetingId: string, status: string, daysAgo: number): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO recordings (id, org_id, meeting_id, status, staging_key, object_key, started_by, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, orgId, meetingId, status, `staging/${id}`, `final/${id}`, host, ago(daysAgo), status === 'ready' || status === 'failed' ? ago(daysAgo) : null],
  );
  return id;
}
const exists = async (table: string, id: string) => ((await owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount ?? 0) > 0;
const chain = async () => (await withTenant(pool, orgId, (c) => c.query('SELECT ok FROM audit_verify_chain($1)', [orgId]))).rows[0].ok as boolean;
const auditCount = async () => Number((await owner.query('SELECT count(*) FROM audit_log WHERE org_id = $1', [orgId])).rows[0].count);

beforeAll(async () => {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `host-${sfx}`, `host-${sfx}@t.local`, 'Host', 'org_admin']);
  orgId = r.rows[0].org_id;
  host = r.rows[0].user_id;
  orgIds.push(orgId);
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug = $1', [slug]);
  await pool.end();
  await owner.end();
});

describe('settings', () => {
  it('defaults are 90 / 90 / 90 / 365 days and come from the environment', () => {
    expect(retentionSettings(loadConfig({ ...process.env, RETENTION_RECORDINGS_DAYS: undefined, RETENTION_FILES_DAYS: undefined, RETENTION_SIGNUP_EVENTS_DAYS: undefined, RETENTION_MEETINGS_DAYS: undefined }))).toEqual({
      recordingsDays: 90,
      filesDays: 90,
      signupEventsDays: 90,
      meetingsDays: 365,
    });
    expect(retentionSettings(loadConfig({ ...process.env, RETENTION_FILES_DAYS: '30' })).filesDays).toBe(30);
    expect(() => loadConfig({ ...process.env, RETENTION_FILES_DAYS: '0' })).toThrow();
  });
});

describe('retention pass', () => {
  it('deletes only what is past its period, files and recordings with their objects, and never the audit log', async () => {
    const m = await meeting(10);
    const oldFile = await file(m, 91);
    const newFile = await file(m, 89);
    const oldRec = await recording(m, 'ready', 91);
    const newRec = await recording(m, 'ready', 89);
    const m2 = await meeting(10);
    const failedRec = await recording(m2, 'failed', 120);
    const m3 = await meeting(10);
    const activeRec = await recording(m3, 'active', 200); // in flight: never deleted, whatever its age
    // an audit row far older than every period
    await owner.query(`INSERT INTO audit_log (org_id, actor_id, action, target, created_at) VALUES ($1,$2,'old.event','x',$3)`, [orgId, host, ago(900)]);
    const auditBefore = await auditCount();
    objects.files.length = 0;
    objects.recordings.length = 0;

    const rep = await job().runOnce();

    expect(rep.skipped).toBe(false);
    expect(await exists('meeting_files', oldFile.id)).toBe(false);
    expect(await exists('meeting_files', newFile.id)).toBe(true);
    expect(objects.files).toEqual([oldFile.key]);
    expect(await exists('recordings', oldRec)).toBe(false);
    expect(await exists('recordings', failedRec)).toBe(false);
    expect(await exists('recordings', newRec)).toBe(true);
    expect(await exists('recordings', activeRec)).toBe(true);
    expect(objects.recordings.sort()).toEqual([`final/${oldRec}`, `final/${failedRec}`, `staging/${oldRec}`, `staging/${failedRec}`].sort());
    expect(rep.files).toBe(1);
    expect(rep.recordings).toBe(2);
    // the audit log: the old row is still there, the chain verifies, the pass only appended
    expect((await owner.query(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'old.event'`, [orgId])).rowCount).toBe(1);
    expect(await auditCount()).toBeGreaterThan(auditBefore);
    expect(await chain()).toBe(true);
    expect((await owner.query(`SELECT target FROM audit_log WHERE org_id = $1 AND action = 'retention.purge' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0].target).toBe('files=1,recordings=2,meetings=0');
  });

  it('a controllable clock decides: moving it forward expires what was still young', async () => {
    const m = await meeting(5);
    const f = await file(m, 80);
    expect(await job().runOnce()).toMatchObject({ files: 0 });
    expect(await exists('meeting_files', f.id)).toBe(true);
    now += 11 * DAY; // 91 days old now
    const rep = await job().runOnce();
    expect(rep.files).toBeGreaterThanOrEqual(1);
    expect(await exists('meeting_files', f.id)).toBe(false);
  });

  it('periods are configurable per kind', async () => {
    const m = await meeting(3);
    const f = await file(m, 40);
    const r = await recording(m, 'ready', 40);
    await job({ filesDays: 30 }).runOnce(); // files shortened to 30 days, recordings stay at 90
    expect(await exists('meeting_files', f.id)).toBe(false);
    expect(await exists('recordings', r)).toBe(true);
    await job({ recordingsDays: 30 }).runOnce();
    expect(await exists('recordings', r)).toBe(false);
  });

  it('keeps a row when its object cannot be deleted, and the next pass retries', async () => {
    const m = await meeting(3);
    const f = await file(m, 200);
    objects.fail = true;
    const bad = await job().runOnce();
    expect(bad.failures).toBeGreaterThan(0);
    expect(await exists('meeting_files', f.id)).toBe(true);
    objects.fail = false;
    expect((await job().runOnce()).files).toBe(1);
    expect(await exists('meeting_files', f.id)).toBe(false);
  });

  it('without object storage it drops no file or recording row (the objects could still exist)', async () => {
    const m = await meeting(3);
    const f = await file(m, 200);
    const r = await recording(m, 'ready', 200);
    const rep = await job({}, null).runOnce();
    expect(rep.failures).toBeGreaterThan(0);
    expect(await exists('meeting_files', f.id)).toBe(true);
    expect(await exists('recordings', r)).toBe(true);
    await job().runOnce();
  });

  it('removes ended-meeting metadata after a year, but not a meeting that is still scheduled or still holds a file or recording', async () => {
    const mOld = await meeting(400);
    const mScheduled = await meeting(400, 5);
    const mFileOnly = await meeting(400);
    await file(mFileOnly, 200); // the file goes first (past 90 days), then the empty meeting
    const mHoldsFile = await meeting(400);
    const keep = await file(mHoldsFile, 10); // younger than its period: the meeting must stay, the cascade would orphan the object
    const mHoldsRec = await meeting(400);
    const activeRec = await recording(mHoldsRec, 'active', 1);
    const mRecent = await meeting(100);
    const rep = await job().runOnce();
    expect(await exists('meetings', mOld)).toBe(false);
    expect(await exists('meetings', mFileOnly)).toBe(false);
    expect(await exists('meetings', mScheduled)).toBe(true);
    expect(await exists('meetings', mHoldsFile)).toBe(true);
    expect(await exists('meeting_files', keep.id)).toBe(true);
    expect(await exists('meetings', mHoldsRec)).toBe(true);
    expect(await exists('recordings', activeRec)).toBe(true);
    expect(await exists('meetings', mRecent)).toBe(true);
    expect(rep.meetings).toBeGreaterThanOrEqual(2);
    expect(await chain()).toBe(true);
  });

  it('deletes sign-up events past their period and the network hash of an old trial record, keeps the recent ones', async () => {
    const tag = `ret-${sfx}`;
    await owner.query(`INSERT INTO signup_events (at, kind, reason, ip_hash, email_domain) VALUES ($1,'success','',$2,'old.example'),($3,'success','',$2,'new.example')`, [ago(100), tag, ago(10)]);
    await owner.query(`INSERT INTO trial_signups (email_hash, ip_hash, created_at) VALUES ($1,'iphash-old',$2),($3,'iphash-new',$4)`, [`old-${tag}`, ago(100), `new-${tag}`, ago(10)]);
    const rep = await job().runOnce();
    expect(rep.signupEvents).toBeGreaterThanOrEqual(1);
    expect((await owner.query(`SELECT email_domain FROM signup_events WHERE ip_hash = $1`, [tag])).rows.map((r) => r.email_domain)).toEqual(['new.example']);
    const t = (await owner.query(`SELECT email_hash, ip_hash FROM trial_signups WHERE email_hash LIKE $1 ORDER BY email_hash`, [`%-${tag}`])).rows;
    expect(t).toEqual([{ email_hash: `new-${tag}`, ip_hash: 'iphash-new' }, { email_hash: `old-${tag}`, ip_hash: '' }]); // the mailbox record stays: one trial per mailbox
    await owner.query('DELETE FROM trial_signups WHERE email_hash LIKE $1', [`%-${tag}`]);
    await owner.query('DELETE FROM signup_events WHERE ip_hash = $1', [tag]);
  });

  it('only one instance runs at a time (advisory lock) and the loser changes nothing', async () => {
    const m = await meeting(3);
    const f = await file(m, 300);
    const holder = await owner.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [PRIVACY_RETENTION_LOCK]);
      const rep = await job().runOnce();
      expect(rep.skipped).toBe(true);
      expect(await exists('meeting_files', f.id)).toBe(true);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [PRIVACY_RETENTION_LOCK]);
      holder.release();
    }
    const rep2 = await job().runOnce();
    expect(rep2.skipped).toBe(false);
    expect(await exists('meeting_files', f.id)).toBe(false);
  });

  it('finishes an erasure request that nobody retried', async () => {
    const r = await pool.query('SELECT user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `pend-${sfx}`, `pend-${sfx}@t.local`, 'Pending Person', 'member']);
    const uid = r.rows[0].user_id as string;
    await owner.query('UPDATE users SET erasure_requested_at = $2 WHERE id = $1', [uid, iso(now - 10 * 60_000)]);
    const fresh = await pool.query('SELECT user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `fresh-${sfx}`, `fresh-${sfx}@t.local`, 'Fresh Person', 'member']);
    await owner.query('UPDATE users SET erasure_requested_at = $2 WHERE id = $1', [fresh.rows[0].user_id, iso(now - 30_000)]); // too recent: the caller is probably still working on it
    const rep = await job().runOnce();
    expect(rep.erasuresResumed).toBe(1);
    const u = (await owner.query('SELECT email, erased_at FROM users WHERE id = $1', [uid])).rows[0];
    expect(u.email).toBe(ERASED_EMAIL);
    expect(u.erased_at).not.toBeNull();
    expect((await owner.query('SELECT erased_at FROM users WHERE id = $1', [fresh.rows[0].user_id])).rows[0].erased_at).toBeNull();
    expect(await chain()).toBe(true);
  });
});
