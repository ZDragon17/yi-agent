import { randomUUID } from 'node:crypto';
import { LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { canonicalDigest, canonicalJson, SCHEMA_VERSION } from '../runtime/schema.mjs';
import { learn, stepWithPreference, verify } from '../kernel/index.mjs';
import { advanceChangeSupervisor, acknowledgeReplan, createChangeSupervisor, resumeChangeSupervisor } from '../agent/change-supervisor.mjs';
import { replayRun } from '../runtime/replay.mjs';
import {
  builtInWorldRegistry,
} from './world-registry.mjs';
import { createReplayWorld } from './external-world-registry.mjs';
import { buildInspectView } from './inspect-view.mjs';

const SNAPSHOT_INTERVAL = 32;

export async function initLab(input) {
  const source = requireRecord(input, 'init input');
  const labId = requireText(source.labId, 'labId');
  const worldId = requireText(source.worldId, 'worldId');
  const seed = requireText(source.seed ?? 'seed-1', 'seed');
  const registry = resolveRegistry(source.registry);
  registry.worldDefinition(worldId);
  const manifestParts = registry.createManifestParts({ labId, seed, worldId });
  const store = await LabStore.init({
    labPath: requireText(source.labPath, 'labPath'),
    labId,
    worldId,
    seed,
    ...manifestParts,
  });
  registry.assertManifest(store.manifest);
  if (
    canonicalJson(store.manifest.tokenMap) !== canonicalJson(manifestParts.tokenMap) ||
    canonicalJson(store.manifest.authorityPolicy) !== canonicalJson(manifestParts.authorityPolicy) ||
    (store.manifest.scenarioIds !== undefined &&
      canonicalJson(store.manifest.scenarioIds) !== canonicalJson(manifestParts.scenarioIds))
  ) {
    throw new LabStoreError('CONFLICT', 'Lab was initialized with an incompatible world contract.', { worldId });
  }
  return store;
}

export async function runLab(input) {
  const source = requireRecord(input, 'run input');
  if (source.advisor !== undefined && typeof source.advisor !== 'function') {
    throw new LabStoreError('INVALID_INPUT', 'advisor must be a function.', { field: 'advisor' });
  }
  const labPath = requireText(source.labPath, 'labPath');
  const steps = requireSteps(source.steps);
  const runId = source.runId ?? randomUUID();
  const scenario = source.scenario ?? 'steady';
  const registry = resolveRegistry(source.registry);
  const failpoint = typeof source.failpoint === 'function' ? source.failpoint : undefined;
  const supervisorMaxCycles = requireBoundedOptional(source.maxCycles, 1, 1_000_000, 'maxCycles') ?? 1_000_000;
  const supervisorStagnationLimit = requireBoundedOptional(source.stagnationLimit, 1, 100_000, 'stagnationLimit') ?? 3;
  const supervisionActive = source.goal !== undefined && source.goal !== null;
  const store = await LabStore.open({ labPath });
  const manifest = store.manifest;
  registry.assertManifest(manifest);
  const spec = registry.valueSpec(manifest.worldId);
  const world = registry.createWorld(manifest, scenario);
  const current = (await store.inspect()).current;
  const initialState = current.lastRunId === null
    ? {
        worldState: world.initialState(),
        memory: { schemaVersion: SCHEMA_VERSION, actionModels: {} },
        rngState: initialRng(manifest.seed),
        kernelStep: 0,
        changeSupervisor: createChangeSupervisor({
          goal: source.goal ?? '逼近 ValueSpec 目标',
          valueSpec: spec,
          maxCycles: supervisorMaxCycles,
          stagnationLimit: supervisorStagnationLimit,
        }),
      }
    : ensureSupervisor(projectCurrent(current), spec, source.goal, supervisorMaxCycles, supervisorStagnationLimit);
  const run = await store.startRun({
    runId,
    worldId: manifest.worldId,
    scenario,
    initialState,
    reuseLedgerHandle: true,
    ...(failpoint === undefined ? {} : { failpoint }),
  });
  let capabilities;
  let state = initialState;
  let executed = 0;
  let accepted = 0;
  let stopReason = 'COMPLETED';
  let terminalRequested = false;

  try {
    capabilities = world.actions(worldManifest(manifest));
    for (let index = 0; index < steps; index += 1) {
    const beforeObservation = projectObservation(world.observe(state.worldState));
    const modelDecision = source.advisor !== undefined && capabilities.some((capability) => capability.allowed && capability.safe)
      ? await source.advisor({
          observation: beforeObservation,
          memory: state.memory,
          valueSpec: spec,
          capabilities,
          manifest,
          step: state.kernelStep,
          goal: state.changeSupervisor.goal,
        })
      : null;
    const intent = stepWithPreference({
      observation: beforeObservation,
      memory: state.memory,
      valueSpec: spec,
      capabilities,
      rngState: state.rngState,
      ...(state.changeSupervisor.strategy === undefined ? {} : { strategy: state.changeSupervisor.strategy }),
    }, preferenceFor(modelDecision));
    if (intent.status === 'HALTED') {
      stopReason = intent.stopReason;
      terminalRequested = true;
      await run.finish({ terminalStatus: 'HALTED', finalState: state });
      return runSummary(runId, 'HALTED', stopReason, index, { executed, accepted, rejected: 0 });
    }

    const receiptRequest = {
      schemaVersion: SCHEMA_VERSION,
      token: intent.choice.token,
      basedOnVersion: beforeObservation.stateVersion,
      policyVersion: manifest.authorityPolicy.policyVersion,
      constraintsDigest: manifest.authorityPolicy.constraintsDigest,
      executionNonce: `execution:step:${state.kernelStep + 1}`,
    };
    const externalInputs = registry.scenarioExternalInputs(
      manifest.worldId,
      scenario,
      beforeObservation.stateVersion,
    );
    const transition = world.transition(state.worldState, receiptRequest);
    const receipt = externalInputs.length === 0
      ? transition.receipt
      : {
          ...transition.receipt,
          attributionWindowComplete: false,
          confounderCount: Math.max(1, transition.receipt.confounderCount),
        };
    const postObservation = projectObservation(transition.postObservation);
    const verification = verify({ intent, receipt, postObservation });
    const update = learn({
      memory: state.memory,
      intent,
      receipt,
      postObservation,
      verification,
    });
    const activeSupervisor = state.changeSupervisor.status === 'ACTIVE'
      ? state.changeSupervisor
      : resumeChangeSupervisor(state.changeSupervisor, 'runtime-continuation');
    let nextChangeSupervisor = advanceChangeSupervisor(activeSupervisor, {
      beforeObservation,
      postObservation,
      verification,
    });
    if (nextChangeSupervisor.status === 'REPLAN_REQUIRED') {
      nextChangeSupervisor = acknowledgeReplan(nextChangeSupervisor, 'supervisor-stagnation');
    }
    const nextState = {
      worldState: transition.nextWorldState,
      memory: update.nextMemory,
      rngState: intent.nextRngState,
      kernelStep: state.kernelStep + 1,
      changeSupervisor: nextChangeSupervisor,
    };
    const event = await run.append({
      kind: 'STEP',
      payload: {
        recordedAt: new Date().toISOString(),
        boundary: {
          schemaVersion: SCHEMA_VERSION,
          valueSpec: spec,
          capabilities,
          ...(state.changeSupervisor.strategy === undefined ? {} : { strategy: state.changeSupervisor.strategy }),
          externalInputsDigest: canonicalDigest(externalInputs),
        },
        beforeObservation,
        memoryEvidenceProjection: {
          sampleCount: intent.expectation.sampleCount,
          uncertainty: intent.expectation.uncertainty,
        },
        beforeDigest: canonicalDigest(state),
        expectation: intent.expectation,
        choice: intent.choice,
        receipt,
        postObservation,
        verification,
        update,
        afterDigest: canonicalDigest(nextState),
        rngBefore: state.rngState,
        rngAfter: nextState.rngState,
        externalInputs,
        afterState: nextState,
        ...(modelDecision === null ? {} : { policyEvidence: policyEvidence(modelDecision, intent, capabilities) }),
      },
    });
    const shouldSnapshot = (executed + 1) % SNAPSHOT_INTERVAL === 0 ||
      receipt.status === 'REJECTED' || index === steps - 1;
    if (shouldSnapshot) {
      await run.commitSnapshot({
        ...nextState,
        lastRunId: runId,
        lastRunSequence: event.sequence,
        eventsDigest: event.digest,
        status: 'RUNNING',
      });
    }
    state = nextState;
    executed += 1;
    if (receipt.status === 'REJECTED') {
      stopReason = 'EXECUTION_REJECTED';
      terminalRequested = true;
      await run.finish({ terminalStatus: 'HALTED', finalState: state });
      return runSummary(runId, 'HALTED', stopReason, executed, {
        executed,
        accepted,
        rejected: 1,
        evidence: { rejectionReason: transition.receipt.rejectionReason },
      });
    }
    if (supervisionActive && nextChangeSupervisor.status === 'COMPLETED') {
      terminalRequested = true;
      await run.finish({ terminalStatus: 'COMPLETED', finalState: state });
      return runSummary(runId, 'COMPLETED', 'OBJECTIVE_REACHED', executed, {
        executed,
        accepted: accepted + 1,
        rejected: 0,
        supervision: state.changeSupervisor,
      });
    }
    if (supervisionActive && nextChangeSupervisor.status === 'HALTED') {
      terminalRequested = true;
      await run.finish({ terminalStatus: 'HALTED', finalState: state });
      return runSummary(runId, 'HALTED', 'MAX_CYCLES', executed, {
        executed,
        accepted: accepted + 1,
        rejected: 0,
        supervision: state.changeSupervisor,
      });
    }
    accepted += 1;
    }

    terminalRequested = true;
    await run.finish({ terminalStatus: 'COMPLETED', finalState: state });
    return runSummary(runId, 'COMPLETED', stopReason, executed, {
      executed,
      accepted,
      rejected: 0,
      supervision: state.changeSupervisor,
    });
  } catch (error) {
    if (!terminalRequested && !run.terminalEvidence && !run.needsLedgerReconcile &&
        canonicalJson(run.expectedState) === canonicalJson(state)) {
      try {
        await run.finish({ terminalStatus: 'HALTED', finalState: state });
      } catch {
        // Preserve the original world or persistence error; recovery owns the unresolved run.
      }
    }
    throw error;
  } finally {
    await run.closeLedgerHandle();
  }
}

export async function runContinuous(input) {
  const source = requireRecord(input, 'continuous run input');
  const runs = requireBoundedOptional(source.runs, 1, 10_000, 'runs') ?? 1;
  const stepsPerRun = requireSteps(source.stepsPerRun ?? source.steps);
  const results = [];

  for (let index = 0; index < runs; index += 1) {
    const runId = source.runId === undefined
      ? randomUUID()
      : `${requireText(source.runId, 'runId')}-${index + 1}-${randomUUID()}`;
    const result = await runLab({
      ...source,
      runId,
      steps: stepsPerRun,
      stepsPerRun: undefined,
      runs: undefined,
    });
    results.push(result);
    if (result.status === 'HALTED' || result.stopReason === 'OBJECTIVE_REACHED') break;
  }

  const last = results.at(-1);
  return {
    schemaVersion: SCHEMA_VERSION,
    status: last?.status ?? 'COMPLETED',
    stopReason: last?.stopReason ?? 'COMPLETED',
    runs: results.length,
    metrics: {
      executed: results.reduce((sum, result) => sum + (result.metrics?.executed ?? 0), 0),
      accepted: results.reduce((sum, result) => sum + (result.metrics?.accepted ?? 0), 0),
      rejected: results.reduce((sum, result) => sum + (result.metrics?.rejected ?? 0), 0),
    },
    results,
  };
}

function preferenceFor(modelDecision) {
  return modelDecision?.token === null || modelDecision?.token === undefined
    ? null
    : { schemaVersion: SCHEMA_VERSION, token: modelDecision.token };
}

function policyEvidence(modelDecision, intent, capabilities) {
  const safe = capabilities.some((capability) => capability.token === modelDecision.token && capability.allowed && capability.safe);
  const applied = safe && intent.status === 'READY' && intent.choice.token === modelDecision.token;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'model',
    model: modelDecision.model,
    token: modelDecision.token,
    responseDigest: modelDecision.responseDigest,
    applied,
    reason: applied ? null : (modelDecision.reason ?? (safe ? 'KERNEL_SELECTION_REJECTED' : 'TOKEN_NOT_SAFE')),
  };
}

