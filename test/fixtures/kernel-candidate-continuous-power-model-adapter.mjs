import readline from 'node:readline';

// R28：模型提供有限功率假设集，最终选择交给 Kernel 的 proposal 预测与安全边界。
const PROPOSALS = [-50, 0, 50];

function parseContext(prompt) {
  const line = prompt.trim().split(/\r?\n/u).at(-1);
  try { return JSON.parse(line); } catch { return {}; }
}

function tokenFromPrompt(prompt) {
  return /tok_[A-Z0-9]{8,128}/u.exec(prompt)?.[0] ?? null;
}

function allowed(soc, powerKw) {
  const nextSoc = soc + (powerKw * (powerKw > 0 ? 0.95 : 1 / 0.95) * 100) / 800;
  return nextSoc >= 10 && nextSoc <= 95;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const prompt = request.payload?.prompt ?? '';
  const context = parseContext(prompt);
  const token = tokenFromPrompt(prompt);
  const soc = Number(context.observation?.vector?.[2]) * 100;
  const available = PROPOSALS.filter((powerKw) => allowed(soc, powerKw));
  const primary = available[Math.max(0, Number(context.step) || 0) % Math.max(1, available.length)] ?? 0;
  const candidates = available
    .filter((powerKw) => powerKw !== primary)
    .map((powerKw) => ({ token, proposal: { powerKw } }));
  const content = JSON.stringify({
    token,
    proposal: { powerKw: primary },
    candidates,
  });
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'kernel-candidate-continuous-power-fixture', content },
  }) + '\n');
});
