import { createHash } from 'node:crypto';
import { canonicalDigest, SCHEMA_VERSION } from '../runtime/schema.mjs';
import { createGridWorld } from '../worlds/grid.mjs';
import { createInventoryWorld } from '../worlds/inventory.mjs';
import { createQueueWorld } from '../worlds/queue.mjs';
import { createTemperatureWorld } from '../worlds/temperature.mjs';
import { createVirtualDesktopWorld } from '../worlds/virtual-desktop.mjs';

const WORLD_DEFINITIONS = {
  temperature: defineWorld('temperature', {
    worldVersion: 'temperature.v1',
    factory: createTemperatureWorld,
    capabilities: ['temperature.increase', 'temperature.decrease'],
    scenarioIds: ['steady', 'regime-shift', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 1, weights: [1], target: [22] },
  }),
  'virtual-desktop': defineWorld('virtual-desktop', {
    worldVersion: 'virtual-desktop.v1',
    factory: createVirtualDesktopWorld,
    capabilities: ['desktop.move-report', 'desktop.move-protected'],
    scenarioIds: ['steady', 'new-files', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 5, weights: [1, 1, 1, 1, 1], target: [0, 0, 9, 9, 2] },
  }),
  inventory: defineWorld('inventory', {
    worldVersion: 'inventory.v1',
    factory: createInventoryWorld,
    capabilities: ['inventory.restock-a', 'inventory.restock-b', 'inventory.fulfill'],
    scenarioIds: ['steady', 'supply-shock', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 3, weights: [1, 1, 1], target: [8, 8, 0] },
  }),
  grid: defineWorld('grid', {
    worldVersion: 'grid.v1',
    factory: createGridWorld,
    capabilities: ['grid.move-south', 'grid.move-east', 'grid.move-north', 'grid.move-west', 'grid.teleport'],
    scenarioIds: ['steady', 'blocked-route', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 4, weights: [1, 1, 1, 1], target: [2, 2, 2, 2] },
  }),
  queue: defineWorld('queue', {
    worldVersion: 'queue.v1',
    factory: createQueueWorld,
    capabilities: ['queue.serve', 'queue.admit', 'queue.clear'],
    scenarioIds: ['steady', 'burst', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 3, weights: [1, 1, 1], target: [0, 5, 5] },
  }),
};

export function createWorldRegistry(definitions = WORLD_DEFINITIONS) {
  const source = { ...definitions };

  function definition(worldId) {
    const worldDefinition = source[worldId];
    if (!worldDefinition) throw new Error(`Unsupported world: ${worldId}`);
    return worldDefinition;
  }

  return Object.freeze({
    assertManifest(manifest) {
      if (manifest?.adapter !== undefined) {
        throw Object.assign(new Error('An external adapter is required for this lab.'), {
          code: 'CONFLICT',
          context: { field: 'adapter' },
        });
      }
      assertWorldIdentity(manifest, definition(manifest.worldId));
    },
    worldDefinition: definition,
    createWorld(manifest, scenario = 'steady') {
      const worldDefinition = definition(manifest.worldId);
      return worldDefinition.factory({
        manifest: {
          schemaVersion: manifest.schemaVersion,
          tokenMap: manifest.tokenMap,
          authorityPolicy: manifest.authorityPolicy,
        },
        scenario,
      });
    },
    createManifestParts({ labId, seed, worldId }) {
      const worldDefinition = definition(worldId);
      const entries = worldDefinition.capabilities.map((capabilityId, index) => ({
        token: tokenFor({ labId, seed, capabilityId, index }),
        capabilityId,
      }));
      const tokenMap = {
        schemaVersion: 1,
        entries,
        digest: `sha256:${hash(JSON.stringify(entries))}`,
      };
      const capabilities = Object.fromEntries(
        worldDefinition.capabilities.map((capabilityId) => [
          capabilityId,
          { allowed: true, safe: true, cost: 1 },
        ]),
      );
      return {
        worldVersion: requireWorldVersion(worldDefinition.worldVersion, worldId),
        worldImplementationDigest: requireWorldImplementationDigest(worldDefinition, worldId),
        scenarioIds: [...worldDefinition.scenarioIds],
        tokenMap,
        authorityPolicy: {
          schemaVersion: 1,
          policyVersion: `policy:${worldId}:1`,
          constraintsDigest: `sha256:${hash(`${labId}|${seed}|${worldId}|constraints`)}`,
          capabilities,
        },
      };
    },
    valueSpec(worldId) {
      const worldDefinition = definition(worldId);
      return { schemaVersion: 1, ...worldDefinition.valueSpec };
    },
    scenarioExternalInputs(worldId, scenario, stateVersion) {
      const worldDefinition = definition(worldId);
      if (typeof worldDefinition.scenarioExternalInputs === 'function') {
        return worldDefinition.scenarioExternalInputs({ scenario, stateVersion });
      }
      if (scenario === 'external-during-step') {
        const input = {
          schemaVersion: SCHEMA_VERSION,
          source: 'scenario',
          kind: scenario,
          payload: { attributionWindowComplete: false, confounderCount: 1 },
          appliedBeforeVersion: stateVersion,
        };
        return [{ ...input, digest: canonicalDigest(input) }];
      }
      return [];
    },
  });
}

function defineWorld(worldId, definition) {
  return {
    ...definition,
    worldImplementationDigest: canonicalDigest({
      worldId,
      worldVersion: definition.worldVersion,
      factorySource: definition.factory.toString(),
      capabilities: definition.capabilities,
      scenarioIds: definition.scenarioIds,
      valueSpec: definition.valueSpec,
    }),
  };
}

function requireWorldVersion(value, worldId) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`World ${worldId} must declare a non-empty worldVersion.`);
  }
  return value;
}

function requireWorldImplementationDigest(worldDefinition, worldId) {
  const value = worldDefinition.worldImplementationDigest;
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`World ${worldId} must declare a valid worldImplementationDigest.`);
  }
  return value;
}

function assertWorldIdentity(manifest, worldDefinition) {
  if (manifest?.worldVersion === undefined) return;
  const expected = requireWorldVersion(worldDefinition.worldVersion, manifest.worldId);
  if (manifest.worldVersion !== expected) {
    throw Object.assign(new Error('The supplied WorldPort does not match the lab world contract.'), {
      code: 'CONFLICT',
      context: { field: 'worldVersion', expected, actual: manifest.worldVersion },
    });
  }
  if (manifest.worldImplementationDigest !== undefined) {
    const expectedDigest = requireWorldImplementationDigest(worldDefinition, manifest.worldId);
    if (manifest.worldImplementationDigest !== expectedDigest) {
      throw Object.assign(new Error('The supplied WorldPort implementation does not match the lab world contract.'), {
        code: 'CONFLICT',
        context: { field: 'worldImplementationDigest', expected: expectedDigest, actual: manifest.worldImplementationDigest },
      });
    }
  }
}

export const builtInWorldRegistry = createWorldRegistry();

export function worldDefinition(worldId) {
  return builtInWorldRegistry.worldDefinition(worldId);
}

export function createWorld(manifest, scenario = 'steady') {
  return builtInWorldRegistry.createWorld(manifest, scenario);
}

export function createManifestParts(input) {
  return builtInWorldRegistry.createManifestParts(input);
}

export function valueSpec(worldId) {
  return builtInWorldRegistry.valueSpec(worldId);
}

function tokenFor({ labId, seed, capabilityId, index }) {
  const material = `${seed}|${labId}|capability-map|${index}|${capabilityId}`;
  return `tok_${hash(material).slice(0, 24).toUpperCase()}`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
