import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  MAX_PERSISTED_EVENT_BYTES,
  MAX_CANDIDATE_HISTORY,
  MAX_CANDIDATE_PROPOSAL_BYTES,
  MAX_MODEL_PROPOSAL_BYTES,
  candidateDigest,
  canonicalDigest,
  canonicalJson,
  cloneJson,
  verifySelfDigest,
  withSelfDigest,
} from './schema.mjs';
import { isValidCandidateOutcome } from './candidate-evidence.mjs';
import { annotateCandidateHistory } from './candidate-history.mjs';
import {
  externalInputUnsigned,
  isValidEvidencePublicKey,
  verifyExternalInputAttestation,
} from './external-evidence.mjs';
import { createChangeSupervisor, normalizeChangeSupervisorState } from '../agent/change-supervisor.mjs';

const TERMINAL_KINDS = new Set(['RUN_COMPLETED', 'RUN_HALTED']);
const MAX_JSON_BYTES = MAX_PERSISTED_EVENT_BYTES;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = MAX_PERSISTED_EVENT_BYTES;
const MAX_RECENT_COMMITTED_STEPS = 32;
const DURABILITY_MODES = new Set(['strict', 'checkpoint']);
const EXTERNAL_TRANSITION_MARKER = 'external-transition.json';
const MAX_PLANNING_HORIZON = 8;
const PLANNING_CONTEXT_MODES = ['context-v1', 'legacy-v1'];
const PLANNING_BRANCHING_MODES = ['tree-v1', 'recursive-v1', 'legacy-v1'];
const MAX_WORLD_VERSION_LENGTH = 4096;
const WORLD_IMPLEMENTATION_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const INTERNAL_RUN_APPEND = Symbol('yi-agent.internal-run-append');
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const LEGACY_WORLD_SCENARIOS = {
  temperature: new Set(['steady', 'regime-shift', 'external-during-step', 'execution-rejected', 'all-unsafe']),
  'virtual-desktop': new Set(['steady', 'new-files', 'external-during-step', 'execution-rejected', 'all-unsafe']),
};

export class LabStoreError extends Error {
  constructor(code, message, context = {}, options = {}) {
    super(message, options);
    this.name = 'LabStoreError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export class LabStore {
  constructor(root, manifest) {
    this.root = root;
    this.manifest = cloneJson(manifest);
  }

  static async init(options) {
    const input = requireObject(options, 'init options');
    const labId = requireText(input.labId, 'labId');
    const worldId = requireText(input.worldId, 'worldId');
    const seed = requireText(input.seed, 'seed');
    const worldVersion = input.worldVersion === undefined
      ? null
      : requireWorldVersion(input.worldVersion, 'worldVersion');
    const worldImplementationDigest = input.worldImplementationDigest === undefined
      ? null
      : requireWorldImplementationDigest(input.worldImplementationDigest, 'worldImplementationDigest');
    const scenarioIds = input.scenarioIds === undefined
      ? null
      : normalizeScenarioIds(input.scenarioIds, 'scenarioIds');
    const root = await canonicalizeInitPath(requireText(input.labPath, 'labPath'));
    const tokenMap = input.tokenMap === undefined
      ? { schemaVersion: SCHEMA_VERSION, entries: [] }
      : cloneInputJson(requireObject(input.tokenMap, 'tokenMap'), 'tokenMap');
    const authorityPolicy = input.authorityPolicy === undefined
      ? null
      : cloneInputJson(requireObject(input.authorityPolicy, 'authorityPolicy'), 'authorityPolicy');
    const adapter = input.adapter === undefined
      ? null
      : normalizeAdapterMetadata(input.adapter, 'adapter');

    await mkdir(root, { recursive: true });
    await assertDirectoryIsCanonical(root, root);

    const manifestPath = childPath(root, 'manifest.json');
    if (await pathExists(manifestPath)) {
      const manifest = await readVerifiedObject(manifestPath, 'manifest');
      const expected = { labId, worldId, seed, canonicalRoot: root };
      for (const [field, value] of Object.entries(expected)) {
        if (manifest[field] !== value) {
          conflict('Existing lab configuration differs.', { field });
        }
      }
      if (worldVersion !== null && manifest.worldVersion !== undefined && manifest.worldVersion !== worldVersion) {
        conflict('Existing lab world contract differs.', { field: 'worldVersion' });
      }
      if (worldImplementationDigest !== null && manifest.worldImplementationDigest !== undefined &&
          manifest.worldImplementationDigest !== worldImplementationDigest) {
        conflict('Existing lab world implementation contract differs.', { field: 'worldImplementationDigest' });
      }
      if (scenarioIds !== null
        && manifest.scenarioIds !== undefined
        && canonicalJson(manifest.scenarioIds) !== canonicalJson(scenarioIds)) {
        conflict('Existing lab scenario contract differs.', { field: 'scenarioIds' });
      }
      if (adapter !== null
        && manifest.adapter !== undefined
        && canonicalJson(manifest.adapter) !== canonicalJson(adapter)) {
        conflict('Existing lab adapter contract differs.', { field: 'adapter' });
      }
      await validateInitializedLab(root, manifest);
      await cleanupCompletedInitialization(root, { labId, worldId, seed });
      return new LabStore(root, manifest);
    }

    await prepareInitializationTarget(root, { labId, worldId, seed });
    const markerPath = childPath(root, '.initializing');
    const ownerNonce = randomUUID();
    const marker = {
      schemaVersion: SCHEMA_VERSION,
      labId,
      worldId,
      seed,
      createdAt: now(),
      ownerNonce,
      stagingFiles: [
        `state/current.json.staging-init-${ownerNonce}`,
        `manifest.json.staging-init-${ownerNonce}`,
      ],
    };
    await writeFileFlushed(markerPath, `${canonicalJson(marker)}\n`, { exclusive: true });

    try {
      const manifestTokenMap = cloneJson(tokenMap);
      if (manifestTokenMap.digest === undefined) manifestTokenMap.digest = canonicalDigest(manifestTokenMap);
      const manifest = withSelfDigest({
        schemaVersion: SCHEMA_VERSION,
        labId,
        worldId,
        seed,
        ...(worldVersion === null ? {} : { worldVersion }),
        ...(worldImplementationDigest === null ? {} : { worldImplementationDigest }),
        createdAt: marker.createdAt,
        canonicalRoot: root,
        tokenMap: manifestTokenMap,
        ...(scenarioIds === null ? {} : { scenarioIds }),
        ...(adapter === null ? {} : { adapter }),
        ...(authorityPolicy === null ? {} : { authorityPolicy }),
      });
      const current = withSelfDigest({
        schemaVersion: SCHEMA_VERSION,
        worldState: null,
        memory: {},
        rngState: null,
        kernelStep: 0,
        lastRunId: null,
        lastRunSequence: 0,
        status: 'READY',
        eventsDigest: null,
      });

      await ensurePlainDirectory(root, 'state');
      await atomicWriteJson(
        root,
        childPath(root, 'state', 'current.json'),
        current,
        undefined,
        false,
        childPath(root, 'state', `current.json.staging-init-${ownerNonce}`),
      );
      await atomicWriteJson(
        root,
        manifestPath,
        manifest,
        undefined,
        false,
        childPath(root, `manifest.json.staging-init-${ownerNonce}`),
      );
      await rm(markerPath);
      await validateInitializedLab(root, manifest);
      return new LabStore(root, manifest);
    } catch (error) {
      throw normalizeError(error, 'INIT_FAILED', 'Lab initialization failed.');
    }
  }

  static async open(options) {
    const input = requireObject(options, 'open options');
    const root = await canonicalizeExistingLab(requireText(input.labPath, 'labPath'));
    const manifest = await readVerifiedObject(childPath(root, 'manifest.json'), 'manifest');
    await validateInitializedLab(root, manifest);
    return new LabStore(root, manifest);
  }

  static async recover(options) {
    const input = requireObject(options, 'recovery options');
    const root = await canonicalizeExistingLab(requireText(input.labPath, 'labPath'));
    const manifest = await readVerifiedObject(childPath(root, 'manifest.json'), 'manifest');
    await validateInitializedLab(root, manifest);
    const failpoint = typeof input.failpoint === 'function' ? input.failpoint : undefined;
    const livenessProbe = typeof input.livenessProbe === 'function'
      ? input.livenessProbe
      : defaultLivenessProbe;
    const command = typeof input.command === 'string' ? input.command : 'recover';
    const expectedLock = input.expectedLock === undefined ? null : input.expectedLock;
    if (expectedLock !== null) validateWriterLock(expectedLock, manifest);

    const completed = await findRecoveryRecords(root, manifest);
    if (completed.pending.length > 1) {
      corrupt('Recovery evidence has multiple branches.', { phase: 'recovery-scan' });
    }

    const lockPath = childPath(root, 'locks', 'writer.lock');
    let lock = await readOptionalJson(lockPath);

    if (lock !== null) {
      validateWriterLock(lock, manifest);
      const finishedForLock = lock.purpose === 'recovery'
        ? completed.finished.filter((candidate) => candidate.intent.selfDigest === lock.intentDigest)
        : [];
      if (finishedForLock.length === 1) {
        const record = finishedForLock[0];
        const current = await readVerifiedObject(childPath(root, 'state', 'current.json'), 'current');
        if (record.completion.finalCurrentDigest !== current.selfDigest) {
          corrupt('Recovery completion conflicts with current.', { phase: 'completion' });
        }
        await removeOwnedLock(root, lock);
        await validateRecoveryCompletion(root, manifest, record, current);
        return recoveryResult(record.completion.reason, current, record.ownerNonce);
      }
    }

    if (lock === null && completed.pending.length === 0) {
      const current = await readVerifiedObject(childPath(root, 'state', 'current.json'), 'current');
      const matching = completed.finished.filter((candidate) => (
        candidate.completion.finalCurrentDigest === current.selfDigest
      ));
      if (matching.length >= 1) {
        const record = matching.sort((left, right) => (
          left.completion.completedAt.localeCompare(right.completion.completedAt) ||
          left.ownerNonce.localeCompare(right.ownerNonce)
        )).at(-1);
        return recoveryResult(record.completion.reason, current, record.ownerNonce);
      }
      if (expectedLock !== null && current.status !== 'RUNNING') {
        if (await probeOwner(livenessProbe, expectedLock)) {
          throw new LabStoreError('LIVE_OWNER', 'Writer owner is still live.', { pid: expectedLock.pid });
        }
        return recoveryResult('ALREADY_TERMINAL', current, expectedLock.ownerNonce);
      }
      corrupt('No active or idempotently completed recovery exists.', { phase: 'completion' });
    }

    let record = completed.pending[0] ?? null;
    if (lock !== null) {
      validateWriterLock(lock, manifest);
      if (await probeOwner(livenessProbe, lock)) {
        throw new LabStoreError('LIVE_OWNER', 'Writer owner is still live.', { pid: lock.pid });
      }

      if (lock.purpose === 'recovery') {
        if (record === null || lock.intentDigest !== record.intent.selfDigest) {
          corrupt('Recovery lock has no matching intent.', { phase: 'recovery-lock' });
        }
        await archiveRecoveryLock(root, record, lock);
        record.stale ??= lock;
      } else {
        if (record !== null && record.intent.writerLockDigest !== lock.selfDigest) {
          await archiveBlockedContender(root, record, lock);
        } else {
          record ??= await publishRecoveryIntent(root, lock, command);
          inject(failpoint, 'recovery:intent-published');
          await archiveOriginalLock(root, record, lock);
          record.stale = lock;
        }
      }
      lock = null;
      inject(failpoint, 'recovery:stale-lock-archived');
    }

    if (record === null) {
      corrupt('No writer lock or pending recovery intent exists.', { phase: 'recovery-start' });
    }
    if (lock === null && record.stale === null) {
      corrupt('Recovery intent has neither live lock nor archived lock evidence.', { phase: 'recovery-start' });
    }

    const recoveryLock = await acquireRecoveryLock(root, manifest, record.intent);
    inject(failpoint, 'recovery:canonical-lock-acquired');

    try {
      const outcome = await recoverRun(root, manifest);
      const current = outcome.current;
      const completion = withSelfDigest({
        schemaVersion: SCHEMA_VERSION,
        intentDigest: record.intent.selfDigest,
        finalCurrentDigest: current.selfDigest,
        reason: outcome.reason,
        completedAt: now(),
      });
      const completionPath = childPath(root, 'recovery', record.ownerNonce, 'completion.json');
      await publishImmutableJson(root, completionPath, completion, 'recovery completion');
      await removeOwnedLock(root, recoveryLock);
      return recoveryResult(outcome.reason, current, record.ownerNonce);
    } catch (error) {
      throw normalizeError(error, 'RECOVERY_FAILED', 'Recovery failed.');
    }
  }

  async inspect() {
    await assertDirectoryIsCanonical(this.root, this.root);
    const current = await readVerifiedObject(childPath(this.root, 'state', 'current.json'), 'current');
    validateCurrentShape(current);
    if (current.lastRunId !== null) {
      const runId = requireSafeSegment(current.lastRunId, 'runId');
      const start = await readVerifiedObject(childPath(this.root, 'runs', runId, 'start.json'), 'run start');
      validateStart(start, this.manifest, runId);
      const events = await readLedger(this.root, runId, start, {
        maxSequence: current.status === 'RUNNING' ? current.lastRunSequence : undefined,
      }, this.manifest);
      validateLedgerIdentity(start, events);
      validateCurrentReference(current, runId, events);
      validateCurrentProjection(current, start, events);
    }
    return { manifest: cloneJson(this.manifest), current };
  }

  async readWriterLock() {
    await assertDirectoryIsCanonical(this.root, this.root);
    const lock = await readOptionalJson(childPath(this.root, 'locks', 'writer.lock'));
    if (lock !== null) validateWriterLock(lock, this.manifest);
    return lock === null ? null : cloneJson(lock);
  }

  async readRun(runId) {
    const safeRunId = requireSafeSegment(runId, 'runId');
    await assertDirectoryIsCanonical(this.root, this.root);
    const start = await readVerifiedObject(
      childPath(this.root, 'runs', safeRunId, 'start.json'),
      'run start',
    );
    validateStart(start, this.manifest, safeRunId);
    const events = await readLedger(this.root, safeRunId, start, {}, this.manifest);
    validateLedgerIdentity(start, events);
    const end = await readOptionalVerifiedObject(
      childPath(this.root, 'runs', safeRunId, 'end.json'),
      'run end',
    );
    if (end === null) throw new LabStoreError('BUSY', 'Run is not terminal.', { runId: safeRunId });
    validateEnd(end, safeRunId, events);
    return {
      manifest: cloneJson(this.manifest),
      start: cloneJson(start),
      // readLedger already parsed and validated each event. Re-serializing the
      // entire decoded ledger here creates one giant canonical JSON string and
      // makes highly compressible, bounded STEP histories fail with
      // RangeError even though the ledger itself is within its byte budget.
      events,
      end: cloneJson(end),
    };
  }

  async readCandidateOutcomes(limit = MAX_CANDIDATE_HISTORY) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATE_HISTORY) {
      throw new LabStoreError('INVALID_INPUT', 'candidate outcome history limit is invalid.', { field: 'limit' });
    }
    const current = await readVerifiedObject(childPath(this.root, 'state', 'current.json'), 'current');
    validateCurrentShape(current);
    const outcomes = [];
    for (const runId of await listRunIds(this.root)) {
      if (current.status === 'RUNNING' && runId === current.lastRunId) continue;
      let run;
      try {
        run = await this.readRun(runId);
      } catch (error) {
        if (error instanceof LabStoreError && error.code === 'BUSY' && runId === current.lastRunId) continue;
        throw error;
      }
      for (const event of run.events) {
        if (event.kind !== 'STEP' || event.payload.candidateOutcome === undefined) continue;
        const proposal = event.payload.policyEvidence?.proposal;
        let proposalSummary = {};
        if (proposal !== undefined) {
          const proposalJson = canonicalJson(proposal);
          const proposalDigest = canonicalDigest(proposal);
          proposalSummary = Buffer.byteLength(proposalJson, 'utf8') <= MAX_CANDIDATE_PROPOSAL_BYTES
            ? { proposal: cloneJson(proposal), proposalDigest }
            : { proposalDigest, proposalTruncated: true };
        }
        outcomes.push({
          runId,
          worldId: run.start.worldId,
          scenario: run.start.scenario,
          worldVersion: run.manifest.worldVersion,
          tokenMapDigest: run.manifest.tokenMap.digest,
          sequence: event.sequence,
          recordedAt: event.payload.recordedAt,
          kernelStep: event.payload.afterState.kernelStep,
          candidateOutcome: cloneJson(event.payload.candidateOutcome),
          valueSpec: cloneJson(event.payload.boundary.valueSpec),
          beforeVector: [...event.payload.beforeObservation.vector],
          afterVector: [...event.payload.postObservation.vector],
          ...(event.payload.policyEvidence?.observationDigest === undefined
            ? {}
            : { observationDigest: event.payload.policyEvidence.observationDigest }),
          ...proposalSummary,
        });
      }
    }
    outcomes.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) ||
      left.runId.localeCompare(right.runId) || left.sequence - right.sequence);
    return cloneJson(annotateCandidateHistory(outcomes).slice(-limit));
  }

  async readLoopContinuation() {
    const current = await readVerifiedObject(childPath(this.root, 'state', 'current.json'), 'current');
    validateCurrentShape(current);
    if (current.status === 'RUNNING') {
      throw new LabStoreError('BUSY', 'The current run requires recovery before a loop can resume.', {
        runId: current.lastRunId,
      });
    }
    const groups = new Map();
    for (const runId of await listRunIds(this.root)) {
      const run = await this.readRun(runId);
      if (run.start.continuation === undefined) continue;
      const continuation = validateLoopContinuation(run.start.continuation, 'run continuation', true);
      const group = groups.get(continuation.loopId) ?? { continuation, runs: [] };
      group.runs.push(run);
      groups.set(continuation.loopId, group);
    }
    for (const group of groups.values()) {
      group.planningBranchingMode = inferLoopPlanningBranchingMode(group);
      for (const run of group.runs) {
        if (canonicalJson(loopContract(group.continuation, group.planningBranchingMode)) !==
            canonicalJson(loopContract(run.start.continuation, group.planningBranchingMode))) {
          corrupt('Loop continuation contract differs across runs.', { loopId: group.continuation.loopId });
        }
      }
    }
    if (groups.size === 0) {
      throw new LabStoreError('NOT_FOUND', 'No persisted loop continuation exists.', {});
    }
    const candidates = [...groups.values()].map((group) => summarizeLoopContinuation(group));
    const active = candidates.filter((candidate) => candidate.status === 'ACTIVE');
    if (active.length > 1) {
      throw new LabStoreError('CONFLICT', 'Multiple active loop continuations exist; they cannot be resumed implicitly.', {
        loopIds: active.map((candidate) => candidate.loopId),
      });
    }
    return cloneJson((active[0] ?? candidates.sort((left, right) => (
      right.lastStartedAt.localeCompare(left.lastStartedAt) || right.loopId.localeCompare(left.loopId)
    )).at(0)));
  }

  async readCurrentLoopContinuation() {
    const current = await readVerifiedObject(childPath(this.root, 'state', 'current.json'), 'current');
    validateCurrentShape(current);
    if (current.status === 'RUNNING') {
      throw new LabStoreError('BUSY', 'The current run requires recovery before a loop can resume.', {
        runId: current.lastRunId,
      });
    }
    if (current.lastRunId === null) {
      throw new LabStoreError('NOT_FOUND', 'No persisted loop continuation exists.', {});
    }
    const run = await this.readRun(current.lastRunId);
    if (run.start.continuation === undefined) {
      throw new LabStoreError('NOT_FOUND', 'No persisted loop continuation exists.', {});
    }
    const continuation = validateLoopContinuation(run.start.continuation, 'run continuation', true);
    if (continuation.planningBranchingMode === undefined) {
      return this.readLoopContinuation();
    }
    const group = { continuation, runs: [run] };
    group.planningBranchingMode = inferLoopPlanningBranchingMode(group);
    return cloneJson(summarizeLatestLoopRun(group.continuation, group.planningBranchingMode, run));
  }

  async findUnresolvedExternalTransition() {
    const current = await readVerifiedObject(childPath(this.root, 'state', 'current.json'), 'current');
    validateCurrentShape(current);
    const runIds = await listRunIds(this.root);
    const runs = [];
    for (const runId of runIds) {
      if (runId === current.lastRunId && current.status === 'RUNNING') continue;
      runs.push(await this.readRun(runId));
    }
    const committed = runs.flatMap((run) => run.events
      .filter((event) => event.kind === 'STEP')
      .map((event) => ({ run, event })));
    const unknowns = runs.flatMap((run) => {
      const terminal = run.events.at(-1);
      if (terminal?.payload?.reason !== 'EXTERNAL_TRANSITION_UNKNOWN') return [];
      const evidence = terminal.payload.externalTransition;
      if (evidence === undefined) return [{ legacy: true, runId: run.start.runId, scenario: run.start.scenario }];
      validateExternalTransitionEvidence(evidence, run.start.runId, run.start.scenario);
      return [{ legacy: false, runId: run.start.runId, scenario: run.start.scenario, evidence }];
    });
    const unresolved = unknowns.filter((candidate) => candidate.legacy || !committed.some(({ run, event }) =>
      run.start.scenario === candidate.scenario && candidate.evidence !== undefined &&
      event.payload.receipt.executionNonce === candidate.evidence.executionNonce &&
      event.payload.receipt.token === candidate.evidence.token &&
      event.payload.receipt.basedOnVersion === candidate.evidence.basedOnVersion &&
      event.payload.beforeDigest === candidate.evidence.beforeDigest));
    if (unresolved.length === 0) return null;
    const first = unresolved[0];
    if (unresolved.some((candidate) => (
      candidate.legacy !== first.legacy ||
      candidate.scenario !== first.scenario ||
      canonicalJson(externalTransitionIdentity(candidate.evidence)) !== canonicalJson(externalTransitionIdentity(first.evidence))
    ))) {
      corrupt('Multiple unresolved external transitions conflict.', { phase: 'external-transition-scan' });
    }
    return cloneJson(first);
  }

  async startRun(input) {
    const source = requireObject(input, 'run input');
    const runId = requireSafeSegment(source.runId, 'runId');
    const worldId = requireText(source.worldId, 'worldId');
    const scenario = requireText(source.scenario, 'scenario');
    if (worldId !== this.manifest.worldId) {
      conflict('Run worldId differs from the manifest.', { field: 'worldId' });
    }
    if (!scenarioAllowed(this.manifest, scenario)) {
      throw new LabStoreError('INVALID_INPUT', 'Run scenario is unsupported.', { field: 'scenario' });
    }
    const initialState = cloneInputJson(requireObject(source.initialState, 'initialState'), 'initialState');
    validateContinuityState(initialState, 'initialState');
    const continuation = source.continuation === undefined
      ? undefined
      : validateLoopContinuation(source.continuation, 'continuation');
    const failpoint = typeof source.failpoint === 'function' ? source.failpoint : undefined;
    const durability = source.durability ?? 'strict';
    if (!DURABILITY_MODES.has(durability)) {
      throw new LabStoreError('INVALID_INPUT', 'durability must be strict or checkpoint.', { field: 'durability' });
    }

    await assertDirectoryIsCanonical(this.root, this.root);
    await ensurePlainDirectory(this.root, 'locks');
    const writerLock = await acquireWriterLock(this.root, this.manifest, 'run');
    let durable = false;
    let runDirectory = null;
    try {
      if (await hasPendingRecovery(this.root, this.manifest)) {
        await removeOwnedLock(this.root, writerLock);
        throw new LabStoreError('BUSY', 'A recovery intent is pending.', { phase: 'pending-recovery' });
      }

      const previousCurrent = await readVerifiedObject(childPath(this.root, 'state', 'current.json'), 'current');
      validateCurrentShape(previousCurrent);
      if (previousCurrent.lastRunId !== null) {
        const previousRunId = requireSafeSegment(previousCurrent.lastRunId, 'runId');
        const previousStart = await readVerifiedObject(childPath(this.root, 'runs', previousRunId, 'start.json'), 'run start');
        validateStart(previousStart, this.manifest, previousRunId);
        const previousEvents = await readLedger(this.root, previousRunId, previousStart, {}, this.manifest);
        validateLedgerIdentity(previousStart, previousEvents);
        validateCurrentReference(previousCurrent, previousRunId, previousEvents);
        validateCurrentProjection(previousCurrent, previousStart, previousEvents);
      }
      if (previousCurrent.status === 'RUNNING') {
        await removeOwnedLock(this.root, writerLock);
        throw new LabStoreError('BUSY', 'The current run requires recovery.', { phase: 'current-running' });
      }
      if (previousCurrent.status === 'CORRUPT') corrupt('A corrupt lab cannot start a run.', {});
      let existingContinuation = null;
      try {
        existingContinuation = await this.readCurrentLoopContinuation();
      } catch (error) {
        if (error?.code !== 'NOT_FOUND') throw error;
      }
      if (continuation !== undefined &&
          (existingContinuation === null || existingContinuation.loopId !== continuation.loopId) &&
          continuation.runIndex !== 0) {
        conflict('A new loop continuation must start at run index zero.', {
          continuationId: continuation.loopId,
          runIndex: continuation.runIndex,
        });
      }
      if (existingContinuation?.status === 'ACTIVE') {
        if (existingContinuation.loopId !== continuation?.loopId) {
          conflict('An unfinished loop continuation already owns this lab.', {
            continuationId: existingContinuation.loopId,
          });
        }
        if (canonicalJson(loopContract(existingContinuation)) !==
            canonicalJson(loopContract(continuation, existingContinuation.planningBranchingMode))) {
          conflict('Loop continuation contract differs from the persisted owner.', {
            continuationId: existingContinuation.loopId,
          });
        }
        if (continuation.runIndex !== existingContinuation.nextRunIndex) {
          conflict('Run index does not match the persisted loop continuation.', {
            continuationId: existingContinuation.loopId,
            expectedRunIndex: existingContinuation.nextRunIndex,
            runIndex: continuation.runIndex,
          });
        }
      } else if (
        existingContinuation !== null &&
        existingContinuation.loopId === continuation?.loopId
      ) {
        conflict('A completed loop continuation cannot start another Run.', {
          continuationId: existingContinuation.loopId,
          status: existingContinuation.status,
        });
      }
      if (
        previousCurrent.lastRunId !== null &&
        !sameContinuityState(stateProjection(previousCurrent, previousCurrent), initialState)
      ) {
        conflict('Run initialState differs from current continuity state.', { runId });
      }

      await ensurePlainDirectory(this.root, 'runs');
      runDirectory = childPath(this.root, 'runs', runId);
      try {
        await mkdir(runDirectory);
      } catch (error) {
        if (error?.code === 'EEXIST') conflict('Run already exists.', { runId });
        throw error;
      }
      await assertDirectoryIsCanonical(this.root, runDirectory);

      const start = withSelfDigest({
        schemaVersion: SCHEMA_VERSION,
        runId,
        worldId,
        scenario,
        tokenMapDigest: this.manifest.tokenMap.digest,
        manifestDigest: this.manifest.selfDigest,
        initialState,
        ...(continuation === undefined ? {} : { continuation }),
        startedAt: now(),
      });
      if (start.continuation !== undefined && start.continuation.scenario !== scenario) {
        conflict('Run continuation scenario differs from the run scenario.', { runId, scenario });
      }
      await publishImmutableJson(this.root, childPath(this.root, 'runs', runId, 'start.json'), start, 'run start');
      durable = true;
      inject(failpoint, 'start:published');

      const startedEvent = await appendLedgerEvent(this.root, runId, 1, null, {
        kind: 'RUN_STARTED',
        payload: {
          startDigest: start.selfDigest,
          worldId,
          scenario,
        },
      });
      inject(failpoint, 'RUN_STARTED:appended');

      const current = currentFromState(initialState, {
        lastRunId: runId,
        lastRunSequence: startedEvent.sequence,
        status: 'RUNNING',
        eventsDigest: startedEvent.digest,
      });
      await atomicWriteJson(this.root, childPath(this.root, 'state', 'current.json'), current);
      inject(failpoint, 'current:running');

      const writerLockIdentity = await captureWriterLockIdentity(this.root, writerLock);
      return new ActiveRun(
        this,
        start,
        writerLock,
        startedEvent,
        failpoint,
        source.reuseLedgerHandle === true || durability === 'checkpoint',
        durability,
        writerLockIdentity,
      );
    } catch (error) {
      if (!durable && error?.code !== 'BUSY') {
        await removeOwnedLock(this.root, writerLock).catch(() => {});
        if (runDirectory !== null) await removeEmptyDirectory(runDirectory);
      }
      throw normalizeError(error, 'RUN_START_FAILED', 'Run start failed.', { runId });
    }
  }
}

