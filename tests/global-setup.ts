import { execFileSync } from 'child_process';
import { resolve } from 'path';

// Build dist once before any test. Per-file builds rewrote dist while other files were running the CLI from it.
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: resolve(__dirname, '..'), stdio: 'ignore' });
}
