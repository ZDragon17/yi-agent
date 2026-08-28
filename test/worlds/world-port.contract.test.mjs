import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const WORLD_FACTORIES = [
  {
    id: 'temperature',
    module: new URL('../../src/worlds/temperature.mjs', import.meta.url),
    exportName: 'createTemperatureWorld',
    capabilities: ['temperature.increase', 'temperature.decrease'],
    primaryCapability: 'temperature.increase',
    specialScenario: 'regime-shift',
  },
  {
    id: 'virtual-desktop',
    module: new URL('../../src/worlds/virtual-desktop.mjs', import.meta.url),
    exportName: 'createVirtualDesktopWorld',
    capabilities: ['desktop.move-report', 'desktop.move-protected'],
    primaryCapability: 'desktop.move-report',
    protectedCapability: 'desktop.move-protected',
    specialScenario: 'new-files',
  },
  {
    id: 'inventory',
    module: new URL('../../src/worlds/inventory.mjs', import.meta.url),
    exportName: 'createInventoryWorld',
    capabilities: ['inventory.restock-a', 'inventory.restock-b', 'inventory.fulfill'],
    primaryCapability: 'inventory.restock-a',
    specialScenario: 'supply-shock',
  },
  {
    id: 'grid',
    module: new URL('../../src/worlds/grid.mjs', import.meta.url),
    exportName: 'createGridWorld',
    capabilities: ['grid.move-south', 'grid.move-east', 'grid.move-north', 'grid.move-west', 'grid.teleport'],
    primaryCapability: 'grid.move-south',
    specialScenario: 'blocked-route',
  },
  {
    id: 'queue',
    module: new URL('../../src/worlds/queue.mjs', import.meta.url),
    exportName: 'createQueueWorld',
    capabilities: ['queue.serve', 'queue.admit', 'queue.clear'],
    primaryCapability: 'queue.serve',
    specialScenario: 'burst',
  },
];

const TOKENS = [
  'tok_8MW7Q5V2FJ9C4RX6P1KD0ZAN3B',
  'tok_2PZ6KV9RAQ4M1XN8D0FC7J5YHB',
  'tok_6RC1JA8VD0BM5QZ9FX2N7PK4WH',
  'tok_4RMY9D1XKQ6C8VZ0F2PN7WA3HB',
  'tok_7KQ1ZC5AM9X2V0R8F6DPNY3WBH',
  'tok_1BYX8P6WQ4VR0C9M2ZK7NAD5HF',
];
const UNKNOWN_TOKEN = 'tok_9XD4HM2QZ7KCV8P1RB6N5WA0TY';

const OBSERVATION_KEYS = [
  'schemaVersion',
  'vector',
  'stateVersion',
  'intervalId',
  'evidence',
];
const CAPABILITY_KEYS = [
  'schemaVersion',
  'token',
  'cost',
  'allowed',
  'safe',
];
const ACTION_REQUEST_KEYS = [
  'schemaVersion',
  'token',
  'basedOnVersion',
  'policyVersion',
  'constraintsDigest',
  'executionNonce',
];
const TRANSITION_KEYS = ['nextWorldState', 'receipt', 'postObservation'];
const RECEIPT_KEYS = [
  'schemaVersion',
  'status',
  'token',
  'basedOnVersion',
  'policyVersion',
  'constraintsDigest',
  'executionNonce',
  'effectDigest',
  'rejectionReason',
  'attributionWindowComplete',
  'confounderCount',
];

