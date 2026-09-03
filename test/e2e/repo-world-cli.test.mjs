import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { canonicalDigest, MAX_MODEL_PROPOSAL_BYTES } from '../../src/runtime/schema.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/repo-world/adapter.mjs');
const REPOSITORY_ROOT = path.resolve('.');
const READ_PATH = 'README.md';
const TEST_PATH = 'test/agent/model-advisor.test.mjs';

test('repo WorldPort uses the same continuous Run and Replay envelope as a built-in WorldPort', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-matrix-e2e-'));
  const adapterConfig = path.join(root, 'adapter.json');
  const environment = { ...process.env };
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, REPOSITORY_ROOT, READ_PATH, TEST_PATH],
    adapterId: 'repo-readonly-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }));

  const cases = [
    { id: 'repo', seed: 'repo-matrix-seed', adapter: adapterConfig },
    { id: 'temperature', seed: 'temperature-matrix-seed', adapter: null },
  ];
  try {
    const envelopes = [];
    for (const world of cases) {
      const lab = path.join(root, world.id, 'lab');
      const initArgs = [
        'init', '--lab', lab, '--world', world.id, '--seed', world.seed,
        '--json', ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
      ];
      const loopArgs = [
        'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--scenario',
        ...(world.adapter === null ? ['steady'] : ['working-tree']), '--kernel-only', '--json',
        ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
      ];
      const init = await invoke(initArgs, environment);
      assert.equal(init.code, 0, `${world.id} init: ${JSON.stringify(init)}`);
      const loop = await invoke(loopArgs, environment);
      assert.equal(loop.code, 0, `${world.id} loop: ${JSON.stringify(loop)}`);
      const data = loop.stdout[0].data;
      assert.equal(data.status, 'COMPLETED');
      assert.equal(data.runs, 2);
      assert.equal(data.metrics.executed, 2);
      assert.equal(data.results.length, 2);
      assert.equal(new Set(data.results.map((result) => result.runId)).size, 2);
      envelopes.push(data.results.map((result) => Object.keys(result).sort()));

      const inspection = await invoke([
        'inspect', '--lab', lab, '--json',
        ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
      ], environment);
      assert.equal(inspection.code, 0, `${world.id} inspect: ${JSON.stringify(inspection)}`);
      assert.equal(inspection.stdout[0].data.current.kernelStep, 2);
      for (const result of data.results) {
        const replay = await invoke([
          'replay', '--lab', lab, '--run', result.runId, '--json',
          ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
        ], environment);
        assert.equal(replay.code, 0, `${world.id}/${result.runId} replay: ${JSON.stringify(replay)}`);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
      }
      assert.deepEqual(await listRunIds(lab), data.results.map((result) => result.runId).sort());
    }
    assert.deepEqual(envelopes[0], envelopes[1], 'WorldPorts must share the same committed Run result envelope');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only repo WorldPort completes the shared loop without writing the repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-e2e-'));
  const requests = [];
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const tokens = [...new Set(body.messages[0].content.match(/tok_[A-Z0-9]{8,128}/gu) ?? [])];
    assert.ok(tokens.length >= 2, 'the decision context must expose both repo capabilities');
    const token = tokens[modelCalls++ % 2];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'repo-agent-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-local-model',
  };
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const beforeReadme = await readFile(path.join(REPOSITORY_ROOT, READ_PATH));
  const sentinel = path.join(REPOSITORY_ROOT, '.repo-world-write-sentinel');

  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, REPOSITORY_ROOT, READ_PATH, TEST_PATH],
    adapterId: 'repo-readonly-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }));

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-seed',
      '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(init.code, 0);

    const run = await invoke([
      'agent', 'run', '--lab', lab, '--steps', '2', '--scenario', 'working-tree',
      '--adapter', adapterConfig, '--goal', '先读取仓库，再验证测试', '--json',
    ], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(modelCalls, 2);

    const runId = run.stdout[0].data.runId;
    const store = await LabStore.open({ labPath: lab });
    const events = (await store.readRun(runId)).events;
    const stepEvents = events.filter((event) => event.kind === 'STEP');
    assert.equal(stepEvents.length, 2);
    assert.deepEqual(
      stepEvents.map((event) => event.payload.afterState.worldState.lastAction),
      ['repo.read-file', 'repo.run-tests'],
    );
    assert.equal(stepEvents[0].payload.afterState.worldState.lastReadPath, READ_PATH);
    assert.equal(stepEvents[1].payload.afterState.worldState.lastTestStatus, 'PASS');
    assert.match(stepEvents[1].payload.afterState.worldState.lastTestOutputDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(stepEvents.every((event) => event.payload.policyEvidence?.applied === true), true);

    const replay = await invoke([
      'replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    assert.equal(modelCalls, 2, 'replay must not call the model again');
    assert.deepEqual(await readFile(path.join(REPOSITORY_ROOT, READ_PATH)), beforeReadme);
    await assert.rejects(access(sentinel));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('writable repo WorldPort applies a digest-bound patch and verifies the retained fix', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-write-e2e-'));
  const repository = path.join(root, 'repository');
  const sourcePath = path.join(repository, 'src', 'math.mjs');
  const testPath = path.join(repository, 'test', 'math.test.mjs');
  const patchSpecPath = path.join(root, 'patch.json');
  const nonceJournalPath = path.join(root, 'patch-nonces.json');
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const buggySource = 'export function add(left, right) { return left - right; }\n';
  const fixedSource = 'export function add(left, right) { return left + right; }\n';
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(testPath), { recursive: true });
  await writeFile(sourcePath, buggySource, 'utf8');
  if (process.platform !== 'win32') await chmod(sourcePath, 0o755);
  await writeFile(testPath, [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { add } from '../src/math.mjs';",
    "test('add returns the sum', () => assert.equal(add(2, 3), 5));",
    '',
  ].join('\n'), 'utf8');
  await writeFile(patchSpecPath, JSON.stringify({
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: buggySource }),
  }), 'utf8');
  const patchProposal = {
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: buggySource }),
    replacement: fixedSource,
  };

  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = JSON.parse(body.messages[0].content.split('\n').at(-1));
    const capability = context.capabilities.find((item) => item.capabilityId === [
      'repo.read-file', 'repo.run-tests', 'repo.apply-patch', 'repo.run-tests',
    ][modelCalls]);
    assert.ok(capability, `model context is missing step ${modelCalls} capability`);
    if (modelCalls === 1) {
      const actionEvidence = context.observationEvidence.find((item) => item.kind === 'repo-action');
      assert.equal(actionEvidence.readFileContent, buggySource);
      assert.equal(actionEvidence.readFileDigest, canonicalDigest({ bytes: buggySource.length, content: buggySource }));
    }
    modelCalls += 1;
    response.setHeader('Content-Type', 'application/json');
    const patchPolicy = context.observationEvidence.find((item) => item.kind === 'repo-patch-policy');
    assert.deepEqual(patchPolicy?.proposalSchema?.fields, [
      'schemaVersion', 'targetPath', 'expectedBeforeDigest', 'replacement',
    ]);
    const proposal = capability.capabilityId === 'repo.apply-patch'
      ? {
          ...patchProposal,
          targetPath: patchPolicy.targetPath,
          expectedBeforeDigest: patchPolicy.expectedBeforeDigest,
        }
      : undefined;
    response.end(JSON.stringify({
      id: 'repo-write-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({
        token: capability.token,
        ...(proposal === undefined ? {} : { proposal }),
      }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const environment = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-write-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-write-local-model',
  };
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, repository, 'src/math.mjs', 'test/math.test.mjs', patchSpecPath, nonceJournalPath],
    adapterId: 'repo-writable-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }), 'utf8');

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-write-seed',
      '--adapter', adapterConfig, '--json',
    ], environment);
    assert.equal(init.code, 0, JSON.stringify(init));

    const run = await invoke([
      'agent', 'run', '--lab', lab, '--steps', '4', '--scenario', 'working-tree',
      '--adapter', adapterConfig, '--goal', '修复加法并用测试验证', '--json',
    ], environment);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(modelCalls, 4);

    const store = await LabStore.open({ labPath: lab });
    const events = (await store.readRun(run.stdout[0].data.runId)).events;
    const steps = events.filter((event) => event.kind === 'STEP');
    assert.deepEqual(steps.map((event) => event.payload.afterState.worldState.lastAction), [
      'repo.read-file', 'repo.run-tests', 'repo.apply-patch', 'repo.run-tests',
    ]);
    assert.equal(steps[1].payload.afterState.worldState.lastTestStatus, 'FAIL');
    assert.equal(steps[3].payload.afterState.worldState.lastTestStatus, 'PASS');
    assert.equal(await readFile(sourcePath, 'utf8'), fixedSource);
    if (process.platform !== 'win32') assert.equal((await stat(sourcePath)).mode & 0o777, 0o755);
    const nonceJournal = (await readFile(nonceJournalPath, 'utf8'))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(nonceJournal.length, 2);
    assert.equal(nonceJournal[0].status, 'PREPARED');
    assert.equal(nonceJournal[1].status, 'APPLIED');

    const replay = await invoke([
      'replay', '--lab', lab, '--run', run.stdout[0].data.runId,
      '--adapter', adapterConfig, '--json',
    ], environment);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    assert.equal(modelCalls, 4, 'replay must not call the model again');
    assert.equal(await readFile(sourcePath, 'utf8'), fixedSource);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('repo proposal quality is externally distinguishable under one bounded context', async () => {
  const buggySource = 'export function add(left, right) { return left - right; }\n';
  const fixedSource = 'export function add(left, right) { return left + right; }\n';
  const cases = [
    { name: 'correct', replacement: fixedSource, expectedStatus: 'PASS', writes: true },
    { name: 'semantic-error', replacement: 'export function add(left, right) { return left * right; }\n', expectedStatus: 'FAIL', writes: true },
    { name: 'oversized', replacement: 'x'.repeat(MAX_MODEL_PROPOSAL_BYTES), expectedStatus: null, writes: false },
  ];
  const firstContexts = [];
  const appliedCandidateDigests = [];

  for (const candidate of cases) {
    const root = await mkdtemp(path.join(tmpdir(), `yi-agent-repo-quality-${candidate.name}-`));
    const repository = path.join(root, 'repository');
    const sourcePath = path.join(repository, 'src', 'math.mjs');
    const testPath = path.join(repository, 'test', 'math.test.mjs');
    const patchSpecPath = path.join(root, 'patch.json');
    const nonceJournalPath = path.join(root, 'patch-nonces.json');
    const adapterConfig = path.join(root, 'adapter.json');
    const lab = path.join(root, 'lab');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(sourcePath, buggySource, 'utf8');
    await writeFile(testPath, [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { add } from '../src/math.mjs';",
      "test('add returns the sum', () => assert.equal(add(2, 3), 5));",
      '',
    ].join('\n'), 'utf8');
    await writeFile(patchSpecPath, JSON.stringify({
      schemaVersion: 1,
      targetPath: 'src/math.mjs',
      expectedBeforeDigest: canonicalDigest({ content: buggySource }),
    }), 'utf8');

    let modelCalls = 0;
    let firstContext = null;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const context = JSON.parse(body.messages[0].content.split('\n').at(-1));
      if (firstContext === null) firstContext = JSON.stringify(context);
      const capability = context.capabilities.find((item) => item.capabilityId === [
        'repo.read-file', 'repo.run-tests', 'repo.apply-patch', 'repo.run-tests',
      ][modelCalls]);
      assert.ok(capability, `${candidate.name} missing capability at step ${modelCalls}`);
      modelCalls += 1;
      const patchPolicy = context.observationEvidence.find((item) => item.kind === 'repo-patch-policy');
      const proposal = capability.capabilityId === 'repo.apply-patch'
        ? {
            schemaVersion: 1,
            targetPath: patchPolicy.targetPath,
            expectedBeforeDigest: patchPolicy.expectedBeforeDigest,
            replacement: candidate.replacement,
          }
        : undefined;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        id: `repo-quality-${candidate.name}`,
        model: body.model,
        choices: [{ message: { content: JSON.stringify({
          token: capability.token,
          ...(proposal === undefined ? {} : { proposal }),
        }) } }],
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const environment = {
      ...process.env,
      YI_AGENT_API_KEY: `repo-quality-${candidate.name}-secret`,
      YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      YI_AGENT_MODEL: 'repo-quality-model',
    };
    await writeFile(adapterConfig, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, repository, 'src/math.mjs', 'test/math.test.mjs', patchSpecPath, nonceJournalPath],
      adapterId: 'repo-writable-example-v1',
      worldId: 'repo',
      timeoutMs: 30000,
    }), 'utf8');

    try {
      const init = await invoke([
        'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-quality-seed',
        '--adapter', adapterConfig, '--json',
      ], environment);
      assert.equal(init.code, 0, `${candidate.name} init: ${JSON.stringify(init)}`);
      const run = await invoke([
        'agent', 'run', '--lab', lab, '--steps', '4', '--scenario', 'working-tree',
        '--adapter', adapterConfig, '--goal', '修复加法并用测试验证', '--json',
      ], environment);
      if (candidate.writes) {
        assert.equal(run.code, 0, `${candidate.name} run: ${JSON.stringify(run)}`);
        const inspection = await invoke(['inspect', '--lab', lab, '--adapter', adapterConfig, '--json'], environment);
        assert.equal(inspection.code, 0, `${candidate.name} inspect: ${JSON.stringify(inspection)}`);
        assert.equal(inspection.stdout[0].data.current.worldState.lastTestStatus, candidate.expectedStatus);
        assert.equal(await readFile(sourcePath, 'utf8'), candidate.replacement);
        const store = await LabStore.open({ labPath: lab });
        const events = (await store.readRun(run.stdout[0].data.runId)).events;
        const appliedProposalEvent = events.find((event) =>
          event.payload?.policyEvidence?.applied === true &&
          event.payload.policyEvidence.proposal?.replacement === candidate.replacement);
        assert.ok(appliedProposalEvent, `${candidate.name} must persist its applied proposal`);
        const evidence = appliedProposalEvent.payload.policyEvidence;
        assert.equal(evidence.candidateDigest, canonicalDigest({
          token: evidence.token,
          proposal: evidence.proposal,
        }));
        const historyEntry = inspection.stdout[0].data.candidateHistory.find((item) =>
          item.candidateOutcome.candidateDigest === evidence.candidateDigest);
        assert.equal(historyEntry?.proposal?.replacement, candidate.replacement);
        const outcome = appliedProposalEvent.payload.candidateOutcome;
        assert.equal(outcome.candidateDigest, evidence.candidateDigest);
        assert.equal(outcome.token, evidence.token);
        assert.equal(outcome.status, 'APPLIED');
        assert.equal(outcome.receiptStatus, appliedProposalEvent.payload.receipt.status);
        assert.deepEqual(outcome.verification, {
          error: appliedProposalEvent.payload.verification.error,
          attribution: appliedProposalEvent.payload.verification.attribution,
          confidence: appliedProposalEvent.payload.verification.confidence,
          learnable: appliedProposalEvent.payload.verification.learnable,
        });
        appliedCandidateDigests.push(evidence.candidateDigest);
        const replay = await invoke([
          'replay', '--lab', lab, '--run', run.stdout[0].data.runId,
          '--adapter', adapterConfig, '--json',
        ], environment);
        assert.equal(replay.code, 0, `${candidate.name} replay: ${JSON.stringify(replay)}`);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
      } else {
        assert.notEqual(run.code, 0, `${candidate.name} must be rejected: ${JSON.stringify(run)}`);
        assert.equal(await readFile(sourcePath, 'utf8'), buggySource);
        await assert.rejects(access(nonceJournalPath));
      }
      assert.equal(modelCalls, candidate.writes ? 4 : 3);
      firstContexts.push(firstContext);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }

  assert.equal(new Set(firstContexts).size, 1, 'candidate comparison must use one initial bounded context');
  assert.equal(new Set(appliedCandidateDigests).size, 2, 'different applied proposals must have different candidate identities');
});

