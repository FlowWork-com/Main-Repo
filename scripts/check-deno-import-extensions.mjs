import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { error, log } from 'node:console';
import process from 'node:process';

const entrypoints = [
  'supabase/functions/plan-workflow/index.ts',
  'supabase/functions/execute-tool/index.ts',
  'supabase/functions/advance-plan-run/index.ts',
  'supabase/functions/finnlp-integration/index.ts',
];

const importPattern = /\b(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const queue = entrypoints.map((entrypoint) => resolve(entrypoint));
const visited = new Set();
const violations = [];

function resolveImport(importer, specifier) {
  const target = resolve(dirname(importer), specifier);
  const explicitExtension = /\.(?:[cm]?[jt]sx?|json)$/i.test(specifier);
  if (explicitExtension) return { explicitExtension, target: existsSync(target) ? target : null };

  const resolved = sourceExtensions
    .map((extension) => target + extension)
    .find((candidate) => existsSync(candidate));
  return { explicitExtension, target: resolved ?? null };
}

while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file) || !existsSync(file)) continue;
  visited.add(file);

  const source = readFileSync(file, 'utf8');
  importPattern.lastIndex = 0;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (/^https?:\/\//i.test(specifier)) {
      violations.push(file + ': remote URL import "' + specifier + '" is not allowed in deployable Edge Function graphs; use a pinned npm: or jsr: dependency');
      continue;
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
    const resolved = resolveImport(file, specifier);
    if (!resolved.explicitExtension) {
      violations.push(file + ': relative import "' + specifier + '" must include its file extension');
    }
    if (resolved.target && /\.(?:[cm]?[jt]sx?)$/i.test(resolved.target)) {
      queue.push(resolved.target);
    }
  }
}

if (violations.length > 0) {
  error('Supabase Edge Function dependency graphs contain non-Deno-compatible relative imports:');
  for (const violation of violations) error(' - ' + violation);
  process.exitCode = 1;
} else {
  log('Verified explicit relative import extensions across ' + visited.size + ' modules reachable from ' + entrypoints.length + ' deployed Edge Function entrypoints.');
}
