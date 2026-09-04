import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { canonicalDigest, canonicalJson, withSelfDigest } from '../../src/runtime/schema.mjs';
import { advanceChangeSupervisor } from '../../src/agent/change-supervisor.mjs';
import { projectModelObservation } from '../../src/agent/observation-context.mjs';
import { builtInWorldRegistry } from '../../src/application/world-registry.mjs';
import { ED25519_PUBLIC_KEY, verifyAttestation } from '../fixtures/ed25519-proof.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER_FIXTURE = path.resolve('test/fixtures/generated-world-adapter.mjs');
const STATEFUL_ADAPTER_FIXTURE = path.resolve('test/fixtures/stateful-capabilities-world-adapter.mjs');
const IDEMPOTENT_ADAPTER_FIXTURE = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');
const DELAYED_FEEDBACK_ADAPTER_FIXTURE = path.resolve('test/fixtures/delayed-feedback-world-adapter.mjs');
const OVERLAP_FEEDBACK_ADAPTER_FIXTURE = path.resolve('test/fixtures/overlap-feedback-world-adapter.mjs');

test('generated adapter exposes a fixed Ed25519 key for its hello descriptor', async () => {
  const response = await invokeAdapter([], { protocol: 'yi-world-cli', version: 1, id: '1', op: 'hello', payload: {} });
  const { descriptorDigest, ...descriptor } = response.result;
  assert.equal(descriptor.evidencePublicKey, ED25519_PUBLIC_KEY);
  assert.equal(Object.hasOwn(descriptor, 'proof'), false);
  assert.equal(descriptorDigest, canonicalDigest(descriptor));

  const externalInputs = await invokeAdapter([], { protocol: 'yi-world-cli', version: 1, id: '2', op: 'externalInputs', payload: { stateVersion: 'state:generated:0' } });
  const input = externalInputs.result.inputs[0];
  assert.equal(verifyAttestation(input, input.attestation), true);
});

test('CLI executes init, run, inspect, and replay as one JSON-envelope chain', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'lab');
    const init = await invoke('init', '--lab', lab, '--world', 'temperature', '--seed', 'cli-seed', '--lab-id', 'cli-lab', '--json');
    assert.equal(init.code, 0);
    assert.equal(init.stdout.length, 1);
    assert.equal(init.stderr, '');
    assert.equal(init.stdout[0].ok, true);
    assert.equal(init.stdout[0].data.tokenMap.entries.length, 2);

    const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--planning-horizon', '2', '--json');
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');

    const inspect = await invoke('inspect', '--lab', lab, '--action', 'run-1:2', '--json');
    assert.equal(inspect.code, 0);
    assert.equal(inspect.stdout[0].data.inspectView.selectedAction.sequence, 2);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');

    const challenge = await invoke('challenge', '--lab', lab, '--case', 'inspect-readonly', '--json');
    assert.equal(challenge.code, 0);
    assert.equal(challenge.stdout[0].data.verdict, 'PASS');
  });
});

test('CLI executes and resumes a bounded paired trajectory experiment across processes', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'trajectory-lab');
    const output = path.join(root, 'trajectory-experiment');
    const leftFile = path.join(root, 'left-trajectory.json');
    const rightFile = path.join(root, 'right-trajectory.json');
    const init = await invoke('init', '--lab', lab, '--world', 'temperature', '--seed', 'cli-trajectory-seed', '--json');
    assert.equal(init.code, 0);
    const tokens = init.stdout[0].data.tokenMap.entries.map((entry) => entry.token);
    assert.equal((await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--json')).code, 0);
    await writeFile(leftFile, JSON.stringify({ schemaVersion: 1, type: 'candidate-trajectory', tokens: [tokens[0], tokens[0]] }));
    await writeFile(rightFile, JSON.stringify({ schemaVersion: 1, type: 'candidate-trajectory', tokens: [tokens[1], tokens[1]] }));

    const experiment = await invoke(
      'experiment', 'trajectory', '--lab', lab, '--output', output,
      '--left-trajectory', leftFile, '--right-trajectory', rightFile, '--scenario', 'steady', '--json',
    );
    assert.equal(experiment.code, 0);
    assert.equal(experiment.stdout[0].data.verdict, 'PASS');
    assert.equal(experiment.stdout[0].data.comparison.pair, 'same-initial-state-trajectory-v1');
    assert.equal(experiment.stdout[0].data.replayVerdicts.left.length, 2);
    assert.equal(experiment.stdout[0].data.replayVerdicts.right.length, 2);

    const resumed = await invoke('experiment', 'trajectory', '--lab', lab, '--output', output, '--resume', '--json');
    assert.equal(resumed.code, 0);
    assert.deepEqual(resumed.stdout[0].data.comparison, experiment.stdout[0].data.comparison);
    assert.deepEqual(resumed.stdout[0].data.replayVerdicts, experiment.stdout[0].data.replayVerdicts);
  });
});

test('CLI executes and resumes a closed-loop paired policy experiment across processes', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'policy-lab');
    const output = path.join(root, 'policy-experiment');
    const leftFile = path.join(root, 'left-policy.json');
    const rightFile = path.join(root, 'right-policy.json');
    const init = await invoke('init', '--lab', lab, '--world', 'temperature', '--seed', 'cli-policy-seed', '--json');
    assert.equal(init.code, 0);
    const tokens = init.stdout[0].data.tokenMap.entries.map((entry) => entry.token);
    assert.equal((await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--json')).code, 0);
    const inspection = await invoke('inspect', '--lab', lab, '--json');
    assert.equal(inspection.code, 0);
    const world = builtInWorldRegistry.createWorld(init.stdout[0].data, 'steady');
    const observationDigest = projectModelObservation(world.observe(inspection.stdout[0].data.current.worldState)).digest;
    await writeFile(leftFile, JSON.stringify({
      schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[0],
      rules: [{ observationDigest, token: tokens[1] }],
    }));
    await writeFile(rightFile, JSON.stringify({
      schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[1],
      rules: [{ observationDigest, token: tokens[0] }],
    }));

    const experiment = await invoke(
      'experiment', 'policy', '--lab', lab, '--output', output, '--steps', '2',
      '--left-policy', leftFile, '--right-policy', rightFile, '--scenario', 'steady', '--json',
    );
    assert.equal(experiment.code, 0);
    assert.equal(experiment.stdout[0].data.verdict, 'PASS');
    assert.equal(experiment.stdout[0].data.comparison.pair, 'same-initial-state-policy-v1');
    assert.equal(experiment.stdout[0].data.traces.left.length, 2);
    assert.equal(experiment.stdout[0].data.traces.right.length, 2);
    assert.deepEqual(experiment.stdout[0].data.replayVerdicts.left, ['CONSISTENT', 'CONSISTENT']);
    assert.deepEqual(experiment.stdout[0].data.replayVerdicts.right, ['CONSISTENT', 'CONSISTENT']);

    const resumed = await invoke('experiment', 'policy', '--lab', lab, '--output', output, '--resume', '--json');
    assert.equal(resumed.code, 0);
    assert.deepEqual(resumed.stdout[0].data.comparison, experiment.stdout[0].data.comparison);
    assert.deepEqual(resumed.stdout[0].data.traces, experiment.stdout[0].data.traces);
  });
});