export async function inspectLab(input) {
  const source = requireRecord(input, 'inspect input');
  const registry = resolveRegistry(source.registry);
  const store = await LabStore.open({ labPath: requireText(source.labPath, 'labPath') });
  const inspection = await store.inspect();
  const actionReference = source.action === undefined ? null : parseActionReference(source.action);
  if (actionReference !== null && source.runId !== undefined && source.runId !== actionReference.runId) {
    throw new LabStoreError('INVALID_INPUT', 'runId and action reference identify different runs.', { field: 'action' });
  }
  const requestedRunId = actionReference?.runId ?? source.runId ?? inspection.current.lastRunId;
  let run = null;
  let selectedAction = null;
  if (requestedRunId !== null && requestedRunId !== undefined) {
    try {
      run = await store.readRun(requestedRunId);
    } catch (error) {
      if (!(error instanceof LabStoreError) || error.code !== 'BUSY' || source.runId !== undefined || actionReference !== null) throw error;
    }
    if (actionReference !== null) {
      selectedAction = run.events.find((event) => event.sequence === actionReference.sequence && event.kind === 'STEP') ?? null;
      if (selectedAction === null) {
        throw new LabStoreError('NOT_FOUND', 'Action sequence does not identify a STEP event.', { action: source.action });
      }
    }
  }
  const manifest = inspection.manifest;
  registry.assertManifest(manifest);
  const actions = manifest.adapter
    ? selectedAction?.payload?.boundary?.capabilities ?? manifestCapabilities(manifest)
    : registry
      .createWorld(manifest, run?.start?.scenario ?? manifest.scenarioIds?.[0] ?? 'steady')
      .actions(worldManifest(manifest));
  return {
    manifest,
    current: inspection.current,
    inspectView: buildInspectView({
      manifest,
      current: inspection.current,
      run,
      selectedAction,
      actions,
      valueSpec: registry.valueSpec(manifest.worldId),
    }),
  };
}

