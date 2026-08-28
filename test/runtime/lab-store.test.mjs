import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

const RUNTIME_ENTRY = new URL('../../src/runtime/lab-store.mjs', import.meta.url);
const SCHEMA_ENTRY = new URL('../../src/runtime/schema.mjs', import.meta.url);
const SCHEMA_VERSION = 1;

test('init publishes only from target-local staging, rejects collisions, and is configuration-idempotent', async () => withLab(async ({ root, lab }) => {
  const { LabStore } = await loadRuntime();
  await mkdir(lab, { recursive: true });
  await writeFile(path.join(lab, 'foreign.txt'), 'do-not-overwrite');

  await assert.rejects(
    LabStore.init(initOptions(lab)),
    (error) => assertCode(error, 'CONFLICT'),
  );
  assert.equal(await readFile(path.join(lab, 'foreign.txt'), 'utf8'), 'do-not-overwrite');

  await rm(lab, { recursive: true, force: true });
  const beforeParent = await tree(root);
  const first = await LabStore.init(initOptions(lab));
  const afterParent = await tree(root);
  assert.deepEqual(
    afterParent.filter((entry) => entry !== 'lab' && !entry.startsWith('lab/')),
    beforeParent,
  );
  assert.ok(!(await tree(lab)).some((entry) => entry.includes('.staging')));
  assert.ok(!(await tree(lab)).includes('.initializing'));

  const manifest = await readJson(path.join(lab, 'manifest.json'));
  const again = await LabStore.init(initOptions(lab));
  assert.equal(again.manifest.selfDigest, first.manifest.selfDigest);
  assert.equal((await readJson(path.join(lab, 'manifest.json'))).selfDigest, manifest.selfDigest);

  await assert.rejects(
    LabStore.init(initOptions(lab, { seed: 'another-seed' })),
    (error) => assertCode(error, 'CONFLICT'),
  );
}));

test('manifest, current, immutable start and end use schema v1 canonical digests that cover identity fields', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const schema = await loadSchema();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const step = await run.append(stepEvent());
  await run.commitSnapshot(snapshotFor(step));
  await run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });

  const manifest = await readJson(path.join(lab, 'manifest.json'));
  const current = await readJson(path.join(lab, 'state/current.json'));
  const start = await readJson(path.join(lab, 'runs/run-1/start.json'));
  const end = await readJson(path.join(lab, 'runs/run-1/end.json'));
  for (const [name, value] of Object.entries({ manifest, current, start, end })) {
    assert.equal(value.schemaVersion, SCHEMA_VERSION, `${name}.schemaVersion`);
    assert.equal(value.selfDigest, schema.canonicalDigest(omit(value, 'selfDigest')), `${name}.selfDigest`);
  }
  assert.equal(manifest.tokenMap.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.tokenMap.digest, schema.canonicalDigest(omit(manifest.tokenMap, 'digest')));
  assert.equal(start.worldId, 'temperature');
  assert.equal(start.scenario, 'steady');
  assert.equal(start.tokenMapDigest, manifest.tokenMap.digest);
  assert.equal(current.lastRunId, 'run-1');
  assert.equal(current.lastRunSequence, end.finalSequence);
  assert.equal(current.eventsDigest, end.finalEventDigest);

  const before = start.selfDigest;
  start.scenario = 'tampered';
  assert.notEqual(schema.canonicalDigest(omit(start, 'selfDigest')), before, 'scenario belongs to start digest');
  start.worldId = 'other-world';
  assert.notEqual(schema.canonicalDigest(omit(start, 'selfDigest')), before, 'worldId belongs to start digest');
}));

test('events are run-local, flushed before append resolves, and form a prevDigest/digest chain', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const first = await run.append(stepEvent({ marker: 'one' }));
  const eventsPath = path.join(lab, 'runs/run-1/events.jsonl');
  const afterFirst = await readJsonLines(eventsPath);
  assert.ok(afterFirst.some((event) => event.digest === first.digest), 'append resolves only after its line is visible');
  const second = await run.append(stepEvent({ beforeState: finalState(), receipt: { executionNonce: 'nonce-2' }, marker: 'two' }));
  const events = await readJsonLines(eventsPath);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events[0].kind, 'RUN_STARTED');
  assert.equal(events[1].prevDigest, events[0].digest);
  assert.equal(events[2].prevDigest, events[1].digest);
  assert.equal(second.prevDigest, first.digest);
  assert.ok(events.every((event) => event.runId === 'run-1' && event.schemaVersion === SCHEMA_VERSION));
  await run.finish({ terminalStatus: 'HALTED', finalState: finalState() });
}));

test('a snapshot cannot lead the ledger and failed publication leaves the previous current atomically intact', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const before = await readFile(path.join(lab, 'state/current.json'), 'utf8');

  await assert.rejects(
    run.commitSnapshot({ ...snapshotFor({ sequence: 99, digest: 'sha256:future' }), sequence: 99 }),
    (error) => assertCode(error, 'CONFLICT'),
  );
  assert.equal(await readFile(path.join(lab, 'state/current.json'), 'utf8'), before);

  const event = await run.append(stepEvent());
  await assert.rejects(
    run.commitSnapshot(snapshotFor(event), { failpoint: failAfter('snapshot:before-publish') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  assert.equal(await readFile(path.join(lab, 'state/current.json'), 'utf8'), before, 'no partially-written current is visible');
  await run.commitSnapshot(snapshotFor(event));
  await run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });
}));

