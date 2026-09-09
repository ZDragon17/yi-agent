import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';

const options = parseOptions(process.argv.slice(2));
const upstreamHost = options['upstream-host'] ?? '127.0.0.1';
const upstreamPort = Number(options['upstream-port']);
const port = Number(options.port ?? 0);
const dropMarkerFile = options['drop-marker-file'];
const dropLogFile = options['drop-log-file'];
const blackholeMarkerFile = options['blackhole-marker-file'];
const blackholeLogFile = options['blackhole-log-file'];
const hasCutFault = dropMarkerFile !== undefined && dropLogFile !== undefined;
const hasBlackholeFault = blackholeMarkerFile !== undefined && blackholeLogFile !== undefined;

if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
  throw new Error('--upstream-port must be a valid TCP port');
}
if ((!hasCutFault && !hasBlackholeFault) || (hasCutFault && hasBlackholeFault) || options['port-file'] === undefined) {
  throw new Error('--port-file and exactly one TCP fault mode are required');
}

let faultTriggered = false;
const server = createServer((downstream) => {
  let upstream = null;
  let closed = false;
  let blackholed = false;

  const closePair = () => {
    if (closed) return;
    closed = true;
    downstream.destroy();
    upstream?.destroy();
  };

  const dropIfMarkerExists = () => {
    if (!hasCutFault || faultTriggered || closed || !existsSync(dropMarkerFile)) return false;
    faultTriggered = true;
    appendFileSync(dropLogFile, 'drop\n', 'utf8');
    closePair();
    return true;
  };

  const blackholeIfMarkerExists = () => {
    if (!hasBlackholeFault || faultTriggered || closed || !existsSync(blackholeMarkerFile)) return false;
    faultTriggered = true;
    blackholed = true;
    appendFileSync(blackholeLogFile, 'blackhole\n', 'utf8');
    return true;
  };

  upstream = createConnection({ host: upstreamHost, port: upstreamPort });
  downstream.on('data', (chunk) => {
    if (!closed && !upstream.destroyed) upstream.write(chunk);
  });
  downstream.on('end', () => upstream?.end());
  downstream.on('error', closePair);
  downstream.on('close', closePair);
  upstream.on('data', (chunk) => {
    if (blackholed) return;
    if (blackholeIfMarkerExists()) return;
    if (dropIfMarkerExists()) return;
    if (!closed && !downstream.destroyed) downstream.write(chunk);
  });
  upstream.on('error', closePair);
  upstream.on('close', closePair);
});

server.listen(port, '127.0.0.1', () => {
  writeFileSync(options['port-file'], `${server.address().port}\n`, 'utf8');
});

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    result[args[index].replace(/^--/u, '')] = args[index + 1];
  }
  return result;
}
