import { lstatSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

const PROTOCOL = 'yi-execution-signer';
const PROTOCOL_VERSION = 1;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_SIGNATURE_LENGTH = 8192;

export class ExecutionAuthoritySignerError extends Error {
  constructor(code, message, context = {}, options = {}) {
    super(message, options);
    this.name = 'ExecutionAuthoritySignerError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function createExecutionAuthoritySigner(config, { spawnImpl = spawn } = {}) {
  const normalized = normalizeConfig(config);
  let requestNumber = 0;
  return Object.freeze({
    sign(receipt, { signal } = {}) {
      if (!isPlainObject(receipt)) {
        throw new ExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority receipt must be an object.');
      }
      const request = {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        id: String(++requestNumber),
        op: 'sign',
        payload: receipt,
      };
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_RECEIPT_BYTES) {
        throw new ExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority receipt exceeds the size limit.');
      }
      return invokeProcess({ config: normalized, spawnImpl, signal, request });
    },
  });
}

function invokeProcess({ config, spawnImpl, signal, request }) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    let callerAborted = false;
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = () => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* process already exited */ }
      }
    };
    const abortFromCaller = () => {
      if (settled) return;
      callerAborted = true;
      terminate();
      finish(new ExecutionAuthoritySignerError('SIGNER_CANCELLED', 'Execution authority signing was cancelled.', { cancelled: true }));
    };
    const fail = (code, message, context = {}, cause) => {
      terminate();
      finish(new ExecutionAuthoritySignerError(code, message, context, cause === undefined ? {} : { cause }));
    };

    if (signal?.aborted === true) {
      abortFromCaller();
      return;
    }
    if (signal !== undefined) signal.addEventListener('abort', abortFromCaller, { once: true });
    try {
      child = spawnImpl(config.executable, config.args, {
        shell: false,
        windowsHide: true,
        detached: false,
        env: signerEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(new ExecutionAuthoritySignerError('SIGNER_START', 'Execution authority signer could not be started.', {}, { cause: error }));
      return;
    }
    if (settled) {
      child.on('error', () => {});
      terminate();
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      terminate();
      finish(new ExecutionAuthoritySignerError('SIGNER_TIMEOUT', 'Execution authority signer timed out.', { timeoutMs: config.timeoutMs }));
    }, config.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += stdoutDecoder.write(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        fail('SIGNER_PROTOCOL', 'Execution authority signer stdout exceeded the output limit.');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += stderrDecoder.write(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > MAX_STDERR_BYTES) {
        fail('SIGNER_PROTOCOL', 'Execution authority signer stderr exceeded the output limit.');
      }
    });
    child.on('error', (error) => {
      if (callerAborted || settled) return;
      fail('SIGNER_START', 'Execution authority signer process failed.', {}, error);
    });
    child.on('close', (code, signalCode) => {
      if (settled) return;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (callerAborted) {
        finish(new ExecutionAuthoritySignerError('SIGNER_CANCELLED', 'Execution authority signing was cancelled.', { cancelled: true }));
        return;
      }
      if (code !== 0 || signalCode !== null) {
        fail('SIGNER_PROCESS', 'Execution authority signer process failed.', { status: code, signal: signalCode });
        return;
      }
      const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
      if (lines.length !== 1) {
        fail('SIGNER_PROTOCOL', 'Execution authority signer stdout must contain exactly one JSONL response.');
        return;
      }
      let response;
      try {
        response = JSON.parse(lines[0]);
      } catch (error) {
        fail('SIGNER_PROTOCOL', 'Execution authority signer response is not valid JSON.', {}, error);
        return;
      }
      try {
        resolveResponse(response, request);
      } catch (error) {
        fail(error.code ?? 'SIGNER_PROTOCOL', error.message, error.context, error.cause);
        return;
      }
      finish(null, response.result);
    });
    child.stdin.on('error', (error) => {
      if (!settled) fail('SIGNER_PROCESS', 'Execution authority signer stdin failed.', {}, error);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
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
    throw new ExecutionAuthoritySignerError('SIGNER_PROTOCOL', 'Execution authority signer response is invalid.');
  }
}

function normalizeConfig(value) {
  if (!isPlainObject(value) ||
      typeof value.executable !== 'string' || !path.isAbsolute(value.executable) ||
      /(?:cmd|powershell)(?:\.exe)?$/iu.test(path.basename(value.executable)) ||
      !Array.isArray(value.args) || value.args.length > 64 ||
      value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) {
    throw new ExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority signer config is invalid.');
  }
  let status;
  try {
    status = lstatSync(value.executable);
  } catch (error) {
    throw new ExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority signer executable does not exist.', {}, { cause: error });
  }
  if (status.isSymbolicLink() || !status.isFile() || !statSync(value.executable).isFile()) {
    throw new ExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority signer executable must be a regular non-symlink file.');
  }
  const timeoutMs = value.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new ExecutionAuthoritySignerError('INVALID_INPUT', 'Execution authority signer timeoutMs must be between 100 and 30000.');
  }
  return { executable: value.executable, args: [...value.args], timeoutMs };
}

function signerEnvironment() {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