test('CLI runs the same closed loop across multidimensional WorldPorts', async () => {
  await withTemp(async (root) => {
    const worlds = [
      { id: 'inventory', dimensions: 3, tokenCount: 3 },
      { id: 'grid', dimensions: 4, tokenCount: 5 },
      { id: 'queue', dimensions: 3, tokenCount: 3 },
    ];

    for (const world of worlds) {
      const lab = path.join(root, world.id);
      const init = await invoke('init', '--lab', lab, '--world', world.id, '--seed', `cli-${world.id}`, '--json');
      assert.equal(init.code, 0, `${world.id}: init`);
      assert.equal(init.stdout[0].data.tokenMap.entries.length, world.tokenCount);

      const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--json');
      assert.ok([0, 2].includes(run.code), `${world.id}: run`);
      assert.ok(['COMPLETED', 'HALTED'].includes(run.stdout[0].data.status), `${world.id}: status`);

      const inspect = await invoke('inspect', '--lab', lab, '--json');
      assert.equal(inspect.code, 0, `${world.id}: inspect`);
      assert.equal(inspect.stdout[0].data.inspectView.goal.observationDimensions, world.dimensions);
      assert.equal(inspect.stdout[0].data.inspectView.facts.changeSupervisor.objective.observationDimensions, world.dimensions);

      const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--json');
      assert.equal(replay.code, 0, `${world.id}: replay`);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT', `${world.id}: replay verdict`);
    }
  });
});

test('CLI continues across process restarts and recovers a crashed run before the next run', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'restart-lab');
    assert.equal((await invoke('init', '--lab', lab, '--world', 'temperature', '--seed', 'restart-seed', '--json')).code, 0);
    assert.equal((await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--json')).code, 0);
    assert.equal((await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '2', '--json')).code, 0);

    const beforeCrash = await invoke('inspect', '--lab', lab, '--json');
    assert.equal(beforeCrash.stdout[0].data.current.kernelStep, 4);
    assert.equal(beforeCrash.stdout[0].data.inspectView.facts.changeSupervisor.cycle, 4);

    const crashed = await crashAfterStep(lab);
    assert.equal(crashed, 17);
    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout[0].data.reason, 'CRASH_HALTED');
    assert.equal(recovered.stdout[0].data.current.kernelStep, 5);

    const continued = await invoke('run', '--lab', lab, '--run-id', 'run-3', '--steps', '1', '--json');
    assert.equal(continued.code, 0);
    const afterRestart = await invoke('inspect', '--lab', lab, '--json');
    assert.equal(afterRestart.stdout[0].data.current.kernelStep, 6);
    assert.equal(afterRestart.stdout[0].data.inspectView.facts.changeSupervisor.cycle, 6);
    const replay = await invoke('replay', '--lab', lab, '--run', 'run-3', '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  });
});

test('CLI JSON failures are a single stdout envelope with the documented exit code', async () => {
  const result = await invoke('run', '--lab', 'missing-lab', '--steps', '0', '--json');
  assert.equal(result.code, 64);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.length, 1);
  assert.equal(result.stdout[0].ok, false);
  assert.equal(result.stdout[0].error.code, 'INVALID_INPUT');
  assert.equal(Object.hasOwn(result.stdout[0], 'data'), false);

  const unknown = await invoke('inspect', '--lab', 'missing-lab', '--unknown', 'value', '--json');
  assert.equal(unknown.code, 64);
  assert.equal(unknown.stdout[0].error.code, 'INVALID_INPUT');
});

test('CLI maps a safe stop to exit code 2 and keeps the result machine-readable', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'lab');
    await invoke('init', '--lab', lab, '--world', 'temperature', '--json');
    const result = await invoke('run', '--lab', lab, '--steps', '1', '--scenario', 'all-unsafe', '--json');
    assert.equal(result.code, 2);
    assert.equal(result.stdout[0].data.stopReason, 'NO_SAFE_ACTION');
    assert.equal(result.stdout[0].data.metrics.executed, 0);
    const inspection = await invoke('inspect', '--lab', lab, '--json');
    assert.equal(inspection.code, 0);
    assert.equal(inspection.stdout[0].data.inspectView.stopReason, 'NO_SAFE_ACTION');
  });
});

test('CLI runs and replays an unknown generated world through an external adapter', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'generated-lab');
    const adapter = await writeAdapterConfig(root);
    const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', 'cli-generated-seed', '--lab-id', 'generated-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);
    assert.equal(init.stdout[0].ok, true);

    const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', adapter, '--json');
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');

    const inspect = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(inspect.code, 0);
    assert.equal(inspect.stdout[0].data.current.kernelStep, 2);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');

    const steps = await countLedgerSteps(lab, 'run-1');
    assert.equal(steps, 2);
  });
});

test('CLI carries delayed and repeated feedback across WorldPort processes and run restarts', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'delayed-feedback-lab');
    const adapter = await writeDelayedFeedbackAdapterConfig(root, true);
    const init = await invoke('init', '--lab', lab, '--world', 'delayed-feedback', '--seed', 'delayed-feedback-seed', '--lab-id', 'delayed-feedback-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const firstRun = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'delayed', '--adapter', adapter, '--json');
    assert.equal(firstRun.code, 0);
    assert.equal(firstRun.stdout[0].data.status, 'COMPLETED');
    const firstStep = decodeStoredEvent(
      (await readFile(path.join(lab, 'runs', 'run-1', 'events.jsonl'), 'utf8'))
        .trim().split(/\r?\n/u).map(JSON.parse).find((event) => event.kind === 'STEP'),
    );
    assert.equal(firstStep.payload.update.status, 'DEFERRED');
    assert.equal(firstStep.payload.afterState.memory.pendingCredits.length, 1);
    assert.deepEqual(firstStep.payload.afterState.memory.actionModels, {});
    const firstNonce = firstStep.payload.receipt.executionNonce;
    const firstReplay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.equal(firstReplay.code, 0);
    assert.equal(firstReplay.stdout[0].data.verdict, 'CONSISTENT');

    const secondRun = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'delayed', '--adapter', adapter, '--json');
    assert.equal(secondRun.code, 0);
    assert.equal(secondRun.stdout[0].data.status, 'COMPLETED');
    const secondStep = decodeStoredEvent(
      (await readFile(path.join(lab, 'runs', 'run-2', 'events.jsonl'), 'utf8'))
        .trim().split(/\r?\n/u).map(JSON.parse).find((event) => event.kind === 'STEP'),
    );
    assert.equal(secondStep.payload.postObservation.feedback[0].executionNonce, firstNonce);
    assert.equal(secondStep.payload.update.settled[0].attribution, 'ACTION');
    assert.equal(secondStep.payload.update.settled[0].learnable, true);
    assert.equal(secondStep.payload.update.nextMemory.pendingCredits.length, 1);
    assert.equal(Object.values(secondStep.payload.update.nextMemory.actionModels)[0].sampleCount, 1);

    const current = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(current.code, 0);
    assert.equal(current.stdout[0].data.inspectView.facts.worldState.value, 1);
    const secondReplay = await invoke('replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json');
    assert.equal(secondReplay.code, 0);
    assert.equal(secondReplay.stdout[0].data.verdict, 'CONSISTENT');

    for (const runId of ['run-3', 'run-4']) {
      const continued = await invoke('run', '--lab', lab, '--run-id', runId, '--steps', '1', '--scenario', 'delayed', '--adapter', adapter, '--json');
      assert.equal(continued.code, 0);
    }
    const thirdStep = decodeStoredEvent(
      (await readFile(path.join(lab, 'runs', 'run-3', 'events.jsonl'), 'utf8'))
        .trim().split(/\r?\n/u).map(JSON.parse).find((event) => event.kind === 'STEP'),
    );
    assert.equal(thirdStep.payload.postObservation.feedback.length, 2);
    assert.equal(thirdStep.payload.update.settled.length, 1);
    const persisted = JSON.parse(await readFile(path.join(lab, 'state', 'current.json'), 'utf8'));
    const learned = Object.values(persisted.memory.actionModels)[0];
    assert.equal(persisted.worldState.value, 3);
    assert.equal(learned.sampleCount, 3);
    assert.equal(learned.meanDelta[0], 1);
    assert.equal(persisted.memory.settledFeedback.length, 3);
  });
});

