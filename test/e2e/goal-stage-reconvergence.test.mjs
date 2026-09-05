import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const STEPS = 80;
const STAGE1_TARGET = 26;
const STAGE2_TARGET = 14;
const TOLERANCE = 0.4;

// 预注册判据：两阶段计划在 stage-1（升温 26）完成后必须推进到 stage-2（降温 14），
// 并在剩余预算内围绕新目标重新收敛驻留——检验「计划推进 × 已收敛上下文策略」
// 的交互（F-118 记录的最后一个未测方向）。
test('two-stage goal plan advances after the first objective and reconverges on the second', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-stage-switch-e2e-'));
  const lab = path.join(root, 'lab');
  const planFile = path.join(root, 'goal-plan.json');
  await writeFile(planFile, JSON.stringify({
    schemaVersion: 1,
    rootGoal: '两阶段温控：先升温后降温',
    stages: [
      {
        id: 'warm-up',
        goal: '升温到 26 度',
        objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [STAGE1_TARGET], tolerance: TOLERANCE },
      },
      {
        id: 'cool-down',
        goal: '降温到 14 度',
        objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [STAGE2_TARGET], tolerance: TOLERANCE },
      },
    ],
  }));
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'temperature', '--seed', 'stage-switch-seed', '--json']);
    assert.equal(init.code, 0, init.stderr);
    const run = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', String(STEPS), '--goal-plan', planFile, '--kernel-only', '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    // 监督器在 stage-2 到达后以 OBJECTIVE_REACHED 正常终止——提前结束本身
    // 就是「推进 + 重收敛」判据成立的最强信号。
    assert.equal(run.stdout[0].data.stopReason, 'OBJECTIVE_REACHED');

    const store = await LabStore.open({ labPath: lab });
    const events = (await store.readRun('run-1')).events.filter((event) => event.kind === 'STEP');
    assert.ok(events.length > 0 && events.length <= STEPS, `unexpected step count ${events.length}`);

    const supervisors = events.map((event) => event.payload.afterState?.changeSupervisor).filter(Boolean);
    const advanceIndex = supervisors.findIndex((supervisor) =>
      supervisor.plan?.activeStageId === 'cool-down' &&
      supervisor.plan?.stages?.find((stage) => stage.id === 'warm-up')?.status === 'COMPLETED');
    assert.ok(advanceIndex >= 0, 'the plan never advanced from warm-up to cool-down');
    // stage-1 完成后预算内推进（从 22 到 26 的上升段远小于 40 步）。
    assert.ok(advanceIndex < STEPS / 2, `plan advanced at step ${advanceIndex}, too late`);

    // 重收敛：单 run 语义下到达即停，判据为终步观测落在 stage-2 目标带内
    // （|v-14| ≤ 2×tolerance）且终止原因为目标到达。
    const finalValue = events.at(-1).payload.postObservation.vector[0];
    assert.ok(
      Math.abs(finalValue - STAGE2_TARGET) <= TOLERANCE * 2,
      `final value ${finalValue} is outside the cool-down band`,
    );

    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-1', '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(args) {
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