class ActiveRun {
  constructor(store, start, writerLock, lastEvent, failpoint, reuseLedgerHandle, durability, writerLockIdentity) {
    this.store = store;
    this.start = start;
    this.writerLock = writerLock;
    this.lastEvent = lastEvent;
    this.failpoint = failpoint;
    this.reuseLedgerHandle = reuseLedgerHandle;
    this.durability = durability;
    this.writerLockIdentity = writerLockIdentity;
    this.terminal = false;
    this.terminalEvidence = false;
    this.operationTail = Promise.resolve();
    this.lastStepState = null;
    this.expectedState = cloneJson(start.initialState);
    this.expectedStateDigest = canonicalDigest(this.expectedState);
    this.committedSteps = new Map();
    this.knownExecutionNonces = new Set();
    this.needsLedgerReconcile = false;
    this.ledgerHandle = null;
    this.ledgerBytes = null;
  }

  append(input, options = {}) {
    return this.runExclusive(() => this.appendExclusive(input, options));
  }

  async appendExclusive(input, options = {}) {
    if (this.terminal || this.terminalEvidence) {
      throw new LabStoreError('BUSY', 'Run already has terminal evidence.', { runId: this.start.runId });
    }
    await assertOwnedLock(this.store.root, this.writerLockIdentity);
    const source = requireObject(input, 'event');
    const kind = requireText(source.kind, 'event.kind');
    if (kind === 'RUN_STARTED' || TERMINAL_KINDS.has(kind)) {
      conflict('Reserved event kind.', { kind });
    }
    const payload = options[INTERNAL_RUN_APPEND] === true
      ? source.payload
      : cloneInputJson(source.payload ?? {}, 'event.payload');
    if (kind !== 'STEP') conflict('Unsupported event kind.', { kind });
    validateStepPayload(
      payload,
      'event.payload',
      false,
      this.start,
      this.store.manifest,
      options[INTERNAL_RUN_APPEND] === true,
    );
    if (this.needsLedgerReconcile) await this.reconcileLedger();
    const executionNonce = payload.receipt.executionNonce;
    let committed = this.committedSteps.get(executionNonce);
    if (committed === undefined && this.knownExecutionNonces.has(executionNonce)) {
      committed = await this.findCommittedStep(executionNonce);
    }
    if (committed !== undefined) {
      if (canonicalJson(committed.payload) !== canonicalJson(payload)) {
        conflict('Execution nonce was reused with different STEP evidence.', { executionNonce });
      }
      return cloneJson(committed.event);
    }
    if (
      payload.beforeDigest !== this.expectedStateDigest ||
      (payload.rngBefore !== this.expectedState.rngState &&
        canonicalJson(payload.rngBefore) !== canonicalJson(this.expectedState.rngState))
    ) conflict('STEP before-state evidence does not continue the prior state.', { runId: this.start.runId });
    let event;
    try {
      event = await appendLedgerEvent(
        this.store.root,
        this.start.runId,
        this.lastEvent.sequence + 1,
        this.lastEvent.digest,
        { kind, payload },
        options.failpoint ?? this.failpoint,
        this.reuseLedgerHandle ? await this.ensureLedgerHandle() : null,
        this.reuseLedgerHandle,
        this.durability === 'strict',
        this.reuseLedgerHandle ? this : null,
      );
    } catch (error) {
      this.needsLedgerReconcile = true;
      throw error;
    }
    this.lastEvent = event;
    this.lastStepState = payload.afterState;
    this.expectedState = payload.afterState;
    this.expectedStateDigest = payload.afterDigest;
    this.rememberCommittedStep(executionNonce, event, payload);
    inject(options.failpoint ?? this.failpoint, `${kind}:appended`);
    return options.returnReference === true ? event : cloneJson(event);
  }