for (const definition of WORLD_FACTORIES) {
  test(`${definition.id} exposes the common WorldPort surface and opaque capabilities`, async () => {
    const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
    const { port, state } = await makePort(definition, { manifest });
    const manifestBefore = snapshot(manifest);
    const stateBefore = snapshot(state);

    assertPortShape(port, definition.id);

    const observation = port.observe(state);
    assertObservation(observation, `${definition.id} initial observation`);
    assert.equal(observation.stateVersion, state.stateVersion);
    assert.deepEqual(manifest, manifestBefore, 'observe must not mutate manifest');
    assert.deepEqual(state, stateBefore, 'observe must not mutate state');

    const capabilities = port.actions(manifest);
    assert.deepEqual(manifest, manifestBefore, 'actions must not mutate manifest');
    assert.equal(capabilities.length, definition.capabilities.length);

    for (const capability of capabilities) {
      assertExactKeys(capability, CAPABILITY_KEYS, `${definition.id} capability`);
      assert.match(capability.token, /^tok_[A-Z0-9]{8,128}$/u);
      assert.equal(Number.isFinite(capability.cost), true);
      assert.equal(typeof capability.allowed, 'boolean');
      assert.equal(typeof capability.safe, 'boolean');
      assert.equal(Object.hasOwn(capability, 'capabilityId'), false);
      assert.equal(Object.hasOwn(capability, 'label'), false);
      assert.equal(Object.hasOwn(capability, 'description'), false);
    }

    assert.deepEqual(
      new Set(capabilities.map((capability) => capability.token)),
      new Set(manifest.tokenMap.entries.map((entry) => entry.token)),
      'the manifest injects all opaque action tokens',
    );
  });

  test(`${definition.id} transition is deterministic, strict, and non-mutating`, async () => {
    const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
    const { port, state } = await makePort(definition, { manifest });
    const request = makeRequest(manifest, definition.primaryCapability, state, {
      executionNonce: 'nonce:accepted-1',
    });
    const stateBefore = snapshot(state);
    const requestBefore = snapshot(request);
    const manifestBefore = snapshot(manifest);

    const first = port.transition(state, request);
    const second = port.transition(clone(state), clone(request));

    assertTransition(first, `${definition.id} accepted transition`);
    assert.deepEqual(first, second, 'identical state/request must produce identical results');
    assert.equal(first.receipt.status, 'ACCEPTED');
    assert.equal(first.receipt.token, request.token);
    assert.equal(first.receipt.basedOnVersion, state.stateVersion);
    assert.equal(first.receipt.policyVersion, request.policyVersion);
    assert.equal(first.receipt.constraintsDigest, request.constraintsDigest);
    assert.equal(first.receipt.executionNonce, request.executionNonce);
    assert.equal(first.receipt.rejectionReason, null);
    assert.notEqual(first.nextWorldState.stateVersion, state.stateVersion);
    assert.equal(first.postObservation.stateVersion, first.nextWorldState.stateVersion);
    assert.deepEqual(state, stateBefore, 'transition must not mutate state');
    assert.deepEqual(request, requestBefore, 'transition must not mutate ActionRequest');
    assert.deepEqual(manifest, manifestBefore, 'transition must not mutate manifest captured by the port');

    const malformed = { ...makeRequest(manifest, definition.primaryCapability, state), ignored: true };
    const malformedResult = port.transition(state, malformed);
    assertRejectedUnchanged(port, state, malformedResult, 'MALFORMED_REQUEST');
  });

  test(`${definition.id} execution layer fail-closes every denied request without state change`, async () => {
    const baseManifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
    const { port, state } = await makePort(definition, { manifest: baseManifest });
    const baselineRequest = makeRequest(baseManifest, definition.primaryCapability, state);
    const accepted = port.transition(
      state,
      { ...baselineRequest, executionNonce: 'nonce:one-time' },
    );
    assert.equal(accepted.receipt.status, 'ACCEPTED');

    const deniedCases = [
      {
        label: 'unknown token',
        manifest: baseManifest,
        request: { ...baselineRequest, token: UNKNOWN_TOKEN, executionNonce: 'nonce:unknown' },
      },
      {
        label: 'stale stateVersion',
        manifest: baseManifest,
        request: { ...baselineRequest, basedOnVersion: 'state:stale', executionNonce: 'nonce:stale-state' },
      },
      {
        label: 'stale policyVersion',
        manifest: baseManifest,
        request: { ...baselineRequest, policyVersion: 'policy:stale', executionNonce: 'nonce:stale-policy' },
      },
      {
        label: 'constraintsDigest mismatch',
        manifest: baseManifest,
        request: { ...baselineRequest, constraintsDigest: 'sha256:wrong-constraints', executionNonce: 'nonce:wrong-constraints' },
      },
      {
        label: 'reused executionNonce',
        manifest: baseManifest,
        state: accepted.nextWorldState,
        request: { ...baselineRequest, executionNonce: 'nonce:one-time', basedOnVersion: accepted.nextWorldState.stateVersion },
      },
      {
        label: 'allowed=false',
        manifest: makeManifest(definition, TOKENS.slice(0, definition.capabilities.length), {
          [definition.primaryCapability]: { allowed: false, safe: true },
        }),
      },
      {
        label: 'safe=false',
        manifest: makeManifest(definition, TOKENS.slice(0, definition.capabilities.length), {
          [definition.primaryCapability]: { allowed: true, safe: false },
        }),
      },
    ];

    for (const denied of deniedCases) {
      const deniedPort = denied.manifest === baseManifest
        ? port
        : (await makePort(definition, { manifest: denied.manifest })).port;
      const deniedState = denied.state ?? state;
      const deniedRequest = denied.request ?? makeRequest(
        denied.manifest,
        definition.primaryCapability,
        deniedState,
        { executionNonce: `nonce:${denied.label.replaceAll(/[^a-z]/gu, '-')}` },
      );
      const stateBefore = snapshot(deniedState);
      const requestBefore = snapshot(deniedRequest);
      const manifestBefore = snapshot(denied.manifest);

      const result = deniedPort.transition(deniedState, deniedRequest);

      assertRejectedUnchanged(deniedPort, deniedState, result, denied.label);
      assert.deepEqual(deniedState, stateBefore, `${denied.label} must not mutate state`);
      assert.deepEqual(deniedRequest, requestBefore, `${denied.label} must not mutate request`);
      assert.deepEqual(denied.manifest, manifestBefore, `${denied.label} must not mutate manifest`);
    }
  });

  test(`${definition.id} scenarios produce deterministic, machine-decidable WorldPort evidence`, async () => {
    const scenarios = ['steady', definition.specialScenario, 'external-during-step', 'execution-rejected', 'all-unsafe'];

    for (const scenario of scenarios) {
      const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
      const { port, state } = await makePort(definition, { manifest, scenario });
      const capabilities = port.actions(manifest);
      const request = makeRequest(manifest, definition.primaryCapability, state, {
        executionNonce: `nonce:${scenario}`,
      });
      const result = port.transition(state, request);

      assertTransition(result, `${definition.id}/${scenario}`);

      if (scenario === 'steady') {
        assert.equal(result.receipt.status, 'ACCEPTED');
        assert.equal(result.receipt.attributionWindowComplete, true);
        assert.equal(result.receipt.confounderCount, 0);
        continue;
      }

      if (scenario === definition.specialScenario) {
        assert.equal(result.receipt.status, 'ACCEPTED');
        assertEvidenceKind(result.postObservation.evidence, scenario);
        continue;
      }

      if (scenario === 'external-during-step') {
        assert.equal(result.receipt.status, 'ACCEPTED');
        assert.equal(result.receipt.attributionWindowComplete, false);
        assert.ok(result.receipt.confounderCount > 0);
        assertEvidenceKind(result.postObservation.evidence, scenario);
        continue;
      }

      if (scenario === 'execution-rejected') {
        assertRejectedUnchanged(port, state, result, `${definition.id}/${scenario}`);
        assertEvidenceKind(result.postObservation.evidence, scenario);
        continue;
      }

      assert.equal(scenario, 'all-unsafe');
      assert.ok(
        capabilities.every((capability) => !capability.allowed || !capability.safe),
        'all-unsafe must provide no candidate that can pass selection',
      );
      assertRejectedUnchanged(port, state, result, `${definition.id}/${scenario}`);
      assertEvidenceKind(result.postObservation.evidence, scenario);
    }
  });

  test(`${definition.id} preserves behavior when the manifest permutes opaque tokens`, async () => {
    const firstManifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
    const secondManifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length).reverse());
    const first = await makePort(definition, { manifest: firstManifest });
    const second = await makePort(definition, { manifest: secondManifest });

    const firstResult = first.port.transition(
      first.state,
      makeRequest(firstManifest, definition.primaryCapability, first.state, { executionNonce: 'nonce:permutation' }),
    );
    const secondResult = second.port.transition(
      second.state,
      makeRequest(secondManifest, definition.primaryCapability, second.state, { executionNonce: 'nonce:permutation' }),
    );

    assert.equal(firstResult.receipt.status, 'ACCEPTED');
    assert.equal(secondResult.receipt.status, 'ACCEPTED');
    assert.deepEqual(firstResult.nextWorldState, secondResult.nextWorldState);
    assert.deepEqual(firstResult.postObservation, secondResult.postObservation);
    assert.deepEqual(
      receiptProjection(firstResult.receipt, firstManifest),
      receiptProjection(secondResult.receipt, secondManifest),
      'the observable world behavior must not depend on a token spelling',
    );
  });
}