test('CLI does not credit delayed feedback as progress of the current action', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'delayed-progress-lab');
    const adapter = await writeDelayedFeedbackAdapterConfig(root, false, false, true);
    const init = await invoke('init', '--lab', lab, '--world', 'delayed-feedback', '--seed', 'delayed-progress-seed', '--lab-id', 'delayed-progress-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const run = await invoke('agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'delayed', '--goal', 'reach target', '--kernel-only', '--adapter', adapter, '--json');
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    const steps = (await readFile(path.join(lab, 'runs', 'run-1', 'events.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map(JSON.parse).filter((event) => event.kind === 'STEP').map(decodeStoredEvent);
    assert.equal(steps.length, 2);
    assert.equal(steps[1].payload.postObservation.feedback.length, 1);
    assert.equal(steps[1].payload.receipt.attributionWindowComplete, true);
    assert.equal(steps[1].payload.verification.attribution, 'ACTION');
    assert.equal(steps[1].payload.verification.learnable, true);
    assert.equal(steps[1].payload.afterState.changeSupervisor.lastChange.confirmed, false);
    assert.equal(steps[1].payload.afterState.changeSupervisor.lastChange.improved, false);
    assert.equal(Object.values(steps[1].payload.update.nextMemory.actionModels)[0].sampleCount, 1);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  });
});

test('CLI replays a pre-v8 delayed-feedback supervisor ledger with its historical semantics', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'legacy-supervisor-lab');
    const adapter = await writeDelayedFeedbackAdapterConfig(root, false, false, true);
    const init = await invoke('init', '--lab', lab, '--world', 'delayed-feedback', '--seed', 'legacy-supervisor-seed', '--lab-id', 'legacy-supervisor-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const run = await invoke('agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'delayed', '--goal', 'reach target', '--kernel-only', '--adapter', adapter, '--json');
    assert.equal(run.code, 0);
    await rewriteDelayedRunAsV7(lab);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  });
});

test('CLI refuses shared-boundary multi-action credit across adapter restarts and feedback order', async () => {
  await withTemp(async (root) => {
    const identityLab = path.join(root, 'overlap-identity-lab');
    const reverseLab = path.join(root, 'overlap-reverse-lab');
    const identityAdapter = await writeOverlapFeedbackAdapterConfig(root, false);
    const reverseAdapter = await writeOverlapFeedbackAdapterConfig(root, true);

    for (const [lab, adapter] of [[identityLab, identityAdapter], [reverseLab, reverseAdapter]]) {
      const init = await invoke('init', '--lab', lab, '--world', 'overlap-feedback', '--seed', 'overlap-seed', '--lab-id', 'overlap-lab', '--adapter', adapter, '--json');
      assert.equal(init.code, 0, `${lab}: init`);
      const firstRun = await invoke('agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'overlap', '--goal', 'reach target', '--kernel-only', '--adapter', adapter, '--json');
      assert.equal(firstRun.code, 0, `${lab}: first run`);
      const secondRun = await invoke('agent', 'run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'overlap', '--kernel-only', '--adapter', adapter, '--json');
      assert.equal(secondRun.code, 0, `${lab}: second run`);
    }

    const identityCurrent = JSON.parse(await readFile(path.join(identityLab, 'state', 'current.json'), 'utf8'));
    const reverseCurrent = JSON.parse(await readFile(path.join(reverseLab, 'state', 'current.json'), 'utf8'));
    assert.deepEqual(identityCurrent.memory, reverseCurrent.memory);
    assert.equal(identityCurrent.worldState.value, 1);
    assert.equal(identityCurrent.memory.pendingCredits.length, 1);
    assert.equal(Object.keys(identityCurrent.memory.actionModels).length, 0);
    assert.equal(identityCurrent.memory.settledFeedback.length, 2);
    assert.equal(identityCurrent.changeSupervisor.lastChange.evidence, 'AMBIGUOUS');
    assert.equal(identityCurrent.changeSupervisor.lastChange.confirmed, false);
    assert.equal(identityCurrent.changeSupervisor.lastChange.improved, false);
    assert.equal(identityCurrent.changeSupervisor.lastChange.decision, 'REPLAN');
    assert.equal(identityCurrent.changeSupervisor.lastChange.stopReason, 'STAGNATION');
    assert.equal(identityCurrent.changeSupervisor.replanCount, 1);
    assert.equal(identityCurrent.changeSupervisor.stagnation, 0, 'replan acknowledgement resets the counter, not the evidence');
    assert.deepEqual(identityCurrent.changeSupervisor, reverseCurrent.changeSupervisor);

    for (const [lab, adapter] of [[identityLab, identityAdapter], [reverseLab, reverseAdapter]]) {
      const step = decodeStoredEvent(
        (await readFile(path.join(lab, 'runs', 'run-2', 'events.jsonl'), 'utf8'))
          .trim().split(/\r?\n/u).map(JSON.parse).find((event) => event.kind === 'STEP'),
      );
      assert.deepEqual(step.payload.update.settled.map((item) => item.attribution), ['AMBIGUOUS', 'AMBIGUOUS']);
      const replay = await invoke('replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json');
      assert.equal(replay.code, 0, `${lab}: replay`);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT', `${lab}: replay verdict`);
    }
  });
});

test('CLI closes a missing-feedback window without learning and survives repeated restarts', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'missing-feedback-lab');
    const adapter = await writeDelayedFeedbackAdapterConfig(root, false, true);
    const init = await invoke('init', '--lab', lab, '--world', 'delayed-feedback', '--seed', 'missing-feedback-seed', '--lab-id', 'missing-feedback-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    for (let index = 1; index <= 10; index += 1) {
      const run = await invoke('run', '--lab', lab, '--run-id', `run-${index}`, '--steps', '1', '--scenario', 'delayed', '--adapter', adapter, '--json');
      assert.equal(run.code, 0, `run-${index}`);
      assert.equal(run.stdout[0].data.status, 'COMPLETED', `run-${index} status`);
      const replay = await invoke('replay', '--lab', lab, '--run', `run-${index}`, '--adapter', adapter, '--json');
      assert.equal(replay.code, 0, `run-${index} replay`);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT', `run-${index} replay verdict`);
    }

    const timeoutStep = decodeStoredEvent(
      (await readFile(path.join(lab, 'runs', 'run-9', 'events.jsonl'), 'utf8'))
        .trim().split(/\r?\n/u).map(JSON.parse).find((event) => event.kind === 'STEP'),
    );
    assert.equal(timeoutStep.payload.update.settled[0].attribution, 'UNRESOLVED');
    assert.equal(timeoutStep.payload.update.settled[0].reason, 'FEEDBACK_TIMEOUT');
    assert.equal(timeoutStep.payload.update.settled[0].learnable, false);
    assert.equal(timeoutStep.payload.update.nextMemory.actionModels && Object.keys(timeoutStep.payload.update.nextMemory.actionModels).length, 0);
    assert.equal(timeoutStep.payload.update.nextMemory.pendingCredits.length, 8);

    const current = JSON.parse(await readFile(path.join(lab, 'state', 'current.json'), 'utf8'));
    assert.equal(current.memory.pendingCreditPolicy.maxAge, 8);
    assert.equal(current.memory.pendingCredits.length, 8);
    assert.equal(current.worldState.revision, 10);
  });
});

