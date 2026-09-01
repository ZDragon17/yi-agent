import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');
const DURABLE_ADAPTER = path.resolve('test/fixtures/durable-counter-world-adapter.mjs');

test('built-in WorldPorts keep a multi-Run kernel-only loop inspectable and replayable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-durability-matrix-'));
  const environment = kernelOnlyEnvironment();
  const worlds = [
    { id: 'temperature', seed: 'durability-temperature' },
    { id: 'inventory', seed: 'durability-inventory' },
    { id: 'queue', seed: 'durability-queue' },
  ];

  try {
    for (const world of worlds) {
      const lab = path.join(root, world.id, 'lab');
      const init = await invoke([
        'init', '--lab', lab, '--world', world.id, '--seed', world.seed, '--json',
      ], environment);
      assert.equal(init.code, 0, `${world.id} init: ${describeResult(init)}`);
      assert.equal(init.stdout[0]?.data?.worldId, world.id, `${world.id} init must bind its WorldPort`);

      const loop = await invoke([
        'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--kernel-only', '--json',
      ], environment);
      assert.equal(loop.code, 0, `${world.id} loop: ${describeResult(loop)}`);
      const loopData = loop.stdout[0]?.data;
      assert.equal(loopData?.status, 'COMPLETED', `${world.id} loop must complete`);
      assert.equal(loopData?.runs, 2, `${world.id} loop must commit two Runs`);
      assert.equal(loopData?.metrics?.executed, 2, `${world.id} loop must execute two Runs`);
      assert.equal(loopData?.results?.length, 2, `${world.id} loop must report both Runs`);
      assert.equal(new Set(loopData.results.map((result) => result.runId)).size, 2, `${world.id} Run IDs must be unique`);

      const inspection = await invoke(['inspect', '--lab', lab, '--json'], environment);
      assert.equal(inspection.code, 0, `${world.id} inspect: ${describeResult(inspection)}`);
      assert.equal(inspection.stdout[0]?.data?.current?.kernelStep, 2, `${world.id} inspect must see both steps`);
      assert.equal(
        inspection.stdout[0]?.data?.current?.lastRunId,
        loopData.results[1].runId,
        `${world.id} inspect must point at the last committed Run`,
      );

      for (const result of loopData.results) {
        const replay = await invoke([
          'replay', '--lab', lab, '--run', result.runId, '--json',
        ], environment);
        assert.equal(replay.code, 0, `${world.id}/${result.runId} replay: ${describeResult(replay)}`);
        assert.equal(
          replay.stdout[0]?.data?.verdict,
          'CONSISTENT',
          `${world.id}/${result.runId} replay must be consistent`,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('durable-counter survives a lost response across recover, resume, and replay without duplicate effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-durable-counter-'));
  const lab = path.join(root, 'lab');
  const stateFile = path.join(root, 'world', 'state.json');
  const adapter = path.join(root, 'adapter.json');
  const responseLossAdapter = path.join(root, 'response-loss-adapter.mjs');
  const lossMarker = path.join(root, 'response-lost.marker');
  const releaseFile = path.join(root, 'response-loss.release');
  const environment = kernelOnlyEnvironment();

  await writeFile(responseLossAdapter, responseLossAdapterSource());
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [responseLossAdapter, DURABLE_ADAPTER, '--state-file', stateFile, '--loss-marker', lossMarker, '--release-file', releaseFile],
    adapterId: 'durable-counter-adapter-v1',
    worldId: 'durable-counter',
    timeoutMs: 10_000,
  }));

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'durable-counter', '--seed', 'durability-external',
      '--adapter', adapter, '--json',
    ], environment);
    assert.equal(init.code, 0, `durable-counter init: ${describeResult(init)}`);

    const lost = await invokeUntilExternalEffectThenKill([
      'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--kernel-only',
      '--adapter', adapter, '--json',
    ], environment, stateFile, lossMarker, releaseFile);
    assert.notEqual(lost.code, 0, `response loss must prevent the original process from claiming success: ${describeResult(lost)}`);
    assert.equal(lost.timedOut, false, `response-loss process timed out: ${describeResult(lost)}`);

    const afterLoss = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(afterLoss.value, 1, 'the external effect must be durable before its response is lost');
    assert.equal(afterLoss.effects.length, 1, 'the lost response must correspond to one external effect');
    assert.equal(await readFile(lossMarker, 'utf8'), 'response-lost');

    const recovered = await invoke([
      'recover', '--lab', lab, '--confirm-lock-owner-dead', '--json',
    ], environment);
    assert.equal(recovered.code, 0, `recover: ${describeResult(recovered)}`);
    assert.equal(recovered.stdout[0]?.data?.reason, 'EXTERNAL_TRANSITION_UNKNOWN');

    const resumed = await invoke([
      'agent', 'loop', '--lab', lab, '--resume', '--kernel-only', '--adapter', adapter, '--json',
    ], environment);
    assert.equal(resumed.code, 0, `resume: ${describeResult(resumed)}`);
    assert.equal(resumed.stdout[0]?.data?.status, 'COMPLETED');
    assert.equal(resumed.stdout[0]?.data?.runs, 2, 'resume must finish the original two-Run loop budget');

    const afterResume = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(afterResume.value, 2, 'resume must apply only the remaining external effect');
    assert.equal(afterResume.effects.length, 2, 'resume must not duplicate the response-lost effect');

    const inspection = await invoke([
      'inspect', '--lab', lab, '--adapter', adapter, '--json',
    ], environment);
    assert.equal(inspection.code, 0, `external inspect: ${describeResult(inspection)}`);
    assert.equal(inspection.stdout[0]?.data?.current?.kernelStep, 2);
    assert.equal(inspection.stdout[0]?.data?.current?.worldState?.value, 2);

    for (const result of resumed.stdout[0].data.results) {
      const replay = await invoke([
        'replay', '--lab', lab, '--run', result.runId, '--adapter', adapter, '--json',
      ], environment);
      assert.equal(replay.code, 0, `${result.runId} replay: ${describeResult(replay)}`);
      assert.equal(replay.stdout[0]?.data?.verdict, 'CONSISTENT', `${result.runId} replay must be consistent`);
    }

    const afterReplay = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(afterReplay.value, 2, 'replay must not change the external state');
    assert.equal(afterReplay.effects.length, 2, 'replay must not execute an external effect');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function kernelOnlyEnvironment() {
  const environment = { ...process.env };
  delete environment.YI_AGENT_API_KEY;
  delete environment.ZAI_API_KEY;
  delete environment.YI_AGENT_MODEL;
  return environment;
}

