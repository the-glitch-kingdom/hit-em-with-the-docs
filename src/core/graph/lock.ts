/**
 * One `hewtd graph` at a time per repo (#108): the hook runs it in the background, so pulls and checkouts in a row can
 * start several. A run that finds the lock held leaves a pending marker and exits; the holder runs again while one is
 * left, so the graph still reaches the newest HEAD. A lock whose process is gone, or older than 30 minutes, is taken over.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const STALE_MS = 30 * 60 * 1000;

function is_alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function take_lock(lock_file: string): boolean {
  try { writeFileSync(lock_file, String(process.pid), { flag: 'wx' }); return true; } catch { /* held */ }
  let holder = NaN;
  try { holder = Number(readFileSync(lock_file, 'utf8').trim()); } catch { /* vanished */ }
  let age = 0;
  try { age = Date.now() - statSync(lock_file).mtimeMs; } catch { /* vanished */ }
  if (Number.isInteger(holder) && holder > 0 && is_alive(holder) && age < STALE_MS) return false;
  rmSync(lock_file, { force: true });
  try { writeFileSync(lock_file, String(process.pid), { flag: 'wx' }); return true; } catch { return false; } // another run took it first
}

/** Runs `run` under `<state_dir>/graph.lock`; 'queued' when another live run holds it (it will run again for us). */
export async function run_with_graph_lock(state_dir: string, run: () => Promise<void>): Promise<'ran' | 'queued'> {
  mkdirSync(state_dir, { recursive: true });
  const lock_file = join(state_dir, 'graph.lock');
  const pending_file = join(state_dir, 'graph.pending');
  if (!take_lock(lock_file)) {
    writeFileSync(pending_file, '');
    if (!take_lock(lock_file)) return 'queued'; // the holder may have finished between the two checks
  }
  try {
    do { rmSync(pending_file, { force: true }); await run(); } while (existsSync(pending_file));
  } finally { rmSync(lock_file, { force: true }); }
  return 'ran';
}
