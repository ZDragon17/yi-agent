import {
  SCHEMA_VERSION,
  canonicalDigest,
  cloneJson,
} from '../runtime/schema.mjs';

const RISK_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
const PHASES = new Set([
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
  'EXECUTING',
  'RECONCILE_REQUIRED',
  'APPLIED',
  'REJECTED',
  'REVERSED',
  'COMPENSATION_UNKNOWN',
]);
const EVENT_PHASES = new Map([
  ['INTENT_PLANNED', new Set(['AWAITING_CONFIRMATION', 'CONFIRMED'])],
  ['AUTO_AUTHORIZED', new Set(['CONFIRMED'])],
  ['HUMAN_CONFIRMED', new Set(['CONFIRMED'])],
  ['EXECUTION_STARTED', new Set(['EXECUTING'])],
  ['EXECUTION_RESULT_UNKNOWN', new Set(['RECONCILE_REQUIRED'])],
  ['RECONCILIATION_UNKNOWN', new Set(['RECONCILE_REQUIRED'])],
  ['EFFECT_APPLIED', new Set(['APPLIED'])],
  ['EFFECT_REJECTED', new Set(['REJECTED'])],
  ['RECONCILED_ABSENT', new Set(['CONFIRMED'])],
  ['RECONCILED_APPLIED', new Set(['APPLIED'])],
  ['COMPENSATION_STARTED', new Set(['COMPENSATION_UNKNOWN'])],
  ['COMPENSATION_RESULT_UNKNOWN', new Set(['COMPENSATION_UNKNOWN'])],
  ['EFFECT_REVERSED', new Set(['REVERSED'])],
  ['COMPENSATION_RECONCILIATION_UNKNOWN', new Set(['COMPENSATION_UNKNOWN'])],
  ['RECONCILED_REVERSED', new Set(['REVERSED'])],
]);

