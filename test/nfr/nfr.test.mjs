import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const LONG_RUN_CHILD = path.resolve('test/nfr/long-run-child.mjs');

const STEP_KEYS = [
  'recordedAt',
  'boundary',
  'beforeObservation',
  'memoryEvidenceProjection',
  'beforeDigest',
  'expectation',
  'choice',
  'receipt',
  'postObservation',
  'verification',
  'update',
  'afterDigest',
  'rngBefore',
  'rngAfter',
  'externalInputs',
  'afterState',
];

test('10,000-step runs stay within the ledger bound and preserve complete evidence', async () => {
  await withTemp(async (root) => {
    const lab = path.join(root, 'lab');
    const started = performance.now();
    const result = await runLongRunChild(lab);
    const elapsedMs = performance.now() - started;

    assert.equal(result.executed, 10_000);
    assert.ok(elapsedMs < 60_000, `10,000-step run took ${elapsedMs.toFixed(1)}ms`);

    const run = await (await LabStore.open({ labPath: lab })).readRun('nfr-run');
    const steps = run.events.filter((event) => event.kind === 'STEP');
    assert.equal(steps.length, 10_000);
    for (const event of steps) {
      assert.deepEqual(Object.keys(event.payload).sort(), [...STEP_KEYS].sort());
      assert.equal(event.payload.externalInputs.length, 0);
      assert.equal(event.payload.verification.learnable, true);
      assert.ok(event.payload.afterState.memory);
    }

    const ledger = await stat(path.join(lab, 'runs', 'nfr-run', 'events.jsonl'));
    assert.ok(ledger.size < 40 * 1024 * 1024, `ledger is ${ledger.size} bytes`);
  });
});

test('source structure keeps the Kernel domain-blind and the runtime free of shell execution', async () => {
  const sourceRoot = path.resolve('src');
  const files = await collectJavaScriptFiles(sourceRoot);
  const kernelFiles = files.filter((file) => file.startsWith(path.resolve('src/kernel') + path.sep));
  assert.ok(kernelFiles.length > 0);

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"](?:\.\.\/)*test\//u, file);
    assert.doesNotMatch(source, /shell\s*:\s*true/u, file);
  }
  for (const file of kernelFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /(?:temperature|virtual-desktop|inventory|grid|queue)/iu, file);
    assert.doesNotMatch(source, /(?:src[\\/]worlds|\.\.\/worlds)/u, file);
  }
});

async function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(target));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(target);
    }
  }
  return files;
}

function runLongRunChild(labPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LONG_RUN_CHILD, labPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(`long-run child failed: code=${code ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`long-run child returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-nfr-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