test('writer ownership is exclusive while inspect uses one read-only fixed watermark and never creates a lock', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const first = await LabStore.init(initOptions(lab));
  const held = await first.startRun(runInput());
  const beforeInspect = await tree(lab);
  const inspect = await LabStore.open({ labPath: lab });
  const view = await inspect.inspect();
  const afterInspect = await tree(lab);
  assert.deepEqual(afterInspect, beforeInspect, 'inspect is strictly read-only');
  assert.equal(view.current.lastRunId, 'run-1');
  assert.equal(view.current.lastRunSequence, 1);
  assert.equal(await exists(path.join(lab, 'locks/writer.lock')), true, 'inspect did not need a second lock');
  await assert.rejects(
    (await LabStore.open({ labPath: lab })).startRun(runInput({ runId: 'run-2' })),
    (error) => assertCode(error, 'BUSY'),
  );
  await held.finish({ terminalStatus: 'HALTED', finalState: runInput().initialState });
}));

test('every durable run boundary has exactly one idempotent crash recovery outcome', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const points = [
    'start:published',
    'RUN_STARTED:appended',
    'current:running',
    'STEP:appended',
    'terminal:appended',
    'end:published',
    'current:terminal',
  ];

  for (const point of points) {
    const caseLab = path.join(lab, point.replace(/[:]/g, '-'));
    const store = await LabStore.init(initOptions(caseLab, { labId: `lab-${point}` }));
    await assert.rejects(
      exerciseRunThroughBoundary(store, point),
      (error) => assertCode(error, 'INJECTED_FAILURE'),
      point,
    );
    const first = await LabStore.recover({ labPath: caseLab, livenessProbe: () => false });
    const second = await LabStore.recover({ labPath: caseLab, livenessProbe: () => false });
    assert.deepEqual(recoveryProjection(second), recoveryProjection(first), `${point} recovery is idempotent`);
    const view = await (await LabStore.open({ labPath: caseLab })).inspect();
    assert.ok(['READY', 'HALTED'].includes(view.current.status), `${point} resolves to one canonical terminal current`);
    assert.equal(await exists(path.join(caseLab, 'locks/writer.lock')), false, `${point} releases writer lock after completion`);
  }
}));

test('only a complete nonterminal prefix is crash-HALTED; malformed evidence is CORRUPT', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const variants = ['tail', 'gap', 'truncated', 'bad-reference', 'unknown-schema'];
  for (const variant of variants) {
    const caseLab = path.join(lab, variant);
    const store = await LabStore.init(initOptions(caseLab, { labId: `lab-${variant}` }));
    const run = await store.startRun(runInput());
    const event = await run.append(stepEvent());
    await run.commitSnapshot(snapshotFor(event));
    await run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });
    await corrupt(caseLab, variant, await loadSchema());
    await assert.rejects(
      LabStore.recover({ labPath: caseLab, livenessProbe: () => false }),
      (error) => assertCode(error, 'CORRUPT'),
      variant,
    );
  }

  const cleanLab = path.join(lab, 'complete-prefix');
  const store = await LabStore.init(initOptions(cleanLab, { labId: 'lab-prefix' }));
  const run = await store.startRun(runInput());
  await run.append(stepEvent());
  const recovered = await LabStore.recover({ labPath: cleanLab, livenessProbe: () => false });
  assert.equal(recovered.current.status, 'HALTED');
  assert.equal(recovered.reason, 'CRASH_HALTED');
}));

