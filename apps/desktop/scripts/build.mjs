import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], format: 'cjs', sourcemap: false, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
