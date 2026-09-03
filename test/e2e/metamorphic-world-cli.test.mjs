import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/metamorphic-world-adapter.mjs');

test('application remains equivalent across a coordinate-permuted WorldPort after process restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-metamorphic-e2e-'));
  try {
    const identityAdapter = await writeAdapterConfig(root, 'identity');
    const reverseAdapter = await writeAdapterConfig(root, 'reverse', ['--reverse']);
    const identityLab = path.join(root, 'identity-lab');
    const reverseLab = path.join(root, 'reverse-lab');

    for (const [lab, adapter] of [[identityLab, identityAdapter], [reverseLab, reverseAdapter]]) {
      const init = await invoke('init', '--lab', lab, '--lab-id', 'metamorphic-lab', '--world', 'metamorphic', '--seed', 'metamorphic-seed', '--adapter', adapter, '--json');
      assert.equal(init.code, 0, `${lab}: init`);
      const first = await invoke('run', '--lab', lab, '--run-id', 'run-1', '--steps', '4', '--adapter', adapter, '--json');
      assert.equal(first.code, 0, `${lab}: first run ${JSON.stringify(first)}`);
      const second = await invoke('run', '--lab', lab, '--run-id', 'run-2', '--steps', '4', '--adapter', adapter, '--json');
      assert.equal(second.code, 0, `${lab}: second run`);
    }

    const identity = (await invoke('inspect', '--lab', identityLab, '--adapter', identityAdapter, '--json')).stdout[0].data;
    const reverse = (await invoke('inspect', '--lab', reverseLab, '--adapter', reverseAdapter, '--json')).stdout[0].data;
    assert.deepEqual(project(identity, false), project(reverse, true));

    for (const [lab, adapter] of [[identityLab, identityAdapter], [reverseLab, reverseAdapter]]) {
      for (const run of ['run-1', 'run-2']) {
        const replay = await invoke('replay', '--lab', lab, '--run', run, '--adapter', adapter, '--json');
        assert.equal(replay.code, 0, `${lab}/${run}: replay`);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT', `${lab}/${run}: replay verdict`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeAdapterConfig(root, name, args = []) {
  const config = path.join(root, `${name}-adapter.json`);
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, ...args],
    adapterId: 'metamorphic-adapter-v1',
    worldId: 'metamorphic',
    timeoutMs: 30000,
  }));
  return config;
}

async function invoke(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
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

function project(data, reversed) {
  const current = data.current;
  const models = projectModels(current.memory.actionModels, reversed);
  const relationModels = Object.fromEntries(
    Object.entries(current.memory.relationModels).map(([token, relations]) => [
      token,
      Object.fromEntries(Object.entries(relations).map(([key, model]) => [logicalRelationKey(key, reversed), projectModel(model, reversed)])),
    ]),
  );
  const supervisor = current.changeSupervisor;
  return {
    kernelStep: current.kernelStep,
    worldVector: logicalVector(current.worldState.vector, reversed),
    memory: { actionModels: models, relationModels },
    supervisor: {
      cycle: supervisor.cycle,
      bestDistance: supervisor.bestDistance,
      stagnation: supervisor.stagnation,
      replanCount: supervisor.replanCount,
      strategy: supervisor.strategy,
      objective: {
        observationDimensions: supervisor.objective.observationDimensions,
        weights: logicalVector(supervisor.objective.weights, reversed),
        target: logicalVector(supervisor.objective.target, reversed),
      },
    },
  };
}

function projectModels(models, reversed) {
  return Object.fromEntries(Object.entries(models).map(([token, model]) => [token, projectModel(model, reversed)]));
}

function projectModel(model, reversed) {
  return { ...model, meanDelta: logicalVector(model.meanDelta, reversed) };
}

function logicalVector(vector, reversed) {
  return reversed ? [...vector].reverse() : [...vector];
}

function logicalRelationKey(key, reversed) {
  if (!reversed) return key;
  const [prefix, signs] = key.split(':');
  return `${prefix}:${[...signs].reverse().join('')}`;
}
