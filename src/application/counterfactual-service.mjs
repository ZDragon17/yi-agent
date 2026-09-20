import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { normalizeCandidatePolicy } from '../runtime/candidate-policy.mjs';
import {
  evaluateCounterfactualPolicy,
  evaluateCounterfactualPolicyCorpus,
} from '../runtime/counterfactual-replay.mjs';
import { canonicalDigest, SCHEMA_VERSION, withSelfDigest } from '../runtime/schema.mjs';

const REPORT_TYPE = 'counterfactual-policy-evaluation';
// The offline result is a historical replay, not a real counterfactual,
// world outcome, or verified deployment effect. It is labelled so users and
// downstream tooling never mistake it for real-world evidence.
const EPISTEMIC_LABEL = 'historical-policy-replay';

// Zero-execution counterfactual evaluation: the ledger's recorded candidate
// history is the simulator (Dream-RSI style). No world is stepped, no model
// is called, and no branch lab is created — the report only re-reads what
// already happened and states where an alternative policy would have chosen
// differently.
export async function evaluateLabCounterfactual(input) {
  const source = requireRecord(input, 'counterfactual input');
  const labPath = await existingPath(requireText(source.labPath, 'labPath'), 'labPath');
  const store = await LabStore.open({ labPath });
  const inspection = await store.inspect();
  const current = inspection.current;
  if (current.status === 'RUNNING' || current.status === 'CORRUPT') {
    throw new LabStoreError('CONFLICT', 'A counterfactual evaluation requires a lab without an active or corrupt run.', { field: 'labPath', status: current.status });
  }
  const allowedTokens = new Set(store.manifest.tokenMap.entries.map((entry) => entry.token));
  const policy = normalizeCandidatePolicy(requireRecord(source.policy, 'policy'), allowedTokens, {
    worldId: store.manifest.worldId,
    worldVersion: store.manifest.worldVersion,
    worldImplementationDigest: store.manifest.worldImplementationDigest,
    tokenMapDigest: store.manifest.tokenMap.digest,
  });
  const history = await store.readCandidateOutcomes();
  const evaluation = evaluateCounterfactualPolicy({
    history,
    policy,
    ...(source.binding === undefined ? {} : { binding: source.binding }),
  });
  return withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    type: REPORT_TYPE,
    version: 1,
    epistemicLabel: EPISTEMIC_LABEL,
    labPath,
    manifestDigest: store.manifest.selfDigest,
    worldId: store.manifest.worldId,
    worldVersion: store.manifest.worldVersion,
    tokenMapDigest: store.manifest.tokenMap.digest,
    currentDigest: current.selfDigest,
    historyBasisDigest: canonicalDigest(history.map((entry) => ({
      runId: entry?.runId ?? null,
      sequence: entry?.sequence ?? null,
      kernelStep: entry?.kernelStep ?? null,
      beforeStateDigest: entry?.beforeStateDigest ?? null,
      worldId: entry?.worldId ?? null,
      seed: entry?.seed ?? null,
      worldImplementationDigest: entry?.worldImplementationDigest ?? null,
      valueSpecDigest: entry?.valueSpecDigest ?? null,
      candidateDigest: entry?.candidateOutcome?.candidateDigest ?? null,
      token: entry?.candidateOutcome?.token ?? null,
      ...(typeof entry?.observationDigest === 'string' ? { observationDigest: entry.observationDigest } : {}),
    }))),
    historySteps: history.length,
    evaluation,
  });
}

// Evaluate several completed Labs as independent evidence partitions. No
// WorldPort is stepped; only verified outcomes from the same resolved scope
// may fill another Lab's missing counterfactual outcome.
export async function evaluateLabsCounterfactual(input) {
  const source = requireRecord(input, 'counterfactual corpus input');
  if (!Array.isArray(source.labPaths) || source.labPaths.length === 0 || source.labPaths.length > 32) {
    throw new LabStoreError('INVALID_INPUT', 'labPaths must contain 1 to 32 Lab paths.', { field: 'labPaths' });
  }
  const labPaths = [];
  const seenPaths = new Set();
  for (const [index, value] of source.labPaths.entries()) {
    const labPath = await existingPath(requireText(value, `labPaths[${index}]`), `labPaths[${index}]`);
    if (seenPaths.has(labPath)) {
      throw new LabStoreError('INVALID_INPUT', 'labPaths must not contain duplicates.', { field: 'labPaths', index });
    }
    seenPaths.add(labPath);
    labPaths.push(labPath);
  }

  const loaded = [];
  let normalizedPolicy;
  for (const labPath of labPaths) {
    const store = await LabStore.open({ labPath });
    const inspection = await store.inspect();
    const current = inspection.current;
    if (current.status === 'RUNNING' || current.status === 'CORRUPT') {
      throw new LabStoreError('CONFLICT', 'A counterfactual corpus requires Labs without active or corrupt runs.', { field: 'labPaths', labPath, status: current.status });
    }
    const allowedTokens = new Set(store.manifest.tokenMap.entries.map((entry) => entry.token));
    let policy;
    try {
      policy = normalizeCandidatePolicy(requireRecord(source.policy, 'policy'), allowedTokens, {
        worldId: store.manifest.worldId,
        worldVersion: store.manifest.worldVersion,
        worldImplementationDigest: store.manifest.worldImplementationDigest,
        tokenMapDigest: store.manifest.tokenMap.digest,
      });
    } catch (error) {
      // The first Lab validates the policy shape. A later Lab may have a
      // different token map or bound WorldPort identity; keep its history so
      // the corpus evaluator can report MIXED scope instead of borrowing or
      // silently dropping that partition.
      if (normalizedPolicy === undefined || error?.code !== 'INVALID_INPUT') throw error;
      policy = normalizedPolicy;
    }
    normalizedPolicy ??= policy;
    loaded.push({
      labPath,
      store,
      current,
      policy,
      history: await store.readCandidateOutcomes(),
    });
  }

  const evaluation = evaluateCounterfactualPolicyCorpus({
    histories: loaded.map((item) => item.history),
    policy: normalizedPolicy,
    scopeHints: loaded.map((item) => ({
      worldId: item.store.manifest.worldId,
      worldVersion: item.store.manifest.worldVersion,
      worldImplementationDigest: item.store.manifest.worldImplementationDigest,
      tokenMapDigest: item.store.manifest.tokenMap.digest,
      scenario: item.history[0]?.scenario,
      valueSpecDigest: item.history[0]?.valueSpecDigest,
    })),
    ...(source.binding === undefined ? {} : { binding: source.binding }),
  });
  return withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    type: 'counterfactual-policy-corpus-evaluation',
    version: 1,
    epistemicLabel: EPISTEMIC_LABEL,
    labPaths,
    manifestDigests: loaded.map((item) => item.store.manifest.selfDigest),
    currentDigests: loaded.map((item) => item.current.selfDigest),
    historySteps: loaded.reduce((total, item) => total + item.history.length, 0),
    evaluation,
  });
}

async function existingPath(value, field) {
  try {
    return await realpath(path.resolve(value));
  } catch (error) {
    throw new LabStoreError('NOT_FOUND', `${field} does not exist.`, { field }, { cause: error });
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty string.`, { field });
  return value;
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LabStoreError('INVALID_INPUT', `${field} must be an object.`, { field });
  return value;
}
