import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// The inventory document must name every table of the schema, so a new migration cannot add a store of personal data
// without somebody deciding what it holds, how long it is kept and how it is deleted.
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const owner = new Pool({ connectionString: adminUrl, max: 1 });
afterAll(() => owner.end());

describe('docs/privacy-data-inventory.md', () => {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'privacy-data-inventory.md'), 'utf8');

  it('mentions every table of the real schema', async () => {
    const r = await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");
    const missing = (r.rows as Array<{ table_name: string }>).map((x) => x.table_name).filter((n) => !doc.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  it('does not name a table that no longer exists', async () => {
    const r = await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const real = new Set((r.rows as Array<{ table_name: string }>).map((x) => x.table_name));
    const firstColumn = [...doc.matchAll(/^\| `([a-z_]+)`(?:, `([a-z_]+)`)* \|/gm)].flatMap((m) => m[0].match(/`[a-z_]+`/g)!.slice(0, 3).map((x) => x.slice(1, -1)));
    const ghosts = firstColumn.filter((n) => !real.has(n) && !['S3_BUCKET', 'RECORDING_BUCKET'].includes(n));
    expect(ghosts).toEqual([]);
  });
});
