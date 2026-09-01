import { randomUUID } from 'node:crypto';
import { INTERNAL_RUN_APPEND, LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { canonicalDigest, canonicalJson, SCHEMA_VERSION } from '../runtime/schema.mjs';
import { learn, mergeObservationFeedback, stepWithPreference, validateObservationFeedback, verify } from '../kernel/index.mjs';
import { advanceChangeSupervisor, acknowledgeReplan, createChangeSupervisor, enableGoal, goalPlanForActivation, normalizeChangeSupervisorState, resumeChangeSupervisor, reviseGoalPlan } from '../agent/change-supervisor.mjs';
import { replayRun } from '../runtime/replay.mjs';
import {
  builtInWorldRegistry,
} from './world-registry.mjs';
import { createReplayWorld } from './external-world-registry.mjs';
import { buildInspectView } from './inspect-view.mjs';
import { projectModelObservation } from '../agent/observation-context.mjs';

const SNAPSHOT_INTERVAL = 32;
const CHECKPOINT_SNAPSHOT_INTERVAL = 128;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const MAX_PLANNING_HORIZON = 8;
const PLANNING_BRANCHING_MODES = ['tree-v1', 'recursive-v1', 'legacy-v1'];
const KERNEL_LEARNING_VERSION = 18;

export async function initLab(input) {
  const source = requireRecord(input, 'init input');
  const labId = requireText(source.labId, 'labId');
  const worldId = requireText(source.worldId, 'worldId');
  const seed = requireText(source.seed ?? 'seed-1', 'seed');
  const registry = resolveRegistry(source.registry);
  const definition = registry.worldDefinition(worldId);
  const manifestParts = registry.createManifestParts({ labId, seed, worldId });
  if (definition?.worldVersion !== undefined && manifestParts.worldVersion !== definition.worldVersion) {
    throw new LabStoreError('CONFLICT', 'World registry did not persist its declared world contract version.', {
      field: 'worldVersion',
      expected: definition.worldVersion,
      actual: manifestParts.worldVersion ?? null,
    });
  }
  if (definition?.worldImplementationDigest !== undefined &&
      manifestParts.worldImplementationDigest !== definition.worldImplementationDigest) {
    throw new LabStoreError('CONFLICT', 'World registry did not persist its declared implementation contract.', {
      field: 'worldImplementationDigest',
      expected: definition.worldImplementationDigest,
      actual: manifestParts.worldImplementationDigest ?? null,
    });
  }
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
    (store.manifest.worldVersion !== undefined &&
      canonicalJson(store.manifest.worldVersion) !== canonicalJson(manifestParts.worldVersion)) ||
    (store.manifest.worldImplementationDigest !== undefined &&
      canonicalJson(store.manifest.worldImplementationDigest) !== canonicalJson(manifestParts.worldImplementationDigest)) ||
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
  if (source.planner !== undefined && typeof source.planner !== 'function') {
    throw new LabStoreError('INVALID_INPUT', 'planner must be a function.', { field: 'planner' });
  }
  const labPath = requireText(source.labPath, 'labPath');
  const steps = requireSteps(source.steps);
  const runId = source.runId ?? randomUUID();
  const scenario = source.scenario ?? 'steady';
  const registry = resolveRegistry(source.registry);
  const failpoint = typeof source.failpoint === 'function' ? source.failpoint : undefined;
  const durability = source.durability ?? 'strict';
  if (durability !== 'strict' && durability !== 'checkpoint') {
    throw new LabStoreError('INVALID_INPUT', 'durability must be strict or checkpoint.', { field: 'durability' });
  }
  const supervisorMaxCycles = requireBoundedOptional(source.maxCycles, 1, 1_000_000, 'maxCycles') ?? 1_000_000;
  const supervisorStagnationLimit = requireBoundedOptional(source.stagnationLimit, 1, 100_000, 'stagnationLimit') ?? 3;
  const requestedPlanningHorizon = source.planningHorizon === undefined
    ? undefined
    : requireBoundedOptional(source.planningHorizon, 1, MAX_PLANNING_HORIZON, 'planningHorizon');
  const requestedPlanningBranchingMode = source.planningBranchingMode === undefined
    ? undefined
    : requirePlanningBranchingMode(source.planningBranchingMode);
  let planningHorizon = requestedPlanningHorizon ?? 1;
  let planningContextMode = 'context-v1';
  let planningBranchingMode = requestedPlanningBranchingMode ?? 'tree-v1';
  if (source.autoPlan !== undefined && typeof source.autoPlan !== 'boolean') {
    throw new LabStoreError('INVALID_INPUT', 'autoPlan must be a boolean.', { field: 'autoPlan' });
  }
  const planningExplicitlyRequested = source.autoPlan === true ||
    (source.autoPlan === undefined && source.planner !== undefined);
  if (planningExplicitlyRequested && (source.goal === undefined || source.goal === null)) {
    throw new LabStoreError('INVALID_INPUT', 'planner requires an explicit goal.', { field: 'goal' });
  }
  if (planningExplicitlyRequested && source.goalPlan !== undefined) {
    throw new LabStoreError('INVALID_INPUT', 'planner and goalPlan are mutually exclusive.', { fields: ['planner', 'goalPlan'] });
  }
  const store = await LabStore.open({ labPath });
  const manifest = store.manifest;
  registry.assertManifest(manifest);
  const spec = registry.valueSpec(manifest.worldId);
  const world = registry.createWorld(manifest, scenario);
  const current = (await store.inspect()).current;
  let unresolvedExternalTransition = manifest.adapter === undefined
    ? null
    : await store.findUnresolvedExternalTransition();
  if (unresolvedExternalTransition !== null) {
    const unresolved = unresolvedExternalTransition;
    if (unresolved.legacy) {
      throw new LabStoreError(
        'CONFLICT',
        'An unresolved external transition lacks durable retry evidence and requires manual reconciliation.',
        { runId: unresolved.runId },
      );
    }
    if (unresolved.scenario !== scenario) {
      throw new LabStoreError(
        'CONFLICT',
        'An unresolved external transition can only be resumed with the original scenario.',
        { runId: unresolved.runId, previousScenario: unresolved.scenario, scenario },
      );
    }
    if (world.supportsIdempotentTransitions !== true) {
      throw new LabStoreError(
        'CONFLICT',
        'The previous external transition is unresolved and its adapter does not declare idempotent transitions.',
        { runId: unresolved.runId, executionNonce: unresolved.evidence.executionNonce },
      );
    }
    const recoveredPlanningHorizon = unresolved.evidence.planning?.horizon ?? 1;
    if (requestedPlanningHorizon !== undefined && requestedPlanningHorizon !== recoveredPlanningHorizon) {
      throw new LabStoreError(
        'CONFLICT',
        'An unresolved external transition must be retried with its original planning horizon.',
        {
          runId: unresolved.runId,
          fields: ['planningHorizon'],
          expected: recoveredPlanningHorizon,
          actual: requestedPlanningHorizon,
        },
      );
    }
    const recoveredPlanningBranchingMode = unresolved.evidence.planning?.branchingMode ??
      (recoveredPlanningHorizon > 1 ? 'legacy-v1' : requestedPlanningBranchingMode ?? 'tree-v1');
    if (requestedPlanningBranchingMode !== undefined && requestedPlanningBranchingMode !== recoveredPlanningBranchingMode) {
      throw new LabStoreError(
        'CONFLICT',
        'An unresolved external transition must be retried with its original planning branching mode.',
        {
          runId: unresolved.runId,
          fields: ['planningBranchingMode'],
          expected: recoveredPlanningBranchingMode,
          actual: requestedPlanningBranchingMode,
        },
      );
    }
    planningHorizon = recoveredPlanningHorizon;
    planningContextMode = unresolved.evidence.planning?.contextMode ?? 'legacy-v1';
    planningBranchingMode = recoveredPlanningBranchingMode;
  }
  const goalRequested = (source.goal !== undefined && source.goal !== null) || source.goalPlan !== undefined;
  let initialState = current.lastRunId === null
    ? {
        worldState: world.initialState(),
        memory: {
          schemaVersion: SCHEMA_VERSION,
          actionModels: {},
          relationModels: {},
          pendingCredits: [],
          settledFeedback: [],
          pendingCreditPolicy: { schemaVersion: SCHEMA_VERSION, maxAge: 8 },
          beliefModels: {},
          contextModels: {},
          recentHistory: [],
          historyClock: 0,
          historyAccumulator: '0000000000000000000000000000000000000000000000000000000000000000',
          lastVerifiedSteps: {},
        },
        rngState: initialRng(manifest.seed),
        kernelStep: 0,
        changeSupervisor: createChangeSupervisor({
          goal: source.goal ?? source.goalPlan?.rootGoal ?? '逼近 ValueSpec 目标',
          enabled: goalRequested && !planningExplicitlyRequested,
          plannerEnabled: planningExplicitlyRequested,
          plan: source.goalPlan,
          valueSpec: spec,
          maxCycles: supervisorMaxCycles,
          stagnationLimit: supervisorStagnationLimit,
        }),
      }
      : projectCurrent(current);
  const existingSupervisor = initialState.changeSupervisor === undefined
    ? null
    : normalizeChangeSupervisorState(initialState.changeSupervisor);
  if (existingSupervisor !== null) {
    initialState = { ...initialState, changeSupervisor: existingSupervisor };
  }
  const requestedGoal = source.goal ?? source.goalPlan?.rootGoal ?? existingSupervisor?.goal ?? '逼近 ValueSpec 目标';
  const plannerRequested = source.goalPlan === undefined &&
    (planningExplicitlyRequested || existingSupervisor?.plannerEnabled === true);
  if (current.lastRunId !== null && existingSupervisor?.enabled === true && goalRequested && existingSupervisor.goal !== requestedGoal) {
    throw new LabStoreError('CONFLICT', 'An enabled goal cannot be replaced in an existing lab.', { field: 'goal' });
  }
  if (current.lastRunId !== null && existingSupervisor?.enabled === true && source.goalPlan !== undefined) {
    try {
      initialState = {
        ...initialState,
        changeSupervisor: enableGoal(initialState.changeSupervisor, requestedGoal, source.goalPlan),
      };
    } catch (error) {
      throw new LabStoreError('CONFLICT', error instanceof Error ? error.message : 'An enabled goal plan cannot be replaced in an existing lab.', { field: 'goalPlan' });
    }
  }
  const run = await store.startRun({
    runId,
    worldId: manifest.worldId,
    scenario,
    initialState,
    ...(source.continuation === undefined ? {} : { continuation: source.continuation }),
    reuseLedgerHandle: true,
    durability,
    ...(failpoint === undefined ? {} : { failpoint }),
  });
  let state = initialState;
  let executed = 0;
  let accepted = 0;
  let stopReason = 'COMPLETED';
  let terminalRequested = false;
  let externalTransitionUncertain = false;
  const snapshotInterval = durability === 'checkpoint'
    ? CHECKPOINT_SNAPSHOT_INTERVAL
    : SNAPSHOT_INTERVAL;

  try {
    for (let index = 0; index < steps; index += 1) {
    const observedBefore = world.observe(state.worldState);
    const beforeObservation = projectObservation(observedBefore);
    validateObservationFeedback(state.memory, beforeObservation);
    const beforeModelObservation = projectModelObservation(observedBefore);
    const capabilities = world.actions(worldManifest(manifest), state.worldState);
    // The state has already crossed the store/kernel validation boundary on
    // entry and every prior supervisor transition returns a normalized value.
    // Avoid re-normalizing this immutable internal value on every long-run
    // step; public/restart inputs are still normalized at their boundaries.
    const previousSupervisor = state.changeSupervisor === undefined
      ? null
      : state.changeSupervisor;
    let activationPlan = source.goalPlan;
    let plannerEvidence = null;
    if (plannerRequested && previousSupervisor?.enabled !== true) {
      const plannerResult = await requestPlan({
        planner: source.planner,
        goal: requestedGoal,
        observation: beforeObservation,
        observationEvidence: beforeModelObservation.observationEvidence,
        observationEvidenceTruncated: beforeModelObservation.observationEvidenceTruncated,
        valueSpec: spec,
        memory: state.memory,
        manifest,
        step: state.kernelStep,
      });
      plannerEvidence = plannerResult.evidence;
      activationPlan = plannerResult.plan;
    }
    const baseSupervisor = previousSupervisor ?? (!goalRequested
      ? null
      : createChangeSupervisor({
          goal: requestedGoal,
          enabled: true,
          plannerEnabled: plannerRequested,
          plan: activationPlan,
          valueSpec: spec,
          maxCycles: supervisorMaxCycles,
          stagnationLimit: supervisorStagnationLimit,
        }));
    const supervisor = baseSupervisor === null || !goalRequested
      ? baseSupervisor
      : enableGoal(baseSupervisor, requestedGoal, activationPlan, plannerRequested ? true : undefined);
    const goalActivates = supervisor?.enabled === true && previousSupervisor?.enabled !== true;
    const activatedPlan = goalActivates ? goalPlanForActivation(supervisor) : undefined;
    const goalActivation = goalActivates
      ? {
          schemaVersion: SCHEMA_VERSION,
          goal: supervisor.goal,
          plannerEnabled: supervisor.plannerEnabled,
          maxCycles: supervisor.maxCycles,
          stagnationLimit: supervisor.stagnationLimit,
          ...(activatedPlan === undefined ? {} : { plan: activatedPlan }),
          ...(plannerEvidence === null ? {} : { planEvidence: plannerEvidence }),
        }
      : null;
    const stepValueSpec = kernelValueSpec(supervisor?.objective ?? spec);
    const retryPolicyEvidence = unresolvedExternalTransition?.evidence.policyEvidence ?? null;
    const retryPreference = retryPolicyEvidence?.applied === true ? retryPolicyEvidence : null;
    const modelDecision = retryPolicyEvidence === null &&
      source.advisor !== undefined && capabilities.some((capability) => capability.allowed && capability.safe)
      ? await requestAdvice({
          advisor: source.advisor,
          observation: beforeObservation,
          memory: state.memory,
          valueSpec: stepValueSpec,
          capabilities,
          manifest,
          step: state.kernelStep,
          observationEvidence: beforeModelObservation.observationEvidence,
          observationEvidenceTruncated: beforeModelObservation.observationEvidenceTruncated,
          goal: supervisor?.goal ?? requestedGoal,
        })
      : null;
    const intent = stepWithPreference({
      observation: beforeObservation,
      memory: state.memory,
      valueSpec: stepValueSpec,
      capabilities,
      rngState: state.rngState,
      ...(supervisor?.strategy === undefined ? {} : { strategy: supervisor.strategy }),
      planning: planningEvidence(planningHorizon, planningContextMode, planningBranchingMode),
    }, preferenceFor(retryPreference ?? modelDecision, retryPreference !== null));
    if (intent.status === 'HALTED') {
      stopReason = intent.stopReason;
      terminalRequested = true;
      await run.finish({ terminalStatus: 'HALTED', reason: stopReason, finalState: state });
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
    if (unresolvedExternalTransition !== null) {
      assertExternalTransitionRetry(
        unresolvedExternalTransition,
        receiptRequest,
        state,
        planningHorizon,
        planningContextMode,
        planningBranchingMode,
      );
    }
    const externalInputs = registry.scenarioExternalInputs(
      manifest.worldId,
      scenario,
      beforeObservation.stateVersion,
    );
    if (manifest.adapter !== undefined) {
      await run.markExternalTransition({
        executionNonce: receiptRequest.executionNonce,
        token: receiptRequest.token,
        basedOnVersion: receiptRequest.basedOnVersion,
        beforeState: state,
        planning: planningEvidence(planningHorizon, planningContextMode, planningBranchingMode),
        ...(retryPolicyEvidence === null && modelDecision === null
          ? {}
          : { policyEvidence: retryPolicyEvidence ?? policyEvidence(modelDecision, intent, capabilities) }),
      });
    }
    externalTransitionUncertain = manifest.adapter !== undefined;
    const transition = world.transition(state.worldState, receiptRequest);
    externalTransitionUncertain = externalTransitionUncertain && transition.receipt.status === 'ACCEPTED';
    if (typeof failpoint === 'function' && failpoint('external-transition:returned')) {
      throw new LabStoreError('INJECTED_FAILURE', 'Injected failure at external-transition:returned.', {
        point: 'external-transition:returned',
      });
    }
    const afterCapabilities = world.actions(worldManifest(manifest), transition.nextWorldState);
    const receipt = externalInputs.length === 0
      ? transition.receipt
      : {
          ...transition.receipt,
          attributionWindowComplete: false,
          confounderCount: Math.max(1, transition.receipt.confounderCount),
        };
    const postObservation = mergeObservationFeedback(
      beforeObservation,
      projectObservation(transition.postObservation),
    );
    const postModelObservation = projectModelObservation(transition.postObservation);
    const verification = verify({ intent, receipt, postObservation });
    const update = learn({
      memory: state.memory,
      intent,
      receipt,
      postObservation,
      verification,
    });
    const activeSupervisor = supervisor === null ? null : supervisor.status === 'ACTIVE'
      ? supervisor
      : resumeChangeSupervisor(supervisor, 'runtime-continuation', { trusted: true });
    let nextChangeSupervisor = activeSupervisor === null ? null : advanceChangeSupervisor(activeSupervisor, {
      beforeObservation,
      postObservation,
      verification,
      hasFreshFeedbackSettlement: update.settled?.some((item) => item.attribution === 'ACTION' || item.attribution === 'AMBIGUOUS') === true,
      trusted: true,
    });
    let goalReplan = null;
    if (nextChangeSupervisor?.status === 'REPLAN_REQUIRED') {
      if (plannerRequested) {
        const plannerResult = await requestPlan({
          planner: source.planner,
          goal: requestedGoal,
          observation: postObservation,
          observationEvidence: postModelObservation.observationEvidence,
          observationEvidenceTruncated: postModelObservation.observationEvidenceTruncated,
          valueSpec: spec,
          memory: update.nextMemory,
          manifest,
          plan: nextChangeSupervisor.plan,
          reason: 'STAGNATION',
          step: state.kernelStep + 1,
        });
        if (plannerResult.plan !== undefined) {
          try {
            nextChangeSupervisor = reviseGoalPlan(nextChangeSupervisor, plannerResult.plan);
            goalReplan = {
              schemaVersion: SCHEMA_VERSION,
              plan: nextChangeSupervisor.plan,
              planEvidence: plannerResult.evidence,
            };
          } catch {
            goalReplan = {
              schemaVersion: SCHEMA_VERSION,
              planEvidence: { ...plannerResult.evidence, applied: false, reason: 'PLAN_REJECTED' },
            };
          }
        } else {
          goalReplan = {
            schemaVersion: SCHEMA_VERSION,
            planEvidence: plannerResult.evidence,
          };
        }
      }
      nextChangeSupervisor = acknowledgeReplan(nextChangeSupervisor, 'supervisor-stagnation', { trusted: true });
    }
    const nextState = {
      worldState: transition.nextWorldState,
      memory: update.nextMemory,
      rngState: intent.nextRngState,
      kernelStep: state.kernelStep + 1,
      ...(nextChangeSupervisor === null ? {} : { changeSupervisor: nextChangeSupervisor }),
    };
    const event = await run.append({
      kind: 'STEP',
      payload: {
        recordedAt: new Date().toISOString(),
        boundary: {
          schemaVersion: SCHEMA_VERSION,
          kernelLearningVersion: KERNEL_LEARNING_VERSION,
          valueSpec: stepValueSpec,
          planning: planningEvidence(planningHorizon, planningContextMode, planningBranchingMode),
          capabilities,
          afterCapabilities,
          ...(supervisor?.strategy === undefined ? {} : { strategy: supervisor.strategy }),
          ...(goalActivation === null ? {} : { goalActivation }),
          ...(goalReplan === null ? {} : { goalReplan }),
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
        ...(retryPolicyEvidence === null && modelDecision === null
          ? {}
          : { policyEvidence: retryPolicyEvidence ?? policyEvidence(modelDecision, intent, capabilities) }),
      },
    }, { returnReference: true, [INTERNAL_RUN_APPEND]: true });
    if (manifest.adapter !== undefined) {
      if (durability === 'checkpoint') await run.flushLedger();
      await run.clearExternalTransition();
      unresolvedExternalTransition = null;
      externalTransitionUncertain = false;
    }
    const shouldSnapshot = (executed + 1) % snapshotInterval === 0 ||
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
      await run.finish({ terminalStatus: 'HALTED', reason: stopReason, finalState: state });
      return runSummary(runId, 'HALTED', stopReason, executed, {
        executed,
        accepted,
        rejected: 1,
        evidence: { rejectionReason: transition.receipt.rejectionReason },
      });
    }
    if (supervisor?.enabled === true && nextChangeSupervisor?.status === 'COMPLETED') {
      terminalRequested = true;
      await run.finish({ terminalStatus: 'COMPLETED', reason: 'OBJECTIVE_REACHED', finalState: state });
      return runSummary(runId, 'COMPLETED', 'OBJECTIVE_REACHED', executed, {
        executed,
        accepted: accepted + 1,
        rejected: 0,
        supervision: state.changeSupervisor,
      });
    }
    if (supervisor?.enabled === true && nextChangeSupervisor?.status === 'HALTED') {
      terminalRequested = true;
      await run.finish({ terminalStatus: 'HALTED', reason: 'MAX_CYCLES', finalState: state });
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
    await run.finish({ terminalStatus: 'COMPLETED', reason: stopReason, finalState: state });
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
        await run.finish({
          terminalStatus: 'HALTED',
          finalState: state,
          ...(externalTransitionUncertain ? { reason: 'EXTERNAL_TRANSITION_UNKNOWN' } : {}),
        });
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
  if (source.shouldStop !== undefined && typeof source.shouldStop !== 'function') {
    throw new LabStoreError('INVALID_INPUT', 'shouldStop must be a function.', { field: 'shouldStop' });
  }
  const forever = source.forever === true;
  if (source.resume !== undefined && typeof source.resume !== 'boolean') {
    throw new LabStoreError('INVALID_INPUT', 'resume must be a boolean.', { field: 'resume' });
  }
  if (source.resume === true && (
    source.runs !== undefined || source.forever !== undefined || source.stepsPerRun !== undefined || source.steps !== undefined ||
    source.runId !== undefined || source.scenario !== undefined || source.goal !== undefined || source.goalPlan !== undefined ||
    source.autoPlan === true || source.maxCycles !== undefined || source.stagnationLimit !== undefined ||
    source.planningHorizon !== undefined || source.planningBranchingMode !== undefined
  )) {
    throw new LabStoreError('INVALID_INPUT', 'resume cannot be combined with loop configuration.', {
      fields: ['resume', 'loop configuration'],
    });
  }
  if (source.forever !== undefined && typeof source.forever !== 'boolean') {
    throw new LabStoreError('INVALID_INPUT', 'forever must be a boolean.', { field: 'forever' });
  }
  if (forever && source.runs !== undefined) {
    throw new LabStoreError('INVALID_INPUT', 'forever and runs are mutually exclusive.', { fields: ['forever', 'runs'] });
  }
  const requestedRuns = requireBoundedOptional(source.runs, 1, 10_000, 'runs') ?? 1;
  let continuation;
  if (source.resume === true) {
    const store = await LabStore.open({ labPath: requireText(source.labPath, 'labPath') });
    continuation = await store.readLoopContinuation();
    if (continuation.status !== 'ACTIVE') {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: continuation.status === 'STOPPED' ? 'HALTED' : 'COMPLETED',
        stopReason: continuation.lastStopReason ?? 'COMPLETED',
        continuationId: continuation.loopId,
        runs: 0,
        metrics: { executed: 0, accepted: 0, rejected: 0 },
        results: [],
      };
    }
  } else {
    const stepsPerRun = requireSteps(source.stepsPerRun ?? source.steps);
    const store = await LabStore.open({ labPath: requireText(source.labPath, 'labPath') });
    try {
      const existing = await store.readLoopContinuation();
      if (existing.status === 'ACTIVE') {
        throw new LabStoreError('CONFLICT', 'An unfinished loop continuation already owns this lab; use resume first.', {
          continuationId: existing.loopId,
        });
      }
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error;
    }
    continuation = {
      schemaVersion: SCHEMA_VERSION,
      loopId: randomUUID(),
      scenario: source.scenario ?? 'steady',
      runIndex: 0,
      stepsPerRun,
      mode: forever ? 'forever' : 'finite',
      planningHorizon: requireBoundedOptional(source.planningHorizon, 1, MAX_PLANNING_HORIZON, 'planningHorizon') ?? 1,
      planningBranchingMode: 'tree-v1',
      ...(forever ? {} : { maxRuns: requestedRuns }),
    };
  }
  const stepsPerRun = continuation.stepsPerRun;
  const runLimit = continuation.mode === 'finite'
    ? continuation.maxRuns
    : Number.POSITIVE_INFINITY;
  const longLived = continuation.mode === 'forever';
  const startIndex = source.resume === true ? continuation.nextRunIndex : 0;
  const scenario = continuation.scenario;
  const durability = source.durability ?? 'checkpoint';
  if (durability !== 'strict' && durability !== 'checkpoint') {
    throw new LabStoreError('INVALID_INPUT', 'durability must be strict or checkpoint.', { field: 'durability' });
  }
  const results = [];
  let lastResult = null;
  let completedRuns = 0;
  const metrics = { executed: 0, accepted: 0, rejected: 0 };
  let interrupted = false;
  const shouldStop = () => source.shouldStop?.() === true;

  for (let index = startIndex; index < runLimit; index += 1) {
    if (shouldStop()) {
      interrupted = true;
      break;
    }
    const runId = source.runId === undefined
      ? randomUUID()
      : `${requireText(source.runId, 'runId')}-${index + 1}-${randomUUID()}`;
    const result = await runLab({
      ...source,
      runId,
      scenario,
      continuation: { ...continuation, runIndex: index },
      steps: stepsPerRun,
      planningHorizon: continuation.planningHorizon,
      planningBranchingMode: continuation.planningBranchingMode,
      stepsPerRun: undefined,
      runs: undefined,
      durability,
    });
    completedRuns += 1;
    metrics.executed += result.metrics?.executed ?? 0;
    metrics.accepted += result.metrics?.accepted ?? 0;
    metrics.rejected += result.metrics?.rejected ?? 0;
    if (longLived) lastResult = result;
    else results.push(result);
    if (result.status === 'HALTED' || result.stopReason === 'OBJECTIVE_REACHED') break;
    if (shouldStop()) {
      interrupted = true;
      break;
    }
  }

  const last = longLived ? lastResult : results.at(-1);
  const reportedResults = longLived
    ? (lastResult === null ? [] : [lastResult])
    : results;
  return {
    schemaVersion: SCHEMA_VERSION,
    status: last?.status ?? 'COMPLETED',
    stopReason: interrupted ? 'INTERRUPTED' : (last?.stopReason ?? 'COMPLETED'),
    continuationId: continuation.loopId,
    runs: completedRuns,
    metrics,
    results: reportedResults,
  };
}

function preferenceFor(modelDecision, required = false) {
  return modelDecision?.token === null || modelDecision?.token === undefined
    ? null
    : {
        schemaVersion: SCHEMA_VERSION,
        token: modelDecision.token,
        ...(required ? { required: true } : {}),
      };
}

async function requestAdvice({ advisor, ...input }) {
  let result;
  try {
    result = await advisor(input);
  } catch {
    return normalizedAdvice(null, 'MODEL_UNAVAILABLE');
  }
  return normalizedAdvice(result, null);
}

function normalizedAdvice(result, fallbackReason) {
  if (fallbackReason !== null || result === null || typeof result !== 'object' || Array.isArray(result)) {
    return fallbackAdvice(fallbackReason ?? 'INVALID_ADVISOR_RESULT');
  }
  try {
    const model = typeof result.model === 'string' && result.model.length > 0 && result.model.length <= 4096
      ? result.model
      : 'unknown';
    const hasToken = Object.hasOwn(result, 'token');
    const token = result.token;
    const tokenValid = hasToken && (token === null || (typeof token === 'string' && TOKEN_PATTERN.test(token)));
    const reasonValid = result.reason === undefined || result.reason === null ||
      (typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 256);
    const valid = tokenValid && reasonValid;
    const reason = valid ? (result.reason ?? null) : 'INVALID_ADVISOR_RESULT';
    const responseDigest = validDigest(result.responseDigest)
      ? result.responseDigest
      : canonicalDigest({ model, reason });
    const observationDigest = validDigest(result.observationDigest) ? result.observationDigest : null;
    return {
      schemaVersion: SCHEMA_VERSION,
      source: 'model',
      model,
      token: valid ? token : null,
      responseDigest,
      ...(observationDigest === null ? {} : { observationDigest }),
      reason,
    };
  } catch {
    return fallbackAdvice('INVALID_ADVISOR_RESULT');
  }
}

function fallbackAdvice(reason) {
  const model = 'unknown';
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'model',
    model,
    token: null,
    responseDigest: canonicalDigest({ model, reason }),
    reason,
  };
}

function planningEvidence(horizon, contextMode, branchingMode) {
  return {
    schemaVersion: SCHEMA_VERSION,
    horizon,
    ...(horizon > 1 ? { contextMode, branchingMode } :
      contextMode === 'legacy-v1' ? { contextMode } : {}),
  };
}

function requirePlanningBranchingMode(value) {
  if (!PLANNING_BRANCHING_MODES.includes(value)) {
    throw new LabStoreError('INVALID_INPUT', 'planningBranchingMode is invalid.', {
      field: 'planningBranchingMode',
    });
  }
  return value;
}

function assertExternalTransitionRetry(unresolved, request, state, planningHorizon, planningContextMode, planningBranchingMode) {
  const evidence = unresolved.evidence;
  const mismatches = [];
  if (request.executionNonce !== evidence.executionNonce) mismatches.push('executionNonce');
  if (request.token !== evidence.token) mismatches.push('token');
  if (request.basedOnVersion !== evidence.basedOnVersion) mismatches.push('basedOnVersion');
  if (canonicalDigest(state) !== evidence.beforeDigest) mismatches.push('beforeDigest');
  if ((evidence.planning?.horizon ?? 1) !== planningHorizon) mismatches.push('planningHorizon');
  if ((evidence.planning?.contextMode ?? 'legacy-v1') !== planningContextMode) mismatches.push('planningContextMode');
  if (evidence.planning?.branchingMode !== undefined && evidence.planning.branchingMode !== planningBranchingMode) {
    mismatches.push('planningBranchingMode');
  }
  if (mismatches.length > 0) {
    throw new LabStoreError(
      'CONFLICT',
      'An idempotent retry must reproduce the original external transition request exactly.',
      { runId: unresolved.runId, fields: mismatches, executionNonce: evidence.executionNonce },
    );
  }
}

async function requestPlan({ planner, goal, observation, observationEvidence, observationEvidenceTruncated, valueSpec, memory, manifest, plan = null, reason = null, step }) {
  let result;
  try {
    result = await planner({
      goal,
      observation,
      observationEvidence,
      observationEvidenceTruncated,
      valueSpec,
      memory,
      manifest,
      plan,
      reason,
      step,
    });
  } catch {
    return {
      plan: undefined,
      evidence: plannerEvidence(null, false, 'PLANNER_UNAVAILABLE'),
    };
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {
      plan: undefined,
      evidence: plannerEvidence(result, false, 'INVALID_PLANNER_RESULT'),
    };
  }
  try {
    const plan = materializePlannerPlan(result.plan, goal, valueSpec);
    return {
      plan,
      evidence: plannerEvidence(result, true, null),
    };
  } catch {
    return {
      plan: undefined,
      evidence: plannerEvidence(result, false, 'PLAN_REJECTED'),
    };
  }
}

function materializePlannerPlan(candidate, rootGoal, valueSpec) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) ||
      !Array.isArray(candidate.stages) || candidate.stages.length < 1 || candidate.stages.length > 128) {
    throw new Error('Planner proposal must contain a bounded stage list.');
  }
  const base = kernelValueSpec(valueSpec);
  delete base.valueMode;
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    rootGoal: candidate.rootGoal ?? rootGoal,
    stages: candidate.stages.map((stage) => {
      if (stage === null || typeof stage !== 'object' || Array.isArray(stage) ||
          typeof stage.id !== 'string' || typeof stage.goal !== 'string') {
        throw new Error('Planner stage identity is invalid.');
      }
      const target = stage.target;
      if (!Array.isArray(target) || target.length !== base.observationDimensions ||
          target.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Planner stage target is invalid.');
      }
      return {
        id: stage.id,
        goal: stage.goal,
        objective: {
          ...base,
          target: [...target],
        },
      };
    }),
  };
  return createChangeSupervisor({
    goal: rootGoal,
    enabled: true,
    plan,
    valueSpec,
    maxCycles: 1,
    stagnationLimit: 1,
  }).plan;
}

