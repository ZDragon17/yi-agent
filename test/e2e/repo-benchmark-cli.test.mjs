import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');

test('RTA-1 canonical Node repository completes the first autonomous repair task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-single-task-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/manifest.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const task = manifest.tasks[0];
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, {
      [task.goal]: task.expected.files['src/math.mjs'],
    });
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout[0].data.status, 'PASS', JSON.stringify(result));
    assert.equal(result.stdout[0].data.taskResults[0].replayVerdict, 'CONSISTENT');
    assert.equal(
      await readFile(path.join(result.stdout[0].data.taskResults[0].repositoryPath, 'src/math.mjs'), 'utf8'),
      task.expected.files['src/math.mjs'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 T1 profile persists bounded cross-task experience without sharing repositories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-t1-experience-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/manifest.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const task = manifest.tasks[0];
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, {
      [task.goal]: task.expected.files['src/math.mjs'],
    });
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--learning-profile', 't1', '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const report = result.stdout[0].data;
    assert.equal(report.learningProfile, 't1');
    assert.equal(report.experience.entries.length, 1);
    assert.equal(report.experience.entries[0].taskId, task.id);
    assert.equal(new Set(report.taskResults.map((item) => item.repositoryPath)).size, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(outputPath, 'experience.json'), 'utf8')), report.experience);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 T1 experience improves a bounded cross-task workflow against T0', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-t0-t1-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/baseline-6.json');
  const modelPath = path.join(root, 'experience-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(modelPath, experienceAwareModelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, Object.fromEntries(
      manifest.tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']]),
    ));
    const runProfile = (profile) => invoke([
      'repo', 'benchmark', '--manifest', manifestPath,
      '--output', path.join(root, profile), '--model-adapter', modelConfigPath,
      '--learning-profile', profile, '--json',
    ]);
    const [t0, t1] = await Promise.all([runProfile('t0'), runProfile('t1')]);
    assert.equal(t0.code, 2, JSON.stringify(t0));
    assert.equal(t1.code, 0, JSON.stringify(t1));
    const t0Report = t0.stdout[0].data;
    const t1Report = t1.stdout[0].data;
    assert.equal(t0Report.taskResults.filter((task) => task.status === 'PASS').length, 1);
    assert.equal(t1Report.taskResults.filter((task) => task.status === 'PASS').length, 6);
    assert.equal(t1Report.experience.entries.length, 6);
    assert.equal(new Set(t1Report.taskResults.map((task) => task.repositoryPath)).size, 6);
    assert.ok(t1Report.experience.entries.every((entry) => entry.replayVerdict === 'CONSISTENT'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 T1 long-run corpus meets the fixed eight-task floor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-t1-long-run-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/long-run-12.json');
  const modelPath = path.join(root, 'experience-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(modelPath, experienceAwareModelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, Object.fromEntries(
      manifest.tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']]),
    ));
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--learning-profile', 't1', '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const report = result.stdout[0].data;
    const passed = report.taskResults.filter((task) => task.status === 'PASS');
    assert.ok(passed.length >= 8, `T1 completed ${passed.length}/12 tasks`);
    assert.equal(passed.length, 12);
    assert.equal(report.experience.entries.length, 12);
    assert.ok(passed.every((task) => task.replayVerdict === 'CONSISTENT'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 six-task baseline keeps each repository isolated and replayable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-baseline-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/baseline-6.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, Object.fromEntries(
      manifest.tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']]),
    ));
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const report = result.stdout[0].data;
    assert.equal(report.status, 'PASS');
    assert.deepEqual(report.taskResults.map((task) => task.status), Array(6).fill('PASS'));
    assert.deepEqual(report.taskResults.map((task) => task.replayVerdict), Array(6).fill('CONSISTENT'));
    assert.deepEqual(report.taskResults.map((task) => task.metrics.testExecutions), Array(6).fill(2));
    assert.deepEqual(report.taskResults.map((task) => task.metrics.operatorIntervention), Array(6).fill(false));
    assert.equal(new Set(report.taskResults.map((task) => task.repositoryPath)).size, 6);
    for (const task of manifest.tasks) {
      const resultForTask = report.taskResults.find((item) => item.id === task.id);
      assert.equal(
        await readFile(path.join(resultForTask.repositoryPath, 'src/math.mjs'), 'utf8'),
        task.expected.files['src/math.mjs'],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 twelve-task corpus completes through the bounded public loop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-long-run-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/long-run-12.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, Object.fromEntries(
      manifest.tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']]),
    ));
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const report = result.stdout[0].data;
    assert.equal(report.status, 'PASS');
    assert.equal(report.taskResults.length, 12);
    assert.deepEqual(report.taskResults.map((task) => task.status), Array(12).fill('PASS'));
    assert.deepEqual(report.taskResults.map((task) => task.replayVerdict), Array(12).fill('CONSISTENT'));
    assert.equal(new Set(report.taskResults.map((task) => task.repositoryPath)).size, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 twelve-task benchmark resumes after three forced process kills', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-three-kills-e2e-'));
  const manifestPath = path.resolve('examples/rta-1/long-run-12.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  const reportPath = path.join(outputPath, 'report.json');
  let activeChild = null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, Object.fromEntries(
      manifest.tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']]),
    ), undefined, undefined, 150);
    const benchmarkArgs = [
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--learning-profile', 't1', '--json',
    ];

    activeChild = spawnBenchmarkProcess(benchmarkArgs);
    for (const [completedBeforeKill, resumeUntil] of [[3, 6], [6, 9], [9, 12]]) {
      await waitForTaskCount(reportPath, completedBeforeKill);
      await sleep(250);
      const killed = await killProcessTree(activeChild);
      assert.notEqual(killed.code, 0, `forced kill ${completedBeforeKill} must interrupt the benchmark`);
      activeChild = null;

      activeChild = spawnBenchmarkProcess([
        ...benchmarkArgs,
        '--resume',
      ]);
      await waitForTaskCount(reportPath, resumeUntil);
    }

    const completed = await waitForChild(activeChild);
    activeChild = null;
    assert.equal(completed.code, 0, `final resumed benchmark must pass: ${JSON.stringify(completed)}`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'PASS');
    assert.deepEqual(report.taskResults.map((task) => task.status), Array(12).fill('PASS'));
    assert.deepEqual(report.taskResults.map((task) => task.replayVerdict), Array(12).fill('CONSISTENT'));
    assert.equal(report.experience.entries.length, 12);
  } finally {
    if (activeChild !== null && activeChild.exitCode === null) await killProcessTree(activeChild);
    await rm(root, { recursive: true, force: true });
  }
});