test('CLI preserves state-dependent external capabilities across restarts, replay, and historical inspect', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'stateful-lab');
    const adapter = await writeStatefulAdapterConfig(root, path.join(root, 'stateful-first-token.txt'));
    const init = await invoke('init', '--lab', lab, '--world', 'stateful-capabilities', '--seed', 'stateful-seed', '--lab-id', 'stateful-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const firstRun = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'stateful', '--adapter', adapter, '--json');
    assert.equal(firstRun.code, 0);
    assert.equal(firstRun.stdout[0].data.status, 'COMPLETED');

    const secondRun = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'stateful', '--adapter', adapter, '--json');
    assert.equal(secondRun.code, 0);
    assert.equal(secondRun.stdout[0].data.status, 'COMPLETED');

    const current = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(current.code, 0);
    assert.equal(current.stdout[0].data.inspectView.facts.worldState.value, 2);
    assert.equal(current.stdout[0].data.inspectView.constraints.actions.filter((action) => action.safe).length, 1);
    assert.equal(current.stdout[0].data.inspectView.constraints.actions[1].safe, true);

    const historicalRun = await invoke('inspect', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.equal(historicalRun.code, 0);
    assert.equal(historicalRun.stdout[0].data.inspectView.facts.worldState.value, 1);
    assert.equal(historicalRun.stdout[0].data.inspectView.constraints.actions[0].safe, false);
    assert.equal(historicalRun.stdout[0].data.inspectView.constraints.actions[1].safe, true);

    const historicalAction = await invoke('inspect', '--lab', lab, '--action', 'run-1:2', '--adapter', adapter, '--json');
    assert.equal(historicalAction.code, 0);
    assert.equal(historicalAction.stdout[0].data.inspectView.constraints.actions[0].safe, true);
    assert.equal(historicalAction.stdout[0].data.inspectView.constraints.actions[1].safe, false);

    for (const runId of ['run-1', 'run-2']) {
      const replay = await invoke('replay', '--lab', lab, '--run', runId, '--adapter', adapter, '--json');
      assert.equal(replay.code, 0, `${runId}: replay`);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT', `${runId}: replay verdict`);
    }
  });
});

test('CLI resumes a response-lost external transition through the same execution nonce', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'idempotent-lab');
    const effectFile = path.join(root, 'external-effect.json');
    const adapter = await writeIdempotentAdapterConfig(root, effectFile);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'idempotent-seed', '--lab-id', 'idempotent-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const lost = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--planning-horizon', '2', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(lost.code, 0);
    assert.equal(await countLedgerSteps(lab, 'run-1'), 0);
    const recoveredEvents = (await readFile(path.join(lab, 'runs', 'run-1', 'events.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map(JSON.parse);
    const recoveryTerminal = recoveredEvents.find((event) => event.kind === 'RUN_HALTED');
    assert.equal(recoveryTerminal.payload.externalTransition.planning.horizon, 2);
    assert.equal(recoveryTerminal.payload.externalTransition.planning.contextMode, 'context-v1');
    assert.equal(recoveryTerminal.payload.externalTransition.planning.branchingMode, 'tree-v1');
    const afterLoss = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(afterLoss.code, 0);
    assert.equal(afterLoss.stdout[0].data.current.status, 'HALTED');
    assert.equal(afterLoss.stdout[0].data.current.worldState.value, 0);

    const resumed = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.equal(resumed.code, 0);
    assert.equal(resumed.stdout[0].data.status, 'COMPLETED');
    const resumedEvents = (await readFile(path.join(lab, 'runs', 'run-2', 'events.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map(JSON.parse);
    const resumedStep = decodeStoredEvent(resumedEvents.find((event) => event.kind === 'STEP'));
    assert.equal(resumedStep.payload.boundary.planning.horizon, 2);
    assert.equal(resumedStep.payload.boundary.planning.contextMode, 'context-v1');
    assert.equal(resumedStep.payload.boundary.planning.branchingMode, 'tree-v1');

    const current = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(current.code, 0);
    assert.equal(current.stdout[0].data.current.worldState.value, 1);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
  });
});

test('CLI treats an external transition marker without contextMode as legacy-v1 during recovery', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'legacy-planning-marker-lab');
    const effectFile = path.join(root, 'legacy-planning-marker-effect.json');
    const adapter = await writeTransitionAdapterConfig(root, effectFile, [], false);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'legacy-planning-marker-seed', '--lab-id', 'legacy-planning-marker-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const crashed = await crashAfterExternalTransitionReturn(lab, adapter);
    assert.equal(crashed, 17);
    await rewriteExternalTransitionMarkerWithoutContextMode(lab, 'crashed-external-run');

    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout[0].data.reason, 'EXTERNAL_TRANSITION_UNKNOWN');

    const recoveredEvents = (await readFile(path.join(lab, 'runs', 'crashed-external-run', 'events.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map(JSON.parse);
    const recoveryTerminal = recoveredEvents.find((event) => event.kind === 'RUN_HALTED');
    const originalToken = recoveryTerminal.payload.externalTransition.token;
    assert.deepEqual(recoveryTerminal.payload.externalTransition.planning, {
      schemaVersion: 1,
      horizon: 1,
      contextMode: 'legacy-v1',
    });

    const resumed = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.equal(resumed.code, 0);
    const resumedEvents = (await readFile(path.join(lab, 'runs', 'run-2', 'events.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map(JSON.parse);
    const resumedStep = decodeStoredEvent(resumedEvents.find((event) => event.kind === 'STEP'));
    assert.equal(resumedStep.payload.choice.token, originalToken);
    assert.equal(resumedStep.payload.boundary.planning.contextMode, 'legacy-v1');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  });
});

test('CLI reuses the persisted advisor selection when an external transition is retried', async () => {
  await withTemp(async (root) => {
    const baselineLab = path.join(root, 'advisor-baseline-lab');
    const baselineEffect = path.join(root, 'advisor-baseline-effect.json');
    const adapter = await writeTransitionAdapterConfig(root, baselineEffect, ['--two-actions', '--both-safe'], false);
    const baselineInit = await invoke('init', '--lab', baselineLab, '--world', 'idempotent-transition', '--seed', 'advisor-seed', '--lab-id', 'advisor-baseline-lab', '--adapter', adapter, '--json');
    assert.equal(baselineInit.code, 0);
    const baselineRun = await invoke('run', '--lab', baselineLab, '--run-id', 'baseline-run', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.equal(baselineRun.code, 0);
    const defaultToken = await firstStepToken(baselineLab, 'baseline-run');
    const manifest = JSON.parse(await readFile(path.join(baselineLab, 'manifest.json'), 'utf8'));
    const advisorToken = manifest.tokenMap.entries.find((entry) => entry.token !== defaultToken).token;

    const lab = path.join(root, 'advisor-retry-lab');
    const effectFile = path.join(root, 'advisor-retry-effect.json');
    await writeTransitionAdapterConfig(root, effectFile, ['--two-actions', '--both-safe'], false);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'advisor-seed', '--lab-id', 'advisor-baseline-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);
    const crashed = await crashAfterExternalTransitionReturnWithAdvisor(lab, adapter, advisorToken);
    assert.equal(crashed, 17);

    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    const resumed = await invoke('run', '--lab', lab, '--run-id', 'advisor-retry-run', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.equal(resumed.code, 0);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
  });
});

test('CLI rejects an idempotent retry under a different scenario', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'idempotent-scenario-lab');
    const effectFile = path.join(root, 'idempotent-scenario-effect.json');
    const adapter = await writeIdempotentAdapterConfig(root, effectFile);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'idempotent-scenario-seed', '--lab-id', 'idempotent-scenario-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const lost = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(lost.code, 0);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const mismatched = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'alternate', '--adapter', adapter, '--json');
    assert.notEqual(mismatched.code, 0);
    assert.equal(mismatched.stdout[0].error.code, 'CONFLICT');
    assert.match(mismatched.stdout[0].error.message, /original scenario/);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await countLedgerSteps(lab, 'run-2'), 0);
  });
});

