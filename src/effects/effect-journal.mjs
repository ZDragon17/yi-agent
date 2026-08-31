import { mkdir, open as openFile, readFile, lstat, link, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SCHEMA_VERSION, canonicalDigest, canonicalJson, cloneJson } from '../runtime/schema.mjs';

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const JOURNAL_LOCK_SUFFIX = '.lock';
const JOURNAL_RECLAIM_SUFFIX = '.reclaim';
const JOURNAL_LOCK_ATTEMPTS = 8;
const JOURNAL_LOCK_WAIT_MS = 10;

export class EffectJournalError extends Error {
  constructor(code, message, context = {}, options = {}) {
    super(message, options);
    this.name = 'EffectJournalError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export class EffectJournal {
  constructor(filePath, events) {
    this.filePath = filePath;
    this.events = events.map(cloneJson);
    this.operationTail = Promise.resolve();
  }

  static async open(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new EffectJournalError('INVALID_INPUT', 'Effect journal path must be absolute.', { field: 'filePath' });
    }
    const resolved = path.normalize(filePath);
    let status;
    try {
      status = await lstat(resolved);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return new EffectJournal(resolved, []);
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new EffectJournalError('CORRUPT', 'Effect journal must be a regular file.', { filePath: resolved });
    }
    const bytes = await readFile(resolved);
    if (bytes.length > MAX_JOURNAL_BYTES) {
      throw new EffectJournalError('CORRUPT', 'Effect journal exceeds the size limit.', { filePath: resolved });
    }
    if (bytes.length === 0) return new EffectJournal(resolved, []);
    const raw = bytes.toString('utf8');
    if (!raw.endsWith('\n')) {
      throw new EffectJournalError('CORRUPT', 'Effect journal has an incomplete final line.', { filePath: resolved });
    }
    const lines = raw.slice(0, -1).split(/\r?\n/u);
    const events = [];
    let previousDigest = null;
    for (let index = 0; index < lines.length; index += 1) {
      if (Buffer.byteLength(lines[index], 'utf8') > MAX_LINE_BYTES) {
        throw new EffectJournalError('CORRUPT', 'Effect journal line exceeds the size limit.', { sequence: index + 1 });
      }
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch (error) {
        throw new EffectJournalError('CORRUPT', 'Effect journal contains malformed JSON.', { sequence: index + 1 }, { cause: error });
      }
      validateEvent(event, index + 1, previousDigest);
      events.push(event);
      previousDigest = event.digest;
    }
    return new EffectJournal(resolved, events);
  }

  append(input) {
    return this.enqueue(async () => {
      const source = requireAppendInput(input);
      const journalLock = await acquireJournalLock(this.filePath);
      try {
        await assertJournalLock(journalLock);
        const observed = await EffectJournal.open(this.filePath);
        this.events = observed.read();
        const actualPrevDigest = this.events.at(-1)?.digest ?? null;
        if (source.expectedPrevDigest !== undefined && source.expectedPrevDigest !== actualPrevDigest) {
          throw new EffectJournalError('CONFLICT', 'Effect journal changed since the broker state was read.', {
            expectedPrevDigest: source.expectedPrevDigest,
            actualPrevDigest,
          });
        }
        const sequence = this.events.length + 1;
        const unsigned = {
          schemaVersion: SCHEMA_VERSION,
          sequence,
          executionNonce: source.executionNonce,
          type: source.type,
          payload: cloneJson(source.payload),
          prevDigest: this.events.at(-1)?.digest ?? null,
          recordedAt: source.recordedAt ?? new Date().toISOString(),
        };
        const event = { ...unsigned, digest: canonicalDigest(unsigned) };
        const line = `${canonicalJson(event)}\n`;
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          throw new EffectJournalError('INVALID_INPUT', 'Effect journal event exceeds the line limit.', { sequence });
        }
        let handle;
        try {
          await assertJournalLock(journalLock);
          handle = await openFile(this.filePath, 'a');
          await handle.write(line, undefined, 'utf8');
          await handle.sync();
        } catch (error) {
          const recovered = await this.reconcileAppendUncertainty(event);
          if (recovered) return recovered;
          throw new EffectJournalError('IO_ERROR', 'Effect journal append could not be flushed.', { sequence }, { cause: error });
        } finally {
          await handle?.close();
        }
        this.events.push(event);
        return cloneJson(event);
      } finally {
        await releaseJournalLock(journalLock);
      }
    });
  }

  withExclusive(key, operation) {
    if (typeof key !== 'string' || key.length === 0 || typeof operation !== 'function') {
      throw new EffectJournalError('INVALID_INPUT', 'Effect journal exclusive operation is invalid.');
    }
    const lockPath = `${this.filePath}.operation-${canonicalDigest(key).slice('sha256:'.length)}${JOURNAL_LOCK_SUFFIX}`;
    return (async () => {
      const journalLock = await acquireJournalLock(this.filePath, lockPath);
      try {
        const observed = await EffectJournal.open(this.filePath);
        this.events = observed.read();
        return await operation();
      } finally {
        await releaseJournalLock(journalLock);
      }
    })();
  }

  read() {
    return cloneJson(this.events);
  }

  async reconcileAppendUncertainty(event) {
    try {
      const observed = await EffectJournal.open(this.filePath);
      const events = observed.read();
      const last = events.at(-1);
      if (events.length === event.sequence && last?.digest === event.digest &&
          canonicalJson(last) === canonicalJson(event)) {
        this.events = events;
        return cloneJson(event);
      }
    } catch {
      // A partial or unreadable tail remains a hard failure; the caller must recover it explicitly.
    }
    return null;
  }

  enqueue(operation) {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch(() => undefined);
    return result;
  }
}