  commitSnapshot(snapshot, options = {}) {
    return this.runExclusive(() => this.commitSnapshotExclusive(snapshot, options));
  }

  async commitSnapshotExclusive(snapshot, options = {}) {
    if (this.terminal || this.terminalEvidence) {
      throw new LabStoreError('BUSY', 'A terminal run cannot publish a running snapshot.', { runId: this.start.runId });
    }
    await assertOwnedLock(this.store.root, this.writerLockIdentity);
    const source = cloneInputJson(requireObject(snapshot, 'snapshot'), 'snapshot');
    validateContinuityState({
      worldState: source.worldState,
      memory: source.memory,
      rngState: source.rngState,
      kernelStep: source.kernelStep,
      ...(source.changeSupervisor === undefined ? {} : { changeSupervisor: source.changeSupervisor }),
    }, 'snapshot');
    if (
      source.lastRunId !== this.start.runId ||
      source.lastRunSequence !== this.lastEvent.sequence ||
      source.eventsDigest !== this.lastEvent.digest
    ) {
      conflict('Snapshot does not match the ledger watermark.', {
        runId: this.start.runId,
        ledgerSequence: this.lastEvent.sequence,
      });
    }
    const allowed = new Set(['worldState', 'memory', 'rngState', 'kernelStep', 'changeSupervisor', 'lastRunId', 'lastRunSequence', 'eventsDigest', 'status']);
    if (source.status !== 'RUNNING' || Object.keys(source).some((key) => !allowed.has(key))) {
      throw new LabStoreError('INVALID_INPUT', 'Snapshot shape or status is invalid.', { field: 'snapshot' });
    }
    if (this.lastStepState === null || canonicalJson(stateProjection(source, source)) !== canonicalJson(this.lastStepState)) {
      conflict('Snapshot continuity state differs from the ledger STEP.', { runId: this.start.runId });
    }
    const current = withSelfDigest({ ...source, schemaVersion: SCHEMA_VERSION });
    const failpoint = options.failpoint ?? this.failpoint;
    if (this.durability === 'checkpoint') {
      try {
        await this.flushLedgerHandle();
      } catch (error) {
        this.needsLedgerReconcile = true;
        throw error;
      }
    }
    await atomicWriteJson(
      this.store.root,
      childPath(this.store.root, 'state', 'current.json'),
      current,
      () => inject(failpoint, 'snapshot:before-publish'),
    );
    return cloneJson(current);
  }

  finish(input) {
    return this.runExclusive(() => this.finishExclusive(input));
  }

  async finishExclusive(input) {
    if (this.terminal || this.terminalEvidence) {
      throw new LabStoreError('BUSY', 'Run already has terminal evidence.', { runId: this.start.runId });
    }
    await assertOwnedLock(this.store.root, this.writerLockIdentity);
    const source = requireObject(input, 'finish input');
    const terminalStatus = source.terminalStatus;
    if (terminalStatus !== 'COMPLETED' && terminalStatus !== 'HALTED') {
      throw new LabStoreError('INVALID_INPUT', 'terminalStatus must be COMPLETED or HALTED.', { field: 'terminalStatus' });
    }
    const finalState = cloneInputJson(requireObject(source.finalState, 'finalState'), 'finalState');
    validateContinuityState(finalState, 'finalState');
    if (canonicalJson(finalState) !== canonicalJson(this.expectedState)) {
      conflict('Final state differs from the current ledger continuity state.', { runId: this.start.runId });
    }
    const failpoint = typeof source.failpoint === 'function' ? source.failpoint : this.failpoint;
    const finalStateDigest = canonicalDigest(finalState);
    const reason = source.reason === undefined ? undefined : requireTerminalReason(source.reason);
    const externalTransition = reason === 'EXTERNAL_TRANSITION_UNKNOWN'
      ? await readExternalTransitionEvidence(this.store.root, this.start, this.lastEvent)
      : null;
    if (reason === 'EXTERNAL_TRANSITION_UNKNOWN' && externalTransition === null) {
      throw new LabStoreError('CORRUPT', 'An unresolved external transition is missing its durable marker.', { runId: this.start.runId });
    }
    let terminalEvent;
    try {
      terminalEvent = await appendLedgerEvent(
        this.store.root,
        this.start.runId,
        this.lastEvent.sequence + 1,
        this.lastEvent.digest,
        {
          kind: terminalStatus === 'COMPLETED' ? 'RUN_COMPLETED' : 'RUN_HALTED',
          payload: {
            terminalStatus,
            ...(reason === undefined ? {} : { reason }),
            ...(externalTransition === null ? {} : { externalTransition }),
            finalState,
            finalStateDigest,
          },
        },
        failpoint,
        this.reuseLedgerHandle ? await this.ensureLedgerHandle() : null,
        this.reuseLedgerHandle,
        true,
        this.reuseLedgerHandle ? this : null,
      );
    } finally {
      await this.closeLedgerHandle();
    }
    this.lastEvent = terminalEvent;
    this.terminalEvidence = true;
    inject(failpoint, 'terminal:appended');

    const end = withSelfDigest({
      schemaVersion: SCHEMA_VERSION,
      runId: this.start.runId,
      terminalStatus,
      finalSequence: terminalEvent.sequence,
      finalEventDigest: terminalEvent.digest,
      finalStateDigest,
      endedAt: now(),
    });
    await publishImmutableJson(
      this.store.root,
      childPath(this.store.root, 'runs', this.start.runId, 'end.json'),
      end,
      'run end',
    );
    inject(failpoint, 'end:published');

    const current = currentFromState(finalState, {
      lastRunId: this.start.runId,
      lastRunSequence: terminalEvent.sequence,
      status: terminalStatus === 'COMPLETED' ? 'READY' : 'HALTED',
      eventsDigest: terminalEvent.digest,
    });
    await atomicWriteJson(this.store.root, childPath(this.store.root, 'state', 'current.json'), current);
    inject(failpoint, 'current:terminal');
    await this.clearExternalTransitionExclusive();
    await removeOwnedLock(this.store.root, this.writerLock);
    this.terminal = true;
    return cloneJson(end);
  }

  markExternalTransition(input) {
    return this.runExclusive(() => this.markExternalTransitionExclusive(input));
  }

  async markExternalTransitionExclusive(input) {
    await assertOwnedLock(this.store.root, this.writerLockIdentity);
    const source = requireObject(input, 'external transition marker');
    const executionNonce = requireText(source.executionNonce, 'executionNonce');
    const token = requireText(source.token, 'token');
    const basedOnVersion = requireText(source.basedOnVersion, 'basedOnVersion');
    const beforeState = cloneInputJson(requireObject(source.beforeState, 'beforeState'), 'beforeState');
    validateContinuityState(beforeState, 'beforeState');
    const planning = source.planning === undefined
      ? { schemaVersion: SCHEMA_VERSION, horizon: 1 }
      : validatePlanningEvidence(source.planning, 'external transition planning');
    if (source.policyEvidence !== undefined) {
      validateExternalPolicyEvidence(source.policyEvidence, this.start.runId);
    }
    if (source.intent !== undefined) {
      validateExternalIntentEvidence(source.intent, this.start.runId);
    }
    if (source.capabilities !== undefined) {
      validateExternalCapabilitiesEvidence(source.capabilities, this.start.runId);
    }
    if (source.decisionBoundary !== undefined) {
      validateExternalDecisionBoundaryEvidence(source.decisionBoundary, this.start.runId);
    }
    const marker = withSelfDigest({
      schemaVersion: SCHEMA_VERSION,
      runId: this.start.runId,
      sequence: this.lastEvent.sequence + 1,
      scenario: this.start.scenario,
      executionNonce,
      token,
      basedOnVersion,
      beforeDigest: canonicalDigest(beforeState),
      planning,
      markedAt: now(),
      ...(source.policyEvidence === undefined ? {} : { policyEvidence: cloneJson(source.policyEvidence) }),
      ...(source.intent === undefined ? {} : { intent: cloneJson(source.intent) }),
      ...(source.capabilities === undefined ? {} : { capabilities: cloneJson(source.capabilities) }),
      ...(source.decisionBoundary === undefined ? {} : { decisionBoundary: cloneJson(source.decisionBoundary) }),
    });
    const result = await publishImmutableJson(
      this.store.root,
      childPath(this.store.root, 'runs', this.start.runId, EXTERNAL_TRANSITION_MARKER),
      marker,
      'external transition marker',
    );
    inject(this.failpoint, 'external-transition:marked');
    return result;
  }

  clearExternalTransition() {
    return this.runExclusive(() => this.clearExternalTransitionExclusive());
  }

  flushLedger() {
    return this.runExclusive(() => this.flushLedgerExclusive());
  }

  async flushLedgerExclusive() {
    await assertOwnedLock(this.store.root, this.writerLockIdentity);
    await this.flushLedgerHandle();
  }

  async clearExternalTransitionExclusive() {
    await assertOwnedLock(this.store.root, this.writerLockIdentity);
    await rm(childPath(this.store.root, 'runs', this.start.runId, EXTERNAL_TRANSITION_MARKER), { force: true });
  }

  complete(input) {
    return this.runExclusive(async () => {
      const source = requireObject(input, 'complete input');
      const failpoint = typeof source.failpoint === 'function' ? source.failpoint : this.failpoint;
      if (!Array.isArray(source.steps)) {
        throw new LabStoreError('INVALID_INPUT', 'complete.steps must be an array.', { field: 'steps' });
      }
      const steps = source.steps;
      for (const step of steps) await this.appendExclusive(step, { failpoint });
      return this.finishExclusive({
        terminalStatus: source.terminalStatus,
        finalState: source.finalState,
        failpoint,
      });
    });
  }

  runExclusive(operation) {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch(async () => {
      await this.closeLedgerHandle().catch(() => {});
    });
    return result;
  }

  async ensureLedgerHandle() {
    if (this.ledgerHandle !== null) return this.ledgerHandle;
    const eventsPath = childPath(this.store.root, 'runs', this.start.runId, 'events.jsonl');
    await assertSafePath(this.store.root, eventsPath);
    this.ledgerHandle = await open(eventsPath, 'a', 0o600);
    const status = await this.ledgerHandle.stat();
    if (!status.isFile() || status.size > MAX_LEDGER_BYTES) {
      await this.closeLedgerHandle();
      corrupt('Ledger exceeds the size limit.', { runId: this.start.runId });
    }
    this.ledgerBytes = status.size;
    return this.ledgerHandle;
  }

  async closeLedgerHandle() {
    const handle = this.ledgerHandle;
    this.ledgerHandle = null;
    this.ledgerBytes = null;
    if (handle !== null) await handle.close();
  }

  async flushLedgerHandle() {
    if (this.ledgerHandle !== null) await this.ledgerHandle.datasync();
  }

  rememberCommittedStep(executionNonce, event, payload) {
    this.knownExecutionNonces.add(executionNonce);
    this.committedSteps.set(executionNonce, { event, payload });
    while (this.committedSteps.size > MAX_RECENT_COMMITTED_STEPS) {
      this.committedSteps.delete(this.committedSteps.keys().next().value);
    }
  }

  async findCommittedStep(executionNonce) {
    const events = await readLedger(this.store.root, this.start.runId, this.start, {}, this.store.manifest);
    const event = events.find((candidate) => (
      candidate.kind === 'STEP' && candidate.payload.receipt.executionNonce === executionNonce
    ));
    if (event === undefined) return undefined;
    const committed = { event, payload: event.payload };
    this.committedSteps.set(executionNonce, committed);
    while (this.committedSteps.size > MAX_RECENT_COMMITTED_STEPS) {
      this.committedSteps.delete(this.committedSteps.keys().next().value);
    }
    return committed;
  }

  async reconcileLedger() {
    const events = await readLedger(this.store.root, this.start.runId, this.start, {}, this.store.manifest);
    const known = events[this.lastEvent.sequence - 1];
    if (!known || known.digest !== this.lastEvent.digest) {
      corrupt('In-memory run watermark is not a ledger prefix.', { runId: this.start.runId });
    }
    for (const event of events.slice(this.lastEvent.sequence)) {
      if (event.kind !== 'STEP') {
        this.terminalEvidence = TERMINAL_KINDS.has(event.kind);
        throw new LabStoreError('BUSY', 'Ledger advanced to a non-STEP event.', { runId: this.start.runId });
      }
      const nonce = event.payload.receipt.executionNonce;
      const prior = this.committedSteps.get(nonce);
      if (prior && canonicalJson(prior.payload) !== canonicalJson(event.payload)) {
        corrupt('Ledger reused an execution nonce with different evidence.', { executionNonce: nonce });
      }
      this.rememberCommittedStep(nonce, event, event.payload);
      this.lastEvent = event;
      this.lastStepState = event.payload.afterState;
      this.expectedState = event.payload.afterState;
      this.expectedStateDigest = event.payload.afterDigest;
    }
    this.needsLedgerReconcile = false;
  }
}