test('RTA-1 benchmark rejects decision and test budgets above the fixed limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-rta-1-budget-boundary-e2e-'));
  const sourceManifest = JSON.parse(await readFile(path.resolve('examples/rta-1/manifest.json'), 'utf8'));
  const manifestPath = path.join(root, 'manifest.json');
  try {
    for (const [field, value] of [['steps', 25], ['maxTests', 5]]) {
      const manifest = structuredClone(sourceManifest);
      manifest.tasks[0][field] = value;
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
      const outputPath = path.join(root, `output-${field}`);
      const result = await invoke([
        'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
        '--model-adapter', path.join(root, 'missing-model.json'), '--json',
      ]);
      assert.equal(result.code, 64, JSON.stringify(result));
      assert.equal(result.stdout[0].error.code, 'INVALID_INPUT');
      await assert.rejects(() => readFile(path.join(outputPath, 'report.json')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo benchmark retains a passing test after a later observation step', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-benchmark-test-retention-e2e-'));
  const sourceManifest = JSON.parse(await readFile(path.resolve('examples/rta-1/manifest.json'), 'utf8'));
  const manifestPath = path.join(root, 'manifest.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const task = sourceManifest.tasks[0];
    task.steps = 6;
    await writeFile(manifestPath, JSON.stringify(sourceManifest), 'utf8');
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, {
      [task.goal]: task.expected.files['src/math.mjs'],
    }, undefined, task.goal);
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout[0].data.taskResults[0].acceptance.lastTestStatus, 'PASS');
    assert.equal(result.stdout[0].data.taskResults[0].metrics.testExecutions, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo benchmark continues from a patched but unverified Run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-benchmark-continuation-e2e-'));
  const sourceManifest = JSON.parse(await readFile(path.resolve('examples/rta-1/manifest.json'), 'utf8'));
  const manifestPath = path.join(root, 'manifest.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  try {
    const task = sourceManifest.tasks[0];
    task.steps = 4;
    await writeFile(manifestPath, JSON.stringify(sourceManifest), 'utf8');
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, {
      [task.goal]: task.expected.files['src/math.mjs'],
    });
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--learning-profile', 't1', '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const taskResult = result.stdout[0].data.taskResults[0];
    assert.equal(taskResult.status, 'PASS');
    assert.ok(taskResult.metrics.kernelSteps > task.steps);
    assert.ok(taskResult.metrics.kernelSteps <= 24);
    assert.ok(taskResult.metrics.testExecutions > 1);
    assert.ok(taskResult.metrics.testExecutions <= task.maxTests);
    assert.ok(taskResult.runIds.length > 1);
    assert.equal(taskResult.runIds.at(-1), taskResult.runId);
    assert.ok(result.stdout[0].data.experience.entries[0].workflow.length > task.steps);
    assert.equal(taskResult.replayVerdict, 'CONSISTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo benchmark selects a discovered patch target from an authorized candidate set', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-benchmark-dynamic-target-e2e-'));
  const manifestPath = path.join(root, 'manifest.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  const buggySource = 'export function target(left, right) { return left - right; }\n';
  const fixedSource = 'export function target(left, right) { return left + right; }\n';
  const decoySource = 'export function decoy() { return "untouched"; }\n';
  const task = {
    id: 'dynamic-target-task',
    goal: 'Find the failing target test, repair the discovered implementation, and verify it.',
    seed: 'dynamic-target-seed',
    files: [
      { path: 'package.json', content: '{"name":"dynamic-target-task","private":true,"type":"module"}\n' },
      { path: 'src/target.mjs', content: buggySource },
      { path: 'src/decoy.mjs', content: decoySource },
      {
        path: 'test/target.test.mjs',
        content: [
          "import assert from 'node:assert/strict';",
          "import { test } from 'node:test';",
          "import { target } from '../src/target.mjs';",
          '',
          "test('target returns the sum', () => assert.equal(target(2, 3), 5));",
          '',
        ].join('\n'),
      },
    ],
    readPath: 'src/target.mjs',
    testPath: 'test/target.test.mjs',
    patch: { allowedPaths: ['src/decoy.mjs', 'src/target.mjs'] },
    expected: { files: { 'src/target.mjs': fixedSource }, lastTestStatus: 'PASS' },
    steps: 5,
    maxTests: 4,
  };
  try {
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, type: 'repo-benchmark', tasks: [task] }), 'utf8');
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, { [task.goal]: fixedSource });
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const taskResult = result.stdout[0].data.taskResults[0];
    assert.equal(taskResult.status, 'PASS');
    assert.equal(taskResult.replayVerdict, 'CONSISTENT');
    assert.equal(await readFile(path.join(taskResult.repositoryPath, 'src/target.mjs'), 'utf8'), fixedSource);
    assert.equal(await readFile(path.join(taskResult.repositoryPath, 'src/decoy.mjs'), 'utf8'), decoySource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo benchmark runs isolated tasks through the public agent and replay boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-benchmark-e2e-'));
  const manifestPath = path.join(root, 'benchmark.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  const tasks = [
    createTask('add-task', 'task:add', 'export function add(left, right) { return left - right; }\n', 'export function add(left, right) { return left + right; }\n'),
    createTask('multiply-task', 'task:multiply', 'export function multiply(left, right) { return left / right; }\n', 'export function multiply(left, right) { return left * right; }\n'),
  ];
  try {
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, type: 'repo-benchmark', tasks }), 'utf8');
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeFile(modelConfigPath, JSON.stringify({
      executable: process.execPath,
      args: [modelPath, JSON.stringify(Object.fromEntries(tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']])) )],
      model: 'repo-benchmark-fixture',
      timeoutMs: 30000,
    }), 'utf8');

    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout.length, 1);
    assert.equal(result.stdout[0].ok, true, JSON.stringify(result));
    const report = result.stdout[0].data;
    assert.equal(report.status, 'PASS');
    assert.equal(report.taskResults.length, 2);
    assert.deepEqual(report.taskResults.map((task) => task.status), ['PASS', 'PASS']);
    assert.deepEqual(report.taskResults.map((task) => task.replayVerdict), ['CONSISTENT', 'CONSISTENT']);
    assert.notEqual(report.taskResults[0].repositoryPath, report.taskResults[1].repositoryPath);
    assert.equal(await readFile(path.join(report.taskResults[0].repositoryPath, 'src/math.mjs'), 'utf8'), tasks[0].expected.files['src/math.mjs']);
    assert.equal(await readFile(path.join(report.taskResults[1].repositoryPath, 'src/math.mjs'), 'utf8'), tasks[1].expected.files['src/math.mjs']);
    assert.deepEqual(JSON.parse(await readFile(path.join(outputPath, 'report.json'), 'utf8')), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo benchmark rejects a path escape before creating output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-benchmark-invalid-e2e-'));
  const manifestPath = path.join(root, 'benchmark.json');
  const outputPath = path.join(root, 'output');
  try {
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      type: 'repo-benchmark',
      tasks: [{
        id: 'escape',
        goal: 'task:escape',
        seed: 'escape-seed',
        files: [{ path: '../outside.mjs', content: 'export default 1;\n' }],
        readPath: '../outside.mjs',
        testPath: 'test/math.test.mjs',
        patch: { allowedPaths: ['../outside.mjs'] },
        expected: { files: {} },
      }],
    }), 'utf8');
    const result = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', path.join(root, 'missing-model.json'), '--json',
    ]);
    assert.equal(result.code, 64, JSON.stringify(result));
    assert.equal(result.stdout[0].ok, false);
    assert.equal(result.stdout[0].error.code, 'INVALID_INPUT');
    await assert.rejects(() => readFile(path.join(outputPath, 'report.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo benchmark resumes from task checkpoints without overwriting prior evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-benchmark-resume-e2e-'));
  const manifestPath = path.join(root, 'benchmark.json');
  const modelPath = path.join(root, 'benchmark-model.mjs');
  const modelConfigPath = path.join(root, 'model.json');
  const outputPath = path.join(root, 'output');
  const tasks = [
    createTask('add-task', 'task:add', 'export function add(left, right) { return left - right; }\n', 'export function add(left, right) { return left + right; }\n'),
    createTask('multiply-task', 'task:multiply', 'export function multiply(left, right) { return left / right; }\n', 'export function multiply(left, right) { return left * right; }\n'),
  ];
  tasks[1].steps = 1;
  tasks[1].expected.lastTestStatus = 'NOT_RUN';
  try {
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, type: 'repo-benchmark', tasks }), 'utf8');
    await writeFile(modelPath, modelSource(), 'utf8');
    await writeModelConfig(modelConfigPath, modelPath, {
      'task:add': tasks[0].expected.files['src/math.mjs'],
    }, 'task:multiply');
    const interrupted = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--json',
    ]);
    assert.equal(interrupted.code, 2, JSON.stringify(interrupted));
    const checkpoint = interrupted.stdout[0].data;
    assert.equal(checkpoint.status, 'FAIL');
    assert.equal(checkpoint.taskResults.find((task) => task.id === 'add-task').status, 'PASS');
    assert.equal(checkpoint.taskResults.find((task) => task.id === 'multiply-task').status, 'FAIL');

    await writeModelConfig(modelConfigPath, modelPath, Object.fromEntries(
      tasks.map((task) => [task.goal, task.expected.files['src/math.mjs']]),
    ), 'task:multiply');
    const resumed = await invoke([
      'repo', 'benchmark', '--manifest', manifestPath, '--output', outputPath,
      '--model-adapter', modelConfigPath, '--resume', '--json',
    ]);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    const report = resumed.stdout[0].data;
    assert.equal(report.status, 'PASS');
    assert.deepEqual(report.taskResults.map((task) => task.status), ['PASS', 'PASS']);
    assert.equal(report.taskResults[0].repositoryPath, checkpoint.taskResults[0].repositoryPath);
    assert.match(report.taskResults[1].repositoryPath, /attempt-2[\\/]repository$/u);
    assert.notEqual(report.taskResults[1].repositoryPath, checkpoint.taskResults[1].repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createTask(id, goal, buggySource, fixedSource) {
  return {
    id,
    goal,
    seed: `${id}-seed`,
    files: [
      { path: 'src/math.mjs', content: buggySource },
      {
        path: 'test/math.test.mjs',
        content: id.startsWith('add')
          ? [
              "import assert from 'node:assert/strict';",
              "import { test } from 'node:test';",
              "import { add } from '../src/math.mjs';",
              "test('add returns the sum', () => assert.equal(add(2, 3), 5));",
              '',
            ].join('\n')
          : [
              "import assert from 'node:assert/strict';",
              "import { test } from 'node:test';",
              "import { multiply } from '../src/math.mjs';",
              "test('multiply returns the product', () => assert.equal(multiply(2, 3), 6));",
              '',
            ].join('\n'),
      },
    ],
    readPath: 'src/math.mjs',
    testPath: 'test/math.test.mjs',
    patch: { allowedPaths: ['src/math.mjs'] },
    expected: { files: { 'src/math.mjs': fixedSource }, lastTestStatus: 'PASS' },
    maxTests: 4,
    steps: 5,
  };
}

function modelSource() {
  return [
    "import readline from 'node:readline';",
    'const replacements = JSON.parse(process.argv[2]);',
    'const defaultSequence = [\'repo.list-files\', \'repo.read-file\', \'repo.run-tests\', \'repo.apply-patch\', \'repo.run-tests\'];',
    'const fastGoal = process.argv[3] || null;',
    'const trailingGoal = process.argv[4] || null;',
    'const delayMs = Number(process.argv[5] ?? \'0\');',
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'rl.on(\'line\', (line) => {',
    '  const request = JSON.parse(line);',
    '  const prompt = request.payload?.prompt ?? \'\';',
    '  const context = JSON.parse(prompt.split(\'\\n\').at(-1));',
    '  const readPolicy = context.observationEvidence.find((item) => item.kind === \'repo-read-policy\');',
    '  const actionEvidence = context.observationEvidence.find((item) => item.kind === \'repo-action\');',
    '  const patchPolicy = context.observationEvidence.find((item) => item.kind === \'repo-patch-policy\');',
    '  const targetPath = actionEvidence?.lastReadPath ?? readPolicy?.defaultPath ?? \'src/math.mjs\';',
    '  const testPolicy = context.observationEvidence.find((item) => item.kind === \'repo-test-policy\');',
    '  const selectedTestPath = testPolicy?.testPath ?? \'test/math.test.mjs\';',
    '  const allowedTarget = patchPolicy?.allowedPaths?.find((item) => item.path === targetPath);',
    '  const expectedBeforeDigest = allowedTarget?.expectedBeforeDigest ?? patchPolicy?.expectedBeforeDigest;',
    '  const sequence = context.goal === fastGoal ? [\'repo.apply-patch\']',
    '    : context.goal === trailingGoal ? [...defaultSequence, \'repo.read-file\'] : defaultSequence;',
    '  const capabilityId = sequence[context.step] ?? sequence.at(-1);',
    '  const capability = context.capabilities.find((item) => item.capabilityId === capabilityId);',
    '  const proposal = capabilityId === \'repo.read-file\' ? { path: targetPath }',
    '    : capabilityId === \'repo.run-tests\' ? { path: selectedTestPath }',
    '      : capabilityId === \'repo.apply-patch\' ? {',
    '          schemaVersion: 1, targetPath,',
    '          expectedBeforeDigest,',
    '          replacement: replacements[context.goal],',
    '        } : undefined;',
    '  const response = JSON.stringify({ protocol: \'yi-model-cli\', version: 1, id: request.id, ok: true,',
    '    result: { model: \'repo-benchmark-fixture\', content: JSON.stringify({ token: capability.token, ...(proposal === undefined ? {} : { proposal }) }) } }) + \'\\n\';',
    '  if (delayMs > 0) setTimeout(() => process.stdout.write(response), delayMs);',
    '  else process.stdout.write(response);',
    '});',
  ].join('\n');
}

function experienceAwareModelSource() {
  return [
    "import readline from 'node:readline';",
    'const replacements = JSON.parse(process.argv[2]);',
    'const defaultSequence = [\'repo.list-files\', \'repo.read-file\', \'repo.run-tests\', \'repo.apply-patch\', \'repo.run-tests\'];',
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'rl.on(\'line\', (line) => {',
    '  const request = JSON.parse(line);',
    '  const prompt = request.payload?.prompt ?? \'\';',
    '  const context = JSON.parse(prompt.split(\'\\n\').at(-1));',
    '  const readPolicy = context.observationEvidence.find((item) => item.kind === \'repo-read-policy\');',
    '  const actionEvidence = context.observationEvidence.find((item) => item.kind === \'repo-action\');',
    '  const patchPolicy = context.observationEvidence.find((item) => item.kind === \'repo-patch-policy\');',
    '  const targetPath = actionEvidence?.lastReadPath ?? readPolicy?.defaultPath ?? \'src/math.mjs\';',
    '  const testPolicy = context.observationEvidence.find((item) => item.kind === \'repo-test-policy\');',
    '  const selectedTestPath = testPolicy?.testPath ?? \'test/math.test.mjs\';',
    '  const allowedTarget = patchPolicy?.allowedPaths?.find((item) => item.path === targetPath);',
    '  const expectedBeforeDigest = allowedTarget?.expectedBeforeDigest ?? patchPolicy?.expectedBeforeDigest;',
    '  const experience = context.observationEvidence.find((item) => item.kind === \'repo-experience\');',
    '  const hasPriorExperience = (experience?.entries?.length ?? 0) > 0;',
    '  const canUseWorkflow = hasPriorExperience || context.goal.includes(\'addition\');',
    '  const sequence = canUseWorkflow ? defaultSequence : [\'repo.read-file\'];',
    '  const capabilityId = sequence[context.step] ?? sequence.at(-1);',
    '  const capability = context.capabilities.find((item) => item.capabilityId === capabilityId);',
    '  const proposal = capabilityId === \'repo.read-file\' ? { path: targetPath }',
    '    : capabilityId === \'repo.run-tests\' ? { path: selectedTestPath }',
    '      : capabilityId === \'repo.apply-patch\' ? {',
    '          schemaVersion: 1, targetPath,',
    '          expectedBeforeDigest,',
    '          replacement: replacements[context.goal],',
    '        } : undefined;',
    '  const response = JSON.stringify({ protocol: \'yi-model-cli\', version: 1, id: request.id, ok: true,',
    '    result: { model: \'repo-benchmark-experience-fixture\', content: JSON.stringify({ token: capability.token, ...(proposal === undefined ? {} : { proposal }) }) } }) + \'\\n\';',
    '  process.stdout.write(response);',
    '});',
  ].join('\n');
}

async function writeModelConfig(filePath, modelPath, replacements, fastGoal = undefined, trailingGoal = undefined, delayMs = 0) {
  await writeFile(filePath, JSON.stringify({
    executable: process.execPath,
    args: [modelPath, JSON.stringify(replacements), fastGoal ?? '', trailingGoal ?? '', String(delayMs)],
    model: 'repo-benchmark-fixture',
    timeoutMs: 30000,
  }), 'utf8');
}

function spawnBenchmarkProcess(args) {
  return spawn(process.execPath, [CLI, ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitForTaskCount(reportPath, minimum) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      if (Array.isArray(report.taskResults) && report.taskResults.length >= minimum) return report;
    } catch {}
    await sleep(100);
  }
  throw new Error(`benchmark did not reach ${minimum} completed tasks before timeout`);
}

async function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return waitForChild(child);
  if (process.platform === 'win32') {
    const killer = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (killer.error !== undefined) throw killer.error;
  } else if (!child.kill('SIGKILL')) {
    throw new Error('failed to signal benchmark process');
  }
  return waitForChild(child);
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: stdout.trim().length === 0 ? [] : stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line)),
      stderr,
    }));
  });
}