export class EffectBrokerError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'EffectBrokerError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function createEffectBroker({
  executor,
  now = () => new Date().toISOString(),
  journal = null,
  initialRecords = [],
}) {
  validateExecutor(executor);
  if (typeof now !== 'function') {
    throw new EffectBrokerError('INVALID_INPUT', 'EffectBroker clock must be a function.');
  }
  if (journal !== null && (typeof journal.append !== 'function' || typeof journal.read !== 'function')) {
    throw new EffectBrokerError('INVALID_INPUT', 'EffectBroker journal does not expose append/read.');
  }

  const records = new Map();
  for (const source of initialRecords) {
    const record = restoreRecord(source);
    if (records.has(record.intent.executionNonce)) {
      throw new EffectBrokerError('INVALID_INPUT', 'EffectBroker restore contains duplicate execution nonces.');
    }
    records.set(record.intent.executionNonce, record);
  }
  let operationTail = Promise.resolve();

  return Object.freeze({
    plan(input) {
      return enqueue(async () => {
        const intent = normalizeIntent(input);
        const existing = records.get(intent.executionNonce);
        if (existing !== undefined) {
          if (existing.intent.planDigest !== intent.planDigest) {
            throw new EffectBrokerError('CONFLICT', 'Execution nonce is already bound to a different effect plan.', {
              executionNonce: intent.executionNonce,
            });
          }
          return snapshot(existing);
        }
        const record = {
          intent,
          phase: intent.requiresConfirmation ? 'AWAITING_CONFIRMATION' : 'CONFIRMED',
          receipt: null,
          events: [],
        };
        await transition(record, record.phase, null, 'INTENT_PLANNED', {
          planDigest: intent.planDigest,
        });
        records.set(intent.executionNonce, record);
        if (record.phase === 'CONFIRMED') {
          await transition(record, 'CONFIRMED', null, 'AUTO_AUTHORIZED', {
            reason: 'intent.requiresConfirmation=false',
          });
        }
        return snapshot(record);
      });
    },

    confirm(executionNonce) {
      return enqueue(async () => {
        const record = requireRecord(records, executionNonce);
        if (record.phase === 'AWAITING_CONFIRMATION') {
          await transition(record, 'CONFIRMED', null, 'HUMAN_CONFIRMED', {});
        } else if (record.phase !== 'CONFIRMED') {
          throw invalidPhase(record, 'confirm');
        }
        return snapshot(record);
      });
    },

    execute(executionNonce) {
      return enqueue(async () => {
        const record = requireRecord(records, executionNonce);
        if (record.phase === 'APPLIED' || record.phase === 'REJECTED' || record.phase === 'REVERSED') {
          return snapshot(record);
        }
        if (record.phase !== 'CONFIRMED') throw invalidPhase(record, 'execute');

        // This durable boundary is the permission to call the external effect executor.
        await transition(record, 'EXECUTING', null, 'EXECUTION_STARTED', {});
        let result;
        try {
          result = await executor.execute(cloneJson(record.intent));
        } catch (error) {
          return markUnknown(record, 'EXECUTION_RESULT_UNKNOWN', error);
        }
        if (!isRecord(result) || !['APPLIED', 'REJECTED', 'UNKNOWN'].includes(result.status) ||
            (result.status !== 'UNKNOWN' && !isDigest(result.effectDigest))) {
          return markUnknown(record, 'EXECUTION_RESULT_UNKNOWN', new Error('invalid executor result'));
        }
        if (result.status === 'UNKNOWN') return markUnknown(record, 'EXECUTION_RESULT_UNKNOWN', null);

        const receipt = {
          ...result,
          executionNonce: record.intent.executionNonce,
          planDigest: record.intent.planDigest,
        };
        try {
          await transition(record, result.status, receipt,
            result.status === 'APPLIED' ? 'EFFECT_APPLIED' : 'EFFECT_REJECTED', receipt);
        } catch (error) {
          markLocallyUnknown(record);
          throw error;
        }
        return snapshot(record);
      });
    },

    reconcile(executionNonce) {
      return enqueue(async () => {
        const record = requireRecord(records, executionNonce);
        if (record.phase !== 'RECONCILE_REQUIRED') throw invalidPhase(record, 'reconcile');
        let result;
        try {
          result = await executor.reconcile(cloneJson(record.intent));
        } catch (error) {
          return markUnknown(record, 'RECONCILIATION_UNKNOWN', error);
        }
        if (!isRecord(result) || !['APPLIED', 'ABSENT', 'UNKNOWN'].includes(result.status) ||
            (result.status === 'APPLIED' && !isDigest(result.effectDigest))) {
          return markUnknown(record, 'RECONCILIATION_UNKNOWN', new Error('invalid reconciler result'));
        }
        if (result.status === 'UNKNOWN') return markUnknown(record, 'RECONCILIATION_UNKNOWN', null);
        if (result.status === 'ABSENT') {
          try {
            await transition(record, 'CONFIRMED', null, 'RECONCILED_ABSENT', {
              executionNonce: record.intent.executionNonce,
            });
          } catch (error) {
            markLocallyUnknown(record);
            throw error;
          }
          return snapshot(record);
        }

        const receipt = {
          ...result,
          executionNonce: record.intent.executionNonce,
          planDigest: record.intent.planDigest,
          source: 'RECONCILIATION',
        };
        try {
          await transition(record, 'APPLIED', receipt, 'RECONCILED_APPLIED', receipt);
        } catch (error) {
          markLocallyUnknown(record);
          throw error;
        }
        return snapshot(record);
      });
    },

    compensate(executionNonce) {
      return enqueue(async () => {
        const record = requireRecord(records, executionNonce);
        if (record.phase !== 'APPLIED') throw invalidPhase(record, 'compensate');
        if (!record.intent.reversible || record.intent.compensation === null) {
          throw new EffectBrokerError('NOT_REVERSIBLE', 'Effect has no declared compensation plan.', { executionNonce });
        }
        // Compensation is another external effect: persist its uncertain boundary first.
        await transition(record, 'COMPENSATION_UNKNOWN', null, 'COMPENSATION_STARTED', {});
        let result;
        try {
          result = await executor.compensate(cloneJson(record.intent), cloneJson(record.receipt));
        } catch (error) {
          return markCompensationUnknown(record, errorDescriptor(error));
        }
        if (!isRecord(result) || !['REVERSED', 'UNKNOWN'].includes(result.status) ||
            (result.status === 'REVERSED' && !isDigest(result.effectDigest))) {
          return markCompensationUnknown(record, { reason: 'invalid executor result' });
        }
        if (result.status === 'UNKNOWN') return markCompensationUnknown(record, {});

        const receipt = {
          ...result,
          executionNonce: record.intent.executionNonce,
          planDigest: record.intent.planDigest,
        };
        try {
          await transition(record, 'REVERSED', receipt, 'EFFECT_REVERSED', receipt);
        } catch (error) {
          record.phase = 'COMPENSATION_UNKNOWN';
          record.receipt = null;
          throw error;
        }
        return snapshot(record);
      });
    },

    reconcileCompensation(executionNonce) {
      return enqueue(async () => {
        const record = requireRecord(records, executionNonce);
        if (record.phase !== 'COMPENSATION_UNKNOWN') throw invalidPhase(record, 'reconcileCompensation');
        let result;
        try {
          result = await executor.reconcileCompensation(cloneJson(record.intent), cloneJson(record.receipt));
        } catch (error) {
          await appendOnly(record, 'COMPENSATION_RECONCILIATION_UNKNOWN', errorDescriptor(error));
          return snapshot(record);
        }
        if (!isRecord(result) || !['REVERSED', 'NOT_REVERSED', 'UNKNOWN'].includes(result.status) ||
            (result.status === 'REVERSED' && !isDigest(result.effectDigest))) {
          await appendOnly(record, 'COMPENSATION_RECONCILIATION_UNKNOWN', { reason: 'invalid executor result' });
          return snapshot(record);
        }
        if (result.status === 'NOT_REVERSED' || result.status === 'UNKNOWN') {
          await appendOnly(record, 'COMPENSATION_RECONCILIATION_UNKNOWN', result);
          return snapshot(record);
        }

        const receipt = {
          ...result,
          executionNonce: record.intent.executionNonce,
          planDigest: record.intent.planDigest,
          source: 'COMPENSATION_RECONCILIATION',
        };
        await transition(record, 'REVERSED', receipt, 'RECONCILED_REVERSED', receipt);
        return snapshot(record);
      });
    },

    get(executionNonce) {
      return snapshot(requireRecord(records, executionNonce));
    },
  });

  function enqueue(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => undefined);
    return result;
  }

  async function transition(record, phase, receipt, type, detail) {
    if (!PHASES.has(phase)) throw new EffectBrokerError('INVALID_INPUT', `Unknown broker phase: ${phase}.`);
    const event = await appendEvent(record, type, { phase, receipt, detail });
    record.phase = phase;
    record.receipt = receipt === null ? null : cloneJson(receipt);
    record.events.push(event);
  }

  async function appendOnly(record, type, detail) {
    const event = await appendEvent(record, type, {
      phase: record.phase,
      receipt: record.receipt,
      detail,
    });
    record.events.push(event);
  }

  async function appendEvent(record, type, state) {
    if (journal !== null) {
      return journal.append({
        type,
        executionNonce: record.intent.executionNonce,
        recordedAt: now(),
        payload: {
          phase: state.phase,
          intent: record.intent,
          receipt: state.receipt === null ? null : cloneJson(state.receipt),
          detail: state.detail === undefined ? null : cloneJson(state.detail),
        },
      });
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      sequence: record.events.length + 1,
      recordedAt: now(),
      type,
      executionNonce: record.intent.executionNonce,
      detail: cloneJson(state.detail === undefined ? null : state.detail),
    };
  }

  async function markUnknown(record, type, error) {
    try {
      await transition(record, 'RECONCILE_REQUIRED', null, type, errorDescriptor(error));
    } catch (appendError) {
      markLocallyUnknown(record);
      throw appendError;
    }
    return snapshot(record);
  }

  async function markCompensationUnknown(record, detail) {
    try {
      await transition(record, 'COMPENSATION_UNKNOWN', null, 'COMPENSATION_RESULT_UNKNOWN', detail);
    } catch (appendError) {
      record.phase = 'COMPENSATION_UNKNOWN';
      record.receipt = null;
      throw appendError;
    }
    return snapshot(record);
  }

  function markLocallyUnknown(record) {
    record.phase = 'RECONCILE_REQUIRED';
    record.receipt = null;
  }
}

