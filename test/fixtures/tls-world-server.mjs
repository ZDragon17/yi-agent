import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:tls';

const options = parseOptions(process.argv.slice(2));
const adapterArgs = JSON.parse(options['adapter-args-json']);
const server = createServer({
  allowHalfOpen: true,
  key: readFileSync(options['tls-key-file']),
  cert: readFileSync(options['tls-cert-file']),
  ca: readFileSync(options['tls-client-ca-file']),
  requestCert: true,
  rejectUnauthorized: true,
}, (socket) => {
  let input = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    input += chunk;
    const newline = input.indexOf('\n');
    if (newline === -1) return;
    const requestLine = input.slice(0, newline);
    const result = spawnSync(process.execPath, [options.adapter, ...adapterArgs], {
      input: `${requestLine}\n`,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (typeof result.stdout === 'string' && result.stdout.length > 0) {
      if (options['extra-response-json'] === undefined) {
        socket.end(result.stdout);
      } else {
        socket.write(result.stdout);
        setTimeout(() => socket.end(`${options['extra-response-json']}\n`), Number(options['extra-response-delay-ms'] ?? 10));
      }
    } else {
      socket.end(`${JSON.stringify({
        protocol: 'yi-world-cli',
        version: 1,
        id: 'unknown',
        ok: false,
        error: result.error?.message ?? 'adapter did not return a response',
      })}\n`);
    }
  });
});

server.listen(Number(options.port ?? 0), '127.0.0.1', () => {
  writeFileSync(options['port-file'], `${server.address().port}\n`, 'utf8');
});

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    result[args[index].replace(/^--/u, '')] = args[index + 1];
  }
  return result;
}