function parseActionReference(value) {
  if (typeof value !== 'string') {
    throw new LabStoreError('INVALID_INPUT', 'action must use runId:sequence format.', { field: 'action' });
  }
  const match = /^([^:]+):(\d+)$/u.exec(value);
  if (!match || Number(match[2]) < 1 || !Number.isSafeInteger(Number(match[2]))) {
    throw new LabStoreError('INVALID_INPUT', 'action must use runId:sequence format.', { field: 'action' });
  }
  return { runId: match[1], sequence: Number(match[2]) };
}

export async function replayLab(input) {
  const source = requireRecord(input, 'replay input');
  const registry = resolveRegistry(source.registry);
  const store = await LabStore.open({ labPath: requireText(source.labPath, 'labPath') });
  const run = await store.readRun(requireText(source.runId, 'runId'));
  registry.assertManifest(run.manifest);
  return replayRun({
    ...run,
    worldFactories: {
      [run.start.worldId]: run.manifest.adapter
        ? () => createReplayWorld(run)
        : (options) => registry.createWorld(run.manifest, options.scenario),
    },
  });
}

function resolveRegistry(value) {
  const registry = value ?? builtInWorldRegistry;
  if (
    registry === null ||
    typeof registry !== 'object' ||
    typeof registry.worldDefinition !== 'function' ||
    typeof registry.createWorld !== 'function' ||
    typeof registry.createManifestParts !== 'function' ||
    typeof registry.valueSpec !== 'function' ||
    typeof registry.scenarioExternalInputs !== 'function'
  ) {
    throw new LabStoreError('INVALID_INPUT', 'registry must expose the WorldPort registry contract.', { field: 'registry' });
  }
  if (typeof registry.assertManifest === 'function') return registry;
  return {
    ...registry,
    assertManifest() {},
  };
}