async function recoverRun(root, manifest) {
  const currentPath = childPath(root, 'state', 'current.json');
  const current = await readVerifiedObject(currentPath, 'current');
  validateCurrentShape(current);
  const runIds = await listRunIds(root);
  const incompleteRunIds = [];
  for (const candidate of runIds) {
    if (!(await pathExists(childPath(root, 'runs', candidate, 'end.json')))) {
      const startPath = childPath(root, 'runs', candidate, 'start.json');
      if (!(await pathExists(startPath))) {
        const orphanDirectory = childPath(root, 'runs', candidate);
        const orphanEntries = await readdir(orphanDirectory);
        const ownedStaging = orphanEntries.filter((name) => (
          /^start\.json\.staging-\d+-[0-9a-f-]{36}$/iu.test(name)
        ));
        if (ownedStaging.length !== orphanEntries.length) {
          corrupt('Pre-start run directory contains unexplained artifacts.', { runId: candidate });
        }
        for (const name of ownedStaging) await rm(childPath(root, 'runs', candidate, name));
        await rmdir(orphanDirectory);
        continue;
      }
      incompleteRunIds.push(candidate);
    }
  }
  const runId = current.status === 'RUNNING' && runIds.includes(current.lastRunId)
    ? current.lastRunId
    : incompleteRunIds.length === 1
      ? incompleteRunIds[0]
      : incompleteRunIds.length === 0 && runIds.includes(current.lastRunId)
        ? current.lastRunId
        : null;
  if (runId === null) {
    if (current.status !== 'RUNNING' && incompleteRunIds.length === 0) {
      return { reason: 'PRESTART_ABORTED', current };
    }
    corrupt('Recovery cannot identify one active run.', {
      runCount: runIds.length,
      incompleteRunCount: incompleteRunIds.length,
    });
  }
  const start = await readVerifiedObject(childPath(root, 'runs', runId, 'start.json'), 'run start');
  validateStart(start, manifest, runId);
  const tornTail = { byteLength: null };
  const events = await readLedger(root, runId, start, {
    allowTornTrailingLine: current.status === 'RUNNING' && current.lastRunId === runId,
    tornTail,
  }, manifest);
  validateLedgerIdentity(start, events);
  validateCurrentReference(current, runId, events);
  if (current.lastRunId === runId) validateCurrentProjection(current, start, events);

  const endPath = childPath(root, 'runs', runId, 'end.json');
  let end = await readOptionalVerifiedObject(endPath, 'run end');
  if (end !== null) validateEnd(end, runId, events);

  let last = events.at(-1) ?? null;
  const markerPath = childPath(root, 'runs', runId, EXTERNAL_TRANSITION_MARKER);
  let externalMarker = await readOptionalVerifiedObject(markerPath, 'external transition marker');
  if (externalMarker !== null) {
    validateExternalTransitionMarker(externalMarker, runId, start, events, current);
    const committed = events.find((event) => (
      event.kind === 'STEP' &&
      event.sequence === externalMarker.sequence &&
      event.payload.receipt.executionNonce === externalMarker.executionNonce
    ));
      if (committed !== undefined) {
        if (committed.payload.receipt.token !== externalMarker.token ||
            committed.payload.beforeDigest !== externalMarker.beforeDigest ||
            committed.payload.receipt.basedOnVersion !== externalMarker.basedOnVersion ||
            canonicalJson(normalizePlanningEvidence(committed.payload.boundary?.planning)) !==
              canonicalJson(normalizePlanningEvidence(externalMarker.planning))) {
          corrupt('External transition marker does not match its committed STEP.', { runId });
        }
      await rm(markerPath);
      externalMarker = null;
    } else if (TERMINAL_KINDS.has(last?.kind)) {
      if (last.payload.reason !== 'EXTERNAL_TRANSITION_UNKNOWN') {
        corrupt('External transition marker remains after an unrelated terminal event.', { runId });
      }
      await rm(markerPath);
      externalMarker = null;
    }
  }
  const externalTransition = externalMarker === null ? null : externalTransitionEvidence(externalMarker, start);
  if (tornTail.byteLength !== null) {
    await truncateLedger(childPath(root, 'runs', runId, 'events.jsonl'), tornTail.byteLength);
  }
  let reason;
  if (end === null && !TERMINAL_KINDS.has(last?.kind)) {
    if (events.length === 0) {
      last = await appendLedgerEvent(root, runId, 1, null, {
        kind: 'RUN_STARTED',
        payload: { startDigest: start.selfDigest, worldId: start.worldId, scenario: start.scenario },
      });
      events.push(last);
    }
    const finalState = recoveryStateProjection(current, start, events);
    last = await appendLedgerEvent(root, runId, last.sequence + 1, last.digest, {
      kind: 'RUN_HALTED',
      payload: {
        terminalStatus: 'HALTED',
        reason: externalMarker === null ? 'CRASH_HALTED' : 'EXTERNAL_TRANSITION_UNKNOWN',
        ...(externalTransition === null ? {} : { externalTransition }),
        finalState,
        finalStateDigest: canonicalDigest(finalState),
      },
    });
    events.push(last);
    reason = externalMarker === null ? 'CRASH_HALTED' : 'EXTERNAL_TRANSITION_UNKNOWN';
  }

  if (end === null) {
    const terminal = events.at(-1);
    validateTerminalEvent(terminal);
    end = withSelfDigest({
      schemaVersion: SCHEMA_VERSION,
      runId,
      terminalStatus: terminal.payload.terminalStatus,
      finalSequence: terminal.sequence,
      finalEventDigest: terminal.digest,
      finalStateDigest: terminal.payload.finalStateDigest,
      endedAt: now(),
    });
    await publishImmutableJson(root, endPath, end, 'run end');
    reason ??= events.at(-1)?.payload?.reason === 'EXTERNAL_TRANSITION_UNKNOWN'
      ? 'EXTERNAL_TRANSITION_UNKNOWN'
      : 'TERMINAL_COMPLETED';
  }

  const terminal = events.at(-1);
  validateEnd(end, runId, events);
  const finalCurrent = currentFromState(terminal.payload.finalState, {
    lastRunId: runId,
    lastRunSequence: terminal.sequence,
    status: terminal.payload.terminalStatus === 'COMPLETED' ? 'READY' : 'HALTED',
    eventsDigest: terminal.digest,
  });
  if (current.selfDigest !== finalCurrent.selfDigest) {
    await atomicWriteJson(root, currentPath, finalCurrent);
  }
  if (externalMarker !== null) await rm(markerPath);
  reason ??= terminal.payload.reason === 'EXTERNAL_TRANSITION_UNKNOWN'
    ? 'EXTERNAL_TRANSITION_UNKNOWN'
    : terminal.payload.reason === 'CRASH_HALTED'
      ? 'CRASH_HALTED'
      : 'ALREADY_TERMINAL';
  return { reason, current: finalCurrent };
}

async function appendLedgerEvent(
  root,
  runId,
  sequence,
  prevDigest,
  input,
  failpoint,
  existingHandle = null,
  compactStorage = false,
  syncLedger = true,
  ledgerOwner = null,
) {
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    sequence,
    kind: input.kind,
    payload: input.payload,
    prevDigest,
  };
  const payloadJson = compactStorage ? canonicalJson(input.payload) : null;
  const event = {
    ...unsigned,
    digest: compactStorage ? digestLedgerEvent(unsigned, payloadJson) : canonicalDigest(unsigned),
  };
  const eventsPath = childPath(root, 'runs', runId, 'events.jsonl');
  if (existingHandle === null) await assertSafePath(root, eventsPath);
  const storedEvent = compactStorage && input.kind === 'STEP'
    ? encodeStoredLedgerEvent(event, payloadJson)
    : event;
  const line = compactStorage && input.kind === 'STEP'
    ? canonicalStoredLedgerLine(storedEvent)
    : `${canonicalJson(storedEvent)}\n`;
  const lineBuffer = Buffer.from(line, 'utf8');
  if (lineBuffer.byteLength > MAX_EVENT_LINE_BYTES) {
    throw new LabStoreError('INVALID_INPUT', 'Ledger event exceeds the size limit.', { runId, sequence });
  }
  const handle = existingHandle ?? await open(eventsPath, 'a', 0o600);
  const ownsHandle = existingHandle === null;
  try {
    const lineBytes = lineBuffer.byteLength;
    const status = ledgerOwner === null ? await handle.stat() : null;
    const currentBytes = ledgerOwner === null ? status.size : ledgerOwner.ledgerBytes;
    if ((status !== null && !status.isFile()) || currentBytes === undefined || currentBytes === null || currentBytes + lineBytes > MAX_LEDGER_BYTES) {
      corrupt('Ledger exceeds the size limit.', { runId });
    }
    await writeComplete(handle, lineBuffer);
    inject(failpoint, 'ledger:after-write-before-sync');
    if (syncLedger) await handle.datasync();
    if (ledgerOwner !== null) ledgerOwner.ledgerBytes += lineBytes;
  } finally {
    if (ownsHandle) await handle.close();
  }
  return event;
}

async function writeComplete(handle, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new LabStoreError('IO_ERROR', 'Ledger write made no progress.', {});
    }
    offset += result.bytesWritten;
  }
}

function digestLedgerEvent(event, payloadJson) {
  const unsignedJson = `{"kind":${JSON.stringify(event.kind)},"payload":${payloadJson},"prevDigest":${JSON.stringify(event.prevDigest)},"runId":${JSON.stringify(event.runId)},"schemaVersion":${event.schemaVersion},"sequence":${event.sequence}}`;
  return `sha256:${createHash('sha256').update(unsignedJson).digest('hex')}`;
}

function encodeStoredLedgerEvent(event, payloadJson) {
  const rawPayload = Buffer.from(payloadJson, 'utf8');
  if (rawPayload.byteLength > MAX_JSON_BYTES) {
    throw new LabStoreError('INVALID_INPUT', 'Ledger event payload exceeds the size limit.', {
      runId: event.runId,
      sequence: event.sequence,
    });
  }
  // Long runs favor bounded CPU per step; the ledger size guard remains the
  // hard limit, and the payload is still losslessly encoded.
  const compressedPayload = deflateRawSync(rawPayload, { level: 6 });
  return {
    ...event,
    payload: compressedPayload.toString('base64'),
  };
}

function canonicalStoredLedgerLine(event) {
  // Keep the same lexicographic key order as canonicalJson without sorting the
  // already fixed-shape compact STEP envelope on every long-run append.
  return `{"digest":${JSON.stringify(event.digest)},"kind":${JSON.stringify(event.kind)},"payload":${JSON.stringify(event.payload)},"prevDigest":${JSON.stringify(event.prevDigest)},"runId":${JSON.stringify(event.runId)},"schemaVersion":${event.schemaVersion},"sequence":${event.sequence}}\n`;
}

function decodeStoredLedgerEvent(event, runId, sequence) {
  if (typeof event?.payload !== 'string') return event;
  if (event.payload.length === 0) corrupt('Ledger event payload encoding is unsupported.', { runId, sequence });
  let payload;
  try {
    const raw = inflateRawSync(Buffer.from(event.payload, 'base64'), { maxOutputLength: MAX_JSON_BYTES });
    payload = JSON.parse(raw.toString('utf8'));
    canonicalJson(payload);
  } catch (cause) {
    throw new LabStoreError('CORRUPT', 'Ledger event payload cannot be decompressed.', { runId, sequence }, { cause });
  }
  const decoded = { ...event, payload };
  return decoded;
}

async function readLedger(root, runId, start, options = {}, manifest = null) {
  const eventsPath = childPath(root, 'runs', runId, 'events.jsonl');
  let raw;
  try {
    const status = await lstat(eventsPath);
    if (!status.isFile() || status.isSymbolicLink()) pathEscape('Ledger is not a plain file.');
    if (status.size > MAX_LEDGER_BYTES) corrupt('Ledger exceeds the size limit.', { runId });
    raw = await readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (raw === '') return [];
  const maxSequence = options.maxSequence;
  let tornTailByteLength = null;
  if (!Number.isSafeInteger(maxSequence) && !raw.endsWith('\n')) {
    if (options.allowTornTrailingLine !== true) corrupt('Ledger has an incomplete trailing line.', { runId });
    const lastNewline = raw.lastIndexOf('\n');
    const completeRaw = lastNewline < 0 ? '' : raw.slice(0, lastNewline + 1);
    const tornTail = lastNewline < 0 ? raw : raw.slice(lastNewline + 1);
    if (Buffer.byteLength(tornTail, 'utf8') > MAX_EVENT_LINE_BYTES) {
      corrupt('Ledger torn trailing line exceeds the size limit.', { runId });
    }
    tornTailByteLength = Buffer.byteLength(completeRaw, 'utf8');
    if (options.tornTail !== undefined) options.tornTail.byteLength = tornTailByteLength;
    raw = completeRaw;
  }
  let lines;
  if (Number.isSafeInteger(maxSequence)) {
    if ((raw.match(/\n/g) ?? []).length < maxSequence) {
      corrupt('Ledger watermark line is incomplete.', { runId, maxSequence });
    }
    lines = raw.split(/\r?\n/).slice(0, maxSequence);
    if (lines.length !== maxSequence || lines.some((line) => line.length === 0)) {
      corrupt('Ledger is shorter than the current watermark.', { runId, maxSequence });
    }
  } else {
    if (!raw.endsWith('\n')) corrupt('Ledger has an incomplete trailing line.', { runId });
    lines = raw.slice(0, -1).split(/\r?\n/);
  }
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (Buffer.byteLength(lines[index]) > MAX_EVENT_LINE_BYTES) {
      corrupt('Ledger line exceeds the size limit.', { runId, line: index + 1 });
    }
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch (cause) {
      throw new LabStoreError('CORRUPT', 'Ledger contains malformed JSON.', { runId, line: index + 1 }, { cause });
    }
    event = decodeStoredLedgerEvent(event, runId, index + 1);
    try {
      validateEvent(event, runId, index + 1, events.at(-1)?.digest ?? null, start, manifest);
    } catch (cause) {
      if (cause instanceof TypeError) {
        throw new LabStoreError('CORRUPT', 'Ledger event exceeds JSON structural limits.', { runId, line: index + 1 }, { cause });
      }
      throw cause;
    }
    events.push(event);
  }
  if (tornTailByteLength !== null && TERMINAL_KINDS.has(events.at(-1)?.kind)) {
    corrupt('Ledger has a torn tail after a terminal event.', { runId });
  }
  return events;
}

