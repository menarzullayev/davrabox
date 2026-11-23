import { build } from 'esbuild';

// electron-updater stays external: electron-builder packages it as a production dependency.
const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron', 'electron-updater'], format: 'cjs', sourcemap: false, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
