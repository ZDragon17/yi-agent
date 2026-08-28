import { canonicalDigest, cloneJson } from '../runtime/schema.mjs';

export function createDryRunExecutor({ initialState, apply, compensate }) {
  if (typeof apply !== 'function' || typeof compensate !== 'function') {
    throw new TypeError('Dry-run executor requires apply and compensate functions.');
  }
  let state = cloneJson(initialState);
  const applied = new Map();
  const reversed = new Set();

  return Object.freeze({
    async execute(intent) {
      const prior = applied.get(intent.executionNonce);
      if (prior !== undefined) return cloneJson(prior);
      const result = await apply({ state: cloneJson(state), intent: cloneJson(intent) });
      if (!result || result.accepted !== true) {
        const receipt = {
          status: 'REJECTED',
          effectDigest: canonicalDigest(state),
          rejectionReason: typeof result?.rejectionReason === 'string' ? result.rejectionReason : 'DRY_RUN_REJECTED',
        };
        applied.set(intent.executionNonce, receipt);
        return cloneJson(receipt);
      }
      state = cloneJson(result.nextState);
      const receipt = { status: 'APPLIED', effectDigest: canonicalDigest(state) };
      applied.set(intent.executionNonce, receipt);
      return cloneJson(receipt);
    },

    async reconcile(intent) {
      const receipt = applied.get(intent.executionNonce);
      return receipt?.status === 'APPLIED'
        ? { status: 'APPLIED', effectDigest: receipt.effectDigest }
        : { status: 'ABSENT' };
    },

    async compensate(intent) {
      if (reversed.has(intent.executionNonce)) {
        return { status: 'REVERSED', effectDigest: canonicalDigest(state) };
      }
      const result = await compensate({ state: cloneJson(state), intent: cloneJson(intent) });
      if (!result || result.accepted !== true) return { status: 'UNKNOWN' };
      state = cloneJson(result.nextState);
      reversed.add(intent.executionNonce);
      return { status: 'REVERSED', effectDigest: canonicalDigest(state) };
    },

    async reconcileCompensation(intent) {
      return reversed.has(intent.executionNonce)
        ? { status: 'REVERSED', effectDigest: canonicalDigest(state) }
        : { status: 'NOT_REVERSED' };
    },

    inspect() {
      return cloneJson(state);
    },
  });
}