function responseLossAdapterSource() {
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const fixture = process.argv[2];
const stateFile = process.argv[process.argv.indexOf('--state-file') + 1];
const lossMarker = process.argv[process.argv.indexOf('--loss-marker') + 1];
const releaseFile = process.argv[process.argv.indexOf('--release-file') + 1];
const requestText = readFileSync(0, 'utf8');
const request = JSON.parse(requestText);
const result = spawnSync(process.execPath, [fixture, '--state-file', stateFile], {
  input: requestText,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

if (request.op === 'transition' && !existsSync(lossMarker) && result.status === 0) {
  writeFileSync(lossMarker, 'response-lost');
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (existsSync(releaseFile) || Date.now() >= deadline) {
      clearInterval(timer);
      process.exit(17);
    }
  }, 25);
} else {
  process.stdout.write(result.stdout ?? '');
  process.exit(result.status ?? 17);
}
`;
}

function invoke(args, environment, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout: parseJsonLines(stdout), stderr });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code, timedOut: false, stdout: parseJsonLines(stdout), stderr });
    });
  });
}

async function invokeUntilExternalEffectThenKill(args, environment, stateFile, lossMarker, releaseFile, timeoutMs = 10_000) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  await waitFor(async () => {
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.effects?.length !== 1) return false;
      await readFile(lossMarker, 'utf8');
      return true;
    } catch {
      return false;
    }
  }, timeoutMs, 'durable external effect');

  assert.equal(child.kill(), true, 'the first CLI process must be terminable while the response is withheld');
  await writeFile(releaseFile, 'release-response-loss');
  const closed = await waitForClose(child, timeoutMs);
  return {
    code: closed.code,
    timedOut: false,
    stdout: parseJsonLines(stdout),
    stderr,
  };
}

function parseJsonLines(value) {
  return value.trim() === '' ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

function describeResult(result) {
  return JSON.stringify({
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code, signal });
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not become observable within ${timeoutMs}ms`);
}