test('temperature rejects an increase at 34.9C even when the selection layer is bypassed', async () => {
  const definition = WORLD_FACTORIES[0];
  const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
  const { port, state } = await makePort(definition, { manifest });
  const boundaryState = { ...state, temperatureC: 34.9 };
  const request = makeRequest(manifest, 'temperature.increase', boundaryState, {
    executionNonce: 'nonce:temperature-boundary',
  });

  const result = port.transition(boundaryState, request);

  assertRejectedUnchanged(port, boundaryState, result, 'temperature upper bound');
});

test('virtual-desktop never moves its protected item when a guarded token bypasses selection', async () => {
  const definition = WORLD_FACTORIES[1];
  const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
  const { port, state } = await makePort(definition, { manifest });
  const request = makeRequest(manifest, 'desktop.move-protected', state, {
    executionNonce: 'nonce:protected-item',
  });

  const result = port.transition(state, request);

  assertRejectedUnchanged(port, state, result, 'protected desktop item');
});

test('inventory preserves resource bounds when a direct caller bypasses selection', async () => {
  const definition = WORLD_FACTORIES.find((item) => item.id === 'inventory');
  const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
  const { port, state } = await makePort(definition, { manifest });
  const boundaryState = { ...state, stockA: 100 };
  const result = port.transition(
    boundaryState,
    makeRequest(manifest, 'inventory.restock-a', boundaryState, {
      executionNonce: 'nonce:inventory-capacity',
    }),
  );

  assertRejectedUnchanged(port, boundaryState, result, 'inventory stock bound');
  assert.equal(result.receipt.rejectionReason, 'INVENTORY_STOCK_A_CAPACITY');
});