test('recovery records immutable intent, stale lock, canonical lock, and completion; conflicts stay CORRUPT', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const schema = await loadSchema();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  const first = await LabStore.recover({ labPath: lab, livenessProbe: () => false, command: 'recover' });
  const recoveryDir = path.join(lab, 'recovery', first.writerOwnerNonce);
  const intent = await readJson(path.join(recoveryDir, 'intent.json'));
  const stale = await readJson(path.join(recoveryDir, 'stale-lock.json'));
  const completion = await readJson(path.join(recoveryDir, 'completion.json'));
  assert.equal(intent.writerLockDigest, stale.selfDigest);
  assert.equal(completion.intentDigest, intent.selfDigest);
  assert.equal(completion.finalCurrentDigest, (await readJson(path.join(lab, 'state/current.json'))).selfDigest);
  assert.deepEqual(
    recoveryProjection(await LabStore.recover({ labPath: lab, livenessProbe: () => false, command: 'recover' })),
    recoveryProjection(first),
  );

  completion.finalCurrentDigest = 'sha256:conflicting-branch';
  completion.selfDigest = schema.canonicalDigest(omit(completion, 'selfDigest'));
  await writeJson(path.join(recoveryDir, 'completion.json'), completion);
  await assert.rejects(
    LabStore.recover({ labPath: lab, livenessProbe: () => false, command: 'recover' }),
    (error) => assertCode(error, 'CORRUPT'),
  );

  const pendingLab = path.join(lab, 'pending-intent');
  const pending = await LabStore.init(initOptions(pendingLab, { labId: 'pending-intent' }));
  await pending.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: pendingLab, livenessProbe: () => false, failpoint: failAfter('recovery:stale-lock-archived') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  assert.equal(await exists(path.join(pendingLab, 'locks/writer.lock')), false, 'the stale lock was archived before the canonical lock race');
  await assert.rejects(
    (await LabStore.open({ labPath: pendingLab })).startRun(runInput({ runId: 'run-2' })),
    (error) => assertCode(error, 'BUSY'),
    'a pending intent rejects a writer that won the empty-lock race',
  );
  await LabStore.recover({ labPath: pendingLab, livenessProbe: () => false });

  const canonicalLab = path.join(lab, 'canonical-lock');
  const canonical = await LabStore.init(initOptions(canonicalLab, { labId: 'canonical-lock' }));
  await canonical.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: canonicalLab, livenessProbe: () => false, failpoint: failAfter('recovery:canonical-lock-acquired') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  assert.equal((await readJson(path.join(canonicalLab, 'locks/writer.lock'))).purpose, 'recovery');
  await LabStore.recover({ labPath: canonicalLab, livenessProbe: () => false });
}));

test('an active owner cannot be taken over and a pending recovery intent blocks a normal writer', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: lab, livenessProbe: () => true }),
    (error) => assertCode(error, 'LIVE_OWNER'),
  );
  await assert.rejects(
    (await LabStore.open({ labPath: lab })).startRun(runInput({ runId: 'run-2' })),
    (error) => assertCode(error, 'BUSY'),
  );
}));

test('storage input is not mutated and all paths stay below the canonical lab without following links', async () => withLab(async ({ root, lab }) => {
  const { LabStore } = await loadRuntime();
  const input = initOptions(lab);
  const original = structuredClone(input);
  await LabStore.init(input);
  assert.deepEqual(input, original);

  await assert.rejects(
    (await LabStore.open({ labPath: lab })).startRun(runInput({ runId: '../escape' })),
    (error) => assertCode(error, 'PATH_ESCAPE'),
  );
  const outside = await mkdtemp(path.join(tmpdir(), 'yi-agent-outside-'));
  try {
    await symlink(outside, path.join(lab, 'runs'), 'junction');
    await assert.rejects(
      (await LabStore.open({ labPath: lab })).startRun(runInput()),
      (error) => assertCode(error, 'PATH_ESCAPE'),
    );
    assert.equal((await lstat(path.join(lab, 'runs'))).isSymbolicLink(), true);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));

test('missing or altered start scenario is CORRUPT even when its selfDigest is recomputed', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const schema = await loadSchema();
  for (const [name, scenario] of [['missing', undefined], ['altered', 'other']]) {
    const caseLab = path.join(lab, name);
    const store = await LabStore.init(initOptions(caseLab, { labId: `scenario-${name}` }));
    const run = await store.startRun(runInput());
    await run.append(stepEvent());
    const startPath = path.join(caseLab, 'runs/run-1/start.json');
    const start = await readJson(startPath);
    if (scenario === undefined) delete start.scenario;
    else start.scenario = scenario;
    start.selfDigest = schema.canonicalDigest(omit(start, 'selfDigest'));
    await writeJson(startPath, start);
    await assert.rejects(
      LabStore.recover({ labPath: caseLab, livenessProbe: () => false }),
      (error) => assertCode(error, 'CORRUPT'),
      name,
    );
  }
}));

test('a stale ActiveRun cannot write after terminal evidence or lock takeover', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun({
    ...runInput(),
    failpoint: failAfter('terminal:appended'),
  });
  const step = await run.append(stepEvent());
  await assert.rejects(
    run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  await assert.rejects(run.append(stepEvent()), (error) => assertCode(error, 'BUSY'));
  await assert.rejects(
    run.commitSnapshot(snapshotFor(step)),
    (error) => assertCode(error, 'BUSY'),
  );

  await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  await assert.rejects(
    run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() }),
    (error) => assertCode(error, 'BUSY'),
  );
}));

test('recovery selects the current nonterminal run when historical terminal runs exist', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const first = await store.startRun(runInput());
  await first.finish({ terminalStatus: 'COMPLETED', finalState: runInput().initialState });

  const second = await store.startRun(runInput({ runId: 'run-2' }));
  await second.append(stepEvent());
  const recovered = await LabStore.recover({ labPath: lab, livenessProbe: () => false });

  assert.equal(recovered.current.lastRunId, 'run-2');
  assert.equal(recovered.current.status, 'HALTED');
}));

test('runtime rejects semantically invalid continuity inputs before persistence', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await assert.rejects(
    store.startRun(runInput({ scenario: 'unknown-scenario' })),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
  await assert.rejects(
    store.startRun(runInput({ initialState: { worldState: {}, memory: {}, rngState: {}, kernelStep: -1 } })),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
}));

