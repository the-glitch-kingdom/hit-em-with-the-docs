import { execFileSync } from 'child_process';
import { resolve } from 'path';

// Build dist once before any test. Per-file builds rewrote dist while other files were running the CLI from it.
// CI sets HEWTD_TEST_PREBUILT=1 after its own Build step, so the shards do not each rebuild.
export default function setup(): void {
  if (process.env.HEWTD_TEST_PREBUILT === '1') return;
  execFileSync('npm', ['run', 'build'], { cwd: resolve(__dirname, '..'), stdio: 'ignore' });
}
