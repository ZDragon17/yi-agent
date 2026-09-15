import readline from 'node:readline';
import { candidateDigest } from '../../src/runtime/schema.mjs';

// R26：在候选 proposal 已经有 verified 全局模型后，优先读取当前活动上下文的
// proposal-context 模型；没有上下文样本时回退到全局模型。
const PROPOSALS = [-50, 0, 50];

function parseContext(prompt) {
  const line = prompt.trim().split(/\r?\n/u).at(-1);
  try { return JSON.parse(line); } catch { return {}; }
}

function tokenFromPrompt(prompt) {
  return /tok_[A-Z0-9]{8,128}/u.exec(prompt)?.[0] ?? null;
}

function proposalFor(context, token) {
  const globalModels = context.memory?.proposalModels?.[token] ?? {};
  const contextualModels = context.memory?.proposalContextModels?.[token] ?? {};
  const activeContextKeys = context.activeContextKeys ?? [];
  const soc = Number(context.observation?.vector?.[2]) * 100;
  const allowed = (powerKw) => {
    const nextSoc = soc + (powerKw * (powerKw > 0 ? 0.95 : 1 / 0.95) * 100) / 800;
    return nextSoc >= 10 && nextSoc <= 95;
  };
  const known = PROPOSALS.map((powerKw) => {
    const digest = candidateDigest({ token, proposal: { powerKw } });
    const contextual = activeContextKeys
      .map((contextKey) => contextualModels[digest]?.[contextKey])
      .find((model) => model !== undefined && model.sampleCount >= 2);
    return { powerKw, model: contextual ?? globalModels[digest] };
  }).filter((candidate) => candidate.model !== undefined);
  if (known.length < PROPOSALS.length) {
    const candidate = PROPOSALS[Math.max(0, Number(context.step) || 0) % PROPOSALS.length];
    return allowed(candidate) ? candidate : 0;
  }
  const safeKnown = known.filter((candidate) => allowed(candidate.powerKw));
  if (safeKnown.length === 0) return 0;
  return safeKnown.reduce((best, candidate) =>
    candidate.model.meanDelta[3] > best.model.meanDelta[3] ? candidate : best,
  ).powerKw;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const prompt = request.payload?.prompt ?? '';
  const context = parseContext(prompt);
  const token = tokenFromPrompt(prompt);
  const powerKw = token === null ? 0 : proposalFor(context, token);
  const content = JSON.stringify({ token, proposal: { powerKw } });
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'context-aware-continuous-power-fixture', content },
  }) + '\n');
});