test('explicit scenario contracts allow an unknown world to complete a run', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const initialState = genericState(0);
  const store = await LabStore.init(initOptions(lab, {
    worldId: 'generated-world',
    scenarioIds: ['generated'],
  }));
  const run = await store.startRun({
    runId: 'run-1',
    worldId: 'generated-world',
    scenario: 'generated',
    initialState,
  });

  await run.finish({ terminalStatus: 'COMPLETED', finalState: initialState });
  assert.equal((await store.inspect()).current.status, 'READY');
}));

test('re-initializing an old manifest without scenarioIds remains compatible', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const first = await LabStore.init(initOptions(lab));
  const again = await LabStore.init(initOptions(lab, {
    scenarioIds: ['steady', 'regime-shift', 'external-during-step', 'execution-rejected', 'all-unsafe'],
  }));

  assert.equal(again.manifest.selfDigest, first.manifest.selfDigest);
  assert.equal(again.manifest.scenarioIds, undefined);
}));

test('unknown worlds accept external-during-step payloads without built-in payload rules', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const initialState = genericState(0);
  const afterState = genericState(1);
  const store = await LabStore.init(initOptions(lab, {
    worldId: 'generated-world',
    scenarioIds: ['external-during-step'],
  }));
  const run = await store.startRun({
    runId: 'run-1',
    worldId: 'generated-world',
    scenario: 'external-during-step',
    initialState,
  });
  const external = {
    schemaVersion: SCHEMA_VERSION,
    source: 'scenario',
    kind: 'external-during-step',
    payload: { arbitrary: true },
    appliedBeforeVersion: '1',
  };
  external.digest = canonicalDigest(external);

  const step = await run.append(stepEvent({
    beforeState: initialState,
    afterState,
    receipt: { executionNonce: 'generated-nonce-1' },
    externalInputs: [external],
  }));
  assert.equal(step.kind, 'STEP');
  await run.finish({ terminalStatus: 'COMPLETED', finalState: afterState });
}));

test('storage rejects oversized JSON, oversized ledger lines, and excessive JSON depth', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const schema = await loadSchema();
  await LabStore.init(initOptions(lab));

  await writeFile(path.join(lab, 'manifest.json'), `{"padding":"${'x'.repeat(1024 * 1024)}"}\n`, 'utf8');
  await assert.rejects(
    LabStore.open({ labPath: lab }),
    (error) => assertCode(error, 'CORRUPT'),
  );

  const ledgerLab = path.join(lab, '..', 'ledger-limit');
  const store = await LabStore.init(initOptions(ledgerLab, { labId: 'ledger-limit' }));
  await store.startRun(runInput());
  await writeFile(
    path.join(ledgerLab, 'runs/run-1/events.jsonl'),
    `${JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })}\n`,
    'utf8',
  );
  await assert.rejects(
    LabStore.recover({ labPath: ledgerLab, livenessProbe: () => false }),
    (error) => assertCode(error, 'CORRUPT'),
  );

  let deep = {};
  for (let index = 0; index < 130; index += 1) deep = { child: deep };
  assert.throws(() => schema.canonicalJson(deep), /depth/i);
}));

test('interrupted init never deletes an unlisted staging-like file', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const ownerNonce = '00000000-0000-4000-8000-000000000001';
  await mkdir(path.join(lab, 'state'), { recursive: true });
  await writeJson(path.join(lab, '.initializing'), {
    schemaVersion: SCHEMA_VERSION,
    labId: 'lab-test-1',
    worldId: 'temperature',
    seed: 'seed-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerNonce,
    stagingFiles: [
      `state/current.json.staging-init-${ownerNonce}`,
      `manifest.json.staging-init-${ownerNonce}`,
    ],
  });
  const foreign = path.join(lab, 'state/current.json.staging-user');
  await writeFile(foreign, 'must-survive', 'utf8');

  await assert.rejects(
    LabStore.init(initOptions(lab)),
    (error) => assertCode(error, 'CONFLICT'),
  );
  assert.equal(await readFile(foreign, 'utf8'), 'must-survive');
}));

test('historical recovery evidence does not block a later crashed run', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await LabStore.recover({ labPath: lab, livenessProbe: () => false });

  await (await LabStore.open({ labPath: lab })).startRun(runInput({ runId: 'run-2' }));
  const second = await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  assert.equal(second.current.lastRunId, 'run-2');
  assert.equal(second.current.status, 'HALTED');
}));

test('run-local mutations serialize concurrent append, snapshot, and finish calls', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const secondState = { ...finalState(), kernelStep: 2 };
  const [first, second] = await Promise.all([
    run.append(stepEvent({ marker: 'first' })),
    run.append(stepEvent({ beforeState: finalState(), afterState: secondState, receipt: { executionNonce: 'nonce-2' }, marker: 'second' })),
  ]);
  assert.deepEqual([first.sequence, second.sequence], [2, 3]);
  assert.equal(second.prevDigest, first.digest);

  const finish = run.finish({ terminalStatus: 'COMPLETED', finalState: secondState });
  const lateAppend = run.append(stepEvent({ marker: 'late' }));
  await finish;
  await assert.rejects(lateAppend, (error) => assertCode(error, 'BUSY'));
  assert.deepEqual((await readJsonLines(path.join(lab, 'runs/run-1/events.jsonl'))).map((event) => event.sequence), [1, 2, 3, 4]);
}));