test('grid rejects a forbidden discrete action at the execution boundary', async () => {
  const definition = WORLD_FACTORIES.find((item) => item.id === 'grid');
  const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
  const { port, state } = await makePort(definition, { manifest });
  const result = port.transition(
    state,
    makeRequest(manifest, 'grid.teleport', state, { executionNonce: 'nonce:grid-teleport' }),
  );

  assertRejectedUnchanged(port, state, result, 'grid forbidden action');
  assert.equal(result.receipt.rejectionReason, 'ACTION_UNSAFE');
});

test('queue rejects serving an empty system without changing its multidimensional state', async () => {
  const definition = WORLD_FACTORIES.find((item) => item.id === 'queue');
  const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
  const { port, state } = await makePort(definition, { manifest });
  const emptyState = { ...state, queueLength: 0 };
  const result = port.transition(
    emptyState,
    makeRequest(manifest, 'queue.serve', emptyState, { executionNonce: 'nonce:queue-empty' }),
  );

  assertRejectedUnchanged(port, emptyState, result, 'queue empty boundary');
  assert.equal(result.receipt.rejectionReason, 'QUEUE_EMPTY');
});

test('queue rejects serving beyond the bounded served counter', async () => {
  const definition = WORLD_FACTORIES.find((item) => item.id === 'queue');
  const manifest = makeManifest(definition, TOKENS.slice(0, definition.capabilities.length));
  const { port, state } = await makePort(definition, { manifest });
  const boundaryState = { ...state, queueLength: 1, servedCount: 1_000_000 };
  const result = port.transition(
    boundaryState,
    makeRequest(manifest, 'queue.serve', boundaryState, { executionNonce: 'nonce:queue-served-capacity' }),
  );

  assertRejectedUnchanged(port, boundaryState, result, 'queue served counter boundary');
  assert.equal(result.receipt.rejectionReason, 'QUEUE_SERVED_COUNT_CAPACITY');
});

async function makePort(definition, { manifest, scenario = 'steady' }) {
  const module = await import(definition.module.href);
  const factory = module[definition.exportName];
  assert.equal(typeof factory, 'function', `${definition.exportName} must be exported`);

  const port = factory({ manifest, scenario });
  assertPortShape(port, definition.id);
  const state = port.initialState();

  assert.equal(isPlainRecord(state), true, `${definition.id} initialState must return a plain state object`);
  assert.equal(typeof state.stateVersion, 'string');
  return { port, state };
}