test('CLI binds an idempotent retry to the original external action identity', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'idempotent-action-lab');
    const effectFile = path.join(root, 'idempotent-action-effect.json');
    const adapter = await writeTransitionAdapterConfig(root, effectFile, ['--two-actions']);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'idempotent-action-seed', '--lab-id', 'idempotent-action-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const lost = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(lost.code, 0);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const mismatched = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(mismatched.code, 0);
    assert.equal(mismatched.stdout[0].error.code, 'CONFLICT');
    assert.match(mismatched.stdout[0].error.message, /original external transition request/);
    assert.deepEqual(mismatched.stdout[0].error.context.fields, ['token']);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await countLedgerSteps(lab, 'run-2'), 0);
  });
});

test('CLI keeps the original external uncertainty after a retry crashes again', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'persistent-uncertainty-lab');
    const effectFile = path.join(root, 'persistent-uncertainty-effect.json');
    const adapter = await writeIdempotentAdapterConfig(root, effectFile);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-uncertainty-seed', '--lab-id', 'persistent-uncertainty-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const lost = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(lost.code, 0);
    const crashed = await crashAfterExternalTransitionReturn(lab, adapter);
    assert.equal(crashed, 17);
    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout[0].data.reason, 'EXTERNAL_TRANSITION_UNKNOWN');

    const blocked = await invoke('run', '--lab', lab, '--run-id', 'run-3', '--steps', '1', '--scenario', 'alternate', '--adapter', adapter, '--json');
    assert.notEqual(blocked.code, 0);
    assert.equal(blocked.stdout[0].error.code, 'CONFLICT');
    assert.match(blocked.stdout[0].error.message, /original scenario/);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
  });
});

test('CLI preserves the unknown reason when recovery follows a terminal-append crash', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'terminal-append-unknown-lab');
    const effectFile = path.join(root, 'terminal-append-unknown-effect.json');
    const adapter = await writeIdempotentAdapterConfig(root, effectFile);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'terminal-append-unknown-seed', '--lab-id', 'terminal-append-unknown-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const crashed = await crashAfterUnknownTerminalAppend(lab, adapter);
    assert.equal(crashed, 17);
    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout[0].data.reason, 'EXTERNAL_TRANSITION_UNKNOWN');
  });
});

test('CLI blocks retry after an uncertain external transition without an idempotency declaration', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'non-idempotent-lab');
    const effectFile = path.join(root, 'non-idempotent-effect.json');
    const adapter = await writeNonIdempotentAdapterConfig(root, effectFile);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'non-idempotent-seed', '--lab-id', 'non-idempotent-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const lost = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(lost.code, 0);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const blocked = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(blocked.code, 0);
    assert.equal(blocked.stdout[0].error.code, 'CONFLICT');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await countLedgerSteps(lab, 'run-2'), 0);
  });
});

test('CLI recovers a host crash after an external transition without duplicating the effect', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'host-crash-lab');
    const effectFile = path.join(root, 'host-crash-effect.json');
    const adapter = await writeTransitionAdapterConfig(root, effectFile, [], false);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'host-crash-seed', '--lab-id', 'host-crash-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const crashed = await crashAfterExternalTransitionReturn(lab, adapter);
    assert.equal(crashed, 17);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout[0].data.reason, 'EXTERNAL_TRANSITION_UNKNOWN');

    const resumed = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.equal(resumed.code, 0);
    assert.equal(resumed.stdout[0].data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
  });
});

test('CLI blocks a host-crash retry when the external adapter is not idempotent', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'host-crash-non-idempotent-lab');
    const effectFile = path.join(root, 'host-crash-non-idempotent-effect.json');
    const adapter = await writeTransitionAdapterConfig(root, effectFile, ['--non-idempotent'], false);
    const init = await invoke('init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'host-crash-non-idempotent-seed', '--lab-id', 'host-crash-non-idempotent-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);

    const crashed = await crashAfterExternalTransitionReturn(lab, adapter);
    assert.equal(crashed, 17);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    const recovered = await invoke('recover', '--lab', lab, '--confirm-lock-owner-dead', '--json');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout[0].data.reason, 'EXTERNAL_TRANSITION_UNKNOWN');

    const blocked = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json');
    assert.notEqual(blocked.code, 0);
    assert.equal(blocked.stdout[0].error.code, 'CONFLICT');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
  });
});

test('CLI drives a marked sandbox file effect across separate processes', async () => {
  await withTemp(async (root) => {
    const sandbox = path.join(root, 'sandbox');
    await mkdir(sandbox);
    await mkdir(path.join(sandbox, 'inbox'));
    await mkdir(path.join(sandbox, 'done'));
    await writeFile(path.join(sandbox, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(sandbox, 'inbox', 'report.txt'), 'report', 'utf8');
    const journal = path.join(root, 'effects.jsonl');
    const intentPath = path.join(root, 'intent.json');
    const unsigned = {
      schemaVersion: 1,
      effectId: 'effect:file:move',
      executionNonce: 'nonce:cli:sandbox:1',
      actionToken: 'tok_FILEMOVE',
      target: { operation: 'move', from: 'inbox/report.txt', to: 'done/report.txt' },
      precondition: { sourceExists: true, destinationAbsent: true },
      risk: 'HIGH',
      requiresConfirmation: true,
      reversible: true,
      compensation: { operation: 'move-back' },
    };
    await writeFile(intentPath, JSON.stringify({ ...unsigned, planDigest: canonicalDigest(unsigned) }));

    const plan = await invoke('effect', 'plan', '--journal', journal, '--sandbox-root', sandbox, '--intent', intentPath, '--json');
    assert.equal(plan.code, 0);
    assert.equal(plan.stdout[0].data.phase, 'AWAITING_CONFIRMATION');
    const confirm = await invoke('effect', 'confirm', '--journal', journal, '--sandbox-root', sandbox, '--nonce', unsigned.executionNonce, '--json');
    assert.equal(confirm.code, 0);
    const execute = await invoke('effect', 'execute', '--journal', journal, '--sandbox-root', sandbox, '--nonce', unsigned.executionNonce, '--json');
    assert.equal(execute.code, 0);
    assert.equal(execute.stdout[0].data.phase, 'APPLIED');
    const inspect = await invoke('effect', 'inspect', '--journal', journal, '--json');
    assert.equal(inspect.code, 0);
    assert.equal(inspect.stdout[0].data.effects[0].phase, 'APPLIED');
    const compensate = await invoke('effect', 'compensate', '--journal', journal, '--sandbox-root', sandbox, '--nonce', unsigned.executionNonce, '--json');
    assert.equal(compensate.code, 0);
    assert.equal(compensate.stdout[0].data.phase, 'REVERSED');
    assert.equal(await readFile(path.join(sandbox, 'inbox', 'report.txt'), 'utf8'), 'report');
  });
});

test('CLI binds external adapter identity and preserves the completed ledger', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'generated-lab');
    const validAdapter = await writeAdapterConfig(root);
    const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', 'cli-generated-seed', '--lab-id', 'generated-lab', '--adapter', validAdapter, '--json');
    assert.equal(init.code, 0);

    const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', validAdapter, '--json');
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    const ledgerPath = path.join(lab, 'runs', 'run-1', 'events.jsonl');
    const originalLedger = await readFile(ledgerPath, 'utf8');

    const differentLaunch = await writeAdapterConfig(root, ['--mode', 'nonzero']);
    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', differentLaunch, '--json');
    assert.notEqual(replay.code, 0);
    assert.equal(await countLedgerSteps(lab, 'run-1'), 2);
    assert.equal(await readFile(ledgerPath, 'utf8'), originalLedger);
  });
});

