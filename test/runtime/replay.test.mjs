import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { learn, step, verify } from '../../src/kernel/index.mjs';
import { canonicalDigest, canonicalJson, SCHEMA_VERSION } from '../../src/runtime/schema.mjs';
import { createTemperatureWorld } from '../../src/worlds/temperature.mjs';
import { ReplayError, replayRun } from '../../src/runtime/replay.mjs';

test('replay re-executes the immutable start, world transition, kernel, and rng without writing', async () => {
  const fixture = await createRunFixture();
  try {
    const before = await directoryDigest(fixture.lab);
    const result = replayRun({
      manifest: fixture.manifest,
      start: fixture.start,
      events: fixture.events,
      end: fixture.end,
      worldFactories: { temperature: createTemperatureWorld },
    });

    assert.equal(result.verdict, 'CONSISTENT');
    assert.equal(result.firstDifference, null);
    assert.equal(result.checkedSequences, 3);
    assert.deepEqual(result.finalState, fixture.finalState);
    assert.equal(await directoryDigest(fixture.lab), before, 'replay is read-only');
  } finally {
    await fixture.cleanup();
  }
});

test('replay selects the world and scenario from immutable start, never a caller default', async () => {
  const fixture = await createRunFixture({ scenario: 'steady' });
  const seen = [];
  try {
    const result = replayRun({
      manifest: fixture.manifest,
      start: fixture.start,
      events: fixture.events,
      end: fixture.end,
      defaultScenario: 'regime-shift',
      worldFactories: {
        temperature: (options) => {
          seen.push(options.scenario);
          return createTemperatureWorld(options);
        },
      },
    });
    assert.equal(result.verdict, 'CONSISTENT');
    assert.deepEqual(seen, ['steady']);
  } finally {
    await fixture.cleanup();
  }
});

test('replay reports the first run-local sequence when deterministic kernel output diverges', async () => {
  const fixture = await createRunFixture();
  try {
    const result = replayRun({
      manifest: fixture.manifest,
      start: fixture.start,
      events: fixture.events,
      end: fixture.end,
      worldFactories: { temperature: createTemperatureWorld },
      kernel: {
        step(input) {
          const intent = step(input);
          return {
            ...intent,
            nextRngState: { ...intent.nextRngState, state: intent.nextRngState.state + 1 },
          };
        },
        verify,
        learn,
      },
    });
    assert.equal(result.verdict, 'INCONSISTENT');
    assert.equal(result.firstDifference.sequence, 2);
    assert.equal(result.firstDifference.path, 'payload.rngAfter');
  } finally {
    await fixture.cleanup();
  }
});