test('public snapshot and finish APIs reject malformed continuity state before writing', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const event = await run.append(stepEvent());
  await assert.rejects(
    run.commitSnapshot({ ...snapshotFor(event), status: 'READY', schemaVersion: 999 }),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
  await assert.rejects(
    run.finish({ terminalStatus: 'COMPLETED', finalState: { worldState: {} } }),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
  await run.finish({ terminalStatus: 'HALTED', finalState: finalState() });
}));

test('public APIs cannot create JSON artifacts that their own reader rejects', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await assert.rejects(
    store.startRun(runInput({ initialState: { ...runInput().initialState, memory: { padding: 'x'.repeat(1024 * 1024) } } })),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
  assert.equal(await exists(path.join(lab, 'runs/run-1/start.json')), false);
  const run = await store.startRun(runInput());
  await run.finish({ terminalStatus: 'HALTED', finalState: runInput().initialState });
}));

test('recovery-owner takeover records generation-specific liveness evidence', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: lab, livenessProbe: () => false, failpoint: failAfter('recovery:canonical-lock-acquired') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  const ownerNonce = (await readJson(path.join(lab, 'locks/writer.lock'))).intentDigest;
  await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  const recoveryRoots = await readdir(path.join(lab, 'recovery'));
  const recoveryDir = path.join(lab, 'recovery', recoveryRoots[0]);
  const generationIntent = await readJson(path.join(recoveryDir, 'intent-1.json'));
  const staleGeneration = await readJson(path.join(recoveryDir, 'stale-lock-1.json'));
  assert.equal(generationIntent.writerLockDigest, staleGeneration.selfDigest);
  assert.equal(generationIntent.parentIntentDigest, ownerNonce);
}));

test('interrupted init can only resume with the same identity parameters', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const ownerNonce = '00000000-0000-4000-8000-000000000001';
  await mkdir(lab, { recursive: true });
  await writeJson(path.join(lab, '.initializing'), {
    schemaVersion: SCHEMA_VERSION,
    labId: 'original',
    worldId: 'temperature',
    seed: 'seed-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerNonce,
    stagingFiles: [`state/current.json.staging-init-${ownerNonce}`, `manifest.json.staging-init-${ownerNonce}`],
  });
  await assert.rejects(
    LabStore.init(initOptions(lab, { labId: 'different' })),
    (error) => assertCode(error, 'CONFLICT'),
  );
  assert.equal(await exists(path.join(lab, '.initializing')), true);
}));

test('recovery rebuilds continuity from a flushed STEP when current lags', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const afterState = { ...finalState(), worldState: { temperatureC: 29, stateVersion: '9' }, kernelStep: 7 };
  await run.append(stepEvent({ afterState }));
  const recovered = await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  assert.deepEqual(recovered.current.worldState, afterState.worldState);
  assert.equal(recovered.current.kernelStep, 7);
}));

test('a new run at start publication can recover while current still references historical run', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const first = await store.startRun(runInput());
  await first.finish({ terminalStatus: 'COMPLETED', finalState: runInput().initialState });
  await assert.rejects(
    store.startRun({ ...runInput({ runId: 'run-2' }), failpoint: failAfter('start:published') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  const recovered = await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  assert.equal(recovered.current.lastRunId, 'run-2');
  assert.equal(recovered.current.status, 'HALTED');
}));

test('recovery resumes when intent was published before the original lock archive', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: lab, livenessProbe: () => false, failpoint: failAfter('recovery:intent-published') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  assert.equal(await exists(path.join(lab, 'locks/writer.lock')), true);
  const recovered = await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  assert.equal(recovered.current.status, 'HALTED');
}));

test('empty STEP payload is rejected before it reaches the ledger', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  await assert.rejects(run.append({ kind: 'STEP', payload: {} }), (error) => assertCode(error, 'INVALID_INPUT'));
  assert.equal((await readJsonLines(path.join(lab, 'runs/run-1/events.jsonl'))).length, 1);
  await run.finish({ terminalStatus: 'HALTED', finalState: runInput().initialState });
}));

test('default recovery liveness probe recognizes a definitely absent pid', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const schema = await loadSchema();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  const lockPath = path.join(lab, 'locks/writer.lock');
  const lock = await readJson(lockPath);
  lock.pid = 2147483647;
  lock.selfDigest = schema.canonicalDigest(omit(lock, 'selfDigest'));
  await writeJson(lockPath, lock);
  const recovered = await LabStore.recover({ labPath: lab });
  assert.equal(recovered.current.status, 'HALTED');
}));

