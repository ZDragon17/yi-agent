import readline from 'node:readline';

const hang = process.argv.includes('--hang');
// 宿主写出请求后立即结束 stdin；没有存活句柄时进程会在截止时间前干净退出，超时路径不再可达。
if (hang) setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (hang) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const token = /tok_[A-Z0-9]{8,128}/u.exec(request.payload?.prompt ?? '')?.[0] ?? null;
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'fixture-process-model', content: JSON.stringify({ token }) },
  }) + '\n');
});
