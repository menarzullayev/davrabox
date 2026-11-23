import { migrate } from './migrate.js';

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) throw new Error('MIGRATE_DATABASE_URL is required');
migrate(url).then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date'));