async function truncateLedger(filePath, byteLength) {
  let handle;
  try {
    handle = await open(filePath, 'r+');
    await handle.truncate(byteLength);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function validateEvent(event, runId, sequence, prevDigest, start, manifest = null) {
  if (!event || event.schemaVersion !== SCHEMA_VERSION) corrupt('Event schema is unsupported.', { runId, sequence });
  if (event.runId !== runId || event.sequence !== sequence || event.prevDigest !== prevDigest) {
    corrupt('Ledger sequence or digest chain is invalid.', { runId, sequence });
  }
  const unsigned = { ...event };
  delete unsigned.digest;
  if (event.digest !== canonicalDigest(unsigned)) corrupt('Event digest is invalid.', { runId, sequence });
  if (event.kind === 'STEP') validateStepPayload(event.payload, 'event.payload', true, start, manifest);
  else if (event.kind !== 'RUN_STARTED' && !TERMINAL_KINDS.has(event.kind)) {
    corrupt('Event kind is unsupported.', { runId, sequence });
  }
}

function validateLedgerIdentity(start, events) {
  if (events.length === 0) return;
  const first = events[0];
  if (
    first.kind !== 'RUN_STARTED' ||
    first.payload?.startDigest !== start.selfDigest ||
    first.payload?.worldId !== start.worldId ||
    first.payload?.scenario !== start.scenario
  ) {
    corrupt('RUN_STARTED does not bind the immutable start.', { runId: start.runId });
  }
  const terminalIndexes = events
    .map((event, index) => TERMINAL_KINDS.has(event.kind) ? index : -1)
    .filter((index) => index >= 0);
  if (terminalIndexes.length > 1 || (terminalIndexes.length === 1 && terminalIndexes[0] !== events.length - 1)) {
    corrupt('Ledger has an invalid terminal transition.', { runId: start.runId });
  }
  if (terminalIndexes.length === 1) validateTerminalEvent(events.at(-1));
  let expectedState = cloneJson(start.initialState);
  const executionNonces = new Set();
  for (const event of events.slice(1)) {
    if (event.kind === 'STEP') {
      const nonce = event.payload.receipt.executionNonce;
      if (
        event.payload.beforeDigest !== canonicalDigest(expectedState) ||
        canonicalJson(event.payload.rngBefore) !== canonicalJson(expectedState.rngState) ||
        executionNonces.has(nonce)
      ) corrupt('STEP does not continue the prior ledger state.', { runId: start.runId, sequence: event.sequence });
      executionNonces.add(nonce);
      expectedState = cloneJson(event.payload.afterState);
    } else if (TERMINAL_KINDS.has(event.kind) && canonicalJson(event.payload.finalState) !== canonicalJson(expectedState)) {
      corrupt('Terminal state differs from the prior ledger state.', { runId: start.runId, sequence: event.sequence });
    }
  }
}

function validateTerminalEvent(event) {
  if (!event || !TERMINAL_KINDS.has(event.kind)) corrupt('Terminal event is missing.', {});
  const expectedStatus = event.kind === 'RUN_COMPLETED' ? 'COMPLETED' : 'HALTED';
  if (
    event.payload?.terminalStatus !== expectedStatus ||
    !event.payload?.finalState ||
    event.payload.finalStateDigest !== canonicalDigest(event.payload.finalState)
  ) {
    corrupt('Terminal event payload is invalid.', { runId: event.runId, sequence: event.sequence });
  }
  if (event.payload.reason !== undefined) {
    try {
      requireTerminalReason(event.payload.reason);
    } catch {
      corrupt('Terminal event reason is invalid.', { runId: event.runId, sequence: event.sequence });
    }
  }
  if (event.payload.externalTransition !== undefined) {
    validateExternalTransitionEvidence(event.payload.externalTransition, event.runId);
  }
  validateContinuityState(event.payload.finalState, 'terminal finalState', true);
}

function externalTransitionEvidence(marker, start) {
  validateExternalTransitionEvidence(marker, start.runId, start.scenario);
  return {
    runId: marker.runId,
    sequence: marker.sequence,
    scenario: marker.scenario,
    executionNonce: marker.executionNonce,
    token: marker.token,
    basedOnVersion: marker.basedOnVersion,
    beforeDigest: marker.beforeDigest,
    planning: normalizePlanningEvidence(marker.planning),
    ...(marker.policyEvidence === undefined ? {} : { policyEvidence: cloneJson(marker.policyEvidence) }),
    ...(marker.intent === undefined ? {} : { intent: cloneJson(marker.intent) }),
    ...(marker.capabilities === undefined ? {} : { capabilities: cloneJson(marker.capabilities) }),
    ...(marker.decisionBoundary === undefined ? {} : { decisionBoundary: cloneJson(marker.decisionBoundary) }),
  };
}

async function readExternalTransitionEvidence(root, start) {
  const marker = await readOptionalVerifiedObject(
    childPath(root, 'runs', start.runId, EXTERNAL_TRANSITION_MARKER),
    'external transition marker',
  );
  return marker === null ? null : externalTransitionEvidence(marker, start);
}

function validateExternalTransitionEvidence(value, runId, scenario = undefined) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.runId !== runId ||
    (scenario !== undefined && value.scenario !== scenario) ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 2 ||
    typeof value.scenario !== 'string' || value.scenario.length === 0 || value.scenario.length > 4096 ||
    typeof value.executionNonce !== 'string' || value.executionNonce.length === 0 || value.executionNonce.length > 4096 ||
    typeof value.token !== 'string' || value.token.length === 0 || value.token.length > 4096 ||
    typeof value.basedOnVersion !== 'string' || value.basedOnVersion.length === 0 || value.basedOnVersion.length > 4096 ||
    typeof value.beforeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.beforeDigest)
  ) {
    corrupt('External transition evidence is invalid.', { runId });
  }
  if (value.planning !== undefined && !isValidPlanningEvidence(value.planning)) {
    corrupt('External transition planning evidence is invalid.', { runId });
  }
  if (value.policyEvidence !== undefined) validateExternalPolicyEvidence(value.policyEvidence, runId);
  if (value.intent !== undefined) validateExternalIntentEvidence(value.intent, runId);
  if (value.capabilities !== undefined) validateExternalCapabilitiesEvidence(value.capabilities, runId);
  if (value.decisionBoundary !== undefined) validateExternalDecisionBoundaryEvidence(value.decisionBoundary, runId);
}

function validateExternalDecisionBoundaryEvidence(value, runId) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION || typeof value.goalRequested !== 'boolean' ||
    typeof value.requestedGoal !== 'string' || value.requestedGoal.length === 0 || value.requestedGoal.length > 4096 ||
    !isValidValueSpec(value.valueSpec) ||
    (value.supervisor !== null && (typeof value.supervisor !== 'object' || Array.isArray(value.supervisor))) ||
    (value.goalActivation !== null && (typeof value.goalActivation !== 'object' || Array.isArray(value.goalActivation)))
  ) {
    corrupt('External transition decision boundary evidence is invalid.', { runId });
  }
  if (value.supervisor !== null) {
    try {
      normalizeChangeSupervisorState(value.supervisor);
    } catch (error) {
      corrupt('External transition decision boundary supervisor is invalid.', {
        runId,
        cause: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
  if (value.goalActivation !== null) {
    validateExternalGoalActivationEvidence(value.goalActivation, value.valueSpec, runId);
  }
}

function validateExternalGoalActivationEvidence(value, valueSpec, runId) {
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.goal !== 'string' || value.goal.length === 0 || value.goal.length > 4096 ||
    !Number.isSafeInteger(value.maxCycles) || value.maxCycles < 1 || value.maxCycles > 1_000_000 ||
    !Number.isSafeInteger(value.stagnationLimit) || value.stagnationLimit < 1 || value.stagnationLimit > 100_000 ||
    (value.plannerEnabled !== undefined && typeof value.plannerEnabled !== 'boolean') ||
    (value.plan !== undefined && (value.plan === null || typeof value.plan !== 'object' || Array.isArray(value.plan)))
  ) {
    corrupt('External transition decision boundary goal activation is invalid.', { runId });
  }
  if (value.planEvidence !== undefined) {
    if (
      value.planEvidence === null || typeof value.planEvidence !== 'object' || Array.isArray(value.planEvidence) ||
      value.planEvidence.schemaVersion !== SCHEMA_VERSION || value.planEvidence.source !== 'model' ||
      typeof value.planEvidence.model !== 'string' || value.planEvidence.model.length === 0 || value.planEvidence.model.length > 4096 ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.planEvidence.responseDigest) ||
      typeof value.planEvidence.applied !== 'boolean' ||
      (value.planEvidence.reason !== null &&
        (typeof value.planEvidence.reason !== 'string' || value.planEvidence.reason.length === 0 || value.planEvidence.reason.length > 256))
    ) {
      corrupt('External transition decision boundary plan evidence is invalid.', { runId });
    }
    if ((value.planEvidence.applied && value.planEvidence.reason !== null) ||
        (!value.planEvidence.applied && value.planEvidence.reason === null) ||
        value.planEvidence.applied !== (value.plan !== undefined)) {
      corrupt('External transition decision boundary plan evidence does not match its plan.', { runId });
    }
  }
  try {
    createChangeSupervisor({
      goal: value.goal,
      plannerEnabled: value.plannerEnabled === true,
      plan: value.plan,
      valueSpec,
      maxCycles: value.maxCycles,
      stagnationLimit: value.stagnationLimit,
    });
  } catch (error) {
    corrupt('External transition decision boundary goal activation plan is invalid.', {
      runId,
      cause: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

function validateExternalCapabilitiesEvidence(value, runId) {
  if (
    !Array.isArray(value) || value.length === 0 || value.length > 1024 ||
    value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item) ||
      item.schemaVersion !== SCHEMA_VERSION || typeof item.token !== 'string' || !TOKEN_PATTERN.test(item.token) ||
      !Number.isFinite(item.cost) || item.cost < 0 ||
      typeof item.allowed !== 'boolean' || typeof item.safe !== 'boolean')
  ) {
    corrupt('External transition capability evidence is invalid.', { runId });
  }
}

function validateExternalIntentEvidence(value, runId) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION || value.status !== 'READY' ||
    value.expectation === null || typeof value.expectation !== 'object' || Array.isArray(value.expectation) ||
    value.choice === null || typeof value.choice !== 'object' || Array.isArray(value.choice) ||
    value.nextRngState === null || typeof value.nextRngState !== 'object' || Array.isArray(value.nextRngState) ||
    typeof value.expectation.token !== 'string' || !TOKEN_PATTERN.test(value.expectation.token) ||
    value.choice.token !== value.expectation.token ||
    value.choice.allowed !== true || value.choice.safe !== true ||
    !Array.isArray(value.expectation.expectedDelta) ||
    !value.expectation.expectedDelta.every((item) => Number.isFinite(item)) ||
    value.expectation.predictedObservation === null ||
    typeof value.expectation.predictedObservation !== 'object' ||
    Array.isArray(value.expectation.predictedObservation) ||
    !Array.isArray(value.expectation.predictedObservation.vector) ||
    value.expectation.predictedObservation.vector.length !== value.expectation.expectedDelta.length ||
    !value.expectation.predictedObservation.vector.every((item) => Number.isFinite(item)) ||
    value.nextRngState.schemaVersion !== SCHEMA_VERSION ||
    typeof value.nextRngState.algorithm !== 'string' ||
    !Number.isSafeInteger(value.nextRngState.state) || value.nextRngState.state < 0 || value.nextRngState.state > 0xffffffff
  ) {
    corrupt('External transition intent evidence is invalid.', { runId });
  }
}

function isValidPlanningEvidence(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.schemaVersion === SCHEMA_VERSION &&
    Number.isSafeInteger(value.horizon) && value.horizon >= 1 && value.horizon <= MAX_PLANNING_HORIZON &&
    (value.contextMode === undefined || PLANNING_CONTEXT_MODES.includes(value.contextMode)) &&
    (value.branchingMode === undefined || PLANNING_BRANCHING_MODES.includes(value.branchingMode));
}

function validatePlanningEvidence(value, field) {
  if (!isValidPlanningEvidence(value)) {
    throw new LabStoreError('INVALID_INPUT', 'Planning evidence is invalid.', { field });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    horizon: value.horizon,
    contextMode: value.contextMode === undefined ? 'legacy-v1' : value.contextMode,
    ...(value.branchingMode === undefined && value.horizon <= 1 ? {} : {
      branchingMode: value.branchingMode === undefined ? 'legacy-v1' : value.branchingMode,
    }),
  };
}

function normalizePlanningEvidence(value) {
  return value === undefined
    ? { schemaVersion: SCHEMA_VERSION, horizon: 1, contextMode: 'legacy-v1', branchingMode: 'legacy-v1' }
    : {
        schemaVersion: SCHEMA_VERSION,
        horizon: value.horizon,
        contextMode: value.contextMode === undefined ? 'legacy-v1' : value.contextMode,
        ...(value.branchingMode === undefined && value.horizon <= 1 ? {} : {
          branchingMode: value.branchingMode === undefined ? 'legacy-v1' : value.branchingMode,
        }),
      };
}

function validateExternalPolicyEvidence(value, runId) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION || value.source !== 'model' ||
    typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 4096 ||
    (value.token !== null && (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token))) ||
    typeof value.responseDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.responseDigest) ||
    (value.observationDigest !== undefined && (typeof value.observationDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.observationDigest))) ||
    (value.proposal !== undefined && !isValidModelProposal(value.proposal)) ||
    typeof value.applied !== 'boolean' ||
    (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 256))
  ) {
    corrupt('External transition policy evidence is invalid.', { runId });
  }
}

function externalTransitionIdentity(value) {
  if (value === undefined) return null;
  return {
    scenario: value.scenario,
    executionNonce: value.executionNonce,
    token: value.token,
    basedOnVersion: value.basedOnVersion,
    beforeDigest: value.beforeDigest,
    planning: normalizePlanningEvidence(value.planning),
  };
}

function validateExternalTransitionMarker(marker, runId, start, events, current) {
  if (
    marker.runId !== runId ||
    !Number.isSafeInteger(marker.sequence) || marker.sequence < 2 ||
    marker.scenario !== start.scenario ||
    typeof marker.executionNonce !== 'string' || marker.executionNonce.length === 0 ||
    typeof marker.token !== 'string' || marker.token.length === 0 ||
    typeof marker.basedOnVersion !== 'string' || marker.basedOnVersion.length === 0 ||
    typeof marker.beforeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(marker.beforeDigest) ||
    (marker.planning !== undefined && !isValidPlanningEvidence(marker.planning)) ||
    typeof marker.markedAt !== 'string' ||
    !events.some((event) => event.kind === 'RUN_STARTED' && event.payload.startDigest === start.selfDigest)
  ) {
    corrupt('External transition marker is invalid.', { runId });
  }
  const lastSequence = events.at(-1)?.sequence ?? 0;
  if (marker.sequence !== lastSequence && marker.sequence !== lastSequence + 1) {
    corrupt('External transition marker is not adjacent to the ledger watermark.', { runId });
  }
  if (marker.sequence === lastSequence + 1 && marker.beforeDigest !== canonicalDigest(recoveryStateProjection(current, start, events))) {
    corrupt('External transition marker does not bind the current continuity state.', { runId });
  }
}

function validateStart(start, manifest, runId) {
  if (
    start.schemaVersion !== SCHEMA_VERSION ||
    start.runId !== runId ||
    start.worldId !== manifest.worldId ||
    !scenarioAllowed(manifest, start.scenario) ||
    (start.manifestDigest !== undefined && start.manifestDigest !== manifest.selfDigest) ||
    start.tokenMapDigest !== manifest.tokenMap.digest ||
    !start.initialState
  ) {
    corrupt('Immutable run start is invalid.', { runId });
  }
  if (start.continuation !== undefined) validateLoopContinuation(start.continuation, 'run continuation', true);
  validateContinuityState(start.initialState, 'run start initialState', true);
}

function validateLoopContinuation(value, field, corruptOnFailure = false) {
  const fail = (message) => {
    if (corruptOnFailure) corrupt(message, { field });
    throw new LabStoreError('INVALID_INPUT', message, { field });
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.loopId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.loopId) ||
      typeof value.scenario !== 'string' || value.scenario.length === 0 || value.scenario.length > 4096 ||
      !Number.isSafeInteger(value.runIndex) || value.runIndex < 0 ||
      !Number.isSafeInteger(value.stepsPerRun) || value.stepsPerRun < 1 || value.stepsPerRun > 10_000 ||
      (value.planningHorizon !== undefined && (!Number.isSafeInteger(value.planningHorizon) || value.planningHorizon < 1 || value.planningHorizon > MAX_PLANNING_HORIZON)) ||
      (value.planningBranchingMode !== undefined && !PLANNING_BRANCHING_MODES.includes(value.planningBranchingMode)) ||
      (value.mode !== 'finite' && value.mode !== 'forever') ||
      (value.mode === 'finite' && (!Number.isSafeInteger(value.maxRuns) || value.maxRuns < 1 || value.maxRuns > 10_000 || value.runIndex >= value.maxRuns)) ||
      (value.mode === 'forever' && value.maxRuns !== undefined)) {
    fail('Loop continuation metadata is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    loopId: value.loopId,
    scenario: value.scenario,
    runIndex: value.runIndex,
    stepsPerRun: value.stepsPerRun,
    ...(value.planningHorizon === undefined ? {} : { planningHorizon: value.planningHorizon }),
    ...(value.planningBranchingMode === undefined ? {} : { planningBranchingMode: value.planningBranchingMode }),
    mode: value.mode,
    ...(value.maxRuns === undefined ? {} : { maxRuns: value.maxRuns }),
  };
}

