import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverRelatedPaths } from '../../examples/repo-world/repository-relations.mjs';

test('repo WorldPort exposes only discovered relative module paths', () => {
  const paths = discoverRelatedPaths(
    'src/display-name.mjs',
    "import { normalizeName } from './text-normalizer.mjs';\nimport './missing.mjs';\n",
    ['src/display-name.mjs', 'src/text-normalizer.mjs', 'src/other.mjs'],
  );
  assert.deepEqual(paths, ['src/text-normalizer.mjs']);
});

test('repo WorldPort resolves extensionless modules and index files', () => {
  assert.deepEqual(
    discoverRelatedPaths('src/entry.mjs', "import helper from './helpers';", [
      'src/entry.mjs',
      'src/helpers/index.mjs',
    ]),
    ['src/helpers/index.mjs'],
  );
});
