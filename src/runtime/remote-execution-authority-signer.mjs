import { connect } from 'node:net';

const PROTOCOL = 'yi-execution-signer';
const PROTOCOL_VERSION = 1;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_SIGNATURE_LENGTH = 8192;

export class RemoteExecutionAuthoritySignerError extends Error {
  constructor(code, message, context = {}, options = {}) {
    super(message, options);
    this.name = 'RemoteExecutionAuthoritySignerError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function createRemoteExecutionAuthoritySigner(config, { connectImpl = connect } = {}) {
  const normalized = normalizeConfig(config);
  let requestNumber = 0;
  return Object.freeze({
    sign(receipt, { signal } = {}) {
      if (!isPlainObject(receipt)) {
        throw new RemoteExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority receipt must be an object.');
      }
      const request = {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        id: String(++requestNumber),
        op: 'sign',
        authToken: normalized.authToken,
        payload: receipt,
      };
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_RECEIPT_BYTES) {
        throw new RemoteExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority receipt exceeds the size limit.');
      }
      return invokeRemote({ config: normalized, connectImpl, signal, request });
    },
  });
}

function invokeRemote({ config, connectImpl, signal, request }) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let timer;
    let buffer = '';
    let callerAborted = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
      if (socket !== undefined) socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (code, message, context = {}, cause) => {
      finish(new RemoteExecutionAuthoritySignerError(code, message, context, cause === undefined ? {} : { cause }));
    };
    const abortFromCaller = () => {
      if (settled) return;
      callerAborted = true;
      fail('SIGNER_CANCELLED', 'Remote execution authority signing was cancelled.', { cancelled: true });
    };

    if (signal?.aborted === true) {
      abortFromCaller();
      return;
    }
    if (signal !== undefined) signal.addEventListener('abort', abortFromCaller, { once: true });
    timer = setTimeout(() => fail('SIGNER_TIMEOUT', 'Remote execution authority signer timed out.', { timeoutMs: config.timeoutMs }), config.timeoutMs);
    try {
      socket = connectImpl({ host: config.host, port: config.port });
    } catch (error) {
      fail('SIGNER_CONNECT', 'Remote execution authority signer could not be reached.', {}, error);
      return;
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      if (!settled) socket.end(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_STDOUT_BYTES) {
        fail('SIGNER_PROTOCOL', 'Remote execution authority signer response exceeded the output limit.');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      const rest = buffer.slice(newline + 1);
      buffer = rest;
      if (line.length === 0 || rest.trim().length > 0) {
        fail('SIGNER_PROTOCOL', 'Remote execution authority signer must return exactly one JSONL response.');
        return;
      }
      let response;
      try { response = JSON.parse(line); } catch (error) {
        fail('SIGNER_PROTOCOL', 'Remote execution authority signer response is not valid JSON.', {}, error);
        return;
      }
      try { resolveResponse(response, request); } catch (error) {
        fail(error.code ?? 'SIGNER_PROTOCOL', error.message, error.context, error.cause);
        return;
      }
      finish(null, response.result);
    });
    socket.on('error', (error) => {
      if (settled || callerAborted) return;
      fail('SIGNER_CONNECT', 'Remote execution authority signer connection failed.', {}, error);
    });
    socket.on('close', () => {
      if (!settled) fail('SIGNER_PROTOCOL', 'Remote execution authority signer closed before responding.');
    });
  });
}

function resolveResponse(value, request) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.protocol !== PROTOCOL || value.version !== PROTOCOL_VERSION || value.id !== request.id ||
      value.ok !== true || !isPlainObject(value.result) ||
      Object.keys(value.result).some((key) => !['schemaVersion', 'type', 'digest', 'signature'].includes(key)) ||
      !Number.isSafeInteger(value.result.schemaVersion) ||
      typeof value.result.type !== 'string' || value.result.type.length === 0 || value.result.type.length > 128 ||
      typeof value.result.digest !== 'string' || value.result.digest.length === 0 || value.result.digest.length > 128 ||
      typeof value.result.signature !== 'string' || value.result.signature.length === 0 || value.result.signature.length > MAX_SIGNATURE_LENGTH) {
    throw new RemoteExecutionAuthoritySignerError('SIGNER_PROTOCOL', 'Remote execution authority signer response is invalid.');
  }
}

function normalizeConfig(value) {
  if (!isPlainObject(value) || typeof value.host !== 'string' || value.host.length === 0 || value.host.length > 253 ||
      !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.authToken !== 'string' || value.authToken.length < 16 || value.authToken.length > 64 * 1024) {
    throw new RemoteExecutionAuthoritySignerError('INVALID_INPUT', 'Remote execution authority signer address is invalid.');
  }
  const timeoutMs = value.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new RemoteExecutionAuthoritySignerError('INVALID_INPUT', 'Remote execution authority signer timeoutMs must be between 100 and 30000.');
  }
  return { host: value.host, port: value.port, authToken: value.authToken, timeoutMs };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
