import { lstatSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

const PROTOCOL = 'yi-model-cli';
const PROTOCOL_VERSION = 1;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;

export class ModelAdapterError extends Error {
  constructor(code, message, context = {}, options = {}) {
    super(message, options);
    this.name = 'ModelAdapterError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function loadProcessModelConfig(configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  let raw;
  try {
    raw = readFileSync(resolvedPath);
  } catch (error) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter config could not be read.', { field: 'model-adapter' }, { cause: error });
  }
  if (raw.byteLength > MAX_CONFIG_BYTES) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter config exceeds the 1 MiB limit.', { field: 'model-adapter' });
  }
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter config is not valid JSON.', { field: 'model-adapter' }, { cause: error });
  }
  return normalizeConfig(value);
}

export function createProcessModelClient(config, { spawnImpl = spawn } = {}) {
  const normalized = normalizeConfig(config, { checkExecutable: false });
  let requestNumber = 0;
  return {
    async chat(prompt, { signal } = {}) {
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new ModelAdapterError('INVALID_INPUT', 'Prompt must be a non-empty string.', { field: 'prompt' });
      }
      if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
        throw new ModelAdapterError('INVALID_INPUT', 'Prompt exceeds the 128 KiB limit.', { field: 'prompt' });
      }
      requestNumber += 1;
      return invokeProcess({
        config: normalized,
        spawnImpl,
        signal,
        request: {
          protocol: PROTOCOL,
          version: PROTOCOL_VERSION,
          id: String(requestNumber),
          op: 'chat',
          payload: { prompt },
        },
      });
    },
  };
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
      if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    };
    const abortFromCaller = () => {
      if (settled) return;
      callerAborted = true;
      terminate();
      finish(new ModelAdapterError('MODEL_ADAPTER_CANCELLED', 'Model adapter request was cancelled.', { cancelled: true }));
    };
    const timeout = () => {
      if (settled) return;
      terminate();
      finish(new ModelAdapterError('MODEL_CALLBACK_TIMEOUT', 'Model adapter request timed out.', { timeoutMs: config.timeoutMs }));
    };
    const fail = (code, message, context = {}, cause) => {
      terminate();
      finish(new ModelAdapterError(code, message, context, cause === undefined ? {} : { cause }));
    };

    if (signal?.aborted === true) {
      callerAborted = true;
      finish(new ModelAdapterError('MODEL_ADAPTER_CANCELLED', 'Model adapter request was cancelled.', { cancelled: true }));
      return;
    }
    if (signal !== undefined) signal.addEventListener('abort', abortFromCaller, { once: true });
    try {
      child = spawnImpl(config.executable, config.args, {
        shell: false,
        windowsHide: true,
        detached: false,
        env: modelAdapterEnvironment(config.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(new ModelAdapterError('MODEL_ADAPTER_START', 'Model adapter process could not be started.', {}, { cause: error }));
      return;
    }

    timer = setTimeout(timeout, config.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += stdoutDecoder.write(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        fail('MODEL_ADAPTER_PROTOCOL', 'Model adapter stdout exceeded the output limit.', { maxBytes: MAX_STDOUT_BYTES });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += stderrDecoder.write(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > MAX_STDERR_BYTES) {
        fail('MODEL_ADAPTER_PROTOCOL', 'Model adapter stderr exceeded the output limit.', { maxBytes: MAX_STDERR_BYTES });
      }
    });
    child.on('error', (error) => {
      if (callerAborted || settled) return;
      fail('MODEL_ADAPTER_START', 'Model adapter process failed.', {}, error);
    });
    child.on('close', (code, signalCode) => {
      if (settled) return;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (callerAborted) {
        finish(new ModelAdapterError('MODEL_ADAPTER_CANCELLED', 'Model adapter request was cancelled.', { cancelled: true }));
        return;
      }
      if (code !== 0 || signalCode !== null) {
        fail('MODEL_ADAPTER_PROCESS', 'Model adapter process failed.', { status: code, signal: signalCode });
        return;
      }
      let response;
      const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
      if (lines.length !== 1) {
        fail('MODEL_ADAPTER_PROTOCOL', 'Model adapter stdout must contain exactly one JSONL response.', {});
        return;
      }
      try {
        response = JSON.parse(lines[0]);
      } catch (error) {
        fail('MODEL_ADAPTER_PROTOCOL', 'Model adapter response is not valid JSON.', {}, error);
        return;
      }
      try {
        resolveResponse(response, request);
      } catch (error) {
        fail(error.code ?? 'MODEL_ADAPTER_PROTOCOL', error.message, error.context, error.cause);
        return;
      }
      finish(null, response.result);
    });
    child.stdin.on('error', (error) => {
      if (!settled) fail('MODEL_ADAPTER_PROCESS', 'Model adapter stdin failed.', {}, error);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function resolveResponse(value, request) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.protocol !== PROTOCOL || value.version !== PROTOCOL_VERSION || value.id !== request.id ||
      value.ok !== true || value.result === null || typeof value.result !== 'object' || Array.isArray(value.result) ||
      typeof value.result.content !== 'string' || Buffer.byteLength(value.result.content, 'utf8') > MAX_CONTENT_BYTES ||
      (value.result.model !== undefined && (typeof value.result.model !== 'string' || value.result.model.length === 0 || value.result.model.length > 4096))) {
    throw new ModelAdapterError('MODEL_ADAPTER_PROTOCOL', 'Model adapter response envelope is invalid.', { op: request.op });
  }
}

function normalizeConfig(value, { checkExecutable = true } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter config must be an object.', { field: 'model-adapter' });
  }
  const allowed = new Set(['executable', 'args', 'model', 'timeoutMs', 'env']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter config contains an unsupported field.', { field: 'model-adapter' });
  }
  if (typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || /(?:cmd|powershell)(?:\.exe)?$/iu.test(path.basename(value.executable))) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter executable must be an absolute non-shell executable path.', { field: 'model-adapter.executable' });
  }
  if (checkExecutable) {
    let status;
    try { status = lstatSync(value.executable); } catch (error) {
      throw new ModelAdapterError('INVALID_INPUT', 'Model adapter executable does not exist.', { field: 'model-adapter.executable' }, { cause: error });
    }
    if (!status.isFile() || status.isSymbolicLink() || !statSync(value.executable).isFile()) {
      throw new ModelAdapterError('INVALID_INPUT', 'Model adapter executable must be a regular non-symlink file.', { field: 'model-adapter.executable' });
    }
  }
  if (!Array.isArray(value.args) || value.args.length > 64 || value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter args must be a bounded string array.', { field: 'model-adapter.args' });
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 4096)) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter model is invalid.', { field: 'model-adapter.model' });
  }
  const timeoutMs = value.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter timeoutMs must be between 100 and 30000.', { field: 'model-adapter.timeoutMs' });
  }
  if (value.env !== undefined && (!Array.isArray(value.env) || value.env.length > 64 || value.env.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)))) {
    throw new ModelAdapterError('INVALID_INPUT', 'Model adapter env must be a bounded environment-name array.', { field: 'model-adapter.env' });
  }
  return {
    executable: value.executable,
    args: [...value.args],
    model: value.model ?? 'process-model',
    timeoutMs,
    env: [...(value.env ?? [])],
  };
}

function modelAdapterEnvironment(names) {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', ...names]) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function resolveConfigPath(value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new ModelAdapterError('INVALID_INPUT', 'model-adapter must be an absolute config path.', { field: 'model-adapter' });
  }
  return path.normalize(value);
}