test('writable repo WorldPort rejects a nonce journal inside the scanned repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-write-boundary-e2e-'));
  const repository = path.join(root, 'repository');
  const sourcePath = path.join(repository, 'src', 'math.mjs');
  const patchSpecPath = path.join(root, 'patch.json');
  const adapterConfig = path.join(root, 'adapter.json');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const source = 'export const value = 1;\n';
  await writeFile(sourcePath, source, 'utf8');
  await writeFile(patchSpecPath, JSON.stringify({
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: source }),
  }), 'utf8');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, repository, 'src/math.mjs', 'src/math.mjs', patchSpecPath, path.join(repository, 'nonce.log')],
    adapterId: 'repo-writable-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }), 'utf8');

  try {
    const init = await invoke([
      'init', '--lab', path.join(root, 'lab'), '--world', 'repo', '--seed', 'boundary-seed',
      '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(init.code, 70);
    await assert.rejects(access(path.join(repository, 'nonce.log')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writable repo WorldPort rejects invalid proposals before journaling or writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-write-proposal-boundary-e2e-'));
  const repository = path.join(root, 'repository');
  const sourcePath = path.join(repository, 'src', 'math.mjs');
  const patchSpecPath = path.join(root, 'patch.json');
  const nonceJournalPath = path.join(root, 'patch-nonces.json');
  const buggySource = 'export const value = 1;\n';
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, buggySource, 'utf8');
  await writeFile(patchSpecPath, JSON.stringify({
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: buggySource }),
  }), 'utf8');
  const adapterArgs = [
    ADAPTER, repository, 'src/math.mjs', 'test/math.test.mjs', patchSpecPath, nonceJournalPath,
  ];
  const initial = invokeAdapterOnce(adapterArgs, 'initialState', {});
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const manifest = {
    tokenMap: {
      entries: [
        { schemaVersion: 1, token: 'tok_REPO_READ_01', capabilityId: 'repo.read-file' },
        { schemaVersion: 1, token: 'tok_REPO_TEST_01', capabilityId: 'repo.run-tests' },
        { schemaVersion: 1, token: 'tok_REPO_APPLY_01', capabilityId: 'repo.apply-patch' },
      ],
    },
  };
  const requests = [
    {
      executionNonce: 'execution:invalid-target',
      proposal: {
        schemaVersion: 1,
        targetPath: 'src/other.mjs',
        expectedBeforeDigest: canonicalDigest({ content: buggySource }),
        replacement: 'export const value = 2;\n',
      },
      message: /not authorized/u,
    },
    {
      executionNonce: 'execution:oversized-replacement',
      proposal: {
        schemaVersion: 1,
        targetPath: 'src/math.mjs',
        expectedBeforeDigest: canonicalDigest({ content: buggySource }),
        replacement: 'x'.repeat(512 * 1024 + 1),
      },
      message: /proposal is invalid/u,
    },
  ];
  try {
    for (const item of requests) {
      const response = invokeAdapterOnce(adapterArgs, 'transition', {
        manifest,
        state: initial.result.state,
        request: {
          schemaVersion: 1,
          token: 'tok_REPO_APPLY_01',
          basedOnVersion: initial.result.state.stateVersion,
          policyVersion: 'policy-1',
          constraintsDigest: 'sha256:' + 'a'.repeat(64),
          executionNonce: item.executionNonce,
          proposal: item.proposal,
        },
      });
      assert.equal(response.ok, false, JSON.stringify(response));
      assert.match(response.error, item.message);
    }
    assert.equal(await readFile(sourcePath, 'utf8'), buggySource);
    await assert.rejects(access(nonceJournalPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writable repo WorldPort resumes a lost patch response without applying twice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-write-recovery-e2e-'));
  const repository = path.join(root, 'repository');
  const sourcePath = path.join(repository, 'src', 'math.mjs');
  const testPath = path.join(repository, 'test', 'math.test.mjs');
  const patchSpecPath = path.join(root, 'patch.json');
  const nonceJournalPath = path.join(root, 'patch-nonces.json');
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const buggySource = 'export function add(left, right) { return left - right; }\n';
  const fixedSource = 'export function add(left, right) { return left + right; }\n';
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(testPath), { recursive: true });
  await writeFile(sourcePath, buggySource, 'utf8');
  await writeFile(testPath, [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { add } from '../src/math.mjs';",
    "test('add returns the sum', () => assert.equal(add(2, 3), 5));",
    '',
  ].join('\n'), 'utf8');
  await writeFile(patchSpecPath, JSON.stringify({
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: buggySource }),
  }), 'utf8');
  const patchProposal = {
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: buggySource }),
    replacement: fixedSource,
  };

  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = JSON.parse(body.messages[0].content.split('\n').at(-1));
    const capability = context.capabilities.find((item) => item.capabilityId === [
      'repo.read-file', 'repo.run-tests', 'repo.apply-patch',
    ][modelCalls]);
    assert.ok(capability, `model context is missing recovery step ${modelCalls} capability`);
    modelCalls += 1;
    response.setHeader('Content-Type', 'application/json');
    const proposal = capability.capabilityId === 'repo.apply-patch' ? patchProposal : undefined;
    response.end(JSON.stringify({
      id: 'repo-write-recovery-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({
        token: capability.token,
        ...(proposal === undefined ? {} : { proposal }),
      }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const environment = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-write-recovery-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-write-recovery-local-model',
  };
  const offlineEnvironment = { ...environment };
  delete offlineEnvironment.YI_AGENT_API_KEY;
  delete offlineEnvironment.ZAI_API_KEY;
  delete offlineEnvironment.YI_AGENT_MODEL;
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [
      ADAPTER, repository, 'src/math.mjs', 'test/math.test.mjs', patchSpecPath,
      nonceJournalPath, '--drop-patch-response',
    ],
    adapterId: 'repo-writable-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }), 'utf8');

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-write-recovery-seed',
      '--adapter', adapterConfig, '--json',
    ], environment);
    assert.equal(init.code, 0, JSON.stringify(init));

    const prepared = await invoke([
      'agent', 'run', '--lab', lab, '--steps', '2', '--scenario', 'working-tree',
      '--adapter', adapterConfig, '--goal', '修复加法并用测试验证', '--json',
    ], environment);
    assert.equal(prepared.code, 0, JSON.stringify(prepared));
    assert.equal(modelCalls, 2);
    const lost = await invoke([
      'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '1',
      '--scenario', 'working-tree', '--adapter', adapterConfig,
      '--goal', '修复加法并用测试验证', '--json',
    ], environment);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    assert.equal(modelCalls, 3);
    assert.equal(await readFile(sourcePath, 'utf8'), fixedSource);
    const preparedRecord = JSON.parse((await readFile(nonceJournalPath, 'utf8')).trim().split(/\r?\n/u)[0]);
    const recoveryStore = await LabStore.open({ labPath: lab });
    const unresolved = await recoveryStore.findUnresolvedExternalTransition();
    assert.deepEqual(unresolved.evidence.policyEvidence.proposal, patchProposal);
    assert.equal(preparedRecord.patchDigest, canonicalDigest(patchProposal));
    assert.equal(preparedRecord.requestDigest, canonicalDigest({
      schemaVersion: 1,
      token: unresolved.evidence.token,
      basedOnVersion: unresolved.evidence.basedOnVersion,
      policyVersion: recoveryStore.manifest.authorityPolicy.policyVersion,
      constraintsDigest: recoveryStore.manifest.authorityPolicy.constraintsDigest,
      executionNonce: unresolved.evidence.executionNonce,
      proposal: patchProposal,
    }));

    const resumed = await invoke([
      'agent', 'loop', '--lab', lab, '--resume', '--adapter', adapterConfig, '--json',
    ], offlineEnvironment);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0].data.status, 'COMPLETED');
    assert.equal(resumed.stdout[0].data.runs, 1);
    assert.equal(modelCalls, 3, 'retry must use persisted intent instead of calling the model');
    assert.equal(await readFile(sourcePath, 'utf8'), fixedSource);
    const nonceJournal = (await readFile(nonceJournalPath, 'utf8'))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(nonceJournal.length, 2);
    assert.equal(nonceJournal[0].status, 'PREPARED');
    assert.equal(nonceJournal[1].status, 'APPLIED');
    const inspection = await invoke(['inspect', '--lab', lab, '--adapter', adapterConfig, '--json']);
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    assert.equal(inspection.stdout[0].data.current.kernelStep, 3);
    for (const runId of await listRunIds(lab)) {
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('repo WorldPort survives a process restart, resumes the remaining Run, and replays both Runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-restart-e2e-'));
  let releasePending = () => {};
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    requestCount += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const tokens = [...new Set(body.messages[0].content.match(/tok_[A-Z0-9]{8,128}/gu) ?? [])];
    assert.ok(tokens.length >= 2, 'the restart decision context must expose both repo capabilities');
    if (requestCount === 2 && !server.released) {
      await new Promise((resolve) => { releasePending = () => { server.released = true; resolve(); }; });
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'repo-restart-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token: tokens[requestCount === 1 ? 0 : 1] }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const environment = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-restart-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-restart-local-model',
  };
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const beforeReadme = await readFile(path.join(REPOSITORY_ROOT, READ_PATH));
  const sentinel = path.join(REPOSITORY_ROOT, '.repo-world-write-sentinel');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, REPOSITORY_ROOT, READ_PATH, TEST_PATH],
    adapterId: 'repo-readonly-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }));

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-restart-seed',
      '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(init.code, 0, JSON.stringify(init));

    const child = spawn(process.execPath, [
      CLI, 'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2',
      '--scenario', 'working-tree', '--adapter', adapterConfig,
      '--goal', '先读取仓库，再验证测试', '--json',
    ], { env: environment, windowsHide: true });
    const childClosed = invokeChildClose(child);
    try {
      await waitFor(async () => requestCount >= 2 && (await inspectKernelStep(lab, adapterConfig)) === 1, 10_000);
    } catch (error) {
      child.kill();
      const diagnostic = await childClosed;
      error.message += `; requests=${requestCount}; child=${JSON.stringify(diagnostic)}`;
      throw error;
    }
    assert.equal(child.kill(), true);
    releasePending();
    const killed = await childClosed;
    assert.notEqual(killed.code, 0, 'the interrupted repo loop must not report success');

    const recovered = await invoke(['recover', '--lab', lab, '--confirm-lock-owner-dead', '--json']);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    assert.equal(recovered.stdout[0].data.current.kernelStep, 1);

    const resumed = await invoke([
      'agent', 'loop', '--lab', lab, '--resume', '--adapter', adapterConfig, '--json',
    ], environment);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0].data.status, 'COMPLETED');
    assert.equal(resumed.stdout[0].data.runs, 1);
    assert.equal(await inspectKernelStep(lab, adapterConfig), 2);

    const inspection = await invoke(['inspect', '--lab', lab, '--adapter', adapterConfig, '--json']);
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    assert.equal(inspection.stdout[0].data.current.worldState.lastAction, 'repo.run-tests');
    assert.equal(inspection.stdout[0].data.current.worldState.lastTestStatus, 'PASS');
    for (const runId of await listRunIds(lab)) {
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
    assert.deepEqual(await readFile(path.join(REPOSITORY_ROOT, READ_PATH)), beforeReadme);
    await assert.rejects(access(sentinel));
  } finally {
    server.released = true;
    releasePending();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a current-state repo policy enables a history-guided repair across Runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-history-repair-e2e-'));
  const repository = path.join(root, 'repository');
  const sourcePath = path.join(repository, 'src', 'math.mjs');
  const testPath = path.join(repository, 'test', 'math.test.mjs');
  const patchSpecPath = path.join(root, 'patch.json');
  const nonceJournalPath = path.join(root, 'patch-nonces.json');
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const buggySource = 'export function add(left, right) { return left - right; }\n';
  const wrongSource = 'export function add(left, right) { return left * right; }\n';
  const fixedSource = 'export function add(left, right) { return left + right; }\n';
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(testPath), { recursive: true });
  await writeFile(sourcePath, buggySource, 'utf8');
  await writeFile(testPath, [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { add } from '../src/math.mjs';",
    "test('add returns the sum', () => assert.equal(add(2, 3), 5));",
    '',
  ].join('\n'), 'utf8');
  await writeFile(patchSpecPath, JSON.stringify({
    schemaVersion: 1,
    targetPath: 'src/math.mjs',
    expectedBeforeDigest: canonicalDigest({ content: buggySource }),
    beforeDigestMode: 'current',
  }), 'utf8');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, repository, 'src/math.mjs', 'test/math.test.mjs', patchSpecPath, nonceJournalPath],
    adapterId: 'repo-writable-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }), 'utf8');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = JSON.parse(body.messages[0].content.split('\n').at(-1));
    const step = requests.length % 4;
    const capability = context.capabilities.find((item) => item.capabilityId === [
      'repo.read-file', 'repo.run-tests', 'repo.apply-patch', 'repo.run-tests',
    ][step]);
    assert.ok(capability, `missing repo capability at step ${step}`);
    requests.push(context);
    const hasFailedProposal = context.candidateHistory.some((entry) =>
      entry.proposal?.replacement === wrongSource && entry.candidateOutcome.verification?.attribution === 'ACTION');
    const policy = context.observationEvidence.find((item) => item.kind === 'repo-patch-policy');
    const proposal = capability.capabilityId === 'repo.apply-patch'
      ? {
          schemaVersion: 1,
          targetPath: policy.targetPath,
          expectedBeforeDigest: policy.expectedBeforeDigest,
          replacement: hasFailedProposal ? fixedSource : wrongSource,
        }
      : undefined;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'repo-history-repair-agent',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({
        token: capability.token,
        ...(proposal === undefined ? {} : { proposal }),
      }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-history-repair-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-history-repair-model',
  };
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'repo', '--seed', 'repo-history-repair-seed', '--adapter', adapterConfig, '--json'], env);
    assert.equal(init.code, 0, JSON.stringify(init));
    const first = await invoke([
      'agent', 'run', '--lab', lab, '--steps', '4', '--scenario', 'working-tree',
      '--adapter', adapterConfig, '--goal', '先尝试修复并验证', '--json',
    ], env);
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.equal(await readFile(sourcePath, 'utf8'), wrongSource);
    const second = await invoke([
      'agent', 'run', '--lab', lab, '--steps', '4', '--scenario', 'working-tree',
      '--adapter', adapterConfig, '--goal', '先尝试修复并验证', '--json',
    ], env);
    assert.equal(second.code, 0, JSON.stringify(second));
    assert.equal(await readFile(sourcePath, 'utf8'), fixedSource);
    assert.equal(requests.length, 8);
    assert.equal(requests[0].candidateHistory.length, 0);
    assert.ok(requests[4].candidateHistory.some((entry) => entry.proposal?.replacement === wrongSource));
    assert.ok(requests[6].candidateHistory.some((entry) => entry.proposal?.replacement === wrongSource));
    const store = await LabStore.open({ labPath: lab });
    const firstEvents = (await store.readRun(first.stdout[0].data.runId)).events;
    const secondEvents = (await store.readRun(second.stdout[0].data.runId)).events;
    assert.ok(firstEvents.some((event) => event.kind === 'STEP' && event.payload.policyEvidence?.proposal?.replacement === wrongSource));
    assert.ok(secondEvents.some((event) => event.kind === 'STEP' && event.payload.policyEvidence?.proposal?.replacement === fixedSource));
    for (const runId of [first.stdout[0].data.runId, second.stdout[0].data.runId]) {
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json'], env);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: parseJsonLines(stdout), stderr }));
  });
}

function invokeAdapterOnce(args, op, payload) {
  const request = { protocol: 'yi-world-cli', version: 1, id: 'boundary-test', op, payload };
  const result = spawnSync(process.execPath, args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1, result.stdout);
  return JSON.parse(lines[0]);
}

function invokeChildClose(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function inspectKernelStep(lab, adapterConfig = null) {
  const inspection = await invoke([
    'inspect', '--lab', lab, '--json',
    ...(adapterConfig === null ? [] : ['--adapter', adapterConfig]),
  ]);
  return inspection.stdout[0]?.data?.current?.kernelStep ?? null;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function listRunIds(lab) {
  return (await readdir(path.join(lab, 'runs'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseJsonLines(value) {
  return value.trim().length === 0 ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}
