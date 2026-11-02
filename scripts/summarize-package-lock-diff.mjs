import { readFile } from 'node:fs/promises';
import { error, log } from 'node:console';
import process from 'node:process';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  error('Usage: node scripts/summarize-package-lock-diff.mjs <before-lock> <after-lock>');
  process.exitCode = 1;
} else {
  try {
    const before = JSON.parse(await readFile(beforePath, 'utf8'));
    const after = JSON.parse(await readFile(afterPath, 'utf8'));
    const beforePackages = before.packages ?? {};
    const afterPackages = after.packages ?? {};
    const paths = [...new Set([...Object.keys(beforePackages), ...Object.keys(afterPackages)])].sort();
    let changes = 0;

    for (const path of paths) {
      const previous = beforePackages[path];
      const next = afterPackages[path];
      if (!previous || !next) {
        log(`[npm-audit-preview] ${path || '<root>'}: ${previous ? 'removed' : 'added'}`);
        changes += 1;
        continue;
      }

      const fields = ['version', 'resolved', 'integrity'];
      const differences = fields.filter((field) => previous[field] !== next[field]);
      if (differences.length === 0) continue;

      const name = path || '<root>';
      const beforeVersion = previous.version ?? 'unspecified';
      const afterVersion = next.version ?? 'unspecified';
      log(`[npm-audit-preview] ${name}: ${beforeVersion} -> ${afterVersion}`);
      if (previous.resolved !== next.resolved && typeof next.resolved === 'string') {
        log(`[npm-audit-preview]   resolved: ${next.resolved.slice(0, 300)}`);
      }
      if (previous.integrity !== next.integrity && typeof next.integrity === 'string') {
        log(`[npm-audit-preview]   integrity: ${next.integrity.slice(0, 200)}`);
      }
      changes += 1;
    }

    log(`[npm-audit-preview] ${changes} package-lock path(s) changed in the runner-only preview.`);
    if (changes === 0) {
      log('[npm-audit-preview] No compatible lockfile-only update was proposed.');
    }
  } catch {
    error('[npm-audit-preview] Could not compare package-lock files.');
    process.exitCode = 1;
  }
}