test('snapshot and terminal state must equal the last ledger STEP continuity state', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const event = await run.append(stepEvent());
  await assert.rejects(
    run.commitSnapshot({ ...snapshotFor(event), kernelStep: 99 }),
    (error) => assertCode(error, 'CONFLICT'),
  );
  await assert.rejects(
    run.finish({ terminalStatus: 'COMPLETED', finalState: { ...finalState(), kernelStep: 99 } }),
    (error) => assertCode(error, 'CONFLICT'),
  );
  await run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });
}));

test('STEP evidence rejects malformed verification, external inputs, and after-state binding', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  for (const payload of [
    stepEvent({ verification: {} }),
    stepEvent({ externalInputs: [42] }),
    stepEvent({ afterDigest: 'sha256:wrong' }),
    stepEvent({ rngAfter: { state: 999 } }),
  ]) {
    await assert.rejects(run.append(payload), (error) => assertCode(error, 'INVALID_INPUT'));
  }
  await run.finish({ terminalStatus: 'HALTED', finalState: runInput().initialState });
}));

test('open validates token-map semantics, not only the manifest outer digest', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  await LabStore.init(initOptions(lab));
  const manifestPath = path.join(lab, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.tokenMap.digest = 'sha256:wrong';
  manifest.selfDigest = canonicalDigest(omit(manifest, 'selfDigest'));
  await writeJson(manifestPath, manifest);
  await assert.rejects(LabStore.open({ labPath: lab }), (error) => assertCode(error, 'CORRUPT'));
}));

test('oversized and deeply nested public input fails as INVALID_INPUT without poisoning retries', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const oversized = initOptions(lab, { seed: 'x'.repeat(5000) });
  await assert.rejects(LabStore.init(oversized), (error) => assertCode(error, 'INVALID_INPUT'));
  await assert.rejects(LabStore.init(oversized), (error) => assertCode(error, 'INVALID_INPUT'));
  assert.equal(await exists(lab), false);

  const store = await LabStore.init(initOptions(lab));
  let deep = {};
  for (let index = 0; index < 130; index += 1) deep = { child: deep };
  await assert.rejects(
    store.startRun(runInput({ initialState: { ...runInput().initialState, memory: deep } })),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
}));

test('recover rejects a recomputed manifest with an invalid tokenMap digest or scenarioIds', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const schema = await loadSchema();
  const cases = [
    (manifest) => { manifest.tokenMap.digest = 'sha256:wrong-token-map'; },
    (manifest) => { manifest.scenarioIds = ['steady', 'steady']; },
  ];

  for (const [index, mutateManifest] of cases.entries()) {
    const caseLab = path.join(lab, `manifest-contract-${index}`);
    await LabStore.init(initOptions(caseLab));
    const manifestPath = path.join(caseLab, 'manifest.json');
    const manifest = await readJson(manifestPath);
    mutateManifest(manifest);
    manifest.selfDigest = schema.canonicalDigest(omit(manifest, 'selfDigest'));
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      LabStore.recover({ labPath: caseLab, livenessProbe: () => false }),
      (error) => assertCode(error, 'CORRUPT'),
    );
  }
}));

test('recovery ignores only tool-shaped start staging left before publication', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await assert.rejects(
    store.startRun({ ...runInput(), failpoint: failAfter('start:published') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  await rename(
    path.join(lab, 'runs/run-1/start.json'),
    path.join(lab, 'runs/run-1/start.json.staging-123-00000000-0000-4000-8000-000000000001'),
  );
  const recovered = await LabStore.recover({ labPath: lab, livenessProbe: () => false });
  assert.equal(recovered.reason, 'PRESTART_ABORTED');
  assert.equal(await exists(path.join(lab, 'runs/run-1')), false);
}));

test('a dead ordinary contender cannot invalidate an older pending recovery intent', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: lab, livenessProbe: () => false, failpoint: failAfter('recovery:stale-lock-archived') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  const recoveryRoot = path.join(lab, 'recovery', (await readdir(path.join(lab, 'recovery')))[0]);
  const contender = await readJson(path.join(recoveryRoot, 'stale-lock.json'));
  contender.ownerNonce = '00000000-0000-4000-8000-000000000002';
  contender.pid = 2147483647;
  contender.selfDigest = canonicalDigest(omit(contender, 'selfDigest'));
  await writeJson(path.join(lab, 'locks/writer.lock'), contender);

  const recovered = await LabStore.recover({ labPath: lab });
  assert.equal(recovered.current.status, 'HALTED');
  assert.equal(await exists(path.join(recoveryRoot, 'contender-intent-1.json')), true);
  assert.equal(await exists(path.join(recoveryRoot, 'contender-lock-1.json')), true);
}));

test('inspect validates that current watermark actually exists in its ledger', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  await run.finish({ terminalStatus: 'HALTED', finalState: runInput().initialState });
  const currentPath = path.join(lab, 'state/current.json');
  const current = await readJson(currentPath);
  current.lastRunSequence = 99;
  current.selfDigest = canonicalDigest(omit(current, 'selfDigest'));
  await writeJson(currentPath, current);
  await assert.rejects(
    (await LabStore.open({ labPath: lab })).inspect(),
    (error) => assertCode(error, 'CORRUPT'),
  );
}));

