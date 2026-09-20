import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const hang = process.argv.includes('--hang');
const hangAfterIndex = process.argv.indexOf('--hang-after');
const hangAfter = hangAfterIndex === -1 ? null : Number.parseInt(process.argv[hangAfterIndex + 1] ?? '', 10);
const markerIndex = process.argv.indexOf('--marker');
const marker = markerIndex === -1 ? null : process.argv[markerIndex + 1] ?? null;
let requestCount = 0;
// 宿主写出请求后立即结束 stdin；没有存活句柄时进程会在截止时间前干净退出，超时路径不再可达。
if (hang) keepAlive();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (hang) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  requestCount += 1;
  if (marker !== null) appendFileSync(marker, `${requestCount}\n`, 'utf8');
  if (hangAfter !== null && Number.isSafeInteger(hangAfter) && requestCount > hangAfter) {
    keepAlive();
    return;
  }
  const token = /tok_[A-Z0-9]{8,128}/u.exec(request.payload?.prompt ?? '')?.[0] ?? null;
  process.stdout.write(JSON.stringify({
    protocol: 'yi-model-cli',
    version: 1,
    id: request.id,
    ok: true,
    result: { model: 'fixture-process-model', content: JSON.stringify({ token }) },
  }) + '\n');
});

function keepAlive() {
  setInterval(() => {}, 1000);
}