async function acquireJournalLock(filePath, lockPath = `${filePath}${JOURNAL_LOCK_SUFFIX}`) {
  const reclaimPath = `${lockPath}${JOURNAL_RECLAIM_SUFFIX}`;
  await mkdir(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < JOURNAL_LOCK_ATTEMPTS; attempt += 1) {
    const owner = {
      schemaVersion: SCHEMA_VERSION,
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const claimPath = `${lockPath}.${process.pid}.${owner.nonce}.claim`;
    let claimHandle;
    try {
      claimHandle = await openFile(claimPath, 'wx', 0o600);
      await claimHandle.write(`${canonicalJson(owner)}\n`, undefined, 'utf8');
      await claimHandle.sync();
    } finally {
      await claimHandle?.close();
    }

    let reclaimOwned = false;
    try {
      try {
        await link(claimPath, reclaimPath);
        reclaimOwned = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!await reclaimDeadJournalReservation(reclaimPath)) {
          await waitForJournalLock(attempt);
        }
        continue;
      }

      let lockStatus;
      try {
        lockStatus = await lstat(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        lockStatus = null;
      }
      if (lockStatus !== null) {
        if (!lockStatus.isFile() || lockStatus.isSymbolicLink()) {
          throw new EffectJournalError('CORRUPT', 'Effect journal lock must be a regular file.', { lockPath });
        }
        let currentOwner;
        try {
          currentOwner = await readJournalLockOwner(lockPath);
        } catch (error) {
          if (error instanceof EffectJournalError && error.code === 'IO_ERROR' && error.cause?.code === 'ENOENT') {
            currentOwner = null;
          } else {
            throw error;
          }
        }
        if (currentOwner !== null && isProcessAlive(currentOwner.pid)) {
          await waitForJournalLock(attempt);
          continue;
        }
        if (currentOwner !== null) {
          const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
          try {
            await rename(lockPath, stalePath);
          } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
          }
          await rm(stalePath);
        }
      }

      await link(claimPath, lockPath);
      await rm(claimPath, { force: true });
      await rm(reclaimPath, { force: true });
      reclaimOwned = false;
      const status = await lstat(lockPath);
      return { lockPath, owner, identity: fileIdentity(status) };
    } finally {
      await rm(claimPath, { force: true });
      if (reclaimOwned) await releaseJournalReclaimReservation(reclaimPath, owner);
    }
  }

  throw new EffectJournalError('BUSY', 'Effect journal lock could not be acquired.', { filePath });
}

