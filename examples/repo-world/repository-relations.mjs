import path from 'node:path';

const MAX_RELATIONS = 16;
const MAX_SPECIFIER_BYTES = 4096;
const SOURCE_PATTERN = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu;
const EXTENSIONS = ['', '.mjs', '.js', '.cjs'];

export function discoverRelatedPaths(sourcePath, content, availablePaths) {
  if (typeof sourcePath !== 'string' || typeof content !== 'string' || !Array.isArray(availablePaths)) return [];
  const available = new Set(availablePaths.filter((item) => typeof item === 'string'));
  const related = new Set();
  for (const match of content.matchAll(SOURCE_PATTERN)) {
    const specifier = match[1];
    if (!specifier.startsWith('.') || Buffer.byteLength(specifier, 'utf8') > MAX_SPECIFIER_BYTES) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
    for (const candidate of candidates(base)) {
      if (candidate !== sourcePath && available.has(candidate)) related.add(candidate);
    }
    if (related.size >= MAX_RELATIONS) break;
  }
  return [...related].sort((left, right) => left.localeCompare(right)).slice(0, MAX_RELATIONS);
}

function candidates(base) {
  return [
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.slice(1).map((extension) => `${base}/index${extension}`),
  ];
}
