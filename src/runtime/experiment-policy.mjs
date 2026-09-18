import { cloneJson } from './schema.mjs';

export const EXPERIMENT_STRATEGIES = [
  'fixed',
  'learned',
  'without-relation',
  'without-belief',
  'without-context',
];

export function normalizeExperimentStrategy(value) {
  if (value === undefined || value === null) return 'learned';
  if (!EXPERIMENT_STRATEGIES.includes(value)) {
    throw new Error(`Unknown experiment strategy: ${value}`);
  }
  return value;
}

export function projectExperimentMemory(memory, strategy) {
  const normalized = normalizeExperimentStrategy(strategy);
  const next = cloneJson(memory);
  if (normalized === 'learned') return next;
  if (normalized === 'fixed') {
    next.actionModels = {};
    next.proposalModels = {};
    next.proposalContextModels = {};
    next.relationModels = {};
    next.rejectionModels = {};
    next.beliefModels = {};
    next.contextModels = {};
    next.recentHistory = [];
    next.historyClock = 0;
    next.historyAccumulator = zeroAccumulator(next.historyAccumulator);
    next.lastVerifiedSteps = {};
    next.lastProbeSteps = {};
    next.modelClock = 0;
    delete next.modelAges;
    return next;
  }
  if (normalized === 'without-relation') next.relationModels = {};
  if (normalized === 'without-belief') next.beliefModels = {};
  if (normalized === 'without-context') {
    next.contextModels = {};
    next.recentHistory = [];
    next.historyAccumulator = zeroAccumulator(next.historyAccumulator);
    next.lastProbeSteps = {};
  }
  if (normalized !== 'learned') removeModelAges(next);
  return next;
}

function removeModelAges(memory) {
  delete memory.modelAges;
  delete memory.modelClock;
  for (const models of [memory.actionModels, memory.proposalModels, memory.rejectionModels]) {
    for (const model of Object.values(models ?? {})) delete model.modelAge;
  }
  for (const nested of [memory.relationModels, memory.beliefModels, memory.contextModels]) {
    for (const models of Object.values(nested ?? {})) {
      for (const model of Object.values(models ?? {})) delete model.modelAge;
    }
  }
  for (const proposals of Object.values(memory.proposalContextModels ?? {})) {
    for (const contexts of Object.values(proposals ?? {})) {
      for (const models of Object.values(contexts ?? {})) {
        for (const model of Object.values(models ?? {})) delete model.modelAge;
      }
    }
  }
}

function zeroAccumulator(value) {
  return typeof value === 'string' && value.length > 0 ? '0'.repeat(value.length) : value;
}