function plannerEvidence(result, applied, reason) {
  const model = typeof result?.model === 'string' && result.model.length > 0 && result.model.length <= 4096
    ? result.model
    : 'unknown';
  const responseDigest = typeof result?.responseDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(result.responseDigest)
    ? result.responseDigest
    : canonicalDigest({ model, reason });
  const observationDigest = validDigest(result?.observationDigest) ? result.observationDigest : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'model',
    model,
    responseDigest,
    ...(observationDigest === null ? {} : { observationDigest }),
    applied,
    reason,
  };
}

function policyEvidence(modelDecision, intent, capabilities) {
  const safe = capabilities.some((capability) => capability.token === modelDecision.token && capability.allowed && capability.safe);
  const applied = safe && intent.status === 'READY' && intent.choice.token === modelDecision.token;
  const observationDigest = validDigest(modelDecision.observationDigest) ? modelDecision.observationDigest : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'model',
    model: modelDecision.model,
    token: modelDecision.token,
    responseDigest: modelDecision.responseDigest,
    ...(observationDigest === null ? {} : { observationDigest }),
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
  const recordedBoundary = run?.events?.findLast((event) => event.kind === 'STEP')?.payload?.boundary;
  const recordedCapabilities = recordedBoundary?.afterCapabilities ?? recordedBoundary?.capabilities;
  const actions = selectedAction?.payload?.boundary?.capabilities
    ?? (manifest.adapter
      ? recordedCapabilities ?? manifestCapabilities(manifest)
      : (() => {
        const world = registry.createWorld(
          manifest,
          run?.start?.scenario ?? manifest.scenarioIds?.[0] ?? 'steady',
        );
          const actionState = run?.events?.at(-1)?.payload?.finalState?.worldState
            ?? inspection.current.worldState
            ?? world.initialState();
        return world.actions(worldManifest(manifest), actionState);
        })());
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
    assertManifest(manifest) {
      const definition = registry.worldDefinition(manifest?.worldId);
      if (manifest?.worldVersion === undefined) return;
      if (typeof definition?.worldVersion !== 'string' || definition.worldVersion.length === 0 ||
          manifest.worldVersion !== definition.worldVersion) {
        throw new LabStoreError('CONFLICT', 'The supplied WorldPort does not match the lab world contract.', {
          field: 'worldVersion',
          expected: definition?.worldVersion ?? null,
          actual: manifest.worldVersion,
        });
      }
      if (manifest.worldImplementationDigest !== undefined &&
          (typeof definition?.worldImplementationDigest !== 'string' ||
            manifest.worldImplementationDigest !== definition.worldImplementationDigest)) {
        throw new LabStoreError('CONFLICT', 'The supplied WorldPort implementation does not match the lab world contract.', {
          field: 'worldImplementationDigest',
          expected: definition?.worldImplementationDigest ?? null,
          actual: manifest.worldImplementationDigest,
        });
      }
    },
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
  const projected = {
    schemaVersion: observation.schemaVersion,
    vector: [...observation.vector],
    stateVersion: observation.stateVersion,
    intervalId: observation.intervalId,
  };
  if (observation.feedback !== undefined) {
    projected.feedback = observation.feedback.map((item) => ({
      schemaVersion: item.schemaVersion,
      executionNonce: item.executionNonce,
      stateVersion: item.stateVersion,
      intervalId: item.intervalId,
      vector: [...item.vector],
      confounderCount: item.confounderCount,
    }));
  }
  return projected;
}

function validDigest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function kernelValueSpec(valueSpec) {
  return {
    schemaVersion: valueSpec.schemaVersion,
    observationDimensions: valueSpec.observationDimensions,
    weights: [...valueSpec.weights],
    target: [...valueSpec.target],
    tolerance: valueSpec.tolerance ?? 0,
    valueMode: 'distance-v2',
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