export async function restoreEffectBroker({ journal, executor, now = () => new Date().toISOString() }) {
  if (!journal || typeof journal.read !== 'function') {
    throw new EffectBrokerError('INVALID_INPUT', 'EffectBroker restore requires a readable journal.');
  }
  const grouped = new Map();
  for (const event of journal.read()) {
    if (!isRecord(event) || !isRecord(event.payload)) {
      throw new EffectBrokerError('CORRUPT', 'Effect journal event payload cannot restore an effect broker.');
    }
    const { phase, intent, receipt } = event.payload;
    const normalized = normalizeIntent(intent);
    const allowedPhases = EVENT_PHASES.get(event.type);
    if (event.executionNonce !== normalized.executionNonce || allowedPhases === undefined ||
        !allowedPhases.has(phase) ||
        (receipt !== null && !isData(receipt))) {
      throw new EffectBrokerError('CORRUPT', 'Effect journal event contains an invalid broker snapshot.', {
        executionNonce: event.executionNonce,
      });
    }
    const existing = grouped.get(normalized.executionNonce);
    if (existing === undefined && event.type !== 'INTENT_PLANNED') {
      throw new EffectBrokerError('CORRUPT', 'Effect journal starts an effect without INTENT_PLANNED.', {
        executionNonce: normalized.executionNonce,
      });
    }
    if (existing !== undefined && event.type === 'INTENT_PLANNED') {
      throw new EffectBrokerError('CORRUPT', 'Effect journal plans the same effect more than once.', {
        executionNonce: normalized.executionNonce,
      });
    }
    if (existing !== undefined && !canFollow(existing.phase, event.type, phase)) {
      throw new EffectBrokerError('CORRUPT', 'Effect journal contains an impossible broker transition.', {
        executionNonce: normalized.executionNonce,
        phase: existing.phase,
        type: event.type,
      });
    }
    if (existing !== undefined && existing.intent.planDigest !== normalized.planDigest) {
      throw new EffectBrokerError('CORRUPT', 'Effect journal changes the plan bound to an execution nonce.', {
        executionNonce: normalized.executionNonce,
      });
    }
    const record = existing ?? {
      intent: normalized,
      phase,
      receipt: receipt === null ? null : cloneJson(receipt),
      events: [],
    };
    record.phase = phase;
    record.receipt = receipt === null ? null : cloneJson(receipt);
    record.events.push(cloneJson(event));
    grouped.set(normalized.executionNonce, record);
  }

  for (const record of grouped.values()) {
    // EXECUTING means the executor may have observed the request before a crash.
    // Recovery must reconcile; it must never blindly execute the same nonce again.
    if (record.phase === 'EXECUTING') {
      record.phase = 'RECONCILE_REQUIRED';
      record.receipt = null;
    }
  }
  return createEffectBroker({ executor, now, journal, initialRecords: [...grouped.values()] });
}

