import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/runtime/schema.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const WORLD_ID = 'chain-credit';
const BASIS = 'counterfactual-independent-v1';
const WRONG_WITNESS = process.argv.includes('--wrong-witness');
const MISSING_MEMBER = process.argv.includes('--missing-member');
const COLLUDING_CLAIM = process.argv.includes('--colluding-claim');
const PRIVATE_SEED_HEX = '7701a3964d6e8f70aeb5c4a1b18dd74dfdf7e3594c8bb0c8c27c70dab3fc222b';
const PUBLIC_KEY_HEX = '906a69053d1348a3c58259b8f9315fcc87f3caeb4487bb546c10ca9fe7d448a6';
const PRIVATE_KEY_PREFIX_HEX = '302e020100300506032b657004220420';
const PUBLIC_KEY_PREFIX_HEX = '302a300506032b6570032100';
const { createPrivateKey, sign } = await import('node:crypto');
const privateKey = createPrivateKey({
  key: Buffer.from(`${PRIVATE_KEY_PREFIX_HEX}${PRIVATE_SEED_HEX}`, 'hex'),
  format: 'der',
  type: 'pkcs8',
});
const PUBLIC_KEY = Buffer.from(`${PUBLIC_KEY_PREFIX_HEX}${PUBLIC_KEY_HEX}`, 'hex').toString('base64');

const rl = (await import('node:readline')).createInterface({ input: process.stdin, crlfDelay: Infinity });
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
      adapterId: 'chain-credit-witness-v1',
      worldId: WORLD_ID,
      worldVersion: 'chain-credit-1-independent',
      capabilityIds: ['chain.prepare', 'chain.commit'],
      scenarioIds: ['chain'],
      valueSpec: { schemaVersion: VERSION, observationDimensions: 1, weights: [1], target: [1] },
      evidencePublicKey: PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op !== 'evidence') throw new Error(`unsupported operation: ${op}`);
  const feedback = payload.feedback;
  const members = [
    { executionNonce: feedback.executionNonce, delta: [COLLUDING_CLAIM ? 0.9 : (WRONG_WITNESS ? 0.5 : 0.75)] },
    { executionNonce: payload.memberExecutionNonces[1], delta: [COLLUDING_CLAIM ? 0.1 : 0.25] },
  ];
  const evidence = {
    schemaVersion: VERSION,
    basis: BASIS,
    members: MISSING_MEMBER ? members.slice(0, 1) : members,
  };
  const signingValue = {
    schemaVersion: VERSION,
    executionNonce: feedback.executionNonce,
    stateVersion: feedback.stateVersion,
    intervalId: feedback.intervalId,
    vector: feedback.vector,
    confounderCount: feedback.confounderCount,
    basis: evidence.basis,
    members: evidence.members,
  };
  return {
    ...evidence,
    attestation: {
      schemaVersion: VERSION,
      digest: canonicalDigest(signingValue),
      attestation: sign(null, Buffer.from(canonicalJson({ ...signingValue, digest: canonicalDigest(signingValue) }), 'utf8'), privateKey).toString('base64'),
    },
  };
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: VERSION, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
