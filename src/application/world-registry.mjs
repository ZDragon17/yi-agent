import { createHash } from 'node:crypto';
import { canonicalDigest, SCHEMA_VERSION } from '../runtime/schema.mjs';
import { createTemperatureWorld } from '../worlds/temperature.mjs';
import { createVirtualDesktopWorld } from '../worlds/virtual-desktop.mjs';

const WORLD_DEFINITIONS = {
  temperature: {
    factory: createTemperatureWorld,
    capabilities: ['temperature.increase', 'temperature.decrease'],
    scenarioIds: ['steady', 'regime-shift', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 1, weights: [1], target: [22] },
  },
  'virtual-desktop': {
    factory: createVirtualDesktopWorld,
    capabilities: ['desktop.move-report', 'desktop.move-protected'],
    scenarioIds: ['steady', 'new-files', 'external-during-step', 'execution-rejected', 'all-unsafe'],
    valueSpec: { observationDimensions: 5, weights: [1, 1, 1, 1, 1], target: [0, 0, 9, 9, 2] },
  },
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
