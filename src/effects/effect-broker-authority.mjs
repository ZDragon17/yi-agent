import { SCHEMA_VERSION, canonicalDigest, cloneJson } from '../runtime/schema.mjs';
import {
  publicKeyForPrivateKey,
  signExecutionAuthorityReceipt,
} from '../runtime/execution-authority-attestation.mjs';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;

export class EffectBrokerAuthorityError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'EffectBrokerAuthorityError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function createEffectBrokerAuthority({ broker, effectPlan, descriptor = null, signingKey = null }) {
  if (!broker || typeof broker.plan !== 'function' || typeof broker.get !== 'function' ||
      typeof broker.execute !== 'function' || typeof broker.reconcile !== 'function') {
    throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority requires a complete EffectBroker.');
  }
  const plan = normalizeEffectPlan(effectPlan);
  const publishedDescriptor = descriptor === null ? null : cloneJson(descriptor);
  if (signingKey !== null) {
    if (publishedDescriptor?.executionPublicKey === undefined ||
        publicKeyForPrivateKey(signingKey) !== publishedDescriptor.executionPublicKey) {
      throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority signing key does not match its published descriptor.');
    }
  } else if (publishedDescriptor?.executionPublicKey !== undefined) {
    throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority descriptor publishes a key without a signing key.');
  }

  return Object.freeze({
    hello() {
      if (publishedDescriptor === null) {
        throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority descriptor is not configured.');
      }
      return cloneJson(publishedDescriptor);
    },

    async executeExecution(payload) {
      const intent = intentFor(payload, plan);
      const planned = await broker.plan(intent);
      if (planned.phase === 'AWAITING_CONFIRMATION') {
        throw new EffectBrokerAuthorityError('CONFIRMATION_REQUIRED', 'EffectBroker authority will not bypass confirmation.');
      }
      const result = await broker.execute(intent.executionNonce);
      if (result.phase !== 'APPLIED') {
        throw new EffectBrokerAuthorityError('EFFECT_NOT_APPLIED', 'EffectBroker authority did not apply the effect.', {
          executionNonce: intent.executionNonce,
          phase: result.phase,
        });
      }
      return authorityReceipt('EXECUTED', payload, plan, signingKey);
    },

    async reconcileExecution(payload) {
      const intent = intentFor(payload, plan);
      await broker.plan(intent);
      let result = broker.get(intent.executionNonce);
      if (result.phase === 'RECONCILE_REQUIRED') {
        result = await broker.reconcile(intent.executionNonce);
      }
      if (result.phase !== 'APPLIED') {
        throw new EffectBrokerAuthorityError('EFFECT_NOT_RECONCILED', 'EffectBroker authority could not reconcile the effect.', {
          executionNonce: intent.executionNonce,
          phase: result.phase,
        });
      }
      return authorityReceipt('RECONCILED', payload, plan, signingKey);
    },
  });
}

function normalizeEffectPlan(value) {
  if (!isPlainObject(value) ||
      Object.keys(value).some((key) => !['effectId', 'target', 'precondition', 'risk', 'requiresConfirmation', 'reversible', 'compensation', 'afterStateDigest'].includes(key)) ||
      typeof value.effectId !== 'string' || value.effectId.length === 0 || value.effectId.length > 4096 ||
      !isData(value.target) || !isData(value.precondition) ||
      !['LOW', 'MEDIUM', 'HIGH'].includes(value.risk) || typeof value.requiresConfirmation !== 'boolean' ||
      typeof value.reversible !== 'boolean' || (value.reversible !== (value.compensation !== null)) ||
      (value.risk !== 'LOW' && value.requiresConfirmation !== true) ||
      (value.compensation !== null && !isData(value.compensation)) ||
      (value.afterStateDigest !== undefined && !DIGEST_PATTERN.test(value.afterStateDigest))) {
    throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority effect plan is invalid.');
  }
  return {
    effectId: value.effectId,
    target: cloneJson(value.target),
    precondition: cloneJson(value.precondition),
    risk: value.risk,
    requiresConfirmation: value.requiresConfirmation,
    reversible: value.reversible,
    compensation: value.compensation === null ? null : cloneJson(value.compensation),
    ...(value.afterStateDigest === undefined ? {} : { afterStateDigest: value.afterStateDigest }),
  };
}

function intentFor(payload, plan) {
  if (!isPlainObject(payload) || payload.schemaVersion !== SCHEMA_VERSION ||
      typeof payload.executionNonce !== 'string' || payload.executionNonce.length === 0 || payload.executionNonce.length > 4096 ||
      typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token) ||
      typeof payload.basedOnVersion !== 'string' || payload.basedOnVersion.length === 0 || payload.basedOnVersion.length > 4096 ||
      !DIGEST_PATTERN.test(payload.beforeStateDigest)) {
    throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority execution payload is invalid.');
  }
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    effectId: plan.effectId,
    executionNonce: payload.executionNonce,
    actionToken: payload.token,
    target: cloneJson(plan.target),
    precondition: {
      ...cloneJson(plan.precondition),
      worldStateDigest: payload.beforeStateDigest,
      stateVersion: payload.basedOnVersion,
    },
    risk: plan.risk,
    requiresConfirmation: plan.requiresConfirmation,
    reversible: plan.reversible,
    compensation: plan.compensation === null ? null : cloneJson(plan.compensation),
  };
  return { ...unsigned, planDigest: canonicalDigest(unsigned) };
}

function authorityReceipt(status, payload, plan, signingKey) {
  if (!DIGEST_PATTERN.test(plan.afterStateDigest ?? '')) {
    throw new EffectBrokerAuthorityError('INVALID_INPUT', 'EffectBroker authority plan has no bound after-state digest.');
  }
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    status,
    executionNonce: payload.executionNonce,
    token: payload.token,
    basedOnVersion: payload.basedOnVersion,
    beforeStateDigest: payload.beforeStateDigest,
    afterStateDigest: plan.afterStateDigest,
  };
  return signingKey === null ? receipt : signExecutionAuthorityReceipt(receipt, signingKey);
}

function isData(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
