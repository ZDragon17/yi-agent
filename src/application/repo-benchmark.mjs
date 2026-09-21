import { canonicalDigest } from '../runtime/schema.mjs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TASKS = 32;
const MAX_FILES_PER_TASK = 64;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TASK_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_ID_LENGTH = 64;
const MAX_STEPS = 24;
const MAX_TEST_EXECUTIONS = 4;
const CLI = fileURLToPath(new URL('../../bin/yi-agent.mjs', import.meta.url));
const REPO_ADAPTER = fileURLToPath(new URL('../../examples/repo-world/adapter.mjs', import.meta.url));

export async function runRepoBenchmark(input) {
  const source = requireRecord(input, 'repo benchmark input');
  const manifestPath = requireAbsolutePath(source.manifestPath, 'manifestPath');
  const outputPath = requireAbsolutePath(source.outputPath, 'outputPath');
  const modelAdapterPath = source.modelAdapterPath === undefined || source.modelAdapterPath === null
    ? null
    : requireAbsolutePath(source.modelAdapterPath, 'modelAdapterPath');
  const manifest = await readManifest(manifestPath);
  const selectedTasks = source.taskId === undefined
    ? manifest.tasks
    : manifest.tasks.filter((task) => task.id === source.taskId);
  if (selectedTasks.length === 0) {
    throw benchmarkError('INVALID_INPUT', 'No benchmark task matched --task.', { field: 'task', taskId: source.taskId });
  }

  const manifestDigest = canonicalDigest(manifest);
  const reportPath = path.join(outputPath, 'report.json');
  let report;
  if (source.resume === true) {
    report = await readCheckpoint(outputPath, manifest, manifestDigest);
  } else {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await createOutputDirectory(outputPath);
    await writeJson(path.join(outputPath, 'manifest.json'), manifest);
    report = {
      schemaVersion: 1,
      type: 'repo-benchmark-report',
      status: 'RUNNING',
      manifestDigest,
      taskResults: [],
    };
    await writeJson(reportPath, report);
  }

  for (const task of selectedTasks) {
    const previous = report.taskResults.find((item) => item.id === task.id);
    if (previous?.status === 'PASS' && await verifyCompletedTask(task, previous, outputPath)) continue;
    const taskRoot = await nextTaskRoot(outputPath, task.id);
    const result = await runTask({ task, taskRoot, modelAdapterPath });
    report = {
      ...report,
      status: 'RUNNING',
      taskResults: replaceTaskResult(report.taskResults, result),
    };
    await writeJson(reportPath, report);
  }

  const resultById = new Map(report.taskResults.map((item) => [item.id, item]));
  const finalReport = {
    schemaVersion: 1,
    type: 'repo-benchmark-report',
    status: selectedTasks.every((task) => resultById.get(task.id)?.status === 'PASS') ? 'PASS' : 'FAIL',
    manifestDigest,
    taskResults: report.taskResults,
  };
  await writeJson(reportPath, finalReport);
  return finalReport;
}