function makeManifest(definition, tokens, overrides = {}) {
  assert.equal(tokens.length, definition.capabilities.length);
  const entries = definition.capabilities.map((capabilityId, index) => ({
    token: tokens[index],
    capabilityId,
  }));
  const authority = Object.fromEntries(definition.capabilities.map((capabilityId) => [
    capabilityId,
    { allowed: true, safe: true, cost: 1 },
  ]));

  for (const [capabilityId, policy] of Object.entries(overrides)) {
    authority[capabilityId] = { ...authority[capabilityId], ...policy };
  }

  return {
    schemaVersion: 1,
    tokenMap: {
      schemaVersion: 1,
      entries,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
    },
    authorityPolicy: {
      schemaVersion: 1,
      policyVersion: `policy:${definition.id}:1`,
      constraintsDigest: `sha256:${definition.id}:constraints:v1`,
      capabilities: authority,
    },
  };
}

function makeRequest(manifest, capabilityId, state, overrides = {}) {
  return {
    schemaVersion: 1,
    token: tokenFor(manifest, capabilityId),
    basedOnVersion: state.stateVersion,
    policyVersion: manifest.authorityPolicy.policyVersion,
    constraintsDigest: manifest.authorityPolicy.constraintsDigest,
    executionNonce: 'nonce:default',
    ...overrides,
  };
}

function tokenFor(manifest, capabilityId) {
  const entry = manifest.tokenMap.entries.find(
    (candidate) => candidate.capabilityId === capabilityId,
  );
  assert.notEqual(entry, undefined, `fixture has token for ${capabilityId}`);
  return entry.token;
}

function assertPortShape(port, worldId) {
  assert.equal(isPlainRecord(port), true, `${worldId} WorldPort must be a plain object`);
  for (const method of ['initialState', 'observe', 'actions', 'transition']) {
    assert.equal(typeof port[method], 'function', `${worldId}.${method} must be a function`);
  }
}

function assertObservation(observation, label) {
  assertExactKeys(observation, OBSERVATION_KEYS, label);
  assert.equal(observation.schemaVersion, 1);
  assert.equal(typeof observation.stateVersion, 'string');
  assert.equal(typeof observation.intervalId, 'string');
  assert.ok(Array.isArray(observation.vector));
  assert.ok(observation.vector.length > 0);
  assert.ok(observation.vector.every(Number.isFinite));
  assert.ok(Array.isArray(observation.evidence));
}

function assertTransition(result, label) {
  assertExactKeys(result, TRANSITION_KEYS, `${label} result`);
  assert.equal(isPlainRecord(result.nextWorldState), true, `${label} nextWorldState`);
  assertObservation(result.postObservation, `${label} postObservation`);
  assertExactKeys(result.receipt, RECEIPT_KEYS, `${label} receipt`);
  assert.ok(['ACCEPTED', 'REJECTED'].includes(result.receipt.status));
  assert.equal(typeof result.receipt.token, 'string');
  assert.equal(typeof result.receipt.basedOnVersion, 'string');
  assert.equal(typeof result.receipt.policyVersion, 'string');
  assert.equal(typeof result.receipt.constraintsDigest, 'string');
  assert.equal(typeof result.receipt.executionNonce, 'string');
  assert.equal(typeof result.receipt.attributionWindowComplete, 'boolean');
  assert.equal(Number.isInteger(result.receipt.confounderCount), true);
  assert.ok(result.receipt.confounderCount >= 0);
}

function assertRejectedUnchanged(port, state, result, label) {
  assertTransition(result, `${label} rejected transition`);
  assert.equal(result.receipt.status, 'REJECTED', `${label} must fail closed`);
  assert.equal(typeof result.receipt.rejectionReason, 'string');
  assert.ok(result.receipt.rejectionReason.length > 0);
  assert.deepEqual(result.nextWorldState, state, `${label} must preserve world state`);
  assert.deepEqual(result.postObservation, port.observe(state), `${label} must preserve observation/version`);
  assert.equal(result.postObservation.stateVersion, state.stateVersion);
}

function assertEvidenceKind(evidence, kind) {
  assert.ok(
    evidence.some((item) => isPlainRecord(item) && item.kind === kind),
    `evidence must contain deterministic scenario kind ${kind}`,
  );
}

function receiptProjection(receipt, manifest) {
  const entry = manifest.tokenMap.entries.find((candidate) => candidate.token === receipt.token);

  return {
    ...receipt,
    token: entry?.capabilityId,
  };
}

function assertExactKeys(value, expectedKeys, label) {
  assert.equal(isPlainRecord(value), true, `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), `${label} keys`);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshot(value) {
  return clone(value);
}

function clone(value) {
  return structuredClone(value);
}
