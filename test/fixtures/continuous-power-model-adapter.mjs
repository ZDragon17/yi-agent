import readline from 'node:readline';

// 充放电成对，避免测试模型因长期单向充电把 SOC 推到 BMS 边界。
const POWERS = [37.5, -37.5, 12.5, -12.5, 50, -50, 25, -25];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const prompt = request.payload?.prompt ?? '';
  const token = /tok_[A-Z0-9]{8,128}/u.exec(prompt)?.[0] ?? null;
  const step = Number(/"step":(\d+)/u.exec(prompt)?.[1] ?? 0);
  const powerKw = POWERS[step % POWERS.length];
  const content = JSON.stringify({ token, proposal: { powerKw } });
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'continuous-power-fixture', content },
  }) + '\n');
});
