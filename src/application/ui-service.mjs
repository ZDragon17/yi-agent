import { createServer } from 'node:http';
import { inspectLab } from './agent-service.mjs';

const SCHEMA_VERSION = 1;
const HOST = '127.0.0.1';

// 只读检查外壳：宪法允许在内核通过反例实验后以只读外壳接入。
// 服务仅绑定回环地址，仅响应 GET；/api/state 复用 inspectLab 的只读读路径
// （不获取 writer lock、不消耗随机源、不改变世界或学习状态）。
export function createUiServer({ labPath, port = 0, registry = undefined }) {
  const server = createServer((request, response) => {
    handleRequest(request, response, { labPath, registry }).catch((error) => {
      writeJson(response, 500, failureEnvelope('INTERNAL', error?.message ?? 'Internal error.'));
    });
  });
  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.removeListener('error', reject);
          resolve({ host: HOST, port: server.address().port });
        });
      });
    },
    serve() {
      return new Promise((resolve) => {
        server.once('close', resolve);
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function handleRequest(request, response, { labPath, registry }) {
  const url = new URL(request.url ?? '/', `http://${HOST}`);
  if (request.method !== 'GET') {
    writeJson(response, 405, failureEnvelope('INVALID_INPUT', 'The ui shell is read-only; only GET requests are served.'));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(pageHtml());
    return;
  }
  if (url.pathname === '/api/state') {
    try {
      const data = await inspectLab({ labPath, registry });
      writeJson(response, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data });
    } catch (error) {
      writeJson(response, 200, failureEnvelope(
        error?.code ?? error?.cause?.code ?? 'INTERNAL',
        error?.message ?? 'Inspection failed.',
      ));
    }
    return;
  }
  writeJson(response, 404, failureEnvelope('NOT_FOUND', `No ui resource at ${url.pathname}.`));
}

function failureEnvelope(code, message) {
  return { schemaVersion: SCHEMA_VERSION, ok: false, error: { code, message, recoverable: false } };
}

function writeJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>yi-agent 只读检查外壳</title>
<style>
  body { font-family: Consolas, monospace; margin: 16px; background: #111; color: #ddd; }
  h1 { font-size: 16px; } h1 span { color: #7c7; }
  #summary { margin: 8px 0; line-height: 1.6; }
  #summary b { color: #9cf; }
  .err { color: #f87; white-space: pre-wrap; }
  pre { background: #181818; border: 1px solid #333; padding: 10px; overflow: auto; max-height: 70vh; }
  small { color: #888; }
</style>
</head>
<body>
<h1>yi-agent 只读检查外壳 <span id="status">连接中…</span></h1>
<div id="summary"></div>
<pre id="raw">等待 /api/state …</pre>
<small>每 2 秒刷新；仅 GET；本服务不创建锁、不改变实验空间。</small>
<script>
  function render(data) {
    const view = data.inspectView ?? {};
    const current = data.current ?? {};
    const cells = [
      ['status', current.status],
      ['stopReason', view.stopReason ?? current.status],
      ['world', (data.manifest ?? {}).worldId],
      ['kernelStep', current.kernelStep],
      ['lastRun', current.lastRunId],
      ['goal', view.goal],
      ['cycle', view.changeSupervisor?.cycle],
      ['bestDistance', view.changeSupervisor?.bestDistance],
    ];
    document.getElementById('summary').innerHTML = cells
      .map(function (cell) {
        var value = cell[1] === undefined || cell[1] === null ? '—' : String(cell[1]);
        return '<b>' + cell[0] + '</b>: ' + value;
      })
      .join(' &nbsp;|&nbsp; ');
    document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
  }
  async function poll() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const envelope = await response.json();
      if (envelope.ok) {
        document.getElementById('status').textContent = '已连接';
        document.getElementById('status').className = '';
        render(envelope.data);
      } else {
        document.getElementById('status').textContent = '错误';
        document.getElementById('status').className = 'err';
        document.getElementById('raw').textContent = JSON.stringify(envelope, null, 2);
      }
    } catch (error) {
      document.getElementById('status').textContent = '离线';
      document.getElementById('status').className = 'err';
    }
  }
  poll();
  setInterval(poll, 2000);
</script>
</body>
</html>
`;
}
