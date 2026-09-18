import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initLab, replayLab, runLab } from './agent-service.mjs';
import { builtInWorldRegistry } from './world-registry.mjs';
import { LabStore } from '../runtime/lab-store.mjs';
import { EXPERIMENT_STRATEGIES, normalizeExperimentStrategy } from '../runtime/experiment-policy.mjs';

export async function runExperimentCompare(input) {
  const world = requiredText(input.world, 'world');
  const scenario = input.scenario ?? 'steady';
  const steps = boundedInt(input.steps ?? 100, 1, 10_000, 'steps');
  const seedCount = boundedInt(input.seedCount ?? 3, 1, 100, 'seeds');
  const strategies = (input.strategies ?? ['fixed', 'learned']).map(normalizeExperimentStrategy);
  const outputPath = path.resolve(requiredText(input.outputPath, 'output'));
  await mkdir(outputPath, { recursive: true });
  const seeds = Array.isArray(input.seeds) && input.seeds.length > 0
    ? input.seeds.map((seed) => requiredText(seed, 'seed'))
    : Array.from({ length: seedCount }, (_, index) => `compare-${world}-${index + 1}`);
  const sourceDigest = await experimentSourceDigest();
  const records = [];
  for (const seed of seeds) {
    for (const strategy of strategies) {
      records.push(await runOne({ world, scenario, steps, seed, strategy, outputPath, sourceDigest }));
    }
  }
  const summary = summarize({ world, scenario, steps, seeds, strategies, sourceDigest, records });
  await writeFile(path.join(outputPath, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(outputPath, 'results.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await writeFile(path.join(outputPath, 'report.md'), renderReport(summary));
  return { ...summary, outputPath };
}

async function runOne({ world, scenario, steps, seed, strategy, outputPath, sourceDigest }) {
  const safeSeed = seed.replace(/[^A-Za-z0-9._-]/gu, '_');
  const labPath = path.join(outputPath, 'runs', world, scenario, `seed-${safeSeed}`, strategy, 'lab');
  await mkdir(path.dirname(labPath), { recursive: true });
  const startedAt = Date.now();
  const registry = builtInWorldRegistry;
  await initLab({ labPath, labId: `${world}-${safeSeed}-${strategy}`, worldId: world, seed, registry });
  const run = await runLab({ labPath, runId: 'run-1', steps, scenario, registry, experimentStrategy: strategy });
  const replay = await replayLab({ labPath, runId: 'run-1', registry });
  const store = await LabStore.open({ labPath });
  const inspected = await store.inspect();
  const loaded = await store.readRun('run-1');
  const events = loaded.events.filter((event) => event.kind === 'STEP');
  const metrics = deriveMetrics({ events, run, inspected, replay, world, scenario, seed, strategy, sourceDigest, durationMs: Date.now() - startedAt });
  await writeFile(path.join(path.dirname(labPath), 'results.jsonl'), `${JSON.stringify(metrics)}\n`);
  await writeFile(path.join(path.dirname(labPath), 'replay.json'), `${JSON.stringify({ verdict: replay.verdict, checkedSequences: replay.checkedSequences ?? null }, null, 2)}\n`);
  return metrics;
}

function deriveMetrics({ events, run, inspected, replay, world, scenario, seed, strategy, sourceDigest, durationMs }) {
  const feedback = { verified: 0, ambiguous: 0, unresolved: 0 };
  let accepted = 0; let rejected = 0; let bestDistance = null; let finalDistance = null; let reachedGoalStep = null;
  for (const event of events) {
    const payload = event.payload;
    if (payload.receipt?.status === 'ACCEPTED') accepted += 1;
    if (payload.receipt?.status === 'REJECTED') rejected += 1;
    for (const item of payload.update?.settled ?? []) {
      if (item.attribution === 'ACTION' && item.learnable === true) feedback.verified += 1;
      else if (item.attribution === 'AMBIGUOUS') feedback.ambiguous += 1;
      else if (item.attribution === 'UNRESOLVED') feedback.unresolved += 1;
    }
    const distance = payload.afterState?.changeSupervisor?.lastChange?.afterDistance ?? null;
    if (Number.isFinite(distance)) { finalDistance = distance; bestDistance = bestDistance === null ? distance : Math.min(bestDistance, distance); }
    if (reachedGoalStep === null && payload.afterState?.changeSupervisor?.status === 'COMPLETED') reachedGoalStep = payload.afterState.kernelStep;
  }
  const current = inspected.current;
  const supervisor = current.changeSupervisor ?? inspected.changeSupervisor ?? null;
  const finalFromSupervisor = supervisor?.lastChange?.afterDistance;
  if (Number.isFinite(finalFromSupervisor)) finalDistance = finalFromSupervisor;
  if (Number.isFinite(supervisor?.bestDistance)) bestDistance = supervisor.bestDistance;
  return {
    schemaVersion: 1, worldId: world, worldVersion: inspected.manifest?.worldVersion ?? null, scenario, seed, strategyId: strategy,
    kernelLearningVersion: events.at(-1)?.payload.boundary?.kernelLearningVersion ?? null, steps: events.length,
    accepted, rejected, verifiedFeedback: feedback.verified, ambiguousFeedback: feedback.ambiguous, unresolvedFeedback: feedback.unresolved,
    finalGoalDistance: finalDistance, bestGoalDistance: bestDistance, reachedGoal: reachedGoalStep !== null, goalReachedStep: reachedGoalStep,
    advisorCalls: 0, plannerCalls: 0, modelCalls: 0, replanCount: supervisor?.replanCount ?? 0, durationMs,
    replay: replay.verdict, failureReason: run.status === 'HALTED' ? run.stopReason : null,
    runStatus: run.status, stopReason: run.stopReason, manifestDigest: inspected.manifest?.selfDigest ?? null, experimentSourceDigest: sourceDigest,
  };
}

function summarize({ world, scenario, steps, seeds, strategies, sourceDigest, records }) {
  const byStrategy = Object.fromEntries(strategies.map((strategy) => {
    const rows = records.filter((record) => record.strategyId === strategy);
    const mean = (field) => { const values = rows.map((row) => row[field]).filter(Number.isFinite); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
    return [strategy, { runs: rows.length, replayConsistent: rows.every((row) => row.replay === 'CONSISTENT'), reachedGoalCount: rows.filter((row) => row.reachedGoal).length, meanFinalGoalDistance: mean('finalGoalDistance'), meanBestGoalDistance: mean('bestGoalDistance'), meanSteps: mean('steps'), meanDurationMs: mean('durationMs') }];
  }));
  return { schemaVersion: 1, experiment: 'strategy-compare-v1', world, scenario, steps, seeds, strategies, experimentSourceDigest: sourceDigest, records: records.length, allReplayConsistent: records.every((record) => record.replay === 'CONSISTENT'), byStrategy };
}

function renderReport(summary) {
  const lines = [`# yi-agent strategy comparison`, '', `- World: \`${summary.world}\``, `- Scenario: \`${summary.scenario}\``, `- Steps per run: ${summary.steps}`, `- Seeds: ${summary.seeds.length}`, `- Replay all consistent: **${summary.allReplayConsistent}**`, '', '## Summary', '', '| Strategy | Runs | Replay | Reached goal | Mean final distance | Mean best distance |', '| --- | ---: | --- | ---: | ---: | ---: |'];
  for (const [strategy, value] of Object.entries(summary.byStrategy)) lines.push(`| ${strategy} | ${value.runs} | ${value.replayConsistent ? 'CONSISTENT' : 'FAIL'} | ${value.reachedGoalCount} | ${format(value.meanFinalGoalDistance)} | ${format(value.meanBestGoalDistance)} |`);
  lines.push('', '## Evidence boundary', '', '- These are observed results from real local ledgers and Replay checks.', '- A comparison does not establish causal truth, AGI, RSI, or deployment readiness.', '- The default small sample is exploratory; increase seeds and add holdout scenarios before drawing capability conclusions.');
  return `${lines.join('\n')}\n`;
}

async function experimentSourceDigest() {
  const files = ['src/application/agent-service.mjs', 'src/runtime/experiment-policy.mjs', 'src/application/experiment-compare-service.mjs', 'src/kernel/index.mjs', 'src/runtime/replay.mjs'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(path.resolve(file)));
  return `sha256:${hash.digest('hex')}`;
}
function requiredText(value, field) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string.`); return value; }
function boundedInt(value, min, max, field) { const number = Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${field} must be an integer between ${min} and ${max}.`); return number; }
function format(value) { return value === null ? 'n/a' : Number(value).toFixed(3); }
