import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');
const FIXTURE = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');

test('a non-idempotent WorldPort reconciles an applied effect without executing transition again', async () => {
  await withTemporaryLab(async ({ root, lab }) => {
    const effectFile = path.join(root, 'applied-effect.json');
    const adapter = await writeAdapter(root, effectFile, 'APPLIED', ['--two-actions']);
    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'reconcile-applied', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const lost = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--kernel-only', '--goal', '完成一个可重放目标', '--json']);
    assert.notEqual(lost.code, 0, 'the first transition response must be lost');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0].data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'reconciliation must not call non-idempotent transition again');

    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'Replay must not execute or reconcile an external effect');
  });
});

for (const status of ['ABSENT', 'UNKNOWN']) {
  test(`a non-idempotent WorldPort remains halted when reconciliation returns ${status}`, async () => {
    await withTemporaryLab(async ({ root, lab }) => {
      const effectFile = path.join(root, `${status.toLowerCase()}-effect.json`);
      const adapter = await writeAdapter(root, effectFile, status);
      const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', `reconcile-${status.toLowerCase()}`, '--adapter', adapter, '--json']);
      assert.equal(init.code, 0, JSON.stringify(init));

      const lost = await invoke(['run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
      assert.notEqual(lost.code, 0);
      assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
      const blocked = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
      assert.notEqual(blocked.code, 0, `${status} must not be treated as a successful recovery`);
      assert.equal(blocked.stdout[0]?.error?.code, 'CONFLICT', JSON.stringify(blocked));
      assert.match(blocked.stdout[0]?.error?.message ?? '', new RegExp(`could not be reconciled: ${status}`));
      assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, `${status} must not trigger a blind transition retry`);
      assert.equal(await countSteps(lab, 'run-2'), 0, `${status} must not append a STEP`);
    });
  });
}

test('a reconcilable non-idempotent WorldPort survives loop restart and replays every completed Run', async () => {
  await withTemporaryLab(async ({ root, lab }) => {
    const effectFile = path.join(root, 'loop-effect.json');
    const adapter = await writeAdapter(root, effectFile, 'APPLIED', ['--two-actions']);
    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'reconcile-loop', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const lost = await invoke([
      'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '3', '--scenario', 'idempotent', '--kernel-only', '--adapter', adapter, '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the first loop Run must lose its transition response');
    let firstEffect;
    try {
      firstEffect = JSON.parse(await readFile(effectFile, 'utf8'));
    } catch (error) {
      assert.fail(`${JSON.stringify(lost)}; ${error.message}`);
    }
    assert.equal(firstEffect.effectCount, 1);

    const resumed = await invoke([
      'agent', 'loop', '--lab', lab, '--resume', '--kernel-only', '--adapter', adapter, '--json',
    ]);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0]?.data?.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 3, 'the reconciled first effect and two later effects must each occur once');

    const runIds = await readdir(path.join(lab, 'runs'));
    assert.equal(runIds.length, 4, JSON.stringify(runIds));
    const completedRunIds = [];
    for (const runId of runIds) {
      const events = (await readFile(path.join(lab, 'runs', runId, 'events.jsonl'), 'utf8'))
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      if (events.at(-1)?.payload?.terminalStatus !== 'COMPLETED') continue;
      completedRunIds.push(runId);
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapter, '--json']);
      assert.equal(replay.code, 0, `${runId} replay: ${JSON.stringify(replay)}`);
      assert.equal(replay.stdout[0]?.data?.verdict, 'CONSISTENT', `${runId} replay must remain consistent`);
    }
    assert.equal(completedRunIds.length, 3, JSON.stringify(completedRunIds));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 3, 'Replay must not execute or reconcile an external effect');
  });
});

test('a force-killed reconcilable non-idempotent loop recovers explicitly before resuming', async () => {
  await withTemporaryLab(async ({ root, lab }) => {
    const effectFile = path.join(root, 'force-kill-effect.json');
    const releaseFile = path.join(root, 'release-response');
    const adapter = await writeAdapter(root, effectFile, 'APPLIED', [
      '--two-actions', '--hold-response', '--release-file', releaseFile,
    ]);
    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'reconcile-force-kill', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const killed = await invokeUntilEffectThenKill([
      'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '3', '--scenario', 'idempotent', '--kernel-only', '--adapter', adapter, '--json',
    ], effectFile, releaseFile);
    assert.notEqual(killed.code, 0, 'the host process must be killed while the external response is withheld');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const recovered = await invoke(['recover', '--lab', lab, '--confirm-lock-owner-dead', '--json']);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    assert.equal(recovered.stdout[0]?.data?.reason, 'EXTERNAL_TRANSITION_UNKNOWN');

    const resumed = await invoke(['agent', 'loop', '--lab', lab, '--resume', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0]?.data?.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 3);
  });
});