test('replay rejects recomputed external evidence and does not start the adapter', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'generated-lab');
    const counter = path.join(root, 'adapter-spawn-count.txt');
    const adapter = await writeAdapterConfig(root, ['--counter-file', counter]);
    const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', 'cli-generated-seed', '--lab-id', 'generated-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);
    const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', adapter, '--json');
    assert.equal(run.code, 0);
    const beforeReplay = Number.parseInt(await readFile(counter, 'utf8'), 10);
    await rewriteExternalInputEvidence(lab);

    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.notEqual(replay.code, 0, 'replay must reject an externally tampered signed input');
    assert.equal(Number.parseInt(await readFile(counter, 'utf8'), 10), beforeReplay, 'replay must not start the adapter');
  });
});

test('CLI external adapter failures do not append STEP events', async () => {
  for (const mode of ['nonzero', 'pollution', 'timeout', 'invalid-response', 'truncated-response', 'wrong-response-id', 'wrong-response-version', 'duplicate-response']) {
    await withTemp(async (root) => {
      const lab = path.join(root, 'generated-lab');
      const brokenAdapter = await writeAdapterConfig(root, ['--mode', mode]);
      const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', 'cli-generated-seed', '--lab-id', 'generated-lab', '--adapter', brokenAdapter, '--json');
      assert.equal(init.code, 0, `${mode}: init`);

      const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', brokenAdapter, '--json');
      assert.notEqual(run.code, 0, `${mode}: run must fail`);
      assert.equal(await countLedgerSteps(lab, 'run-1'), 0, `${mode}: failed adapter appended a STEP`);
    });
  }
});

test('CLI keeps JSONL transport deterministic across stderr diagnostics and Windows line endings', async () => {
  for (const mode of ['stderr-noise', 'crlf']) {
    await withTemp(async (root) => {
      const lab = path.join(root, `generated-${mode}`);
      const adapter = await writeAdapterConfig(root, ['--mode', mode]);
      const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', `cli-${mode}-seed`, '--lab-id', `generated-${mode}`, '--adapter', adapter, '--json');
      assert.equal(init.code, 0, `${mode}: init`);

      const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', adapter, '--json');
      assert.equal(run.code, 0, `${mode}: run`);
      assert.equal(run.stdout[0].data.status, 'COMPLETED', `${mode}: status`);

      const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
      assert.equal(replay.code, 0, `${mode}: replay`);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT', `${mode}: replay`);
    });
  }
});

test('CLI rejects external state and observation contract violations before STEP', async () => {
  for (const mode of ['bad-revision', 'bad-observation-dimensions']) {
    await withTemp(async (root) => {
      const lab = path.join(root, 'generated-lab');
      const adapter = await writeAdapterConfig(root, ['--mode', mode]);
      const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', 'cli-generated-seed', '--lab-id', 'generated-lab', '--adapter', adapter, '--json');
      assert.equal(init.code, 0, `${mode}: init`);

      const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', adapter, '--json');
      assert.notEqual(run.code, 0, `${mode}: run must fail`);
      assert.equal(await countLedgerSteps(lab, 'run-1'), 0, `${mode}: invalid contract appended a STEP`);
    });
  }
});

test('CLI accepts an opaque external state-version representation', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'opaque-version-lab');
    const adapter = await writeAdapterConfig(root, ['--mode', 'opaque-state-version']);
    const init = await invoke('init', '--lab', lab, '--world', 'generated', '--seed', 'opaque-version-seed', '--lab-id', 'opaque-version-lab', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);
    const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--scenario', 'generated', '--adapter', adapter, '--json');
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    const replay = await invoke('replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json');
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    assert.equal(replay.stdout[0].data.finalState.worldState.stateVersion, 'opaque-v7/2');
  });
});

test('CLI rejects an adapter config whose executable is not absolute', async () => {
  await withTemp(async (root) => {
    const config = path.join(root, 'relative-executable.json');
    await writeFile(config, JSON.stringify({
      executable: 'node',
      args: [],
      adapterId: 'generated-adapter',
      worldId: 'generated',
    }));
    const result = await invoke('init', '--lab', path.join(root, 'lab'), '--world', 'generated', '--adapter', config, '--json');
    assert.notEqual(result.code, 0);
  });
});

test('CLI rejects oversized opaque external WorldPort boundary identifiers before ledger append', async () => {
  await withTemp(async (root) => {
    const adapter = await writeAdapterConfig(root, ['--mode', 'oversized-boundary-id']);
    const lab = path.join(root, 'lab');
    const init = await invoke(
      'init',
      '--lab', lab,
      '--world', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.equal(init.code, 0);
    const result = await invoke(
      'run',
      '--lab', lab,
      '--run-id', 'run-1',
      '--steps', '1',
      '--scenario', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 1);
    assert.equal(result.stdout[0].ok, false);
    const inspect = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(inspect.code, 0);
    assert.equal(inspect.stdout[0].data.current.lastRunId, null);
  });
});

test('CLI rejects oversized external execution nonces before ledger append', async () => {
  await withTemp(async (root) => {
    const adapter = await writeAdapterConfig(root, ['--mode', 'oversized-execution-nonce']);
    const lab = path.join(root, 'lab');
    const init = await invoke(
      'init',
      '--lab', lab,
      '--world', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.equal(init.code, 0);
    const result = await invoke(
      'run',
      '--lab', lab,
      '--run-id', 'run-1',
      '--steps', '1',
      '--adapter', adapter,
      '--json',
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 1);
    assert.equal(result.stdout[0].ok, false);
    const inspect = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(inspect.code, 0);
    assert.equal(inspect.stdout[0].data.current.lastRunId, null);
  });
});

test('CLI rejects oversized external domain state before STEP append', async () => {
  await withTemp(async (root) => {
    const adapter = await writeAdapterConfig(root, ['--mode', 'oversized-domain-state']);
    const lab = path.join(root, 'lab');
    const init = await invoke(
      'init',
      '--lab', lab,
      '--world', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.equal(init.code, 0);
    const result = await invoke(
      'run',
      '--lab', lab,
      '--run-id', 'run-1',
      '--steps', '1',
      '--scenario', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 1);
    assert.equal(result.stdout[0].ok, false);
    assert.match(result.stdout[0].error.message, /size|state|payload/iu);
    assert.equal(await countLedgerSteps(lab, 'run-1'), 0);
  });
});

test('CLI rejects oversized external input evidence before external transition', async () => {
  await withTemp(async (root) => {
    const transitionCountFile = path.join(root, 'transition-count.txt');
    const adapter = await writeAdapterConfig(root, [
      '--mode', 'oversized-external-input',
      '--transition-count-file', transitionCountFile,
    ]);
    const lab = path.join(root, 'lab');
    const init = await invoke(
      'init',
      '--lab', lab,
      '--world', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.equal(init.code, 0);
    const result = await invoke(
      'run',
      '--lab', lab,
      '--run-id', 'run-1',
      '--steps', '1',
      '--scenario', 'generated',
      '--adapter', adapter,
      '--json',
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 1);
    assert.equal(result.stdout[0].ok, false);
    assert.match(result.stdout[0].error.message, /evidence|input|persistence|size/iu);
    assert.equal(await countLedgerSteps(lab, 'run-1'), 0);
    await assert.rejects(readFile(transitionCountFile), { code: 'ENOENT' });
  });
});

test('CLI converts non-canonical external input evidence into a protocol error', async () => {
  await withTemp(async (root) => {
    const adapter = await writeAdapterConfig(root, ['--mode', 'deep-external-input']);
    const lab = path.join(root, 'lab');
    const init = await invoke('init', '--lab', lab, '--world', 'generated', '--adapter', adapter, '--json');
    assert.equal(init.code, 0);
    const result = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'generated', '--adapter', adapter, '--json');
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 1);
    assert.equal(result.stdout[0].ok, false);
    assert.equal(result.stdout[0].error.code, 'WORLD_ADAPTER_PROTOCOL');
    assert.match(result.stdout[0].error.message, /canonical|JSON/iu);
    assert.equal(await countLedgerSteps(lab, 'run-1'), 0);
  });
});

async function invoke(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Paired experiments perform durable Run creation, Replay, and a second
    // process startup on Windows; keep the timeout above that real boundary.
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ code: null, timedOut: true, stdout: parseOutput(stdout), stderr });
    }, 30000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code, timedOut: false, stdout: parseOutput(stdout), stderr });
    });
  });
}

