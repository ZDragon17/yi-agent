import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:tls';

const options = parseOptions(process.argv.slice(2));
const adapterArgs = JSON.parse(options['adapter-args-json']);
const server = createServer({
  allowHalfOpen: true,
  key: readFileSync(options['tls-key-file']),
  cert: readFileSync(options['tls-cert-file']),
  ca: readFileSync(options['tls-client-ca-file']),
  ...(options['tls-client-crl-file'] === undefined
    ? {}
    : { crl: readFileSync(options['tls-client-crl-file']) }),
  requestCert: true,
  rejectUnauthorized: true,
}, (socket) => {
  if (options['connection-count-file'] !== undefined) appendFileSync(options['connection-count-file'], 'connection\n', 'utf8');
  let input = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    input += chunk;
    let newline;
    while ((newline = input.indexOf('\n')) !== -1) {
      const requestLine = input.slice(0, newline);
      input = input.slice(newline + 1);
      const result = spawnSync(process.execPath, [options.adapter, ...adapterArgs], {
        input: `${requestLine}\n`,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const request = parseJson(requestLine);
      const responseDelayMs = options['delay-response-op'] !== undefined &&
        request?.op === options['delay-response-op']
        ? Number(options['delay-response-ms'] ?? 0)
        : 0;
      const blackholeResponse = options['blackhole-response-op'] !== undefined &&
        request?.op === options['blackhole-response-op'];
      const resetResponse = options['reset-response-op'] !== undefined &&
        request?.op === options['reset-response-op'];
      const sendResponse = () => {
        if (typeof result.stdout === 'string' && result.stdout.length > 0) {
          if (options['extra-response-json'] === undefined) {
            if (options['keep-alive'] === 'true') socket.write(result.stdout);
            else socket.end(result.stdout);
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
      };
      if (resetResponse) {
        socket.destroy();
      } else if (!blackholeResponse) {
        if (Number.isFinite(responseDelayMs) && responseDelayMs > 0) setTimeout(sendResponse, responseDelayMs);
        else sendResponse();
      }
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

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}