test('a later run must continue exactly from the verified current state', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const first = await store.startRun(runInput());
  await first.append(stepEvent());
  await first.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });
  await assert.rejects(
    store.startRun(runInput({ runId: 'run-2', initialState: { ...finalState(), kernelStep: 999 } })),
    (error) => assertCode(error, 'CONFLICT'),
  );
  const second = await store.startRun(runInput({ runId: 'run-2', initialState: finalState() }));
  await second.finish({ terminalStatus: 'HALTED', finalState: finalState() });
}));

test('inspect and startRun reject current state that disagrees with its valid ledger watermark', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  await run.append(stepEvent());
  await run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });
  const currentPath = path.join(lab, 'state/current.json');
  const current = await readJson(currentPath);
  current.worldState = { temperatureC: 999, stateVersion: 'tampered' };
  current.selfDigest = canonicalDigest(omit(current, 'selfDigest'));
  await writeJson(currentPath, current);
  const opened = await LabStore.open({ labPath: lab });
  await assert.rejects(opened.inspect(), (error) => assertCode(error, 'CORRUPT'));
  await assert.rejects(
    opened.startRun(runInput({ runId: 'run-2', initialState: finalState() })),
    (error) => assertCode(error, 'CORRUPT'),
  );
}));

test('external inputs must match the immutable world and scenario schema', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput({ scenario: 'external-during-step' }));
  const external = {
    schemaVersion: SCHEMA_VERSION,
    source: 'scenario',
    kind: 'not-a-temperature-event',
    payload: { arbitrary: true },
    appliedBeforeVersion: '1',
  };
  external.digest = canonicalDigest(external);
  await assert.rejects(
    run.append(stepEvent({ externalInputs: [external] })),
    (error) => assertCode(error, 'INVALID_INPUT'),
  );
  await run.finish({ terminalStatus: 'HALTED', finalState: runInput().initialState });
}));

test('blocked contender archive resumes when its intent exists before lock rename', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await assert.rejects(
    LabStore.recover({ labPath: lab, livenessProbe: () => false, failpoint: failAfter('recovery:stale-lock-archived') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  const recoveryRoot = path.join(lab, 'recovery', (await readdir(path.join(lab, 'recovery')))[0]);
  const rootIntent = await readJson(path.join(recoveryRoot, 'intent.json'));
  const contender = await readJson(path.join(recoveryRoot, 'stale-lock.json'));
  contender.ownerNonce = '00000000-0000-4000-8000-000000000003';
  contender.pid = 2147483647;
  contender.selfDigest = canonicalDigest(omit(contender, 'selfDigest'));
  await writeJson(path.join(lab, 'locks/writer.lock'), contender);
  const contenderIntent = {
    schemaVersion: SCHEMA_VERSION,
    writerLockDigest: contender.selfDigest,
    parentIntentDigest: rootIntent.selfDigest,
    command: rootIntent.command,
    checkedPid: contender.pid,
    ownerLivenessCheck: 'DEAD',
    disposition: 'BLOCKED_BY_PENDING_RECOVERY',
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
  contenderIntent.selfDigest = canonicalDigest(contenderIntent);
  await writeJson(path.join(recoveryRoot, 'contender-intent-1.json'), contenderIntent);

  const recovered = await LabStore.recover({ labPath: lab });
  assert.equal(recovered.current.status, 'HALTED');
  assert.equal(await exists(path.join(recoveryRoot, 'contender-lock-1.json')), true);
}));

test('retrying an executionNonce after write-before-sync uncertainty returns the original event', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  const run = await store.startRun(runInput());
  const step = stepEvent();
  await assert.rejects(
    run.append(step, { failpoint: failAfter('ledger:after-write-before-sync') }),
    (error) => assertCode(error, 'INJECTED_FAILURE'),
  );
  const retried = await run.append(step);
  assert.equal(retried.sequence, 2);
  await run.finish({ terminalStatus: 'COMPLETED', finalState: finalState() });
  assert.deepEqual((await readJsonLines(path.join(lab, 'runs/run-1/events.jsonl'))).map((event) => event.sequence), [1, 2, 3]);
}));

test('inspect reads only its fixed active watermark and ignores a concurrent partial tail', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  await writeFile(path.join(lab, 'runs/run-1/events.jsonl'), '{"partial":', { encoding: 'utf8', flag: 'a' });
  const view = await (await LabStore.open({ labPath: lab })).inspect();
  assert.equal(view.current.lastRunSequence, 1);
  assert.equal(view.current.status, 'RUNNING');
}));

test('deeply nested ledger data is reported as CORRUPT instead of a raw TypeError', async () => withLab(async ({ lab }) => {
  const { LabStore } = await loadRuntime();
  const store = await LabStore.init(initOptions(lab));
  await store.startRun(runInput());
  const eventsPath = path.join(lab, 'runs/run-1/events.jsonl');
  const [started] = await readJsonLines(eventsPath);
  let deep = {};
  for (let index = 0; index < 130; index += 1) deep = { child: deep };
  started.payload.deep = deep;
  await writeFile(eventsPath, `${JSON.stringify(started)}\n`, 'utf8');
  await assert.rejects(
    (await LabStore.open({ labPath: lab })).inspect(),
    (error) => assertCode(error, 'CORRUPT'),
  );
}));

