import { canonicalDigest, cloneJson, SCHEMA_VERSION } from '../runtime/schema.mjs';

export function buildInspectView({ manifest, current, run = null, actions, valueSpec: goal, selectedAction = null }) {
  const latestStep = selectedAction ?? run?.events?.findLast((event) => event.kind === 'STEP') ?? null;
  const terminal = run?.events?.at(-1);
  const viewState = terminal?.payload?.finalState ?? current;
  const actionModels = viewState.memory?.actionModels ?? {};
  const relationModels = viewState.memory?.relationModels ?? {};
  const viewRunId = run?.start?.runId ?? current.lastRunId;
  const viewStatus = run === null ? current.status : terminal?.payload?.terminalStatus === 'COMPLETED' ? 'READY' : 'HALTED';
  return {
    schemaVersion: SCHEMA_VERSION,
    lab: {
      labId: manifest.labId,
      worldId: manifest.worldId,
      seed: manifest.seed,
    },
    run: {
      runId: viewRunId,
      status: viewStatus,
      sequence: run?.end?.finalSequence ?? current.lastRunSequence,
      eventsDigest: run?.end?.finalEventDigest ?? current.eventsDigest,
    },
    boundary: viewRunId === null ? null : cloneJson(viewState.worldState),
    goal: cloneJson(goal),
    constraints: {
      policyVersion: manifest.authorityPolicy?.policyVersion ?? null,
      constraintsDigest: manifest.authorityPolicy?.constraintsDigest ?? null,
      actions: cloneJson(actions),
    },
    facts: {
      worldState: viewRunId === null ? null : cloneJson(viewState.worldState),
      kernelStep: viewState.kernelStep,
      memoryDigest: canonicalDigest(viewState.memory),
      relationModelCount: countRelationModels(relationModels),
      changeSupervisor: viewRunId === null ? null : cloneJson(viewState.changeSupervisor ?? null),
    },
    hypotheses: Object.fromEntries(
      actions.map((action) => [action.token, {
        model: actionModels[action.token] ? cloneJson(actionModels[action.token]) : null,
        relationModels: relationModels[action.token] ? cloneJson(relationModels[action.token]) : {},
        sampleCount: actionModels[action.token]?.sampleCount ?? 0,
        uncertainty: actionModels[action.token]?.uncertainty ?? null,
      }]),
    ),
    recent: latestStep === null ? null : {
      sequence: latestStep.sequence,
      attribution: latestStep.payload.verification.attribution,
      confidence: latestStep.payload.verification.confidence,
      token: latestStep.payload.choice.token,
      evidence: `${latestStep.runId}:${latestStep.sequence}`,
    },
    selectedAction: selectedAction === null ? null : {
      runId: selectedAction.runId,
      sequence: selectedAction.sequence,
      beforeDigest: selectedAction.payload.beforeDigest,
      afterDigest: selectedAction.payload.afterDigest,
      expectation: cloneJson(selectedAction.payload.expectation),
      choice: cloneJson(selectedAction.payload.choice),
      receipt: cloneJson(selectedAction.payload.receipt),
      verification: cloneJson(selectedAction.payload.verification),
      evidence: `${selectedAction.runId}:${selectedAction.sequence}`,
    },
    stopReason: viewStatus === 'HALTED'
      ? latestStep?.payload.receipt.status === 'REJECTED' ? 'EXECUTION_REJECTED' : 'HALTED'
      : null,
  };
}

function countRelationModels(value) {
  return Object.values(value).reduce((sum, relations) => sum + Object.keys(relations).length, 0);
}