async function runTask({ task, taskRoot, modelAdapterPath }) {
  const repositoryPath = path.join(taskRoot, 'repository');
  const labPath = path.join(taskRoot, 'lab');
  const adapterConfigPath = path.join(taskRoot, 'adapter.json');
  const patchSpecPath = path.join(taskRoot, 'patch.json');
  const nonceJournalPath = path.join(taskRoot, 'patch-nonces.json');
  const result = {
    id: task.id,
    taskDigest: canonicalDigest(task),
    status: 'FAIL',
    repositoryPath,
    labPath,
    runId: null,
    replayVerdict: null,
    acceptance: { passed: false, files: [], lastTestStatus: null },
    failure: null,
  };
  try {
    await materializeTask(task, repositoryPath);
    await writeJson(patchSpecPath, {
      schemaVersion: 1,
      allowedPaths: task.patch.allowedPaths,
    });
    await writeJson(adapterConfigPath, {
      executable: process.execPath,
      args: [
        REPO_ADAPTER,
        repositoryPath,
        task.readPath,
        task.testPath,
        patchSpecPath,
        nonceJournalPath,
        '--discover',
        '--max-tests',
        String(task.maxTests),
      ],
      adapterId: 'repo-writable-example-v1',
      worldId: 'repo',
      timeoutMs: 30000,
    });

    const init = await runCli([
      'init', '--lab', labPath, '--world', 'repo', '--seed', task.seed,
      '--adapter', adapterConfigPath, '--json',
    ]);
    if (init.code !== 0) throw commandFailure('init', init);

    const runArgs = [
      'agent', 'run', '--lab', labPath, '--steps', String(task.steps),
      '--scenario', 'working-tree', '--adapter', adapterConfigPath,
      ...(modelAdapterPath === null ? [] : ['--model-adapter', modelAdapterPath]),
      '--goal', task.goal, '--json',
    ];
    const run = await runCli(runArgs);
    result.runId = run.stdout[0]?.data?.runId ?? null;
    const inspection = await runCli([
      'inspect', '--lab', labPath, '--adapter', adapterConfigPath, '--json',
    ]);
    if (inspection.code === 0) {
      result.acceptance = await evaluateAcceptance(task, repositoryPath, inspection.stdout[0]?.data?.current);
    }
    if (result.runId !== null) {
      const replay = await runCli([
        'replay', '--lab', labPath, '--run', result.runId,
        '--adapter', adapterConfigPath, '--json',
      ]);
      result.replayVerdict = replay.stdout[0]?.data?.verdict ?? null;
      if (replay.code !== 0) throw commandFailure('replay', replay);
    }
    if (run.code !== 0) throw commandFailure('agent run', run);
    if (!result.acceptance.passed) {
      throw benchmarkError('BENCHMARK_FAILED', 'Task acceptance did not pass.', {
        taskId: task.id,
        acceptance: result.acceptance,
      });
    }
    if (result.replayVerdict !== 'CONSISTENT') {
      throw benchmarkError('BENCHMARK_FAILED', 'Task replay was not consistent.', {
        taskId: task.id,
        replayVerdict: result.replayVerdict,
      });
    }
    result.status = 'PASS';
  } catch (error) {
    result.failure = {
      code: error?.code ?? 'INTERNAL',
      message: error?.message ?? 'Benchmark task failed.',
      context: error?.context ?? {},
    };
  }
  return result;
}

async function verifyCompletedTask(task, result, outputPath) {
  try {
    if (result.taskDigest !== canonicalDigest(task) || result.runId === null || result.replayVerdict !== 'CONSISTENT' ||
        typeof result.repositoryPath !== 'string' || typeof result.labPath !== 'string') return false;
    const repositoryPath = path.resolve(result.repositoryPath);
    const labPath = path.resolve(result.labPath);
    assertInside(outputPath, repositoryPath, 'checkpoint repository');
    assertInside(outputPath, labPath, 'checkpoint lab');
    const taskRoot = path.dirname(repositoryPath);
    const adapterConfigPath = path.join(taskRoot, 'adapter.json');
    const inspection = await runCli(['inspect', '--lab', labPath, '--adapter', adapterConfigPath, '--json']);
    if (inspection.code !== 0) return false;
    const acceptance = await evaluateAcceptance(task, repositoryPath, inspection.stdout[0]?.data?.current);
    if (!acceptance.passed) return false;
    const replay = await runCli([
      'replay', '--lab', labPath, '--run', result.runId,
      '--adapter', adapterConfigPath, '--json',
    ]);
    return replay.code === 0 && replay.stdout[0]?.data?.verdict === 'CONSISTENT';
  } catch {
    return false;
  }
}

async function nextTaskRoot(outputPath, taskId) {
  const base = path.join(outputPath, 'tasks', taskId);
  if (!await pathExists(base)) return base;
  for (let attempt = 2; attempt <= 64; attempt += 1) {
    const candidate = path.join(outputPath, 'tasks', `${taskId}-attempt-${attempt}`);
    if (!await pathExists(candidate)) return candidate;
  }
  throw benchmarkError('CONFLICT', 'Benchmark task exceeded the bounded attempt count.', { taskId });
}

function replaceTaskResult(results, result) {
  const next = results.filter((item) => item.id !== result.id);
  next.push(result);
  return next;
}

