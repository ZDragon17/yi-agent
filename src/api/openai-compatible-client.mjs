const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ZHIPU_CODE_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ApiClientError extends Error {
  constructor(code, message, context = {}, options = {}) {
    super(message, options);
    this.name = 'ApiClientError';
    this.code = code;
    this.context = context;
  }
}

export function loadApiConfig(env = process.env) {
  const provider = env.YI_AGENT_PROVIDER ?? 'openai-compatible';
  if (!['openai-compatible', 'zhipu-code'].includes(provider)) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_PROVIDER must be openai-compatible or zhipu-code.', { field: 'YI_AGENT_PROVIDER' });
  }
  const apiKey = nonEmptyEnv(
    env.YI_AGENT_API_KEY ?? (provider === 'zhipu-code' ? env.ZAI_API_KEY : undefined),
    provider === 'zhipu-code' ? 'YI_AGENT_API_KEY or ZAI_API_KEY' : 'YI_AGENT_API_KEY',
  );
  const model = nonEmptyEnv(env.YI_AGENT_MODEL, 'YI_AGENT_MODEL');
  const baseUrl = normalizeBaseUrl(
    env.YI_AGENT_API_BASE_URL ?? (provider === 'zhipu-code' ? ZHIPU_CODE_BASE_URL : DEFAULT_BASE_URL),
  );
  const timeoutMs = parseTimeout(env.YI_AGENT_API_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS));

  return { apiKey, baseUrl, model, timeoutMs, provider };
}

export function createOpenAICompatibleClient({ apiKey, baseUrl, model, timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_API_KEY must be configured.');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_MODEL must be configured.');
  }
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl ?? DEFAULT_BASE_URL);
  const normalizedTimeoutMs = parseTimeout(String(timeoutMs ?? DEFAULT_TIMEOUT_MS));
  if (typeof fetchImpl !== 'function') {
    throw new ApiClientError('API_PROTOCOL_ERROR', 'This Node.js runtime does not provide fetch.');
  }

  return {
    async testConnection() {
      const payload = await request('/models', { method: 'GET' });
      return {
        status: 'CONNECTED',
        modelCount: Array.isArray(payload?.data) ? payload.data.length : undefined,
      };
    },

    async chat(prompt, { signal } = {}) {
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new ApiClientError('INVALID_INPUT', 'Prompt must be a non-empty string.', { field: 'prompt' });
      }
      const payload = await request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
      }, signal);
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new ApiClientError('API_PROTOCOL_ERROR', 'API response did not contain choices[0].message.content.');
      }
      return {
        id: typeof payload.id === 'string' ? payload.id : undefined,
        model: typeof payload.model === 'string' ? payload.model : model,
        content,
        usage: payload.usage,
      };
    },
  };

  async function request(endpoint, options, externalSignal) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted === true) {
      controller.abort(externalSignal.reason);
    } else if (externalSignal !== undefined) {
      externalSignal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(`${normalizedBaseUrl}${endpoint}`, {
          ...options,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ApiClientError('API_ERROR', 'API request timed out.', { timeoutMs: normalizedTimeoutMs }, { cause: error });
        }
        throw new ApiClientError('API_ERROR', 'API request could not be sent.', {}, { cause: error });
      }

      const raw = await readResponseText(response);
      let payload;
      try {
        payload = raw.length === 0 ? {} : JSON.parse(raw);
      } catch (error) {
        throw new ApiClientError('API_PROTOCOL_ERROR', 'API returned invalid JSON.', { status: response.status }, { cause: error });
      }
      if (!response.ok) {
        const providerMessage = payload?.error?.message;
        throw new ApiClientError('API_ERROR', typeof providerMessage === 'string' ? providerMessage.slice(0, 500) : `API returned HTTP ${response.status}.`, { status: response.status });
      }
      return payload;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

async function readResponseText(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ApiClientError('API_PROTOCOL_ERROR', 'API response exceeds the 4 MiB limit.');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ApiClientError('API_PROTOCOL_ERROR', 'API response exceeds the 4 MiB limit.');
  }
  return raw;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_API_BASE_URL must be a valid HTTP(S) URL.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_API_BASE_URL must be a valid HTTP(S) URL.', {}, { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_API_BASE_URL must be a URL without credentials, query, or fragment.');
  }
  return url.href.replace(/\/$/u, '');
}

function nonEmptyEnv(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiClientError('INVALID_INPUT', `${name} must be configured.`, { field: name });
  }
  return value.trim();
}

function parseTimeout(value) {
  if (!/^\d+$/u.test(value)) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_API_TIMEOUT_MS must be an integer from 1000 to 300000.', { field: 'YI_AGENT_API_TIMEOUT_MS' });
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new ApiClientError('INVALID_INPUT', 'YI_AGENT_API_TIMEOUT_MS must be an integer from 1000 to 300000.', { field: 'YI_AGENT_API_TIMEOUT_MS' });
  }
  return timeoutMs;
}
