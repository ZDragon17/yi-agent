import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KERNEL_LEARNING_VERSIONS, learn, step, verify } from '../../src/kernel/index.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

const ALPHA = 'tok_CYCLEALPHA1';
const BETA = 'tok_CYCLEBETA1';
const GAMMA = 'tok_CYCLEGAMMA1';
const WINNERS = [ALPHA, BETA, GAMMA];
const VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 1,
  weights: [1],
  target: [100],
  tolerance: 0,
  valueMode: 'distance-v2',
};

test('v25 accumulator h2 keys never hold a readable sample even under perfectly periodic evidence', () => {
  const { decisions, writes } = drivePeriodicSchedule(12, 25);

  // 学习确实在累加器 h2 键下写入过上下文模型（写入路径发生）。
  assert.ok(writes.h2.size > 0);
  // 但在最有利于复现的完全周期重复下，任何决策时刻的 h2 键都不在已存储键中：
  // 键来自带位置权重的累加器，按构造每个时刻都是新状态，写与读永远错开一步。
  assert.equal(
    decisions.some((decision) => decision.h2Present),
    false,
    `decision-time h2 keys unexpectedly matched stored keys: ${JSON.stringify(decisions.filter((d) => d.h2Present))}`,
  );
});

test('v26 window h2 keys recur under periodic evidence and hold reusable samples', () => {
  const { memory, decisions } = drivePeriodicSchedule(12, KERNEL_LEARNING_VERSIONS.current);

  // 窗口-8 键在周期-3 驱动下每个相位唯一；第二个周期起决策时刻应命中。
  const lateDecisions = decisions.filter((decision) => decision.index >= 4);
  assert.ok(lateDecisions.length >= 8);
  const hit = lateDecisions.find((decision) => decision.h2Present);
  assert.ok(hit !== undefined, 'window h2 keys were never readable at decision time');
  const models = memory.contextModels[hit.h2Key];
  assert.ok(Object.values(models).some((m) => m.sampleCount >= 2));
});

test('h1 recent-context keys recur under periodic evidence and drive prediction', () => {
  const { memory, decisions } = drivePeriodicSchedule(12, KERNEL_LEARNING_VERSIONS.current);

  // 第二周期起，最近两条历史的键已由更早的学习写入，决策时应当命中。
  const lateDecisions = decisions.filter((decision) => decision.index >= 5);
  assert.ok(lateDecisions.length >= 5);
  assert.equal(
    lateDecisions.some((decision) => decision.h1Present),
    true,
    'recurring h1 keys were never readable at decision time',
  );
  const recurringKey = lateDecisions.find((decision) => decision.h1Present).h1Key;
  assert.ok(memory.contextModels[recurringKey][WINNERS[(lateDecisions.find((d) => d.h1Present).index) % 3]]
    .sampleCount >= 2);

  // 读路径证明：在下一个决策将命中的 h1 键下预置一个名义上更优的替代候选，
  // 并把该候选的信念样本对齐到同一均值（否则真实 +1 样本的离散度惩罚恰好抵消均值优势）；
  // 同时给其余候选补齐该上下文的既有证据，避免上下文反事实探测抢先改写选择，
  // 使对比只反映 h1 键是否被读取。
  const probeBefore = observation([12], 'state:cyclic:probe');
  const nextKey = contextKeyForHistory(memory.recentHistory);
  assert.ok(nextKey !== undefined);
  const seeded = {
    ...memory,
    contextModels: {
      ...memory.contextModels,
      [nextKey]: {
        ...memory.contextModels[nextKey],
        [BETA]: { schemaVersion: 1, sampleCount: 1, meanDelta: [2], uncertainty: 0 },
        [GAMMA]: { schemaVersion: 1, sampleCount: 1, meanDelta: [1], uncertainty: 0 },
      },
    },
    beliefModels: {
      ...memory.beliefModels,
      [BETA]: {
        ...memory.beliefModels[BETA],
        'r1:+': { schemaVersion: 1, sampleCount: 2, samples: [[2], [2]] },
      },
    },
  };
  const intent = step({
    observation: probeBefore,
    memory: seeded,
    valueSpec: VALUE_SPEC,
    capabilities: WINNERS.map((token) => ({ schemaVersion: 1, token, cost: 1, allowed: true, safe: true })),
    rngState: rng(97),
  });
  assert.equal(intent.choice.token, BETA);
});