async function crashAfterStep(lab) {
  const agentService = pathToFileURL(path.resolve('src/application/agent-service.mjs')).href;
  const script = [
    `import { runLab } from ${JSON.stringify(agentService)};`,
    `runLab({ labPath: ${JSON.stringify(lab)}, runId: 'crashed-run', steps: 1, failpoint: (point) => point === 'STEP:appended' })`,
    '.then(() => process.exit(0), () => process.exit(17));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === null) reject(new Error(`crash runner did not exit cleanly: ${stderr}`));
      else resolve(code);
    });
  });
}

async function crashAfterExternalTransitionReturn(lab, adapter) {
  const agentService = pathToFileURL(path.resolve('src/application/agent-service.mjs')).href;
  const externalRegistry = pathToFileURL(path.resolve('src/application/external-world-registry.mjs')).href;
  const script = [
    `import { runLab } from ${JSON.stringify(agentService)};`,
    `import { loadExternalWorldRegistry } from ${JSON.stringify(externalRegistry)};`,
    `const registry = loadExternalWorldRegistry(${JSON.stringify(adapter)});`,
    `runLab({ labPath: ${JSON.stringify(lab)}, runId: 'crashed-external-run', steps: 1, scenario: 'idempotent', registry, failpoint: (point) => point === 'external-transition:returned' ? process.exit(17) : false })`,
    '.then(() => process.exit(0), () => process.exit(17));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === null) reject(new Error(`external crash runner did not exit cleanly: ${stderr}`));
      else resolve(code);
    });
  });
}

async function crashAfterExternalTransitionReturnWithAdvisor(lab, adapter, token) {
  const agentService = pathToFileURL(path.resolve('src/application/agent-service.mjs')).href;
  const externalRegistry = pathToFileURL(path.resolve('src/application/external-world-registry.mjs')).href;
  const script = [
    `import { runLab } from ${JSON.stringify(agentService)};`,
    `import { loadExternalWorldRegistry } from ${JSON.stringify(externalRegistry)};`,
    `const registry = loadExternalWorldRegistry(${JSON.stringify(adapter)});`,
    `const advisor = async () => ({ model: 'stable-test-advisor', token: ${JSON.stringify(token)}, responseDigest: 'sha256:${'a'.repeat(64)}', reason: null });`,
    `runLab({ labPath: ${JSON.stringify(lab)}, runId: 'advisor-crashed-run', steps: 1, scenario: 'idempotent', registry, advisor, failpoint: (point) => point === 'external-transition:returned' ? process.exit(17) : false })`,
    '.then(() => process.exit(0), () => process.exit(17));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === null) reject(new Error(`advisor crash runner did not exit cleanly: ${stderr}`));
      else resolve(code);
    });
  });
}

async function crashAfterUnknownTerminalAppend(lab, adapter) {
  const agentService = pathToFileURL(path.resolve('src/application/agent-service.mjs')).href;
  const externalRegistry = pathToFileURL(path.resolve('src/application/external-world-registry.mjs')).href;
  const script = [
    `import { runLab } from ${JSON.stringify(agentService)};`,
    `import { loadExternalWorldRegistry } from ${JSON.stringify(externalRegistry)};`,
    `const registry = loadExternalWorldRegistry(${JSON.stringify(adapter)});`,
    `runLab({ labPath: ${JSON.stringify(lab)}, runId: 'terminal-append-unknown-run', steps: 1, scenario: 'idempotent', registry, failpoint: (point) => point === 'external-transition:returned' || point === 'terminal:appended' })`,
    '.then(() => process.exit(0), () => process.exit(17));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === null) reject(new Error(`unknown-terminal runner did not exit cleanly: ${stderr}`));
      else resolve(code);
    });
  });
}

async function writeAdapterConfig(root, args = []) {
  const suffix = (args.join('-') || 'valid').replace(/[^a-z0-9_-]/giu, '_');
  const config = path.join(root, `adapter-${suffix}.json`);
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER_FIXTURE, ...args],
    adapterId: 'generated-adapter-v1',
    worldId: 'generated',
    timeoutMs: 5000,
  }));
  return config;
}

async function writeDelayedFeedbackAdapterConfig(root, repeatFeedback = false, dropFeedback = false, completeAfterPending = false) {
  const config = path.join(root, 'delayed-feedback-adapter.json');
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [DELAYED_FEEDBACK_ADAPTER_FIXTURE, ...(repeatFeedback ? ['--repeat-feedback'] : []), ...(dropFeedback ? ['--drop-feedback'] : []), ...(completeAfterPending ? ['--complete-after-pending'] : [])],
    adapterId: 'delayed-feedback-adapter-v1',
    worldId: 'delayed-feedback',
    timeoutMs: 2000,
  }));
  return config;
}

async function writeOverlapFeedbackAdapterConfig(root, reverseFeedback) {
  const suffix = reverseFeedback ? 'reverse' : 'identity';
  const config = path.join(root, `overlap-feedback-${suffix}.json`);
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [OVERLAP_FEEDBACK_ADAPTER_FIXTURE, ...(reverseFeedback ? ['--reverse-feedback'] : [])],
    adapterId: 'overlap-feedback-adapter-v1',
    worldId: 'overlap-feedback',
    timeoutMs: 2000,
  }));
  return config;
}

async function writeStatefulAdapterConfig(root, memoryFile) {
  const config = path.join(root, 'stateful-adapter.json');
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [STATEFUL_ADAPTER_FIXTURE, '--memory-file', memoryFile],
    adapterId: 'stateful-capabilities-adapter-v1',
    worldId: 'stateful-capabilities',
    timeoutMs: 2000,
  }));
  return config;
}

async function writeIdempotentAdapterConfig(root, effectFile) {
  return writeTransitionAdapterConfig(root, effectFile, []);
}

async function writeNonIdempotentAdapterConfig(root, effectFile) {
  return writeTransitionAdapterConfig(root, effectFile, ['--non-idempotent']);
}

async function writeTransitionAdapterConfig(root, effectFile, modeArgs, dropResponse = true) {
  const config = path.join(root, 'idempotent-adapter.json');
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [IDEMPOTENT_ADAPTER_FIXTURE, '--effect-file', effectFile, ...(dropResponse ? ['--drop-response'] : []), ...modeArgs],
    adapterId: 'idempotent-transition-adapter-v1',
    worldId: 'idempotent-transition',
    timeoutMs: 2000,
  }));
  return config;
}

