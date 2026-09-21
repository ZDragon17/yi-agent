// 将 yi-agent 的持久 JSONL 模型适配器协议转发到 OpenAI 兼容接口。
// 密钥和地址只从环境变量读取；stdout 只保留协议响应，便于被宿主可靠解析。
import readline from 'node:readline';

const PROTOCOL = 'yi-model-cli';
const VERSION = 1;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const DEFAULT_BASE_URL = 'http://127.0.0.1:8645/v1';
const DEFAULT_MODEL = 'GLM-5.3';
const baseUrl = normalizeBaseUrl(process.env.YI_AGENT_API_BASE_URL ?? DEFAULT_BASE_URL);
const apiKey = process.env.YI_AGENT_API_KEY ?? '';
const model = process.env.YI_AGENT_MODEL ?? DEFAULT_MODEL;
const timeoutMs = parseTimeout(process.env.YI_AGENT_ADAPTER_HTTP_TIMEOUT_MS ?? '300000');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.length === 0) continue;
  let request;
  try {
    request = JSON.parse(line);
    validateRequest(request);
    const content = await requestModel(request.payload.prompt);
    respond(request.id, true, { model, content });
  } catch (error) {
    respond(request?.id ?? null, false, 'model adapter request failed');
  }
}

async function requestModel(prompt) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(apiKey.length === 0 ? {} : { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('model endpoint returned an error');
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error('model endpoint returned invalid content');
  }
  return content;
}

function validateRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.protocol !== PROTOCOL || value.version !== VERSION || typeof value.id !== 'string' ||
      value.payload === null || typeof value.payload !== 'object' ||
      typeof value.payload.prompt !== 'string' ||
      Buffer.byteLength(value.payload.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('invalid model adapter request');
  }
}

function respond(id, ok, result) {
  const envelope = ok
    ? { protocol: PROTOCOL, version: VERSION, id, ok: true, result }
    : { protocol: PROTOCOL, version: VERSION, id, ok: false, error: result };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('YI_AGENT_API_BASE_URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('YI_AGENT_API_BASE_URL must be a credential-free HTTP(S) URL');
  }
  return url.href.replace(/\/$/u, '');
}

function parseTimeout(value) {
  if (!/^\d+$/u.test(value)) throw new Error('YI_AGENT_ADAPTER_HTTP_TIMEOUT_MS must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 300000) {
    throw new Error('YI_AGENT_ADAPTER_HTTP_TIMEOUT_MS is out of range');
  }
  return parsed;
}