async function loadRuntime() {
  const runtime = await import(RUNTIME_ENTRY.href);
  assert.equal(typeof runtime.LabStore, 'function', 'runtime must export LabStore');
  return runtime;
}

async function loadSchema() {
  const schema = await import(SCHEMA_ENTRY.href);
  assert.equal(typeof schema.canonicalDigest, 'function', 'schema must export canonicalDigest');
  return schema;
}

async function withLab(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-lab-store-'));
  const lab = path.join(root, 'lab');
  try {
    return await callback({ root, lab });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function initOptions(labPath, overrides = {}) {
  return { labPath, labId: 'lab-test-1', worldId: 'temperature', seed: 'seed-1', ...overrides };
}

function runInput(overrides = {}) {
  return {
    runId: 'run-1',
    worldId: 'temperature',
    scenario: 'steady',
    initialState: { worldState: { temperatureC: 20, stateVersion: '1' }, memory: {}, rngState: { algorithm: 'xorshift32', state: 1 }, kernelStep: 0 },
    ...overrides,
  };
}

function stepEvent(overrides = {}) {
  const {
    beforeState = runInput().initialState,
    afterState = finalState(),
    ...payloadOverrides
  } = overrides;
  return {
    kind: 'STEP',
    payload: {
      recordedAt: '2026-01-01T00:00:00.000Z', boundary: {}, beforeObservation: {}, memoryEvidenceProjection: {}, beforeDigest: canonicalDigest(beforeState), expectation: {}, choice: {}, receipt: { executionNonce: 'nonce-1' }, postObservation: {}, verification: { schemaVersion: SCHEMA_VERSION, error: [], attribution: 'AMBIGUOUS', confidence: 0, learnable: false }, update: {}, afterDigest: canonicalDigest(afterState), rngBefore: beforeState.rngState, rngAfter: afterState.rngState, externalInputs: [], afterState,
      ...payloadOverrides,
    },
  };
}

function snapshotFor(event) {
  return { worldState: { temperatureC: 21, stateVersion: '2' }, memory: {}, rngState: { algorithm: 'xorshift32', state: 2 }, kernelStep: 1, lastRunId: 'run-1', lastRunSequence: event.sequence, eventsDigest: event.digest, status: 'RUNNING' };
}

function finalState() {
  return { worldState: { temperatureC: 21, stateVersion: '2' }, memory: {}, rngState: { algorithm: 'xorshift32', state: 2 }, kernelStep: 1 };
}

function genericState(kernelStep) {
  return {
    worldState: { value: kernelStep },
    memory: {},
    rngState: { algorithm: 'xorshift32', state: kernelStep + 1 },
    kernelStep,
  };
}

function failAfter(name) {
  return (point) => point === name;
}

async function exerciseRunThroughBoundary(store, point) {
  const failpoint = failAfter(point);
  const run = await store.startRun({ ...runInput(), failpoint });
  return run.complete({
    steps: [stepEvent()],
    terminalStatus: 'COMPLETED',
    finalState: finalState(),
    failpoint,
  });
}

function assertCode(error, expected) {
  assert.equal(error?.code, expected, error?.message);
  return true;
}

function omit(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function recoveryProjection(result) {
  return { reason: result.reason, current: result.current, writerOwnerNonce: result.writerOwnerNonce };
}

async function corrupt(lab, variant, schema) {
  const eventsPath = path.join(lab, 'runs/run-1/events.jsonl');
  if (variant === 'tail') return writeFile(eventsPath, `${await readFile(eventsPath, 'utf8')}{`, 'utf8');
  if (variant === 'gap') {
    const events = await readJsonLines(eventsPath);
    events[1].sequence = 9;
    return writeFile(eventsPath, `${events.map(JSON.stringify).join('\n')}\n`, 'utf8');
  }
  if (variant === 'truncated') return writeFile(eventsPath, `${(await readJsonLines(eventsPath)).slice(0, -1).map(JSON.stringify).join('\n')}\n`, 'utf8');
  if (variant === 'bad-reference') {
    const currentPath = path.join(lab, 'state/current.json');
    const current = await readJson(currentPath);
    current.eventsDigest = 'sha256:wrong-reference';
    current.selfDigest = schema.canonicalDigest(omit(current, 'selfDigest'));
    return writeJson(currentPath, current);
  }
  const manifestPath = path.join(lab, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.schemaVersion = 999;
  manifest.selfDigest = schema.canonicalDigest(omit(manifest, 'selfDigest'));
  return writeJson(manifestPath, manifest);
}

async function tree(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix, entry.name);
    found.push(relative);
    if (entry.isDirectory()) found.push(...await tree(path.join(directory, entry.name), relative));
  }
  return found;
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonLines(filePath) {
  return (await readFile(filePath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}