async function invokeAdapter(args, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER_FIXTURE, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`adapter exited with ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function rewriteExternalInputEvidence(lab) {
  const eventsPath = path.join(lab, 'runs', 'run-1', 'events.jsonl');
  const events = (await readFile(eventsPath, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const step = decodeStoredEvent(events[1]);
  const external = step.payload.externalInputs[0];
  external.payload.generated = false;
  const externalUnsigned = { ...external };
  delete externalUnsigned.digest;
  delete externalUnsigned.attestation;
  external.digest = canonicalDigest(externalUnsigned);
  step.digest = digestEvent(step);

  const terminal = events[2];
  terminal.prevDigest = step.digest;
  terminal.digest = digestEvent(terminal);
  events[1] = encodeStoredEvent(step);
  events[2] = terminal;
  await writeFile(eventsPath, `${events.map((event) => canonicalJson(event)).join('\n')}\n`);

  const endPath = path.join(lab, 'runs', 'run-1', 'end.json');
  const end = JSON.parse(await readFile(endPath, 'utf8'));
  delete end.selfDigest;
  end.finalEventDigest = terminal.digest;
  await writeFile(endPath, `${canonicalJson(withSelfDigest(end))}\n`);

  const currentPath = path.join(lab, 'state', 'current.json');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  delete current.selfDigest;
  current.eventsDigest = terminal.digest;
  await writeFile(currentPath, `${canonicalJson(withSelfDigest(current))}\n`);
}

async function rewriteExternalTransitionMarkerWithoutContextMode(lab, runId) {
  const markerPath = path.join(lab, 'runs', runId, 'external-transition.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const { contextMode: _ignored, ...legacyPlanning } = marker.planning;
  delete marker.selfDigest;
  await writeFile(markerPath, `${canonicalJson(withSelfDigest({
    ...marker,
    planning: legacyPlanning,
  }))}\n`);
}

async function rewriteDelayedRunAsV7(lab) {
  const runPath = path.join(lab, 'runs', 'run-1');
  const eventsPath = path.join(runPath, 'events.jsonl');
  const events = (await readFile(eventsPath, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const steps = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === 'STEP')
    .map(({ event, index }) => ({ event: decodeStoredEvent(event), index }));
  assert.equal(steps.length, 2);
  const previous = steps[0].event.payload.afterState.changeSupervisor;
  const current = steps[1].event.payload;
  const legacySupervisor = advanceChangeSupervisor(previous, {
    beforeObservation: current.beforeObservation,
    postObservation: current.postObservation,
    verification: current.verification,
  });
  current.boundary = { ...current.boundary, kernelLearningVersion: 7 };
  current.update = {
    ...current.update,
    nextMemory: withoutModelAge(withoutHistoryAccumulator(current.update.nextMemory)),
  };
  current.afterState = {
    ...current.afterState,
    memory: withoutModelAge(withoutHistoryAccumulator(current.afterState.memory)),
  };
  current.afterState = { ...current.afterState, changeSupervisor: legacySupervisor };
  current.afterDigest = canonicalDigest(current.afterState);
  steps[1].event.digest = digestEvent(steps[1].event);
  events[steps[1].index] = encodeStoredEvent(steps[1].event);

  const terminalIndex = events.findIndex((event) => event.kind === 'RUN_COMPLETED' || event.kind === 'RUN_HALTED');
  const terminal = events[terminalIndex];
  terminal.payload = {
    ...terminal.payload,
    finalState: current.afterState,
    finalStateDigest: canonicalDigest(current.afterState),
  };
  terminal.prevDigest = steps[1].event.digest;
  terminal.digest = digestEvent(terminal);
  events[terminalIndex] = terminal;
  await writeFile(eventsPath, `${events.map(canonicalJson).join('\n')}\n`);

  const endPath = path.join(runPath, 'end.json');
  const end = JSON.parse(await readFile(endPath, 'utf8'));
  delete end.selfDigest;
  end.finalEventDigest = terminal.digest;
  end.finalStateDigest = canonicalDigest(current.afterState);
  await writeFile(endPath, `${canonicalJson(withSelfDigest(end))}\n`);

  const currentPath = path.join(lab, 'state', 'current.json');
  const currentState = JSON.parse(await readFile(currentPath, 'utf8'));
  delete currentState.selfDigest;
  currentState.changeSupervisor = legacySupervisor;
  currentState.eventsDigest = terminal.digest;
  await writeFile(currentPath, `${canonicalJson(withSelfDigest(currentState))}\n`);
}

function withoutHistoryAccumulator(memory) {
  const { historyAccumulator: _ignored, lastVerifiedSteps: _ignoredFreshness, ...withoutAccumulator } = memory;
  return {
    ...withoutAccumulator,
    ...(memory.contextModels === undefined ? {} : {
      contextModels: Object.fromEntries(
        Object.entries(memory.contextModels).filter(([contextKey]) => !contextKey.startsWith('h2:')),
      ),
    }),
    ...(memory.pendingCredits === undefined ? {} : {
      pendingCredits: memory.pendingCredits.map((credit) => {
        if (credit.contextKeys === undefined) return credit;
        const { contextKeys: _ignoredKeys, ...withoutContextKeys } = credit;
        const legacyContextKey = credit.contextKeys.find((contextKey) => contextKey.startsWith('h1:'));
        if (legacyContextKey === undefined) {
          const { contextKey: _ignoredPrimary, ...withoutPrimaryContextKey } = withoutContextKeys;
          return withoutPrimaryContextKey;
        }
        return { ...withoutContextKeys, contextKey: legacyContextKey };
      }),
    }),
  };
}

function withoutModelAge(memory) {
  const withoutAge = { ...memory };
  delete withoutAge.modelClock;
  delete withoutAge.modelAges;
  const stripTopLevel = (models) => Object.fromEntries(Object.entries(models ?? {}).map(([key, model]) => {
    const { modelAge: _ignored, ...legacyModel } = model;
    return [key, legacyModel];
  }));
  const stripNested = (models) => Object.fromEntries(Object.entries(models ?? {}).map(([outerKey, nested]) => [
    outerKey,
    stripTopLevel(nested),
  ]));
  withoutAge.actionModels = stripTopLevel(memory.actionModels);
  if (memory.relationModels !== undefined) withoutAge.relationModels = stripNested(memory.relationModels);
  if (memory.rejectionModels !== undefined) withoutAge.rejectionModels = stripTopLevel(memory.rejectionModels);
  if (memory.beliefModels !== undefined) withoutAge.beliefModels = stripNested(memory.beliefModels);
  if (memory.contextModels !== undefined) withoutAge.contextModels = stripNested(memory.contextModels);
  return withoutAge;
}

function decodeStoredEvent(event) {
  return {
    ...event,
    payload: JSON.parse(inflateRawSync(Buffer.from(event.payload, 'base64')).toString('utf8')),
  };
}

function encodeStoredEvent(event) {
  return {
    ...event,
    payload: deflateRawSync(Buffer.from(canonicalJson(event.payload), 'utf8'), { level: 6 }).toString('base64'),
  };
}

function digestEvent(event) {
  const unsigned = { ...event };
  delete unsigned.digest;
  return canonicalDigest(unsigned);
}

async function countLedgerSteps(lab, runId) {
  try {
    const raw = await readFile(path.join(lab, 'runs', runId, 'events.jsonl'), 'utf8');
    return raw.trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter((event) => event.kind === 'STEP').length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function firstStepToken(lab, runId) {
  const raw = await readFile(path.join(lab, 'runs', runId, 'events.jsonl'), 'utf8');
  const step = raw.trim().split(/\r?\n/u).map(JSON.parse).find((event) => event.kind === 'STEP');
  return decodeStoredEvent(step).payload.choice.token;
}

function parseOutput(value) {
  if (value.trim() === '') return [];
  return value.trim().split(/\r?\n/u).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-e2e-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