async function readCheckpoint(outputPath, manifest, manifestDigest) {
  const outputStatus = await stat(outputPath).catch(() => null);
  if (outputStatus === null || !outputStatus.isDirectory()) {
    throw benchmarkError('NOT_FOUND', 'Benchmark output directory does not exist for --resume.', { outputPath });
  }
  const storedManifest = await readManifest(path.join(outputPath, 'manifest.json'));
  if (canonicalDigest(storedManifest) !== manifestDigest) {
    throw benchmarkError('CONFLICT', 'Benchmark resume manifest does not match the requested manifest.', { outputPath });
  }
  let report;
  try {
    report = JSON.parse(await readFile(path.join(outputPath, 'report.json'), 'utf8'));
  } catch (error) {
    throw benchmarkError(error?.code ?? 'INVALID_INPUT', 'Benchmark checkpoint report could not be read.', { outputPath });
  }
  requireRecord(report, 'benchmark checkpoint report');
  if (report.schemaVersion !== 1 || report.type !== 'repo-benchmark-report' || report.manifestDigest !== manifestDigest ||
      !['RUNNING', 'FAIL', 'PASS'].includes(report.status) || !Array.isArray(report.taskResults)) {
    throw benchmarkError('CONFLICT', 'Benchmark checkpoint report is incompatible with the requested manifest.', { outputPath });
  }
  return report;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function evaluateAcceptance(task, repositoryPath, current) {
  const fileResults = [];
  let passed = true;
  for (const [relativePath, expected] of Object.entries(task.expected.files)) {
    const actual = await readFile(path.join(repositoryPath, relativePath), 'utf8').catch(() => null);
    const matches = actual === expected;
    fileResults.push({ path: relativePath, matches });
    passed = passed && matches;
  }
  const lastTestStatus = current?.worldState?.lastTestStatus ?? null;
  if (task.expected.lastTestStatus !== undefined) passed = passed && lastTestStatus === task.expected.lastTestStatus;
  return { passed, files: fileResults, lastTestStatus };
}

async function materializeTask(task, repositoryPath) {
  await mkdir(repositoryPath, { recursive: true });
  for (const file of task.files) {
    const target = path.resolve(repositoryPath, ...file.path.split('/'));
    assertInside(repositoryPath, target, 'task file');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
}

async function readManifest(manifestPath) {
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    throw benchmarkError(error?.code ?? 'EIO', 'Benchmark manifest could not be read.', { filePath: manifestPath });
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw benchmarkError('INVALID_INPUT', 'Benchmark manifest is not valid JSON.', { filePath: manifestPath });
  }
  return normalizeManifest(value);
}

function normalizeManifest(value) {
  requireKeys(value, ['schemaVersion', 'type', 'tasks'], 'manifest');
  if (value.schemaVersion !== 1 || value.type !== 'repo-benchmark' || !Array.isArray(value.tasks) ||
      value.tasks.length === 0 || value.tasks.length > MAX_TASKS) {
    throw benchmarkError('INVALID_INPUT', 'Benchmark manifest envelope is invalid.', {});
  }
  const ids = new Set();
  const tasks = value.tasks.map((task, index) => {
    requireKeys(task, ['id', 'goal', 'seed', 'files', 'readPath', 'testPath', 'patch', 'expected', 'steps', 'maxTests'], `tasks[${index}]`);
    const id = boundedId(task.id, `tasks[${index}].id`);
    if (ids.has(id)) throw benchmarkError('INVALID_INPUT', 'Benchmark task ids must be unique.', { field: 'tasks', id });
    ids.add(id);
    const files = normalizeFiles(task.files, index);
    const filePaths = new Set(files.map((file) => file.path));
    const readPath = taskPath(task.readPath, `tasks[${index}].readPath`);
    const testPath = taskPath(task.testPath, `tasks[${index}].testPath`);
    if (!filePaths.has(readPath) || !filePaths.has(testPath)) {
      throw benchmarkError('INVALID_INPUT', 'readPath and testPath must reference declared files.', { field: `tasks[${index}]` });
    }
    requireKeys(task.patch, ['allowedPaths'], `tasks[${index}].patch`);
    if (!Array.isArray(task.patch.allowedPaths) || task.patch.allowedPaths.length === 0 || task.patch.allowedPaths.length > MAX_FILES_PER_TASK) {
      throw benchmarkError('INVALID_INPUT', 'patch.allowedPaths must be a non-empty bounded array.', { field: `tasks[${index}].patch.allowedPaths` });
    }
    const allowedPaths = uniqueSorted(task.patch.allowedPaths.map((item) => taskPath(item, `tasks[${index}].patch.allowedPaths`)));
    if (allowedPaths.some((item) => !filePaths.has(item))) {
      throw benchmarkError('INVALID_INPUT', 'patch.allowedPaths must reference declared files.', { field: `tasks[${index}].patch.allowedPaths` });
    }
    requireKeys(task.expected, ['files', 'lastTestStatus'], `tasks[${index}].expected`);
    const expectedFiles = normalizeExpectedFiles(task.expected.files, filePaths, index);
    if (!['PASS', 'FAIL', 'NOT_RUN'].includes(task.expected.lastTestStatus)) {
      throw benchmarkError('INVALID_INPUT', 'expected.lastTestStatus is invalid.', { field: `tasks[${index}].expected.lastTestStatus` });
    }
    const steps = boundedInteger(task.steps, 1, MAX_STEPS, `tasks[${index}].steps`);
    const maxTests = boundedInteger(task.maxTests, 1, MAX_TEST_EXECUTIONS, `tasks[${index}].maxTests`);
    const seed = boundedText(task.seed, `tasks[${index}].seed`);
    const goal = boundedText(task.goal, `tasks[${index}].goal`);
    return {
      id,
      goal,
      seed,
      files,
      readPath,
      testPath,
      patch: { allowedPaths },
      expected: { files: expectedFiles, lastTestStatus: task.expected.lastTestStatus },
      steps,
      maxTests,
    };
  });
  return { schemaVersion: 1, type: 'repo-benchmark', tasks };
}

function normalizeFiles(value, taskIndex) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES_PER_TASK) {
    throw benchmarkError('INVALID_INPUT', 'files must be a non-empty bounded array.', { field: `tasks[${taskIndex}].files` });
  }
  const paths = new Set();
  let totalBytes = 0;
  const files = value.map((file, index) => {
    requireKeys(file, ['path', 'content'], `tasks[${taskIndex}].files[${index}]`);
    const normalizedPath = taskPath(file.path, `tasks[${taskIndex}].files[${index}].path`);
    if (paths.has(normalizedPath)) throw benchmarkError('INVALID_INPUT', 'Task file paths must be unique.', { field: normalizedPath });
    paths.add(normalizedPath);
    const content = boundedText(file.content, `tasks[${taskIndex}].files[${index}].content`, MAX_FILE_BYTES);
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_TASK_BYTES) throw benchmarkError('INVALID_INPUT', 'Task files exceed the bounded task size.', { field: `tasks[${taskIndex}].files` });
    return { path: normalizedPath, content };
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeExpectedFiles(value, filePaths, taskIndex) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw benchmarkError('INVALID_INPUT', 'expected.files must be an object.', { field: `tasks[${taskIndex}].expected.files` });
  }
  const result = {};
  for (const [file, content] of Object.entries(value)) {
    const normalizedPath = taskPath(file, `tasks[${taskIndex}].expected.files`);
    if (!filePaths.has(normalizedPath)) throw benchmarkError('INVALID_INPUT', 'Expected file must be declared by the task.', { field: normalizedPath });
    result[normalizedPath] = boundedText(content, `tasks[${taskIndex}].expected.files.${normalizedPath}`, MAX_FILE_BYTES);
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

async function createOutputDirectory(outputPath) {
  try {
    await mkdir(outputPath, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') throw benchmarkError('CONFLICT', 'Benchmark output directory already exists.', { outputPath });
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = [];
      try {
        parsed = stdout.trim().length === 0 ? [] : stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      } catch (error) {
        reject(benchmarkError('CLI_PROTOCOL', 'Benchmark child CLI returned invalid JSON.', { args, stdout, stderr }, error));
        return;
      }
      resolve({ code, stdout: parsed, stderr });
    });
  });
}