function inferLoopPlanningBranchingMode(group) {
  const declared = uniquePlanningBranchingModes(group.runs.map((run) =>
    run.start.continuation.planningBranchingMode,
  ));
  const observed = uniquePlanningBranchingModes(group.runs.flatMap((run) => [
    ...run.events
      .filter((event) => event.kind === 'STEP')
      .map(planningBranchingModeForStep),
    ...run.events
      .filter((event) => event.kind === 'RUN_HALTED' || event.kind === 'RUN_COMPLETED')
      .map(planningBranchingModeForTerminal),
  ].filter((mode) => mode !== null)));
  if (declared.length > 1 || observed.length > 1 ||
      (declared.length === 1 && observed.length === 1 && declared[0] !== observed[0])) {
    corrupt('Loop continuation planning branching mode differs across runs.', {
      loopId: group.continuation.loopId,
    });
  }
  return declared[0] ?? observed[0] ?? 'legacy-v1';
}

function uniquePlanningBranchingModes(modes) {
  return [...new Set(modes.filter((mode) => mode !== undefined))];
}

function planningBranchingModeForStep(event) {
  const boundary = event.payload?.boundary;
  const explicit = boundary?.planning?.branchingMode;
  if (PLANNING_BRANCHING_MODES.includes(explicit)) return explicit;
  const learningVersion = boundary?.kernelLearningVersion;
  if (learningVersion === 18) return 'tree-v1';
  if (learningVersion === 17) return 'recursive-v1';
  if (Number.isSafeInteger(learningVersion) && learningVersion < 17) return 'legacy-v1';
  return null;
}

function planningBranchingModeForTerminal(event) {
  const explicit = event.payload?.externalTransition?.planning?.branchingMode;
  return PLANNING_BRANCHING_MODES.includes(explicit) ? explicit : null;
}

function loopContract(continuation, fallbackPlanningBranchingMode = 'legacy-v1') {
  return {
    schemaVersion: continuation.schemaVersion,
    loopId: continuation.loopId,
    scenario: continuation.scenario,
    stepsPerRun: continuation.stepsPerRun,
    ...(continuation.planningHorizon === undefined ? {} : { planningHorizon: continuation.planningHorizon }),
    planningBranchingMode: continuation.planningBranchingMode ?? fallbackPlanningBranchingMode,
    mode: continuation.mode,
    ...(continuation.maxRuns === undefined ? {} : { maxRuns: continuation.maxRuns }),
  };
}

function summarizeLoopContinuation(group) {
  const attempts = new Map();
  const ordered = [...group.runs].sort((left, right) => (
    left.start.continuation.runIndex - right.start.continuation.runIndex ||
    left.start.startedAt.localeCompare(right.start.startedAt) ||
    left.start.runId.localeCompare(right.start.runId)
  ));
  for (const run of ordered) {
    const index = run.start.continuation.runIndex;
    const previous = attempts.get(index)?.at(-1);
    if (previous !== undefined && !isRecoverableLoopAttempt(previous)) {
      corrupt('A loop run index was started again after a non-recoverable terminal state.', { loopId: group.continuation.loopId, runIndex: index });
    }
    attempts.set(index, [...(attempts.get(index) ?? []), run]);
  }
  const indexes = [...attempts.keys()].sort((left, right) => left - right);
  for (let position = 0; position < indexes.length; position += 1) {
    if (indexes[position] !== position) {
      corrupt('Loop continuation run indexes are not contiguous.', { loopId: group.continuation.loopId });
    }
  }
  const runs = indexes.map((index) => attempts.get(index).at(-1));
  const last = runs.at(-1);
  return summarizeLatestLoopRun(group.continuation, group.planningBranchingMode, last);
}

function summarizeLatestLoopRun(continuation, planningBranchingMode, last) {
  const terminal = last.events.at(-1);
  const reason = terminal.payload.reason ?? null;
  const objectiveReached = reason === 'OBJECTIVE_REACHED';
  const recoverable = isRecoverableLoopAttempt(last);
  const stopped = terminal.payload.terminalStatus === 'HALTED' &&
    !recoverable;
  const completed = objectiveReached || (!recoverable && continuation.mode === 'finite' && last.start.continuation.runIndex + 1 >= continuation.maxRuns);
  return {
    ...loopContract(continuation, planningBranchingMode),
    nextRunIndex: recoverable ? last.start.continuation.runIndex : last.start.continuation.runIndex + 1,
    status: stopped ? 'STOPPED' : (completed ? 'COMPLETED' : 'ACTIVE'),
    lastRunId: last.start.runId,
    lastStartedAt: last.start.startedAt,
    lastStopReason: reason,
  };
}

function isRecoverableLoopAttempt(run) {
  return ['CRASH_HALTED', 'EXTERNAL_TRANSITION_UNKNOWN'].includes(run.events.at(-1)?.payload?.reason);
}

function validateEnd(end, runId, events) {
  const terminal = events.at(-1);
  validateTerminalEvent(terminal);
  if (
    end.schemaVersion !== SCHEMA_VERSION ||
    end.runId !== runId ||
    end.terminalStatus !== terminal.payload.terminalStatus ||
    end.finalSequence !== terminal.sequence ||
    end.finalEventDigest !== terminal.digest ||
    end.finalStateDigest !== terminal.payload.finalStateDigest
  ) {
    corrupt('Immutable run end does not match the ledger.', { runId });
  }
}

function validateCurrentReference(current, runId, events) {
  if (current.lastRunId === null) {
    if (current.lastRunSequence !== 0 || current.eventsDigest !== null) {
      corrupt('Current has an invalid empty watermark.', {});
    }
    return;
  }
  if (current.lastRunId !== runId) {
    if (
      current.status !== 'RUNNING' &&
      events.length <= 1 &&
      (events.length === 0 || events[0].kind === 'RUN_STARTED')
    ) return;
    corrupt('Current references another run.', { runId });
  }
  if (!Number.isInteger(current.lastRunSequence)) corrupt('Current run sequence is invalid.', { runId });
  const referenced = events[current.lastRunSequence - 1];
  if (!referenced || referenced.digest !== current.eventsDigest) {
    corrupt('Current watermark does not reference a ledger event.', { runId, sequence: current.lastRunSequence });
  }
}

function validateCurrentProjection(current, start, events) {
  const referenced = events[current.lastRunSequence - 1];
  if (!referenced) corrupt('Current has no referenced event state.', { runId: start.runId });
  let expectedState;
  let expectedStatus;
  if (referenced.kind === 'RUN_STARTED') {
    expectedState = start.initialState;
    expectedStatus = 'RUNNING';
  } else if (referenced.kind === 'STEP') {
    expectedState = referenced.payload.afterState;
    expectedStatus = 'RUNNING';
  } else if (TERMINAL_KINDS.has(referenced.kind)) {
    expectedState = referenced.payload.finalState;
    expectedStatus = referenced.payload.terminalStatus === 'COMPLETED' ? 'READY' : 'HALTED';
  } else {
    corrupt('Current references an event without continuity state.', { runId: start.runId });
  }
  if (
    current.status !== expectedStatus ||
    canonicalJson(stateProjection(current, current)) !== canonicalJson(expectedState)
  ) corrupt('Current continuity projection differs from its ledger event.', { runId: start.runId });
}

function validateCurrentShape(current) {
  if (
    current.schemaVersion !== SCHEMA_VERSION ||
    !['READY', 'RUNNING', 'HALTED', 'CORRUPT'].includes(current.status) ||
    !Number.isInteger(current.lastRunSequence)
  ) {
    corrupt('Current state is invalid.', {});
  }
  if (current.lastRunId === null) {
    if (
      current.status !== 'READY' || current.lastRunSequence !== 0 || current.eventsDigest !== null ||
      current.worldState !== null || current.rngState !== null || canonicalJson(current.memory) !== '{}'
    ) corrupt('Empty current state is invalid.', {});
  } else {
    validateContinuityState(stateProjection(current, current), 'current', true);
  }
}

function currentFromState(state, watermark) {
  const source = cloneJson(state);
  return withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    worldState: source.worldState,
    memory: source.memory,
    rngState: source.rngState,
    kernelStep: source.kernelStep,
    ...(source.changeSupervisor === undefined ? {} : { changeSupervisor: source.changeSupervisor }),
    ...watermark,
  });
}

function validateContinuityState(value, field, corruptOnFailure = false, trustedSupervisor = false) {
  const fail = (message) => {
    if (corruptOnFailure) corrupt(message, { field });
    throw new LabStoreError('INVALID_INPUT', message, { field });
  };
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.worldState === null || typeof value.worldState !== 'object' || Array.isArray(value.worldState) ||
    value.memory === null || typeof value.memory !== 'object' || Array.isArray(value.memory) ||
    value.rngState === null || typeof value.rngState !== 'object' || Array.isArray(value.rngState) ||
    !Number.isSafeInteger(value.kernelStep) || value.kernelStep < 0 ||
    Object.keys(value).some((key) => !['worldState', 'memory', 'rngState', 'kernelStep', 'changeSupervisor'].includes(key))
  ) {
    fail('Continuity state is invalid.');
  }
  if (value.changeSupervisor !== undefined && !trustedSupervisor) {
    try {
      normalizeChangeSupervisorState(value.changeSupervisor);
    } catch (error) {
      fail(`Continuity change supervisor is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

function validateStepPayload(value, field, corruptOnFailure = false, runStart, manifest, trustedSupervisor = false) {
  const fail = (message) => {
    if (corruptOnFailure) corrupt(message, { field });
    throw new LabStoreError('INVALID_INPUT', message, { field });
  };
  const required = [
    'recordedAt', 'boundary', 'beforeObservation', 'memoryEvidenceProjection', 'beforeDigest',
    'expectation', 'choice', 'receipt', 'postObservation', 'verification', 'update',
    'afterDigest', 'rngBefore', 'rngAfter', 'externalInputs', 'afterState',
  ];
  if (value === null || typeof value !== 'object' || Array.isArray(value) || required.some((key) => !(key in value))) {
    fail('STEP payload is incomplete.');
  }
  const objectFields = ['boundary', 'beforeObservation', 'memoryEvidenceProjection', 'expectation', 'choice', 'receipt', 'postObservation', 'update', 'rngBefore', 'rngAfter'];
  if (
    typeof value.recordedAt !== 'string' ||
    typeof value.beforeDigest !== 'string' ||
    typeof value.afterDigest !== 'string' ||
    objectFields.some((key) => value[key] === null || typeof value[key] !== 'object' || Array.isArray(value[key])) ||
    !Array.isArray(value.externalInputs) ||
    value.verification === null || typeof value.verification !== 'object' || Array.isArray(value.verification)
  ) {
    fail('STEP payload evidence is invalid.');
  }
  const verification = value.verification;
  if (
    verification.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(verification.error) ||
    verification.error.some((item) => !Number.isFinite(item)) ||
    !['ACTION', 'AMBIGUOUS', 'EXECUTION_REJECTED'].includes(verification.attribution) ||
    !Number.isFinite(verification.confidence) || verification.confidence < 0 || verification.confidence > 1 ||
    typeof verification.learnable !== 'boolean'
  ) fail('STEP verification is invalid.');
  if (value.externalInputs.length > 0 && value.receipt.status === 'ACCEPTED' &&
      (value.receipt.attributionWindowComplete !== false || value.receipt.confounderCount < 1 ||
        verification.attribution !== 'AMBIGUOUS' || verification.learnable !== false)) {
    fail('STEP with external inputs must be conservatively marked ambiguous and non-learnable.');
  }
  if (value.boundary.externalInputsDigest !== undefined &&
      value.boundary.externalInputsDigest !== canonicalDigest(value.externalInputs)) {
    fail('STEP boundary does not bind external inputs.');
  }
  if (manifest?.adapter !== undefined &&
      (typeof value.boundary.externalInputsDigest !== 'string' ||
        value.boundary.externalInputsDigest !== canonicalDigest(value.externalInputs))) {
    fail('External adapter STEP is missing its external input binding.');
  }
  if (typeof value.receipt.executionNonce !== 'string' || value.receipt.executionNonce.length === 0) {
    fail('STEP receipt executionNonce is invalid.');
  }
  validateContinuityState(value.afterState, `${field}.afterState`, corruptOnFailure, trustedSupervisor);
  if (
    value.afterDigest !== canonicalDigest(value.afterState) ||
    canonicalJson(value.rngAfter) !== canonicalJson(value.afterState.rngState)
  ) fail('STEP after-state evidence is inconsistent.');
  for (const external of value.externalInputs) {
    validateExternalInput(external, field, corruptOnFailure, runStart, manifest?.adapter);
  }
  if (value.policyEvidence !== undefined) validatePolicyEvidence(value.policyEvidence, field, corruptOnFailure);
  if (value.candidateOutcome !== undefined &&
      (value.policyEvidence === undefined || !isValidCandidateOutcome(value.candidateOutcome, value.policyEvidence))) {
    fail('STEP candidate outcome evidence is invalid.');
  }
}

function validatePolicyEvidence(value, field, corruptOnFailure) {
  const fail = (message) => {
    if (corruptOnFailure) corrupt(message, { field });
    throw new LabStoreError('INVALID_INPUT', message, { field });
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== SCHEMA_VERSION || value.source !== 'model' ||
      typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 4096 ||
      (value.token !== null && (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token))) ||
      typeof value.responseDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.responseDigest) ||
      (value.observationDigest !== undefined && (typeof value.observationDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.observationDigest))) ||
      (value.candidateDigest !== undefined && !isValidCandidateDigest(value)) ||
      (value.proposal !== undefined && !isValidModelProposal(value.proposal)) ||
      typeof value.applied !== 'boolean' ||
      (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 256))) {
    fail('STEP model policy evidence is invalid.');
  }
}

function isValidModelProposal(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(canonicalJson(value), 'utf8') <= MAX_MODEL_PROPOSAL_BYTES;
  } catch {
    return false;
  }
}

function isValidCandidateDigest(value) {
  if (typeof value.candidateDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.candidateDigest)) return false;
  try {
    return value.candidateDigest === candidateDigest({ token: value.token, proposal: value.proposal ?? null });
  } catch {
    return false;
  }
}

function validateExternalInput(value, field, corruptOnFailure, runStart, adapter) {
  const fail = (message) => {
    if (corruptOnFailure) corrupt(message, { field });
    throw new LabStoreError('INVALID_INPUT', message, { field });
  };
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION || value.source !== 'scenario' ||
    typeof value.kind !== 'string' || value.kind.length === 0 ||
    value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload) ||
    typeof value.appliedBeforeVersion !== 'string' || typeof value.digest !== 'string' ||
    (value.attestation !== undefined && (typeof value.attestation !== 'string' || value.attestation.length === 0))
  ) fail('STEP external input is invalid.');
  if (value.digest !== canonicalDigest(externalInputUnsigned(value))) fail('STEP external input digest is invalid.');
  if (adapter !== undefined && !verifyExternalInputAttestation(value, adapter.evidencePublicKey)) {
    fail('STEP external input attestation is invalid.');
  }
  if (!runStart || value.kind !== runStart.scenario || !validScenarioPayload(runStart.worldId, runStart.scenario, value.payload)) {
    fail('STEP external input does not match the run scenario schema.');
  }
}

function validScenarioPayload(worldId, scenario, payload) {
  if (LEGACY_WORLD_SCENARIOS[worldId] === undefined) return true;
  if (scenario === 'external-during-step') {
    return payload.attributionWindowComplete === false && Number.isSafeInteger(payload.confounderCount) && payload.confounderCount > 0;
  }
  if (worldId === 'temperature' && scenario === 'regime-shift') return typeof payload.regime === 'string';
  if (worldId === 'virtual-desktop' && scenario === 'new-files') {
    return Number.isSafeInteger(payload.syntheticFileCount) && payload.syntheticFileCount >= 0;
  }
  return false;
}

function scenarioAllowed(manifest, scenario) {
  if (Array.isArray(manifest.scenarioIds)) return manifest.scenarioIds.includes(scenario);
  return LEGACY_WORLD_SCENARIOS[manifest.worldId]?.has(scenario) === true;
}

function normalizeScenarioIds(value, field) {
  if (!isValidScenarioIds(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty array.`, { field });
  }
  const result = value.map((item, index) => requireText(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new LabStoreError('INVALID_INPUT', `${field} must not contain duplicates.`, { field });
  }
  return result;
}

function isValidScenarioIds(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4096) &&
    new Set(value).size === value.length;
}