function validateExecutor(executor) {
  if (!executor || typeof executor !== 'object' ||
      typeof executor.execute !== 'function' ||
      typeof executor.reconcile !== 'function' ||
      typeof executor.compensate !== 'function' ||
      typeof executor.reconcileCompensation !== 'function') {
    throw new EffectBrokerError('INVALID_INPUT', 'EffectBroker executor does not expose the complete idempotent contract.');
  }
}

function canFollow(previousPhase, type, nextPhase) {
  if (previousPhase === 'AWAITING_CONFIRMATION') return type === 'HUMAN_CONFIRMED' && nextPhase === 'CONFIRMED';
  if (previousPhase === 'CONFIRMED') return (
    (type === 'AUTO_AUTHORIZED' && nextPhase === 'CONFIRMED') ||
    (type === 'EXECUTION_STARTED' && nextPhase === 'EXECUTING')
  );
  if (previousPhase === 'EXECUTING') return (
    (type === 'EXECUTION_RESULT_UNKNOWN' && nextPhase === 'RECONCILE_REQUIRED') ||
    (type === 'EFFECT_APPLIED' && nextPhase === 'APPLIED') ||
    (type === 'EFFECT_REJECTED' && nextPhase === 'REJECTED')
  );
  if (previousPhase === 'RECONCILE_REQUIRED') return (
    (type === 'RECONCILIATION_UNKNOWN' && nextPhase === 'RECONCILE_REQUIRED') ||
    (type === 'RECONCILED_ABSENT' && nextPhase === 'CONFIRMED') ||
    (type === 'RECONCILED_APPLIED' && nextPhase === 'APPLIED')
  );
  if (previousPhase === 'APPLIED') return type === 'COMPENSATION_STARTED' && nextPhase === 'COMPENSATION_UNKNOWN';
  if (previousPhase === 'COMPENSATION_UNKNOWN') return (
    (type === 'COMPENSATION_RESULT_UNKNOWN' && nextPhase === 'COMPENSATION_UNKNOWN') ||
    (type === 'COMPENSATION_RECONCILIATION_UNKNOWN' && nextPhase === 'COMPENSATION_UNKNOWN') ||
    (type === 'RECONCILED_REVERSED' && nextPhase === 'REVERSED')
  );
  return false;
}

