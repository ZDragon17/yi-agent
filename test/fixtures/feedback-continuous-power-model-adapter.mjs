import readline from 'node:readline';

// R23：proposal 必须由当前 observation 推导，验证模型边界是否形成反馈闭环。
function parseContext(prompt) {
  const line = prompt.trim().split(/\r?\n/u).at(-1);
  try { return JSON.parse(line); } catch { return {}; }
}

function powerForObservation(observation) {
  const vector = observation?.vector;
  const tariff = vector?.[1];
  const soc = Number(vector?.[2]) * 100;
  if (tariff < -0.1 && soc < 80) return 50;
  if (tariff > 0.1 && soc > 20) return -50;
  return 0;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const context = parseContext(request.payload?.prompt ?? '');
  const token = /tok_[A-Z0-9]{8,128}/u.exec(request.payload?.prompt ?? '')?.[0] ?? null;
  const content = JSON.stringify({
    token,
    proposal: { powerKw: powerForObservation(context.observation) },
  });
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'feedback-continuous-power-fixture', content },
  }) + '\n');
});