export function recoverLab(input) {
  const source = requireRecord(input, 'recover input');
  if (source.confirmLockOwnerDead !== true) {
    throw new LabStoreError('BUSY', 'Recovery requires explicit dead-owner confirmation.', {});
  }
  return LabStore.recover({ labPath: requireText(source.labPath, 'labPath') });
}

function worldManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    tokenMap: manifest.tokenMap,
    authorityPolicy: manifest.authorityPolicy,
  };
}

function projectObservation(observation) {
  return {
    schemaVersion: observation.schemaVersion,
    vector: [...observation.vector],
    stateVersion: observation.stateVersion,
    intervalId: observation.intervalId,
  };
}

function manifestCapabilities(manifest) {
  return manifest.tokenMap.entries.map((entry) => {
    const policy = manifest.authorityPolicy.capabilities[entry.capabilityId];
    return {
      schemaVersion: SCHEMA_VERSION,
      token: entry.token,
      cost: policy.cost,
      allowed: policy.allowed,
      safe: policy.safe,
    };
  });
}

function projectCurrent(current) {
  return {
    worldState: current.worldState,
    memory: current.memory,
    rngState: current.rngState,
    kernelStep: current.kernelStep,
    ...(current.changeSupervisor === undefined ? {} : { changeSupervisor: current.changeSupervisor }),
  };
}

function ensureSupervisor(state, valueSpec, goal, maxCycles, stagnationLimit) {
  if (state.changeSupervisor === undefined) {
    return {
      ...state,
      changeSupervisor: createChangeSupervisor({
        goal: goal ?? '逼近 ValueSpec 目标',
        valueSpec,
        maxCycles,
        stagnationLimit,
      }),
    };
  }
  return state;
}

function initialRng(seed) {
  let state = 0;
  for (const character of seed) state = ((state * 31) + character.codePointAt(0)) >>> 0;
  return { schemaVersion: SCHEMA_VERSION, algorithm: 'xorshift32', state: state || 1 };
}

function runSummary(runId, status, stopReason, steps, metrics) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status,
    stopReason,
    steps,
    metrics: { ...metrics },
    evidence: {
      executedActions: metrics.executed,
      acceptedActions: metrics.accepted,
      ...(metrics.evidence ?? {}),
    },
  };
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be an object.`, { field });
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty string.`, { field });
  }
  return value;
}

function requireSteps(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new LabStoreError('INVALID_INPUT', 'steps must be an integer from 1 to 10000.', { field: 'steps' });
  }
  return value;
}

function requireBoundedOptional(value, minimum, maximum, field) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be an integer from ${minimum} to ${maximum}.`, { field });
  }
  return value;
}