function normalizeIntent(value) {
  if (!isRecord(value)) throw new EffectBrokerError('INVALID_INPUT', 'Effect intent must be a plain object.');
  const required = ['schemaVersion', 'effectId', 'executionNonce', 'actionToken', 'target', 'precondition', 'risk', 'requiresConfirmation', 'reversible', 'compensation', 'planDigest'];
  if (Object.keys(value).some((key) => !required.includes(key)) || required.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== SCHEMA_VERSION || !nonEmpty(value.effectId) || !nonEmpty(value.executionNonce) ||
      !nonEmpty(value.actionToken) || !RISK_LEVELS.has(value.risk) || typeof value.requiresConfirmation !== 'boolean' ||
      typeof value.reversible !== 'boolean' || (value.reversible !== (value.compensation !== null)) ||
      (value.risk !== 'LOW' && value.requiresConfirmation !== true) ||
      typeof value.planDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.planDigest) ||
      !isData(value.target) || !isData(value.precondition) || (value.compensation !== null && !isData(value.compensation)) ||
      value.planDigest !== canonicalDigest({ ...value, planDigest: undefined })) {
    throw new EffectBrokerError('INVALID_INPUT', 'Effect intent violates the immutable broker contract.', { field: 'intent' });
  }
  const unsigned = { ...value };
  delete unsigned.planDigest;
  return Object.freeze(cloneJson({ ...unsigned, planDigest: value.planDigest }));
}

function restoreRecord(source) {
  if (!isRecord(source) || !isRecord(source.intent) || !PHASES.has(source.phase) ||
      (source.receipt !== null && !isData(source.receipt)) || !Array.isArray(source.events)) {
    throw new EffectBrokerError('INVALID_INPUT', 'EffectBroker restore record is invalid.');
  }
  return {
    intent: normalizeIntent(source.intent),
    phase: source.phase,
    receipt: source.receipt === null ? null : cloneJson(source.receipt),
    events: cloneJson(source.events),
  };
}

function requireRecord(records, executionNonce) {
  if (typeof executionNonce !== 'string' || executionNonce.length === 0 || !records.has(executionNonce)) {
    throw new EffectBrokerError('NOT_FOUND', 'No effect intent is bound to this execution nonce.', { executionNonce });
  }
  return records.get(executionNonce);
}

function invalidPhase(record, operation) {
  return new EffectBrokerError('INVALID_STATE', `Effect cannot ${operation} in phase ${record.phase}.`, {
    executionNonce: record.intent.executionNonce,
    phase: record.phase,
  });
}

function snapshot(record) {
  return cloneJson({
    schemaVersion: SCHEMA_VERSION,
    phase: record.phase,
    intent: record.intent,
    receipt: record.receipt,
    events: record.events,
  });
}

function errorDescriptor(error) {
  return error === null ? {} : { errorType: typeof error?.name === 'string' ? error.name : 'Error' };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isData(value) {
  try {
    cloneJson(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}
