import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { canonicalDigest, canonicalJson, withSelfDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY, verifyAttestation } from '../fixtures/ed25519-proof.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER_FIXTURE = path.resolve('test/fixtures/generated-world-adapter.mjs');

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

    const run = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '2', '--json');
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
  for (const mode of ['nonzero', 'pollution', 'timeout', 'invalid-response']) {
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

test('CLI rejects external state and observation contract violations before STEP', async () => {
  for (const mode of ['bad-state-version', 'bad-observation-dimensions']) {
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

async function invoke(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ code: null, timedOut: true, stdout: parseOutput(stdout), stderr });
    }, 5000);
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

async function writeAdapterConfig(root, args = []) {
  const suffix = (args.join('-') || 'valid').replace(/[^a-z0-9_-]/giu, '_');
  const config = path.join(root, `adapter-${suffix}.json`);
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER_FIXTURE, ...args],
    adapterId: 'generated-adapter-v1',
    worldId: 'generated',
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
