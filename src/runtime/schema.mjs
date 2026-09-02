import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
// The ledger stores each STEP as one bounded JSON event. Kernel memory keeps
// headroom for the rest of that envelope instead of consuming the full event.
export const MAX_PERSISTED_EVENT_BYTES = 1024 * 1024;
export const MAX_PERSISTED_MEMORY_BYTES = 768 * 1024;
// Reserve half of the event space left after Memory for the current
// WorldPort state; the remaining half covers receipt, observations, and
// other STEP envelope evidence.
export const MAX_PERSISTED_WORLD_STATE_BYTES =
  (MAX_PERSISTED_EVENT_BYTES - MAX_PERSISTED_MEMORY_BYTES) / 2;
// WorldPort versions are opaque, but they are persisted in every STEP.
export const MAX_BOUNDARY_IDENTIFIER_LENGTH = 4096;
export const MAX_EXECUTION_NONCE_LENGTH = 256;
const MAX_JSON_DEPTH = 128;

export function canonicalJson(value) {
  return serialize(value, new Set(), 0);
}

export function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function withSelfDigest(value) {
  const copy = cloneJson(value);
  return { ...copy, selfDigest: canonicalDigest(copy) };
}

export function verifySelfDigest(value) {
  if (!isPlainObject(value) || typeof value.selfDigest !== 'string') return false;
  const copy = { ...value };
  delete copy.selfDigest;
  return value.selfDigest === canonicalDigest(copy);
}

export function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function serialize(value, ancestors, depth) {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`Canonical JSON exceeds maximum depth ${MAX_JSON_DEPTH}.`);
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  }

  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not support cycles.');
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => item === undefined ? 'null' : serialize(item, ancestors, depth + 1)).join(',')}]`;
    }

    if (!isPlainObject(value)) throw new TypeError('Canonical JSON requires plain objects.');
    const properties = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      properties.push(`${JSON.stringify(key)}:${serialize(item, ancestors, depth + 1)}`);
    }
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
