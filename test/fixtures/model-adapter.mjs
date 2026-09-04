import readline from 'node:readline';

const hang = process.argv.includes('--hang');
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
