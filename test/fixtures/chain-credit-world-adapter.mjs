import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { canonicalJson } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY, attestationFor } from './ed25519-proof.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const WORLD_ID = 'chain-credit';
const CREDIT_CHAIN = process.argv.includes('--credit-chain');
const WRONG_SHARE = process.argv.includes('--wrong-share');
const CAUSAL_EVIDENCE = process.argv.includes('--causal-evidence');
const CAUSAL_MISMATCH = process.argv.includes('--causal-mismatch');
const ATTESTED_EVIDENCE = process.argv.includes('--attested-evidence');
const TAMPER_ATTESTATION = process.argv.includes('--tamper-attestation');
const FABRICATED_ATTESTATION = process.argv.includes('--fabricated-attestation');
const INDEPENDENT_EVIDENCE = process.argv.includes('--independent-evidence');
const COLLUDING_CLAIM = process.argv.includes('--colluding-claim');
const TRUTH_FILE_INDEX = process.argv.indexOf('--truth-file');
const TRUTH_FILE = TRUTH_FILE_INDEX === -1 ? null : process.argv[TRUTH_FILE_INDEX + 1];
const START_FILE_INDEX = process.argv.indexOf('--start-file');
const START_FILE = START_FILE_INDEX === -1 ? null : process.argv[START_FILE_INDEX + 1] ?? null;
const ADAPTER_ID = `chain-credit-adapter-${CREDIT_CHAIN ? (INDEPENDENT_EVIDENCE ? (COLLUDING_CLAIM ? 'independent-colluding' : 'independent') : (ATTESTED_EVIDENCE ? 'attested' : (CAUSAL_EVIDENCE ? 'causal' : (WRONG_SHARE ? 'wrong-share' : 'chain')))) : 'ambiguous'}-v1`;

if (START_FILE !== null) appendFileSync(START_FILE, `${process.pid}\n`, 'utf8');
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.protocol !== PROTOCOL || request.version !== VERSION || typeof request.id !== 'string') {
    return respond(request.id ?? null, false, 'unsupported protocol');
  }
  try {
    return respond(request.id, true, dispatch(request.op, request.payload ?? {}));
  } catch (error) {
    return respond(request.id, false, error instanceof Error ? error.message : String(error));
  }
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: `chain-credit-1-${CREDIT_CHAIN ? (INDEPENDENT_EVIDENCE ? 'independent' : (ATTESTED_EVIDENCE ? 'attested' : (CAUSAL_EVIDENCE ? 'causal' : 'chain'))) : 'ambiguous'}`,
      capabilityIds: ['chain.prepare', 'chain.commit'],
      scenarioIds: ['chain'],
      valueSpec: { schemaVersion: VERSION, observationDimensions: 1, weights: [1], target: [1] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0, 0, []) };
  if (op === 'actions') return {
    actions: payload.manifest.tokenMap.entries.map((entry) => ({
      schemaVersion: VERSION,
      token: entry.token,
      cost: 1,
      allowed: true,
      safe: entry.capabilityId === expectedCapability(payload.state),
    })),
  };
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request, payload.manifest);
  throw new Error(`unsupported operation: ${op}`);
}

function expectedCapability(state) {
  const pendingCount = state?.pendingExecutionNonces?.length ?? 0;
  return pendingCount === 0 ? 'chain.prepare' : 'chain.commit';
}

function transition(prior, request, manifest) {
  const waiting = prior.pendingExecutionNonces ?? [];
  const releases = waiting.length >= 2 ? waiting.slice(0, 2) : [];
  const nextRevision = prior.revision + 1;
  const nextValue = releases.length === 0 ? prior.value : prior.value + 1;
  const nextPending = releases.length === 0 ? [...waiting, request.executionNonce] : [request.executionNonce];
  const next = state(nextValue, nextRevision, nextPending, [
    ...(prior.usedExecutionNonces ?? []).slice(-7),
    request.executionNonce,
  ]);
  const feedback = releases.length === 0 ? [] : CREDIT_CHAIN
    ? [{
        schemaVersion: VERSION,
        executionNonce: releases[0],
        stateVersion: next.stateVersion,
        intervalId: next.stateVersion,
        vector: [next.value],
        confounderCount: 0,
        creditChain: CAUSAL_EVIDENCE || ATTESTED_EVIDENCE
          ? causalCreditChain(releases, next)
          : {
              schemaVersion: VERSION,
              members: releases.map((executionNonce, index) => ({
                executionNonce,
                share: index === 0 ? (WRONG_SHARE ? 0.99 : 0.75) : (WRONG_SHARE ? 0.01 : 0.25),
              })),
            },
      }]
    : releases.map((executionNonce) => ({
        schemaVersion: VERSION,
        executionNonce,
        stateVersion: next.stateVersion,
        intervalId: next.stateVersion,
        vector: [next.value],
        confounderCount: 0,
      }));
  if (FABRICATED_ATTESTATION && TRUTH_FILE && releases.length >= 2) {
    appendFileSync(TRUTH_FILE, `${JSON.stringify({
      executionNonce: releases[0],
      trueMemberDeltas: [[0], [1]],
      claimedMemberDeltas: [[0.75], [0.25]],
    })}\n`, 'utf8');
  }
  return {
    nextWorldState: next,
    receipt: {
      schemaVersion: VERSION,
      status: 'ACCEPTED',
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      effectDigest: canonicalDigest(next),
      rejectionReason: null,
      attributionWindowComplete: false,
      confounderCount: 0,
    },
    postObservation: observation(next, feedback),
  };
}

function causalCreditChain(releases, next) {
  const base = {
    schemaVersion: VERSION,
    basis: INDEPENDENT_EVIDENCE ? 'counterfactual-independent-v1' : (ATTESTED_EVIDENCE ? 'counterfactual-attested-v1' : 'counterfactual-additive-v1'),
    members: releases.map((executionNonce, index) => ({
      executionNonce,
      delta: [COLLUDING_CLAIM ? (index === 0 ? 0.9 : 0.1) : (CAUSAL_MISMATCH ? (index === 0 ? 0.5 : 0.25) : (index === 0 ? 0.75 : 0.25))],
    })),
  };
  if (!ATTESTED_EVIDENCE) return base;
  const signedFeedback = {
    schemaVersion: VERSION,
    executionNonce: releases[0],
    stateVersion: next.stateVersion,
    intervalId: next.stateVersion,
    vector: [next.value],
    confounderCount: 0,
    creditChain: base,
  };
  const signingValue = INDEPENDENT_EVIDENCE
    ? {
        schemaVersion: VERSION,
        executionNonce: signedFeedback.executionNonce,
        stateVersion: signedFeedback.stateVersion,
        intervalId: signedFeedback.intervalId,
        vector: signedFeedback.vector,
        confounderCount: signedFeedback.confounderCount,
        basis: base.basis,
        members: base.members,
      }
    : signedFeedback;
  return {
    ...base,
    attestation: {
      schemaVersion: VERSION,
      digest: canonicalDigest(signingValue),
      attestation: tamperAttestation(attestationFor(signingValue)),
    },
  };
}

function tamperAttestation(value) {
  if (!TAMPER_ATTESTATION) return value;
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
}

function state(value, revision, pendingExecutionNonces, usedExecutionNonces = []) {
  return {
    schemaVersion: VERSION,
    stateVersion: `${WORLD_ID}:${revision}`,
    revision,
    value,
    pendingExecutionNonces,
    usedExecutionNonces,
  };
}

function observation(current, feedback = []) {
  return {
    schemaVersion: VERSION,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
    ...(feedback.length === 0 ? {} : { feedback }),
  };
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: VERSION, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
