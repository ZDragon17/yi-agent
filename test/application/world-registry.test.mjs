import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const WORLD_IDS = ['temperature', 'virtual-desktop', 'inventory', 'grid', 'queue'];

test('WorldPort implementation identity ignores unrelated registry edits but binds shared code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yi-agent-world-registry-identity-'));
  try {
    const baseline = await loadRegistry(path.resolve('src'), 'baseline');

    const unrelatedRoot = await copySource(root, 'unrelated');
    const unrelatedRegistry = path.join(unrelatedRoot, 'application', 'world-registry.mjs');
    await appendMarker(unrelatedRegistry, '// unrelated registry-only observation marker');
    const unrelated = await loadRegistry(unrelatedRoot, 'unrelated');
    assert.deepEqual(unrelated, baseline);

    const sharedRoot = await copySource(root, 'shared');
    const sharedBase = path.join(sharedRoot, 'worlds', 'world-port-base.mjs');
    await appendMarker(sharedBase, '// shared WorldPort implementation marker');
    const shared = await loadRegistry(sharedRoot, 'shared');
    for (const worldId of WORLD_IDS) {
      assert.notEqual(shared[worldId], baseline[worldId], `${worldId} must bind shared WorldPort code`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function copySource(root, name) {
  const target = path.join(root, name, 'src');
  await cp(path.resolve('src'), target, { recursive: true });
  return target;
}

async function appendMarker(filePath, marker) {
  const source = await readFile(filePath, 'utf8');
  await writeFile(filePath, `${source}\n${marker}\n`, 'utf8');
}

async function loadRegistry(sourceRoot, label) {
  const modulePath = path.join(sourceRoot, 'application', 'world-registry.mjs');
  const registry = await import(`${pathToFileURL(modulePath).href}?${label}-${randomUUID()}`);
  return Object.fromEntries(
    WORLD_IDS.map((worldId) => [worldId, registry.worldDefinition(worldId).worldImplementationDigest]),
  );
}
