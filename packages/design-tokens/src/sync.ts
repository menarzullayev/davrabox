import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncPlatforms } from './platforms.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const changed = syncPlatforms(root, true);
console.log(changed.length ? `updated: ${changed.join(', ')}` : 'platforms already match the tokens');