async function reclaimDeadJournalReservation(reclaimPath) {
  let status;
  try {
    status = await lstat(reclaimPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new EffectJournalError('CORRUPT', 'Effect journal reclaim reservation must be a regular file.', { reclaimPath });
  }
  let owner;
  try {
    owner = await readJournalLockOwner(reclaimPath);
  } catch (error) {
    if (error instanceof EffectJournalError && error.code === 'IO_ERROR' && error.cause?.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
  if (isProcessAlive(owner.pid)) return false;
  const stalePath = `${reclaimPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    // The reservation is the single compare-and-remove winner for this recovery.
    await rename(reclaimPath, stalePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  await rm(stalePath);
  await rm(`${reclaimPath.slice(0, -JOURNAL_RECLAIM_SUFFIX.length)}.${owner.pid}.${owner.nonce}.claim`, { force: true });
  return true;
}

async function releaseJournalReclaimReservation(reclaimPath, expectedOwner) {
  try {
    const owner = await readJournalLockOwner(reclaimPath);
    if (canonicalJson(owner) !== canonicalJson(expectedOwner)) {
      throw new EffectJournalError('CORRUPT', 'Effect journal reclaim reservation owner changed.', { reclaimPath });
    }
    await rm(reclaimPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || (error instanceof EffectJournalError && error.code === 'IO_ERROR' && error.cause?.code === 'ENOENT')) return;
    throw error;
  }
}

async function waitForJournalLock(attempt) {
  if (attempt + 1 < JOURNAL_LOCK_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, JOURNAL_LOCK_WAIT_MS * (attempt + 1)));
  }
}

function assertJournalLock(journalLock) {
  return lstat(journalLock.lockPath).then((status) => {
    if (!status.isFile() || status.isSymbolicLink() || !sameFileIdentity(status, journalLock.identity)) {
      throw new EffectJournalError('CORRUPT', 'Effect journal lock ownership changed while writing.', {
        filePath: journalLock.lockPath,
      });
    }
  }).catch((error) => {
    if (error instanceof EffectJournalError) throw error;
    if (error?.code === 'ENOENT') {
      throw new EffectJournalError('CORRUPT', 'Effect journal lock disappeared while writing.', {
        filePath: journalLock.lockPath,
      });
    }
    throw error;
  });
}

async function releaseJournalLock(journalLock) {
  await assertJournalLock(journalLock);
  const owner = await readJournalLockOwner(journalLock.lockPath);
  if (canonicalJson(owner) !== canonicalJson(journalLock.owner)) {
    throw new EffectJournalError('CORRUPT', 'Effect journal lock owner changed while writing.', {
      filePath: journalLock.lockPath,
    });
  }
  await rm(journalLock.lockPath);
}

async function readJournalLockOwner(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    throw new EffectJournalError('IO_ERROR', 'Effect journal lock could not be read.', { lockPath }, { cause: error });
  }
  if (!raw.endsWith('\n') || Buffer.byteLength(raw, 'utf8') > 4096) {
    throw new EffectJournalError('CORRUPT', 'Effect journal lock metadata is invalid.', { lockPath });
  }
  let owner;
  try {
    owner = JSON.parse(raw.slice(0, -1));
  } catch (error) {
    throw new EffectJournalError('CORRUPT', 'Effect journal lock metadata is invalid.', { lockPath }, { cause: error });
  }
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner) ||
      Object.keys(owner).length !== 4 || owner.schemaVersion !== SCHEMA_VERSION ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.nonce !== 'string' || !UUID_PATTERN.test(owner.nonce) ||
      typeof owner.createdAt !== 'string') {
    throw new EffectJournalError('CORRUPT', 'Effect journal lock metadata is invalid.', { lockPath });
  }
  return owner;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return true;
  }
}

function fileIdentity(status) {
  return {
    dev: status.dev,
    ino: status.ino,
  };
}

function sameFileIdentity(status, expected) {
  return status.dev === expected.dev &&
    status.ino === expected.ino;
}

function requireAppendInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.type !== 'string' || value.type.length === 0 || value.type.length > 128 ||
      typeof value.executionNonce !== 'string' || value.executionNonce.length === 0 || value.executionNonce.length > 4096 ||
      value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload) ||
      (value.expectedPrevDigest !== undefined && value.expectedPrevDigest !== null && typeof value.expectedPrevDigest !== 'string')) {
    throw new EffectJournalError('INVALID_INPUT', 'Effect journal append input is invalid.');
  }
  try {
    cloneJson(value.payload);
  } catch (error) {
    throw new EffectJournalError('INVALID_INPUT', 'Effect journal payload is not canonical data.', {}, { cause: error });
  }
  return value;
}

function validateEvent(value, sequence, previousDigest) {
  const keys = ['schemaVersion', 'sequence', 'executionNonce', 'type', 'payload', 'prevDigest', 'recordedAt', 'digest'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== SCHEMA_VERSION || value.sequence !== sequence ||
      typeof value.executionNonce !== 'string' || value.executionNonce.length === 0 ||
      typeof value.type !== 'string' || value.type.length === 0 ||
      value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload) ||
      value.prevDigest !== previousDigest || typeof value.recordedAt !== 'string' ||
      typeof value.digest !== 'string') {
    throw new EffectJournalError('CORRUPT', 'Effect journal event violates its envelope.', { sequence });
  }
  const unsigned = { ...value };
  delete unsigned.digest;
  if (value.digest !== canonicalDigest(unsigned)) {
    throw new EffectJournalError('CORRUPT', 'Effect journal digest chain is invalid.', { sequence });
  }
}