test('replay rejects a kernel learning version newer than the supported contract', async () => {
  const fixture = await createRunFixture();
  try {
    const events = fixture.events.map((event) => JSON.parse(JSON.stringify(event)));
    events[1].payload.boundary.kernelLearningVersion = 999;
    events[1].digest = canonicalDigest(omit(events[1], 'digest'));
    events[2].prevDigest = events[1].digest;
    events[2].digest = canonicalDigest(omit(events[2], 'digest'));
    const end = { ...fixture.end, finalEventDigest: events[2].digest };
    end.selfDigest = canonicalDigest(omit(end, 'selfDigest'));

    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: fixture.start,
        events,
        end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('replay locates a tampered event even when its digest chain is recomputed', async () => {
  const fixture = await createRunFixture();
  try {
    const events = fixture.events.map((event) => JSON.parse(JSON.stringify(event)));
    events[1].payload.choice.score += 0.25;
    events[1].digest = canonicalDigest(omit(events[1], 'digest'));
    events[2].prevDigest = events[1].digest;
    events[2].digest = canonicalDigest(omit(events[2], 'digest'));
    const end = { ...fixture.end, finalEventDigest: events[2].digest };
    end.selfDigest = canonicalDigest(omit(end, 'selfDigest'));

    const result = replayRun({
      manifest: fixture.manifest,
      start: fixture.start,
      events,
      end,
      worldFactories: { temperature: createTemperatureWorld },
    });
    assert.equal(result.verdict, 'INCONSISTENT');
    assert.equal(result.firstDifference.sequence, 2);
    assert.equal(result.firstDifference.path, 'payload.choice');
  } finally {
    await fixture.cleanup();
  }
});

test('replay rejects semantically impossible goal replan evidence after the digest chain is recomputed', async () => {
  const fixture = await createRunFixture();
  try {
    const events = fixture.events.map((event) => JSON.parse(JSON.stringify(event)));
    events[1].payload.boundary.goalReplan = {
      schemaVersion: SCHEMA_VERSION,
      planEvidence: {
        schemaVersion: SCHEMA_VERSION,
        source: 'model',
        model: 'tampered-planner',
        responseDigest: `sha256:${'a'.repeat(64)}`,
        applied: false,
        reason: 'PLANNER_UNAVAILABLE',
      },
    };
    events[1].digest = canonicalDigest(omit(events[1], 'digest'));
    events[2].prevDigest = events[1].digest;
    events[2].digest = canonicalDigest(omit(events[2], 'digest'));
    const end = { ...fixture.end, finalEventDigest: events[2].digest };
    end.selfDigest = canonicalDigest(omit(end, 'selfDigest'));

    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: fixture.start,
        events,
        end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('replay rejects a missing or start-unbound scenario before executing a world', async () => {
  const fixture = await createRunFixture();
  try {
    const missing = { ...fixture.start };
    delete missing.scenario;
    missing.selfDigest = canonicalDigest(omit(missing, 'selfDigest'));
    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: missing,
        events: fixture.events,
        end: fixture.end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );

    const altered = { ...fixture.start, scenario: 'regime-shift' };
    altered.selfDigest = canonicalDigest(omit(altered, 'selfDigest'));
    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: altered,
        events: fixture.events,
        end: fixture.end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('replay rejects manifest/start world and scenario contract mismatches', async () => {
  for (const mutateManifest of [
    (manifest) => { manifest.worldId = 'other-world'; },
    (manifest) => { manifest.scenarioIds = ['regime-shift']; },
  ]) {
    const fixture = await createRunFixture();
    try {
      mutateManifest(fixture.manifest);
      fixture.manifest.selfDigest = canonicalDigest(omit(fixture.manifest, 'selfDigest'));
      assert.throws(
        () => replayRun({
          manifest: fixture.manifest,
          start: fixture.start,
          events: fixture.events,
          end: fixture.end,
          worldFactories: { temperature: createTemperatureWorld },
        }),
        (error) => error instanceof ReplayError && error.code === 'CORRUPT',
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test('replay rejects a terminal finalStateDigest that does not match finalState', async () => {
  const fixture = await createRunFixture();
  try {
    const events = fixture.events.map((event) => JSON.parse(JSON.stringify(event)));
    events[2].payload.finalStateDigest = 'sha256:wrong-final-state';
    events[2].digest = canonicalDigest(omit(events[2], 'digest'));
    const end = {
      ...fixture.end,
      finalEventDigest: events[2].digest,
      finalStateDigest: events[2].payload.finalStateDigest,
    };
    end.selfDigest = canonicalDigest(omit(end, 'selfDigest'));

    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: fixture.start,
        events,
        end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('replay rejects a manifest with non-array scenarioIds', async () => {
  const fixture = await createRunFixture();
  try {
    fixture.manifest.scenarioIds = 'steady';
    fixture.manifest.selfDigest = canonicalDigest(omit(fixture.manifest, 'selfDigest'));

    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: fixture.start,
        events: fixture.events,
        end: fixture.end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('replay rejects a terminal event whose kind disagrees with terminalStatus', async () => {
  const fixture = await createRunFixture();
  try {
    const events = fixture.events.map((event) => JSON.parse(JSON.stringify(event)));
    events[2].payload.terminalStatus = 'HALTED';
    events[2].digest = canonicalDigest(omit(events[2], 'digest'));
    const end = {
      ...fixture.end,
      terminalStatus: 'HALTED',
      finalEventDigest: events[2].digest,
    };
    end.selfDigest = canonicalDigest(omit(end, 'selfDigest'));

    assert.throws(
      () => replayRun({
        manifest: fixture.manifest,
        start: fixture.start,
        events,
        end,
        worldFactories: { temperature: createTemperatureWorld },
      }),
      (error) => error instanceof ReplayError && error.code === 'CORRUPT',
    );
  } finally {
    await fixture.cleanup();
  }
});

async function createRunFixture({ scenario = 'steady' } = {}) {
  const lab = await mkdtemp(path.join(tmpdir(), 'yi-replay-'));
  const entries = [
    { token: 'tok_TEMPINCREASE01', capabilityId: 'temperature.increase' },
    { token: 'tok_TEMPDECREASE01', capabilityId: 'temperature.decrease' },
  ];
  const tokenMap = {
    schemaVersion: SCHEMA_VERSION,
    entries,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
  };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    labId: 'replay-lab',
    worldId: 'temperature',
    seed: 'replay-seed',
    canonicalRoot: lab,
    tokenMap,
    authorityPolicy: {
      schemaVersion: SCHEMA_VERSION,
      policyVersion: 'policy:1',
      constraintsDigest: 'sha256:constraints',
      capabilities: {
        'temperature.increase': { allowed: true, safe: true, cost: 0 },
        'temperature.decrease': { allowed: true, safe: true, cost: 0 },
      },
    },
  };
  manifest.selfDigest = canonicalDigest(manifest);
  const worldManifest = {
    schemaVersion: SCHEMA_VERSION,
    tokenMap: manifest.tokenMap,
    authorityPolicy: manifest.authorityPolicy,
  };
  const world = createTemperatureWorld({ manifest: worldManifest, scenario });
  const initialState = {
    worldState: world.initialState(),
    memory: { schemaVersion: SCHEMA_VERSION, actionModels: {} },
    rngState: { schemaVersion: SCHEMA_VERSION, algorithm: 'xorshift32', state: 1 },
    kernelStep: 0,
  };
  const startBase = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run-1',
    worldId: 'temperature',
    scenario,
    tokenMapDigest: manifest.tokenMap.digest,
    initialState,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  const start = { ...startBase, selfDigest: canonicalDigest(startBase) };
  const capabilities = world.actions(worldManifest);
  const beforeObservation = projectObservation(world.observe(initialState.worldState));
  const valueSpec = {
    schemaVersion: SCHEMA_VERSION,
    observationDimensions: 1,
    weights: [1],
    target: [22],
  };
  const intent = step({
    observation: beforeObservation,
    memory: initialState.memory,
    valueSpec,
    capabilities,
    rngState: initialState.rngState,
  });
  const request = {
    schemaVersion: SCHEMA_VERSION,
    token: intent.choice.token,
    basedOnVersion: beforeObservation.stateVersion,
    policyVersion: manifest.authorityPolicy.policyVersion,
    constraintsDigest: manifest.authorityPolicy.constraintsDigest,
    executionNonce: 'nonce-replay-1',
  };
  const transition = world.transition(initialState.worldState, request);
  const postObservation = projectObservation(transition.postObservation);
  const verification = verify({ intent, receipt: transition.receipt, postObservation });
  const update = learn({
    memory: initialState.memory,
    intent,
    receipt: transition.receipt,
    postObservation,
    verification,
  });
  const finalState = {
    worldState: transition.nextWorldState,
    memory: update.nextMemory,
    rngState: intent.nextRngState,
    kernelStep: 1,
  };
  const stepPayload = {
    recordedAt: '2026-01-01T00:00:00.000Z',
    boundary: { schemaVersion: SCHEMA_VERSION, valueSpec },
    beforeObservation,
    memoryEvidenceProjection: { sampleCount: 0 },
    beforeDigest: canonicalDigest(initialState),
    expectation: intent.expectation,
    choice: intent.choice,
    receipt: transition.receipt,
    postObservation,
    verification,
    update,
    afterDigest: canonicalDigest(finalState),
    rngBefore: initialState.rngState,
    rngAfter: finalState.rngState,
    externalInputs: [],
    afterState: finalState,
  };
  const startedEvent = makeEvent('RUN_STARTED', 1, null, {
    startDigest: start.selfDigest,
    worldId: start.worldId,
    scenario: start.scenario,
  });
  const event = makeEvent('STEP', 2, startedEvent.digest, stepPayload);
  const terminal = makeEvent('RUN_COMPLETED', 3, event.digest, {
    terminalStatus: 'COMPLETED',
    finalState,
    finalStateDigest: canonicalDigest(finalState),
  });
  const endBase = {
    schemaVersion: SCHEMA_VERSION,
    runId: start.runId,
    terminalStatus: 'COMPLETED',
    finalSequence: terminal.sequence,
    finalEventDigest: terminal.digest,
    finalStateDigest: canonicalDigest(finalState),
  };
  const end = { ...endBase, selfDigest: canonicalDigest(endBase) };
  await mkdir(path.join(lab, 'runs', 'run-1'), { recursive: true });
  await writeFile(path.join(lab, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  await writeFile(path.join(lab, 'runs', 'run-1', 'start.json'), `${canonicalJson(start)}\n`);
  await writeFile(path.join(lab, 'runs', 'run-1', 'events.jsonl'), `${[startedEvent, event, terminal].map(canonicalJson).join('\n')}\n`);
  await writeFile(path.join(lab, 'runs', 'run-1', 'end.json'), `${canonicalJson(end)}\n`);
  const events = [startedEvent, event, terminal];
  return {
    lab,
    manifest,
    start,
    events,
    end,
    finalState,
    event,
    cleanup: () => rm(lab, { recursive: true, force: true }),
  };
}

function makeEvent(kind, sequence, prevDigest, payload) {
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run-1',
    sequence,
    kind,
    payload,
    prevDigest,
  };
  return { ...unsigned, digest: canonicalDigest(unsigned) };
}

function projectObservation(observation) {
  return {
    schemaVersion: observation.schemaVersion,
    vector: observation.vector,
    stateVersion: observation.stateVersion,
    intervalId: observation.intervalId,
  };
}

async function directoryDigest(directory) {
  const files = [];
  async function visit(current) {
    const entries = await (await import('node:fs/promises')).readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push([path.relative(directory, target), await readFile(target, 'utf8')]);
    }
  }
  await visit(directory);
  return canonicalJson(files.sort((left, right) => left[0].localeCompare(right[0])));
}

function omit(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