function commandFailure(command, result) {
  return benchmarkError('BENCHMARK_FAILED', `Benchmark command failed: ${command}.`, {
    command,
    exitCode: result.code,
    response: result.stdout[0] ?? null,
    stderr: result.stderr.slice(0, 4096),
  });
}

function assertInside(root, target, field) {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw benchmarkError('INVALID_INPUT', `${field} escapes its task repository.`, { field: target });
  }
}

function taskPath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    throw benchmarkError('INVALID_INPUT', 'Task paths must be bounded non-empty strings.', { field });
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    throw benchmarkError('INVALID_INPUT', 'Task paths must be relative.', { field });
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw benchmarkError('INVALID_INPUT', 'Task paths must not contain empty or parent segments.', { field });
  }
  return parts.join('/');
}

function boundedId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value.length > MAX_ID_LENGTH) {
    throw benchmarkError('INVALID_INPUT', 'Task id is invalid.', { field });
  }
  return value;
}

function boundedText(value, field, maxBytes = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw benchmarkError('INVALID_INPUT', 'Text field is invalid or exceeds its bound.', { field });
  }
  return value;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw benchmarkError('INVALID_INPUT', `Integer field must be between ${minimum} and ${maximum}.`, { field });
  }
  return value;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw benchmarkError('INVALID_INPUT', `${field} must be an object.`, { field });
  }
  return value;
}

function requireKeys(value, keys, field) {
  requireRecord(value, field);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw benchmarkError('INVALID_INPUT', `${field} contains an unsupported field.`, { field });
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw benchmarkError('INVALID_INPUT', `${field}.${key} is required.`, { field: `${field}.${key}` });
  }
}

function requireAbsolutePath(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw benchmarkError('INVALID_INPUT', `${field} must be an absolute path.`, { field });
  }
  return path.normalize(value);
}

function benchmarkError(code, message, context = {}, cause = undefined) {
  const error = Object.assign(new Error(message), { code, context });
  if (cause !== undefined) error.cause = cause;
  return error;
}
