import { mkdir, open as openFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, canonicalDigest, canonicalJson, cloneJson } from '../runtime/schema.mjs';

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

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
      await mkdir(path.dirname(this.filePath), { recursive: true });
      let handle;
      try {
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
    });
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

function requireAppendInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.type !== 'string' || value.type.length === 0 || value.type.length > 128 ||
      typeof value.executionNonce !== 'string' || value.executionNonce.length === 0 || value.executionNonce.length > 4096 ||
      value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
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