test('concurrent resumes of one reconcilable non-idempotent loop cannot duplicate effects or logical Runs', async () => {
  await withTemporaryLab(async ({ root, lab }) => {
    const effectFile = path.join(root, 'concurrent-effect.json');
    const adapter = await writeAdapter(root, effectFile, 'APPLIED', ['--two-actions']);
    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'reconcile-concurrent', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const lost = await invoke([
      'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '3', '--scenario', 'idempotent', '--kernel-only', '--adapter', adapter, '--json',
    ]);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    const resumes = await Promise.all([
      invoke(['agent', 'loop', '--lab', lab, '--resume', '--kernel-only', '--adapter', adapter, '--json']),
      invoke(['agent', 'loop', '--lab', lab, '--resume', '--kernel-only', '--adapter', adapter, '--json']),
    ]);
    assert.ok(resumes.some((result) => result.code === 0 && result.stdout[0]?.data?.status === 'COMPLETED'), JSON.stringify(resumes));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 3, 'concurrent resumes must keep exactly one effect per logical Run');
    const runIds = await readdir(path.join(lab, 'runs'));
    assert.equal(runIds.length, 4, JSON.stringify(runIds));
  });
});

async function writeAdapter(root, effectFile, reconciliationStatus, fixtureArgs = []) {
  const wrapper = path.join(root, `reconciliation-${reconciliationStatus.toLowerCase()}.mjs`);
  await writeFile(wrapper, reconciliationAdapterSource());
  const config = path.join(root, `${reconciliationStatus.toLowerCase()}-adapter.json`);
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [wrapper, FIXTURE, '--effect-file', effectFile, ...fixtureArgs, '--reconciliation-status', reconciliationStatus],
    adapterId: 'idempotent-transition-adapter-v1',
    worldId: 'idempotent-transition',
    timeoutMs: 10_000,
  }));
  return config;
}

function reconciliationAdapterSource() {
  return `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const fixture = process.argv[2];
const status = process.argv[process.argv.indexOf('--reconciliation-status') + 1];
const requestText = readFileSync(0, 'utf8');
const request = JSON.parse(requestText);
if (request.op === 'reconcile' && status !== 'APPLIED') {
  process.stdout.write(JSON.stringify({
    protocol: 'yi-world-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { status },
  }) + '\\n');
  process.exit(0);
}
const result = spawnSync(process.execPath, [
  fixture,
  ...process.argv.slice(3, process.argv.indexOf('--reconciliation-status')),
  '--non-idempotent',
  '--reconcilable',
  '--drop-response',
], {
  input: requestText,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
process.stdout.write(result.stdout ?? '');
process.exit(result.status ?? 17);
`;
}

async function withTemporaryLab(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-reconciliation-e2e-'));
  try {
    await callback({ root, lab: path.join(root, 'lab') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function invoke(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, timedOut: true, stdout: parseJsonLines(stdout), stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout: parseJsonLines(stdout), stderr });
    });
  });
}

async function countSteps(lab, runId) {
  try {
    const ledger = await readFile(path.join(lab, 'runs', runId, 'events.jsonl'), 'utf8');
    return ledger.trim() === '' ? 0 : ledger.trim().split(/\r?\n/u).filter((line) => JSON.parse(line).kind === 'STEP').length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function parseJsonLines(value) {
  return value.trim() === '' ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

function invokeUntilEffectThenKill(args, effectFile, releaseFile, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
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
      reject(new Error('timed out waiting for the external effect'));
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
      resolve({ code, stdout: parseJsonLines(stdout), stderr });
    });
    waitForEffect(effectFile, timeoutMs)
      .then(() => {
        if (settled) return;
        child.kill();
        writeFile(releaseFile, 'release-response')
          .then(() => undefined)
          .catch(reject);
      })
      .catch(reject);
  });
}

async function waitForEffect(effectFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(await readFile(effectFile, 'utf8')).effectCount === 1) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the external effect');
}