function drivePeriodicSchedule(totalSteps, learningVersion) {
  let memory = newMemory();
  let value = 0;
  const decisions = [];
  const writes = { h1: new Set(), h2: new Set() };

  for (let index = 0; index < totalSteps; index += 1) {
    const h2Key = longContextKeyForHistory(memory.recentHistory);
    const h1Key = contextKeyForHistory(memory.recentHistory);
    decisions.push({
      index,
      h2Key,
      h2Present: h2Key !== undefined && memory.contextModels !== undefined && h2Key in memory.contextModels,
      h1Key,
      h1Present: h1Key !== undefined && memory.contextModels !== undefined && h1Key in memory.contextModels,
    });

    const winner = WINNERS[index % 3];
    const before = observation([value], `state:cyclic:${index}`);
    const intent = step({
      observation: before,
      memory,
      valueSpec: VALUE_SPEC,
      capabilities: [{ schemaVersion: 1, token: winner, cost: 1, allowed: true, safe: true }],
      rngState: rng(index + 1),
    });
    assert.equal(intent.choice.token, winner);
    const postObservation = observation([value + 1], `state:cyclic:${index + 1}`);
    const receipt = {
      schemaVersion: 1,
      status: 'ACCEPTED',
      token: winner,
      basedOnVersion: before.stateVersion,
      policyVersion: 'policy:cyclic:probe',
      constraintsDigest: 'sha256:cyclic-probe',
      executionNonce: `execution:cyclic:${index}`,
      effectDigest: 'sha256:cyclic-effect',
      rejectionReason: null,
      attributionWindowComplete: true,
      confounderCount: 0,
    };
    const verification = verify({ intent, receipt, postObservation });
    const update = learn({ memory, intent, receipt, postObservation, verification, learningVersion });
    assert.equal(update.status, 'UPDATED');
    for (const key of Object.keys(update.nextMemory.contextModels ?? {})) {
      if (key.startsWith('h2:')) writes.h2.add(key);
      if (key.startsWith('h1:')) writes.h1.add(key);
    }
    memory = update.nextMemory;
    value += 1;
  }
  return { memory, decisions, writes };
}

function longContextKeyForHistory(history) {
  const entries = (history ?? []).filter((entry) => entry.historyOrder !== undefined)
    .sort((left, right) => left.historyOrder - right.historyOrder)
    .slice(-8);
  if (entries.length === 0) return undefined;
  return `h2:${canonicalDigest(entries.map(({ token, actualDelta }) => ({ token, actualDelta })))}`;
}

function contextKeyForHistory(history) {
  if (history === undefined) return undefined;
  const entries = history.filter((entry) => entry.historyOrder !== undefined)
    .sort((left, right) => left.historyOrder - right.historyOrder)
    .slice(-2);
  if (entries.length === 0) return undefined;
  return `h1:${canonicalDigest(entries.map(({ token, actualDelta }) => ({ token, actualDelta })))}`;
}

function newMemory() {
  // 键推导机制属于 v11/v25 语义，与 v21+ 的模型年龄账本无关；
  // 这里使用不带 modelClock 的历史形状，便于直接播种对照模型。
  return {
    schemaVersion: 1,
    actionModels: {},
    relationModels: {},
    pendingCredits: [],
    settledFeedback: [],
    pendingCreditPolicy: { schemaVersion: 1, maxAge: 8 },
    beliefModels: {},
    contextModels: {},
    recentHistory: [],
    historyClock: 0,
    historyAccumulator: '0000000000000000000000000000000000000000000000000000000000000000',
    lastVerifiedSteps: {},
    contextKeyScale: 9,
  };
}

function observation(vector, stateVersion) {
  return {
    schemaVersion: 1,
    vector,
    stateVersion,
    intervalId: `${stateVersion}:interval`,
  };
}

function rng(state) {
  return { schemaVersion: 1, algorithm: 'xorshift32', state };
}
