/**
 * Surface inventory (#117): walk tracked code once and run every detector over each file it applies to. Skips what
 * locate skips (docs, archive, cold root, NOT_CODE, generated, oversized, binary) plus tests and the ignore list.
 */
import { relative } from 'path';
import { GENERATED, NOT_CODE, list_tracked_files, read_code_file } from '../locate.js';
import { SURFACE_DETECTORS, type Surface } from './detectors.js';

export { SURFACE_DETECTORS, type Surface, type SurfaceKind, type SurfaceDetector } from './detectors.js';

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(?:test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;

/** An ignore entry is a path prefix, or a glob (`*` within a folder, `**` across folders). */
export function is_ignored(file: string, ignore: string[]): boolean {
  return ignore.some((entry) => {
    const pattern = entry.replace(/^\.\//, '');
    if (!/[*?]/.test(pattern)) return file === pattern || file.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`);
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\/\*\*$/, '/@@REST@@').replace(/\*\*\/?/g, '@@GLOB@@').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/@@GLOB@@/g, '(?:.*/)?').replace('@@REST@@', '.*');
    return new RegExp(`^${source}$`).test(file);
  });
}

export async function detect_surfaces(options: { repo_root: string; docs_root: string; cold_root?: string; ignore?: string[] }): Promise<Surface[]> {
  const { repo_root, docs_root } = options;
  const docs_prefix = relative(repo_root, docs_root).split('\\').join('/') + '/';
  const cold_prefix = options.cold_root ? options.cold_root.replace(/^\.\//, '').replace(/\/?$/, '/') : undefined;
  const seen = new Set<string>();
  const surfaces: Surface[] = [];
  for (const file of list_tracked_files(repo_root).sort()) {
    if (file.startsWith(docs_prefix) || (cold_prefix && file.startsWith(cold_prefix)) || NOT_CODE.test(file) || TEST_FILE.test(file) || is_ignored(file, options.ignore ?? [])) continue;
    const detectors = SURFACE_DETECTORS.filter((detector) => detector.applies(file));
    if (!detectors.length) continue;
    const text = await read_code_file(repo_root, file);
    if (text === undefined || GENERATED.test(text.split('\n', 8).join('\n'))) continue;
    const lines = text.split('\n');
    for (const surface of detectors.flatMap((detector) => detector.detect(file, lines))) {
      const key = `${surface.kind}\0${surface.name}\0${file}`;
      if (!seen.has(key)) { seen.add(key); surfaces.push(surface); }
    }
  }
  return surfaces;
}
