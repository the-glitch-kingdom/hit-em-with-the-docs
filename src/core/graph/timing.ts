/** Per-stage timings for the graph export, printed to stderr when HEWTD_TIMING=1 (used by scripts/bench-graph.mjs). */
const totals = new Map<string, number>();
const is_timing = (): boolean => process.env.HEWTD_TIMING === '1';

export function time_stage<T>(name: string, run: () => T): T {
  if (!is_timing()) return run();
  const start = performance.now();
  const add = (): void => void totals.set(name, (totals.get(name) ?? 0) + performance.now() - start);
  const result = run();
  if (result instanceof Promise) return result.finally(add) as T;
  add();
  return result;
}

export function print_timings(): void {
  if (!is_timing()) return;
  for (const [name, ms] of totals) process.stderr.write(`[timing] ${name.padEnd(18)} ${(ms / 1000).toFixed(2)} s\n`);
  totals.clear();
}