function isValidWorldVersion(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WORLD_VERSION_LENGTH;
}

function isValidWorldImplementationDigest(value) {
  return typeof value === 'string' && WORLD_IMPLEMENTATION_DIGEST_PATTERN.test(value);
}

function requireWorldVersion(value, field) {
  if (!isValidWorldVersion(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty string.`, { field });
  }
  return value;
}

function requireWorldImplementationDigest(value, field) {
  if (!isValidWorldImplementationDigest(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a SHA-256 digest.`, { field });
  }
  return value;
}

function normalizeAdapterMetadata(value, field, corruptOnFailure = false) {
  const fail = (message) => {
    if (corruptOnFailure) corrupt(message, { field });
    throw new LabStoreError('INVALID_INPUT', message, { field });
  };
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION || value.protocol !== 'yi-world-cli' ||
    value.version !== 1 || typeof value.adapterId !== 'string' || value.adapterId.length === 0 || value.adapterId.length > 4096 ||
    typeof value.worldVersion !== 'string' || value.worldVersion.length === 0 || value.worldVersion.length > 4096 ||
    !isValidValueSpec(value.valueSpec) ||
    !isValidEvidencePublicKey(value.evidencePublicKey) ||
    typeof value.descriptorDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.descriptorDigest) ||
    typeof value.launchDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.launchDigest)
  ) fail('Adapter metadata is invalid.');
  if (value.supportsIdempotentTransitions !== undefined && typeof value.supportsIdempotentTransitions !== 'boolean') {
    fail('Adapter metadata idempotency declaration is invalid.');
  }
  if (value.supportsReconciliation !== undefined && typeof value.supportsReconciliation !== 'boolean') {
    fail('Adapter metadata reconciliation declaration is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    protocol: 'yi-world-cli',
    version: 1,
    adapterId: value.adapterId,
    worldVersion: value.worldVersion,
    valueSpec: cloneJson(value.valueSpec),
    evidencePublicKey: value.evidencePublicKey,
    descriptorDigest: value.descriptorDigest,
    launchDigest: value.launchDigest,
    ...(value.supportsIdempotentTransitions === undefined
      ? {}
      : { supportsIdempotentTransitions: value.supportsIdempotentTransitions }),
    ...(value.supportsReconciliation === undefined
      ? {}
      : { supportsReconciliation: value.supportsReconciliation }),
  };
}

function isValidValueSpec(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.schemaVersion === SCHEMA_VERSION && Number.isSafeInteger(value.observationDimensions) &&
    value.observationDimensions >= 1 && value.observationDimensions <= 1024 &&
    Array.isArray(value.weights) && value.weights.length === value.observationDimensions &&
    Array.isArray(value.target) && value.target.length === value.observationDimensions &&
    value.weights.every((item) => Number.isFinite(item)) && value.target.every((item) => Number.isFinite(item));
}

function stateProjection(current, fallback) {
  if (current.lastRunId !== null) {
    return {
      worldState: cloneJson(current.worldState),
      memory: cloneJson(current.memory),
      rngState: cloneJson(current.rngState),
      kernelStep: current.kernelStep,
      ...(current.changeSupervisor === undefined ? {} : { changeSupervisor: cloneJson(current.changeSupervisor) }),
    };
  }
  return cloneJson(fallback);
}

function sameContinuityState(previous, next) {
  if (canonicalJson(previous) === canonicalJson(next)) return true;
  if (previous.changeSupervisor === undefined && next.changeSupervisor !== undefined) {
    const withoutSupervisor = { ...next };
    delete withoutSupervisor.changeSupervisor;
    return canonicalJson(previous) === canonicalJson(withoutSupervisor);
  }
  return false;
}

function recoveryStateProjection(current, start, events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].kind === 'STEP') return cloneJson(events[index].payload.afterState);
  }
  if (current.lastRunId === start.runId) return stateProjection(current, start.initialState);
  return cloneJson(start.initialState);
}

async function prepareInitializationTarget(root, expectedIdentity) {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length === 0) return;
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('.initializing')) conflict('Lab directory is not empty.', {});
  const marker = await readJson(childPath(root, '.initializing'), 'initialization marker');
  validateInitializationMarker(marker);
  for (const [field, value] of Object.entries(expectedIdentity)) {
    if (marker[field] !== value) conflict('Interrupted initialization identity differs.', { field });
  }
  const allowedRootStaging = new Set(marker.stagingFiles.filter((value) => !value.includes('/')));
  const allowedStateStaging = new Set(
    marker.stagingFiles
      .filter((value) => value.startsWith('state/'))
      .map((value) => value.slice('state/'.length)),
  );
  for (const entry of entries) {
    if (entry.name === '.initializing') continue;
    if (allowedRootStaging.has(entry.name) && entry.isFile()) continue;
    if (entry.name !== 'state' || !entry.isDirectory()) conflict('Lab directory contains foreign entries.', { entry: entry.name });
    const stateEntries = await readdir(childPath(root, 'state'));
    if (stateEntries.some((name) => !allowedStateStaging.has(name) && name !== 'current.json')) {
      conflict('Interrupted initialization contains foreign state.', {});
    }
  }
  for (const relative of marker.stagingFiles) {
    const segments = relative.split('/');
    await rm(childPath(root, ...segments), { force: true });
  }
  await rm(childPath(root, '.initializing'));
}

async function cleanupCompletedInitialization(root, expectedIdentity) {
  const markerPath = childPath(root, '.initializing');
  if (!(await pathExists(markerPath))) return;
  const marker = await readJson(markerPath, 'initialization marker');
  validateInitializationMarker(marker);
  for (const [field, value] of Object.entries(expectedIdentity)) {
    if (marker[field] !== value) conflict('Completed initialization marker identity differs.', { field });
  }
  for (const relative of marker.stagingFiles) {
    await rm(childPath(root, ...relative.split('/')), { force: true });
  }
  await rm(markerPath);
}

function validateInitializationMarker(marker) {
  const ownerNonce = typeof marker?.ownerNonce === 'string' ? marker.ownerNonce : '';
  const expected = [
    `state/current.json.staging-init-${ownerNonce}`,
    `manifest.json.staging-init-${ownerNonce}`,
  ];
  if (
    marker?.schemaVersion !== SCHEMA_VERSION ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ownerNonce) ||
    !Array.isArray(marker.stagingFiles) ||
    marker.stagingFiles.length !== expected.length ||
    marker.stagingFiles.some((value, index) => value !== expected[index])
  ) {
    corrupt('Initialization marker is invalid.', { artifact: 'initialization marker' });
  }
}

async function validateInitializedLab(root, manifest) {
  await validateManifestRoot(root, manifest);
  if (manifest.worldVersion !== undefined && !isValidWorldVersion(manifest.worldVersion)) {
    corrupt('World version contract is invalid.', { field: 'worldVersion' });
  }
  if (manifest.worldImplementationDigest !== undefined &&
      !isValidWorldImplementationDigest(manifest.worldImplementationDigest)) {
    corrupt('World implementation contract is invalid.', { field: 'worldImplementationDigest' });
  }
  if (manifest.scenarioIds !== undefined && !isValidScenarioIds(manifest.scenarioIds)) {
    corrupt('Scenario contract is invalid.', {});
  }
  if (manifest.adapter !== undefined) normalizeAdapterMetadata(manifest.adapter, 'manifest.adapter', true);
  if (manifest.tokenMap?.schemaVersion !== SCHEMA_VERSION) corrupt('Token map schema is unsupported.', {});
  if (!isValidTokenMapDigest(manifest.tokenMap)) corrupt('Token map digest is invalid.', {});
  const current = await readVerifiedObject(childPath(root, 'state', 'current.json'), 'current');
  validateCurrentShape(current);
}

