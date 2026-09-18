// F-282 反事实证据密度测量：在隔离临时目录里用一个候选集 advisor 驱动
// temperature 稳态 Lab 运行 N 步，统计最近候选历史窗口内 before 状态、
// observation 与 before 向量的复现性，再对每个单 Token 默认策略做零执行
// 反事实评估。用法：node scripts/counterfactual-measure.mjs [steps=150]。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initLab, runLab } from '../src/application/agent-service.mjs';
import { LabStore } from '../src/runtime/lab-store.mjs';
import { projectModelObservation } from '../src/agent/observation-context.mjs';
import { evaluateCounterfactualPolicy } from '../src/runtime/counterfactual-replay.mjs';

const STEPS = Number(process.argv[2] ?? 150);
const root = await mkdtemp(path.join(tmpdir(), 'yi-cf-probe-'));
try {
  const labPath = path.join(root, 'lab');
  await initLab({ labPath, labId: 'cf-probe', worldId: 'temperature', seed: 'cf-probe-seed' });
  const store = await LabStore.open({ labPath });
  const tokens = store.manifest.tokenMap.entries.map((entry) => entry.token);
  let step = 0;
  const advisor = ({ observation, observationEvidence, observationEvidenceTruncated }) => {
    const modelObservation = projectModelObservation(observation, observationEvidence, observationEvidenceTruncated);
    const primary = tokens[step % tokens.length];
    step += 1;
    return {
      schemaVersion: 1,
      model: 'cf-probe',
      token: primary,
      candidates: tokens.map((token) => ({ token })),
      observationDigest: modelObservation.digest,
    };
  };
  const result = await runLab({ labPath, runId: 'run-1', steps: STEPS, scenario: 'steady', advisor });
  console.log(`run: status=${result.status} stopReason=${result.stopReason ?? '-'} steps=${STEPS}`);

  const history = await (await LabStore.open({ labPath })).readCandidateOutcomes();
  const beforeStates = new Set(history.map((entry) => entry.beforeStateDigest));
  const observations = new Map();
  const verified = [];
  for (const entry of history) {
    if (entry.observationDigest === undefined) continue;
    if (!observations.has(entry.observationDigest)) observations.set(entry.observationDigest, new Map());
    const byToken = observations.get(entry.observationDigest);
    const token = entry.candidateOutcome?.token ?? 'null';
    byToken.set(token, (byToken.get(token) ?? 0) + 1);
    if (entry.quality?.verified === true && Number.isFinite(entry.quality?.goalDistanceAfter)) verified.push(entry);
  }
  let recurring = 0;
  let multiToken = 0;
  let crossPairs = 0;
  for (const byToken of observations.values()) {
    if (byToken.size >= 2) { multiToken += 1; crossPairs += [...byToken.values()].reduce((a, b) => a + b, 0) - 1; }
    if ([...byToken.values()].reduce((a, b) => a + b, 0) >= 2) recurring += 1;
  }
  console.log(`history=${history.length} uniqueBeforeStates=${beforeStates.size} uniqueObservations=${observations.size}`);
  const vectorCounts = new Map();
  const vectorTokens = new Map();
  for (const entry of history) {
    const vector = typeof entry.beforeVectorDigest === 'string' ? entry.beforeVectorDigest.slice(-12) : 'null';
    vectorCounts.set(vector, (vectorCounts.get(vector) ?? 0) + 1);
    if (!vectorTokens.has(vector)) vectorTokens.set(vector, new Set());
    vectorTokens.get(vector).add(entry.candidateOutcome?.token ?? 'null');
  }
  const repeatedVectors = [...vectorCounts.entries()].filter(([, count]) => count >= 2);
  const multiTokenVectors = [...vectorTokens.entries()].filter(([, tokens2]) => tokens2.size >= 2);
  console.log(`uniqueVectors=${vectorCounts.size} repeatedVectors=${repeatedVectors.length} multiTokenVectors=${multiTokenVectors.length}`);
  console.log(`vector histogram (top 8): ${[...vectorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, c]) => `${v}x${c}`).join(' ')}`);
  console.log(`recurringObservations=${recurring} multiTokenObservations=${multiToken} divergentEvidenceEntries=${crossPairs} verifiedEntries=${verified.length}`);
  console.log(`tokens=[${tokens.join(', ')}]`);

  for (const token of tokens) {
    const evaluation = evaluateCounterfactualPolicy({
      history,
      policy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: token, rules: [] },
    });
    const d = evaluation.divergence;
    const o = evaluation.outcome;
    console.log(`policy ${token}: steps=${evaluation.basis.steps} matched=${evaluation.agreement.matched} diverged=${evaluation.agreement.diverged} strict=${d.strict} vector=${d.vector} unevaluable=${d.unevaluable} verdict=${o.verdict}${Number.isFinite(o.meanDelta) ? ' meanDelta=' + o.meanDelta.toFixed(4) : ''}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
