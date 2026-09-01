import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/history-conditioned-world-adapter.mjs');
const DELAYED_ADAPTER = path.resolve('test/fixtures/history-delayed-world-adapter.mjs');

test('history evidence changes the target action without exposing hidden mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-history-conditioned-e2e-'));
  const stateFile = path.join(root, 'world', 'state.json');
  const adapter = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const currentTokens = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages[0].content;
    const step = Number(/"step":(\d+)/u.exec(prompt)?.[1] ?? -1);
    const forced = new Map([
      [2, 'target-a'],
      [6, 'target-a'],
      [10, 'target-b'],
      [14, 'target-b'],
      [18, 'target-a'],
    ]);
    const capability = forced.get(step);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'history-conditioned-advisor',
      model: 'history-conditioned-model',
      choices: [{ message: { content: JSON.stringify({ token: capability === undefined ? null : currentTokens.get(capability) ?? null }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--state-file', stateFile],
    adapterId: 'history-conditioned-adapter-v1',
    worldId: 'history-conditioned',
    timeoutMs: 2000,
  }));

  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'history-conditioned', '--seed', 'history-conditioned-seed', '--lab-id', 'history-conditioned-lab', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const manifest = init.stdout[0].data;
    const tokens = Object.fromEntries(manifest.tokenMap.entries.map((entry) => [entry.capabilityId, entry.token]));
    currentTokens.set('target-a', tokens['history-conditioned.target-a']);
    currentTokens.set('target-b', tokens['history-conditioned.target-b']);
    const env = {
      ...process.env,
      YI_AGENT_API_KEY: 'history-conditioned-secret',
      YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      YI_AGENT_MODEL: 'history-conditioned-model',
    };
    const result = await invoke(['agent', 'run', '--lab', lab, '--steps', '28', '--adapter', adapter, '--json'], env);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout[0].data.status, 'COMPLETED');
    assert.equal(result.stdout[0].data.metrics.executed, 28);

    const store = await LabStore.open({ labPath: lab });
    const run = await store.readRun(result.stdout[0].data.runId);
    assert.equal(run.events.filter((event) => event.kind === 'STEP').length, 28);
    const targetSteps = run.events
      .filter((event) => event.kind === 'STEP' && [tokens['history-conditioned.target-a'], tokens['history-conditioned.target-b']].includes(event.payload.choice.token));
    assert.deepEqual(targetSteps.map((event) => event.payload.choice.token), [
      tokens['history-conditioned.target-a'],
      tokens['history-conditioned.target-a'],
      tokens['history-conditioned.target-b'],
      tokens['history-conditioned.target-b'],
      tokens['history-conditioned.target-a'],
      tokens['history-conditioned.target-a'],
      tokens['history-conditioned.target-b'],
    ]);
    assert.deepEqual(targetSteps.map((event) => event.payload.postObservation.vector), [[1], [1], [1], [-1], [-1], [1], [1]]);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).effects.length, 28);

    const replay = await invoke(['replay', '--lab', lab, '--run', result.stdout[0].data.runId, '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('delayed feedback keeps recent history in action order across CLI restart and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-history-delayed-e2e-'));
  const adapter = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [DELAYED_ADAPTER],
    adapterId: 'history-delayed-adapter-v1',
    worldId: 'history-delayed',
    timeoutMs: 2000,
  }));

  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'history-delayed', '--seed', 'history-delayed-seed', '--lab-id', 'history-delayed-lab', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const result = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '3', '--scenario', 'delayed-history', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout[0].data.status, 'COMPLETED');

    const store = await LabStore.open({ labPath: lab });
    const run = await store.readRun(result.stdout[0].data.runId);
    const steps = run.events.filter((event) => event.kind === 'STEP');
    assert.deepEqual(steps.map((event) => event.payload.update.status), ['DEFERRED', 'UPDATED', 'SKIPPED']);
    assert.equal(steps[2].payload.update.settled[0].attribution, 'ACTION');
    assert.deepEqual(steps[2].payload.afterState.memory.recentHistory.map((entry) => entry.token), [
      steps[0].payload.choice.token,
      steps[1].payload.choice.token,
    ]);
    assert.equal(steps[2].payload.afterState.memory.historyClock, 2);

    const replay = await invoke(['replay', '--lab', lab, '--run', result.stdout[0].data.runId, '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');

    const continued = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'delayed-history', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(continued.code, 0, JSON.stringify(continued));
    assert.equal(continued.stdout[0].data.status, 'COMPLETED');
    assert.equal((await LabStore.open({ labPath: lab })).manifest.worldId, 'history-delayed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: stdout.trim() === '' ? [] : stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line)),
      stderr,
    }));
  });
}