function isValidTokenMapDigest(tokenMap) {
  const unsigned = { ...tokenMap };
  delete unsigned.digest;
  if (tokenMap.digest === canonicalDigest(unsigned)) return true;
  if (!Array.isArray(tokenMap.entries)) return false;
  const entries = tokenMap.entries.map((entry) => ({ token: entry.token, capabilityId: entry.capabilityId }));
  const entriesDigest = `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
  return tokenMap.digest === entriesDigest;
}

async function validateManifestRoot(root, manifest) {
  if (manifest.schemaVersion !== SCHEMA_VERSION) corrupt('Manifest schema is unsupported.', {});
  if (manifest.canonicalRoot !== root) corrupt('Manifest canonical root does not match the lab.', {});
  await assertDirectoryIsCanonical(root, root);
}

async function acquireWriterLock(root, manifest, purpose, intentDigest) {
  const lock = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    labId: manifest.labId,
    pid: process.pid,
    ownerNonce: randomUUID(),
    purpose,
    ...(intentDigest ? { intentDigest } : {}),
    createdAt: now(),
  });
  const lockPath = childPath(root, 'locks', 'writer.lock');
  const candidatePath = childPath(root, 'locks', `writer.lock.candidate-${process.pid}-${randomUUID()}`);
  await assertSafePath(root, lockPath);
  try {
    await writeFileFlushed(candidatePath, `${canonicalJson(lock)}\n`, { exclusive: true });
    await link(candidatePath, lockPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new LabStoreError('BUSY', 'Writer lock is held.', { purpose });
    throw error;
  } finally {
    await rm(candidatePath, { force: true }).catch(() => {});
  }
  return lock;
}

async function acquireRecoveryLock(root, manifest, intent) {
  await ensurePlainDirectory(root, 'locks');
  return acquireWriterLock(root, manifest, 'recovery', intent.selfDigest);
}

async function removeOwnedLock(root, expected) {
  const lockPath = childPath(root, 'locks', 'writer.lock');
  const actual = await readOptionalJson(lockPath);
  if (actual === null) return;
  if (actual.selfDigest !== expected.selfDigest) {
    corrupt('Writer lock ownership changed.', { phase: 'unlock' });
  }
  await rm(lockPath);
}

async function captureWriterLockIdentity(root, expectedLock) {
  const lockPath = childPath(root, 'locks', 'writer.lock');
  let status;
  try {
    status = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') corrupt('Writer lock disappeared while the run was starting.', { phase: 'start' });
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    pathEscape('Writer lock is not a plain file.', { phase: 'start' });
  }
  const lock = await readOptionalVerifiedObject(lockPath, 'writer lock');
  if (lock === null || lock.selfDigest !== expectedLock.selfDigest) {
    corrupt('Writer lock ownership changed while the run was starting.', { phase: 'start' });
  }
  return {
    ...fileIdentity(status),
    selfDigest: lock.selfDigest,
    rawDigest: rawContentDigest(await readFile(lockPath)),
  };
}

async function assertOwnedLock(root, expectedIdentity) {
  const lockPath = childPath(root, 'locks', 'writer.lock');
  let actual;
  try {
    actual = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') corrupt('Writer lock disappeared while the run was active.', { phase: 'write' });
    throw error;
  }
  if (!actual.isFile() || actual.isSymbolicLink() || !sameFileIdentity(actual, expectedIdentity)) {
    corrupt('Writer lock ownership changed while the run was active.', { phase: 'write' });
  }
  if (actual.size > MAX_JSON_BYTES || rawContentDigest(await readFile(lockPath)) !== expectedIdentity.rawDigest) {
    corrupt('Writer lock ownership changed while the run was active.', { phase: 'write' });
  }
}

function rawContentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fileIdentity(status) {
  return {
    dev: status.dev,
    ino: status.ino,
  };
}

function sameFileIdentity(status, expected) {
  return expected !== undefined &&
    status.dev === expected.dev &&
    status.ino === expected.ino;
}

function validateWriterLock(lock, manifest) {
  if (
    lock.schemaVersion !== SCHEMA_VERSION ||
    lock.labId !== manifest.labId ||
    !verifySelfDigest(lock) ||
    !['run', 'challenge', 'recovery'].includes(lock.purpose) ||
    typeof lock.ownerNonce !== 'string' ||
    !Number.isInteger(lock.pid)
  ) {
    corrupt('Writer lock is invalid.', {});
  }
}

async function probeOwner(probe, lock) {
  try {
    return Boolean(await probe(lock.pid, cloneJson(lock)));
  } catch (cause) {
    throw new LabStoreError('LIVE_OWNER', 'Writer owner liveness is unknown.', { pid: lock.pid }, { cause });
  }
}

function defaultLivenessProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function publishRecoveryIntent(root, lock, command) {
  const ownerNonce = requireSafeSegment(lock.ownerNonce, 'ownerNonce');
  await ensurePlainDirectory(root, 'recovery');
  const directory = childPath(root, 'recovery', ownerNonce);
  try {
    await mkdir(directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertDirectoryIsCanonical(root, directory);
  const intent = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    writerLockDigest: lock.selfDigest,
    command,
    checkedPid: lock.pid,
    ownerLivenessCheck: 'DEAD',
    requestedAt: now(),
  });
  const intentPath = childPath(root, 'recovery', ownerNonce, 'intent.json');
  const existing = await readOptionalVerifiedObject(intentPath, 'recovery intent');
  if (existing !== null) {
    if (existing.writerLockDigest !== lock.selfDigest || existing.command !== command) {
      corrupt('Recovery intent conflicts with existing evidence.', { ownerNonce });
    }
    return { ownerNonce, intent: existing, completion: null };
  }
  await publishImmutableJson(root, intentPath, intent, 'recovery intent');
  return { ownerNonce, intent, completion: null };
}

async function archiveOriginalLock(root, record, lock) {
  const destination = childPath(root, 'recovery', record.ownerNonce, 'stale-lock.json');
  if (await pathExists(destination)) {
    const stale = await readVerifiedObject(destination, 'stale writer lock');
    if (stale.selfDigest !== lock.selfDigest) corrupt('Stale lock evidence conflicts.', { ownerNonce: record.ownerNonce });
    await removeOwnedLock(root, lock);
    return;
  }
  await assertSafePath(root, path.dirname(destination));
  await rename(childPath(root, 'locks', 'writer.lock'), destination);
}

async function archiveRecoveryLock(root, record, lock) {
  const directory = childPath(root, 'recovery', record.ownerNonce);
  const entries = await readdir(directory);
  let generation = 1;
  while (entries.includes(`stale-lock-${generation}.json`)) generation += 1;
  const generationIntent = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    writerLockDigest: lock.selfDigest,
    parentIntentDigest: record.intent.selfDigest,
    command: record.intent.command,
    checkedPid: lock.pid,
    ownerLivenessCheck: 'DEAD',
    requestedAt: now(),
  });
  const intentPath = childPath(root, 'recovery', record.ownerNonce, `intent-${generation}.json`);
  const existing = await readOptionalVerifiedObject(intentPath, 'recovery generation intent');
  if (existing !== null) {
    if (
      existing.writerLockDigest !== lock.selfDigest ||
      existing.parentIntentDigest !== record.intent.selfDigest ||
      existing.checkedPid !== lock.pid
    ) corrupt('Recovery generation intent conflicts with the current lock.', { generation });
  } else {
    await publishImmutableJson(root, intentPath, generationIntent, 'recovery generation intent');
  }
  await rename(childPath(root, 'locks', 'writer.lock'), childPath(root, 'recovery', record.ownerNonce, `stale-lock-${generation}.json`));
}

async function archiveBlockedContender(root, record, lock) {
  const directory = childPath(root, 'recovery', record.ownerNonce);
  const entries = await readdir(directory);
  let generation = 1;
  while (entries.includes(`contender-lock-${generation}.json`)) generation += 1;
  const intent = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    writerLockDigest: lock.selfDigest,
    parentIntentDigest: record.intent.selfDigest,
    command: record.intent.command,
    checkedPid: lock.pid,
    ownerLivenessCheck: 'DEAD',
    disposition: 'BLOCKED_BY_PENDING_RECOVERY',
    requestedAt: now(),
  });
  const intentPath = childPath(root, 'recovery', record.ownerNonce, `contender-intent-${generation}.json`);
  const existing = await readOptionalVerifiedObject(intentPath, 'blocked contender intent');
  if (existing !== null) {
    if (
      existing.writerLockDigest !== lock.selfDigest ||
      existing.parentIntentDigest !== record.intent.selfDigest || existing.checkedPid !== lock.pid
    ) corrupt('Blocked contender intent conflicts with the current lock.', { generation });
  } else {
    await publishImmutableJson(root, intentPath, intent, 'blocked contender intent');
  }
  await rename(
    childPath(root, 'locks', 'writer.lock'),
    childPath(root, 'recovery', record.ownerNonce, `contender-lock-${generation}.json`),
  );
}

async function findRecoveryRecords(root, manifest) {
  const recoveryPath = childPath(root, 'recovery');
  let entries;
  try {
    entries = await readdir(recoveryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { pending: [], finished: [] };
    throw error;
  }
  await assertDirectoryIsCanonical(root, recoveryPath);
  const pending = [];
  const finished = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt('Recovery evidence path is invalid.', { entry: entry.name });
    const ownerNonce = requireSafeSegment(entry.name, 'ownerNonce');
    const recoveryEntries = await readdir(childPath(root, 'recovery', ownerNonce));
    if (recoveryEntries.some((name) => !isRecoveryEvidenceName(name))) {
      corrupt('Recovery evidence contains a foreign file.', { ownerNonce });
    }
    const intent = await readOptionalVerifiedObject(childPath(root, 'recovery', ownerNonce, 'intent.json'), 'recovery intent');
    if (intent === null) continue;
    const stale = await readOptionalVerifiedObject(childPath(root, 'recovery', ownerNonce, 'stale-lock.json'), 'stale writer lock');
    if (stale !== null && intent.writerLockDigest !== stale.selfDigest) {
      corrupt('Recovery intent is not bound to stale lock evidence.', { ownerNonce });
    }
    if (stale !== null) validateWriterLock(stale, manifest);
    validateRecoveryIntent(intent);
    await validateRecoveryGenerations(root, ownerNonce, intent, manifest);
    const completion = await readOptionalVerifiedObject(childPath(root, 'recovery', ownerNonce, 'completion.json'), 'recovery completion');
    if (completion !== null && stale === null) {
      corrupt('Recovery completion has no archived original lock.', { ownerNonce });
    }
    const record = { ownerNonce, intent, stale, completion };
    if (completion === null) pending.push(record);
    else {
      if (completion.intentDigest !== intent.selfDigest) corrupt('Recovery completion targets another intent.', { ownerNonce });
      finished.push(record);
    }
  }
  return { pending, finished };
}

function isRecoveryEvidenceName(name) {
  return name === 'intent.json' || name === 'stale-lock.json' || name === 'completion.json' ||
    /^intent-\d+\.json$/u.test(name) || /^stale-lock-\d+\.json$/u.test(name) ||
    /^contender-intent-\d+\.json$/u.test(name) || /^contender-lock-\d+\.json$/u.test(name) ||
    /^(intent|stale-lock|completion|contender-intent|contender-lock)\.json\.staging-[0-9a-f-]{36}$/iu.test(name);
}

function validateRecoveryIntent(intent) {
  if (
    intent.schemaVersion !== SCHEMA_VERSION || typeof intent.writerLockDigest !== 'string' ||
    typeof intent.command !== 'string' || !Number.isInteger(intent.checkedPid) ||
    intent.ownerLivenessCheck !== 'DEAD'
  ) corrupt('Recovery intent is semantically invalid.', {});
}

async function validateRecoveryGenerations(root, ownerNonce, rootIntent, manifest) {
  const directory = childPath(root, 'recovery', ownerNonce);
  const names = await readdir(directory);
  const generations = names
    .map((name) => /^intent-(\d+)\.json$/u.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
  for (let index = 0; index < generations.length; index += 1) {
    const generation = generations[index];
    if (generation !== index + 1) corrupt('Recovery generation sequence has a gap.', { ownerNonce, generation });
    const intent = await readVerifiedObject(
      childPath(root, 'recovery', ownerNonce, `intent-${generation}.json`),
      'recovery generation intent',
    );
    const stale = await readOptionalVerifiedObject(
      childPath(root, 'recovery', ownerNonce, `stale-lock-${generation}.json`),
      'stale recovery lock',
    );
    if (stale === null) {
      if (index !== generations.length - 1) corrupt('Recovery generation evidence is incomplete.', { ownerNonce, generation });
      continue;
    }
    validateWriterLock(stale, manifest);
    if (
      intent.writerLockDigest !== stale.selfDigest ||
      intent.parentIntentDigest !== rootIntent.selfDigest ||
      intent.checkedPid !== stale.pid ||
      intent.ownerLivenessCheck !== 'DEAD'
    ) {
      corrupt('Recovery generation evidence is not bound.', { ownerNonce, generation });
    }
  }
  const staleGenerations = names.filter((name) => /^stale-lock-\d+\.json$/u.test(name));
  if (staleGenerations.length < generations.length - 1 || staleGenerations.length > generations.length) {
    corrupt('Recovery generation evidence is incomplete.', { ownerNonce });
  }
  const contenderGenerations = names
    .map((name) => /^contender-intent-(\d+)\.json$/u.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
  for (let index = 0; index < contenderGenerations.length; index += 1) {
    const generation = contenderGenerations[index];
    if (generation !== index + 1) corrupt('Blocked contender evidence has a gap.', { ownerNonce, generation });
    const intent = await readVerifiedObject(
      childPath(root, 'recovery', ownerNonce, `contender-intent-${generation}.json`),
      'blocked contender intent',
    );
    const lock = await readOptionalVerifiedObject(
      childPath(root, 'recovery', ownerNonce, `contender-lock-${generation}.json`),
      'blocked contender lock',
    );
    if (lock === null) {
      if (index !== contenderGenerations.length - 1) corrupt('Blocked contender evidence is incomplete.', { ownerNonce, generation });
      continue;
    }
    validateWriterLock(lock, manifest);
    if (
      intent.writerLockDigest !== lock.selfDigest || intent.parentIntentDigest !== rootIntent.selfDigest ||
      intent.checkedPid !== lock.pid || intent.disposition !== 'BLOCKED_BY_PENDING_RECOVERY'
    ) corrupt('Blocked contender evidence is not bound.', { ownerNonce, generation });
  }
  const contenderLockCount = names.filter((name) => /^contender-lock-\d+\.json$/u.test(name)).length;
  if (contenderLockCount < contenderGenerations.length - 1 || contenderLockCount > contenderGenerations.length) {
    corrupt('Blocked contender evidence is incomplete.', { ownerNonce });
  }
}

async function hasPendingRecovery(root, manifest) {
  const records = await findRecoveryRecords(root, manifest);
  if (records.pending.length > 1) {
    corrupt('Recovery evidence has multiple branches.', {});
  }
  return records.pending.length === 1;
}

async function listRunIds(root) {
  const runsPath = childPath(root, 'runs');
  let entries;
  try {
    entries = await readdir(runsPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  await assertDirectoryIsCanonical(root, runsPath);
  const runIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt('Run path is not a plain directory.', { entry: entry.name });
    runIds.push(requireSafeSegment(entry.name, 'runId'));
  }
  return runIds.sort();
}

async function publishImmutableJson(root, target, value, label) {
  const existing = await readOptionalJson(target);
  if (existing !== null) {
    if (canonicalJson(existing) === canonicalJson(value)) return existing;
    conflict(`${label} already exists with different content.`, {});
  }
  return atomicWriteJson(root, target, value, undefined, true);
}

async function atomicWriteJson(root, target, value, beforePublish, exclusive = false, stagingOverride) {
  await assertSafePath(root, path.dirname(target));
  const staging = stagingOverride ?? `${target}.staging-${process.pid}-${randomUUID()}`;
  await assertSafePath(root, staging);
  const content = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(content) > MAX_JSON_BYTES) {
    throw new LabStoreError('INVALID_INPUT', 'JSON artifact exceeds the size limit.', { artifact: path.basename(target) });
  }
  try {
    await writeFileFlushed(staging, content, { exclusive: true });
    if (beforePublish) await beforePublish();
    if (exclusive && await pathExists(target)) conflict('Immutable target was published concurrently.', {});
    if (exclusive) {
      try {
        // A rename can replace a target between the existence check and the
        // publish on Windows. A same-directory hard link makes this commit
        // genuinely create-if-absent.
        await link(staging, target);
      } catch (error) {
        if (error?.code === 'EEXIST') conflict('Immutable target was published concurrently.', {});
        throw error;
      }
    } else {
      await rename(staging, target);
    }
  } catch (error) {
    throw error;
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
  return cloneJson(value);
}

async function writeFileFlushed(filePath, content, { exclusive = false } = {}) {
  const handle = await open(filePath, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeEmptyDirectory(directory) {
  try {
    if ((await readdir(directory)).length === 0) await rmdir(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
  }
}

async function readVerifiedObject(filePath, label) {
  const value = await readJson(filePath, label);
  if (value.schemaVersion !== SCHEMA_VERSION || !verifySelfDigest(value)) {
    corrupt(`${label} schema or digest is invalid.`, { artifact: label });
  }
  return value;
}

async function readOptionalVerifiedObject(filePath, label) {
  const value = await readOptionalJson(filePath);
  if (value === null) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || !verifySelfDigest(value)) {
    corrupt(`${label} schema or digest is invalid.`, { artifact: label });
  }
  return value;
}

async function readJson(filePath, label) {
  try {
    const status = await lstat(filePath);
    if (!status.isFile() || status.isSymbolicLink()) pathEscape(`${label} is not a plain file.`);
    if (status.size > MAX_JSON_BYTES) corrupt(`${label} exceeds the size limit.`, { artifact: label });
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    canonicalJson(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      corrupt(`${label} must be a JSON object.`, { artifact: label });
    }
    return value;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new LabStoreError('CORRUPT', `${label} contains malformed JSON.`, { artifact: label }, { cause });
    }
    if (cause instanceof TypeError) {
      throw new LabStoreError('CORRUPT', `${label} exceeds JSON structural limits.`, { artifact: label }, { cause });
    }
    throw cause;
  }
}

async function readOptionalJson(filePath) {
  try {
    const status = await lstat(filePath);
    if (!status.isFile() || status.isSymbolicLink()) pathEscape('Stored JSON is not a plain file.');
    if (status.size > MAX_JSON_BYTES) corrupt('Stored JSON exceeds the size limit.', {});
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    canonicalJson(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      corrupt('Stored JSON must be a JSON object.', {});
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) corrupt('Stored JSON is malformed.', {});
    if (error instanceof TypeError) corrupt('Stored JSON exceeds structural limits.', {});
    throw error;
  }
}

async function canonicalizeInitPath(inputPath) {
  const resolved = path.resolve(inputPath);
  let existing = resolved;
  while (!(await pathExists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new LabStoreError('PATH_ESCAPE', 'Lab path has no existing ancestor.', {});
    existing = parent;
  }
  const status = await lstat(existing);
  if (!status.isDirectory() || status.isSymbolicLink()) pathEscape('Lab ancestor is not a plain directory.');
  const canonicalAncestor = await realpath(existing);
  const canonical = path.resolve(canonicalAncestor, path.relative(existing, resolved));
  if (!samePath(canonical, resolved)) pathEscape('Lab path traverses a link or junction.');
  return canonical;
}

async function canonicalizeExistingLab(inputPath) {
  const resolved = path.resolve(inputPath);
  const status = await lstat(resolved).catch((error) => {
    if (error?.code === 'ENOENT') pathEscape('Lab path does not exist.');
    throw error;
  });
  if (!status.isDirectory() || status.isSymbolicLink()) pathEscape('Lab path is not a plain directory.');
  const canonical = await realpath(resolved);
  if (!samePath(canonical, resolved)) pathEscape('Lab path traverses a link or junction.');
  return canonical;
}

async function ensurePlainDirectory(root, segment) {
  const directory = childPath(root, segment);
  try {
    await mkdir(directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertDirectoryIsCanonical(root, directory);
}

async function assertDirectoryIsCanonical(root, directory) {
  await assertSafePath(root, directory);
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) pathEscape('Storage directory is a link or non-directory.');
  const canonical = await realpath(directory);
  if (!samePath(canonical, directory)) pathEscape('Storage directory traverses a link or junction.');
}

async function assertSafePath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) pathEscape('Storage path escapes the canonical lab.');
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let status;
    try {
      status = await lstat(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (status.isSymbolicLink()) pathEscape('Storage path contains a link or junction.');
  }
}

function childPath(root, ...segments) {
  for (const segment of segments) requireSafeSegment(segment, 'path segment');
  const candidate = path.join(root, ...segments);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) pathEscape('Storage path escapes the canonical lab.');
  return candidate;
}

function requireSafeSegment(value, field) {
  const text = requireText(value, field);
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\') || text.includes('\0')) {
    pathEscape(`${field} is not a canonical path segment.`, { field });
  }
  return text;
}

function requireObject(value, field) {
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

function requireTerminalReason(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new LabStoreError('INVALID_INPUT', 'reason must be a non-empty string of at most 512 characters.', { field: 'reason' });
  }
  return value;
}

function cloneInputJson(value, field) {
  try {
    return cloneJson(value);
  } catch (cause) {
    throw new LabStoreError('INVALID_INPUT', `${field} is not bounded JSON data.`, { field }, { cause });
  }
}

function inject(failpoint, point) {
  if (typeof failpoint === 'function' && failpoint(point)) {
    throw new LabStoreError('INJECTED_FAILURE', `Injected failure at ${point}.`, { point });
  }
}

function recoveryResult(reason, current, writerOwnerNonce) {
  return { reason, current: cloneJson(current), writerOwnerNonce };
}

function now() {
  return new Date().toISOString();
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeError(error, fallbackCode, fallbackMessage, context = {}) {
  if (error instanceof LabStoreError) return error;
  return new LabStoreError(fallbackCode, fallbackMessage, context, { cause: error });
}

function conflict(message, context) {
  throw new LabStoreError('CONFLICT', message, context);
}

function corrupt(message, context) {
  throw new LabStoreError('CORRUPT', message, context);
}

function pathEscape(message, context = {}) {
  throw new LabStoreError('PATH_ESCAPE', message, context);
}
