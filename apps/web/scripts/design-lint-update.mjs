// Re-records the design-lint baseline after a clean-up (works on every OS: sets the variable for the child process).
import { spawnSync } from 'node:child_process';
const r = spawnSync('pnpm', ['exec', 'vitest', 'run', 'src/design-lint'], { stdio: 'inherit', shell: true, env: { ...process.env, UPDATE_DESIGN_LINT: '1' } });
process.exit(r.status ?? 1);
