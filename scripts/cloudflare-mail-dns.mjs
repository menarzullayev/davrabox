#!/usr/bin/env node
// DNS records of the DavraBox sender domain (owner decision 1 of 2026-11-27): Brevo verification code, DKIM, SPF and DMARC
// for mail.davrabox.bugvector.uz in the Cloudflare zone bugvector.uz. Idempotent: an existing equal record is left alone, a
// record of the same kind (same name + type + "v=spf1" / "v=DMARC1" / "brevo-code:" prefix, or a CNAME) is replaced.
//
//   node scripts/cloudflare-mail-dns.mjs --records brevo-records.json [--dry-run]
//
// brevo-records.json: what Brevo shows under Senders, Domains -> Authenticate, e.g.
//   [ { "type": "TXT",   "name": "mail.davrabox.bugvector.uz",                   "content": "brevo-code:0123abcd..." },
//     { "type": "CNAME", "name": "brevo1._domainkey.mail.davrabox.bugvector.uz", "content": "b1.mail-davrabox-bugvector-uz.dkim.brevo.com" },
//     { "type": "CNAME", "name": "brevo2._domainkey.mail.davrabox.bugvector.uz", "content": "b2.mail-davrabox-bugvector-uz.dkim.brevo.com" },
//     { "type": "TXT",   "name": "_dmarc.mail.davrabox.bugvector.uz",            "content": "v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com" } ]
// SPF ("v=spf1 include:spf.brevo.com ~all" on the sender name) and DMARC at p=none are added when the file has none.
//
// The API token is the one cloudflared already uses for this zone (cert.pem, CLOUDFLARED_CERT overrides the path). It is
// read from the file and never printed. Record contents that are keys (DKIM) are shortened in the output.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENDER = 'mail.davrabox.bugvector.uz';
export const DEFAULT_SPF = 'v=spf1 include:spf.brevo.com ~all';
export const DEFAULT_DMARC = 'v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com';

/** The records to have: the given ones plus SPF and DMARC defaults when missing. Pure. */
export function plan(records) {
  if (!Array.isArray(records)) throw new Error('records must be a JSON array');
  const out = records.map((r) => {
    const type = String(r.type ?? '').toUpperCase();
    const name = String(r.name ?? '').toLowerCase().replace(/\.$/, '');
    const content = String(r.content ?? '').trim().replace(/^"|"$/g, '');
    if (!['TXT', 'CNAME'].includes(type)) throw new Error(`unsupported record type ${type}`);
    if (!(name === SENDER || name.endsWith(`.${SENDER}`))) throw new Error(`record ${name} is outside ${SENDER}`);
    if (!content) throw new Error(`record ${name} has no content`);
    return { type, name, content };
  });
  if (!out.some((r) => r.type === 'TXT' && r.name === SENDER && r.content.startsWith('v=spf1'))) out.push({ type: 'TXT', name: SENDER, content: DEFAULT_SPF });
  if (!out.some((r) => r.type === 'TXT' && r.name === `_dmarc.${SENDER}`)) out.push({ type: 'TXT', name: `_dmarc.${SENDER}`, content: DEFAULT_DMARC });
  return out;
}

/** Which existing record a wanted one replaces (same name and type, same kind of TXT); null = create. Pure. */
export function counterpart(want, existing) {
  const kind = (c) => (/^v=spf1/i.test(c) ? 'spf' : /^v=dmarc1/i.test(c) ? 'dmarc' : /^brevo-code:/i.test(c) ? 'brevo' : /^(v=dkim1|k=rsa)/i.test(c) ? 'dkim' : 'other');
  return existing.find((e) => e.type === want.type && e.name === want.name && (want.type === 'CNAME' || kind(e.content.replace(/^"|"$/g, '')) === kind(want.content))) ?? null;
}

const short = (c) => (c.length > 60 ? `${c.slice(0, 40)}…(${c.length} chars)` : c);

function token() {
  const pem = readFileSync(process.env.CLOUDFLARED_CERT ?? join(homedir(), '.cloudflared', 'cert.pem'), 'utf8');
  const m = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END/.exec(pem);
  if (!m) throw new Error('no tunnel token in cert.pem');
  const d = JSON.parse(Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'));
  if (!d.apiToken || !d.zoneID) throw new Error('cert.pem token lacks apiToken/zoneID');
  return d;
}

async function main() {
  const i = process.argv.indexOf('--records');
  const dry = process.argv.includes('--dry-run');
  const records = i > 0 ? JSON.parse(readFileSync(process.argv[i + 1], 'utf8')) : [];
  const want = plan(records);
  const { apiToken, zoneID } = token();
  const cf = async (path, init = {}) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneID}${path}`, { ...init, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } });
    const body = await res.json();
    if (!body.success) throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${(body.errors ?? []).map((e) => e.message).join('; ')}`);
    return body.result;
  };
  const zone = await cf('');
  if (zone.name !== 'bugvector.uz') throw new Error(`the token belongs to zone ${zone.name}, not bugvector.uz`);
  const existing = await cf(`/dns_records?per_page=100&name.endswith=${encodeURIComponent(SENDER)}`);
  for (const w of want) {
    const e = counterpart(w, existing);
    if (e && e.content.replace(/^"|"$/g, '') === w.content) {
      console.log(`OK      ${w.type} ${w.name} ${short(w.content)}`);
      continue;
    }
    console.log(`${dry ? 'WOULD ' : ''}${e ? 'UPDATE' : 'CREATE'} ${w.type} ${w.name} ${short(w.content)}`);
    if (dry) continue;
    const body = JSON.stringify({ type: w.type, name: w.name, content: w.content, ttl: 1, proxied: false, comment: 'DavraBox mail (Brevo)' });
    if (e) await cf(`/dns_records/${e.id}`, { method: 'PUT', body });
    else await cf('/dns_records', { method: 'POST', body });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`cloudflare-mail-dns: ${e.message}`);
    process.exit(1);
  });
}
