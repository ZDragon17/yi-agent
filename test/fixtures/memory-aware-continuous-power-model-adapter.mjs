import readline from 'node:readline';
import { candidateDigest } from '../../src/runtime/schema.mjs';

// R25：在同一 Token 的多个连续 proposal 都已有 verified model 后，
// 模型按 utility 通道的已验证平均变化选择候选；尚未覆盖完整候选集时先轮换取证。
const PROPOSALS = [-50, 0, 50];

function parseContext(prompt) {
  const line = prompt.trim().split(/\r?\n/u).at(-1);
  try { return JSON.parse(line); } catch { return {}; }
}

function tokenFromPrompt(prompt) {
  return /tok_[A-Z0-9]{8,128}/u.exec(prompt)?.[0] ?? null;
}

function proposalFor(context, token, requestCount) {
  const models = context.memory?.proposalModels?.[token] ?? {};
  const soc = Number(context.observation?.vector?.[2]) * 100;
  const allowed = (powerKw) => {
    const nextSoc = soc + (powerKw * (powerKw > 0 ? 0.95 : 1 / 0.95) * 100) / 800;
    return nextSoc >= 10 && nextSoc <= 95;
  };
  const known = PROPOSALS.map((powerKw) => {
    const digest = candidateDigest({ token, proposal: { powerKw } });
    return { powerKw, model: models[digest] };
  }).filter((candidate) => candidate.model !== undefined);
  if (known.length < PROPOSALS.length) {
    const candidate = PROPOSALS[requestCount % PROPOSALS.length];
    return allowed(candidate) ? candidate : 0;
  }
  const safeKnown = known.filter((candidate) => allowed(candidate.powerKw));
  if (safeKnown.length === 0) return 0;
  return safeKnown.reduce((best, candidate) =>
    candidate.model.meanDelta[3] > best.model.meanDelta[3] ? candidate : best,
  ).powerKw;
}

let requestCount = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const prompt = request.payload?.prompt ?? '';
  const context = parseContext(prompt);
  const token = tokenFromPrompt(prompt);
  const powerKw = token === null ? 0 : proposalFor(context, token, requestCount);
  requestCount += 1;
  const content = JSON.stringify({ token, proposal: { powerKw } });
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'memory-aware-continuous-power-fixture', content },
  }) + '\n');
});
