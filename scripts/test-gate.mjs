#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:mjs|cjs|js)$/i;

if (isMainModule()) {
  process.exit(await main());
}

export default async function* actualCaseReporter(source) {
  const files = new Map();

  for await (const event of source) {
    const data = event?.data;

    if (!isActualTestCompletion(event)) {
      continue;
    }

    const filePath = path.resolve(completionEntryFile(data));
    const counts = files.get(filePath) ?? {
      path: filePath,
      actual: 0,
      passed: 0,
      failed: 0,
    };

    if (!data.skip && !data.todo) {
      counts.actual += 1;

      if (event.type === 'test:pass') {
        counts.passed += 1;
      }

      if (event.type === 'test:fail') {
        counts.failed += 1;
      }
    }

    files.set(filePath, counts);
  }

  yield `${JSON.stringify({
    schemaVersion: 1,
    files: Array.from(files.values()).sort((left, right) =>
      compareText(left.path, right.path),
    ),
  })}\n`;
}

async function main() {
  const scopes = process.argv.slice(2);

  if (scopes.length === 0) {
    fail('Usage: node scripts/test-gate.mjs <scope> [...]');
  }

  const testFiles = uniqueSorted(await collectAllTestFiles(scopes));

  if (testFiles.length === 0) {
    fail('No test files found.');
  }

  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'yi-agent-test-gate-'));
  const summaryPath = path.join(tempDirectory, 'actual-cases.jsonl');

  try {
    const result = await runNodeTest(testFiles, summaryPath);
    const summary = await readActualCaseSummary(summaryPath);

    if (result.signal) {
      console.error(`[test-gate] node:test terminated by signal ${result.signal}.`);
      return 1;
    }

    if (!summary) {
      if (result.code === 0) {
        console.error('[test-gate] node:test did not report actual test cases.');
        return 1;
      }

      return result.code ?? 1;
    }

    const filesWithoutCases = findFilesWithoutActualCases(testFiles, summary);
    const totalActual = summary.files.reduce(
      (total, file) => total + file.actual,
      0,
    );
    const totalPassed = summary.files.reduce(
      (total, file) => total + file.passed,
      0,
    );

    if ((result.code ?? 1) === 0) {
      if (totalActual === 0) {
        console.error('[test-gate] node:test executed 0 actual test cases.');
        return 1;
      }

      if (filesWithoutCases.length > 0) {
        console.error(
          `[test-gate] Test files without actual cases: ${filesWithoutCases.join(', ')}`,
        );
        return 1;
      }

      if (totalPassed === 0) {
        console.error('[test-gate] node:test completed without a passing test case.');
        return 1;
      }
    }

    return result.code ?? 1;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function collectAllTestFiles(inputScopes) {
  const files = [];

  for (const scope of inputScopes) {
    const resolved = path.resolve(scope);
    let entry;

    try {
      entry = await stat(resolved);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(`Scope does not exist: ${scope}`);
      }
      throw error;
    }

    if (entry.isFile()) {
      files.push(resolved);
      continue;
    }

    if (entry.isDirectory()) {
      const found = await collectDirectoryTestFiles(resolved);

      if (found.length === 0) {
        fail(`No test files found under scope: ${scope}`);
      }

      files.push(...found);
      continue;
    }

    fail(`Scope is not a file or directory: ${scope}`);
  }

  return files;
}

async function collectDirectoryTestFiles(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });

  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const childPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await collectDirectoryTestFiles(childPath)));
      continue;
    }

    if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      found.push(childPath);
    }
  }

  return found;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort(compareText);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function runNodeTest(files, summaryPath) {
  const reporterUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
        `--test-reporter=${reporterUrl}`,
        '--test-reporter-destination=stdout',
        `--test-reporter-destination=${summaryPath}`,
        ...files,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

async function readActualCaseSummary(summaryPath) {
  let content;

  try {
    content = await readFile(summaryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const lines = content.trim().split(/\r?\n/).filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return JSON.parse(lines.at(-1));
}

function findFilesWithoutActualCases(testFiles, summary) {
  const actualCountsByPath = new Map(
    summary.files.map((file) => [normalizeForCompare(file.path), file.actual]),
  );

  return testFiles
    .filter((file) => (actualCountsByPath.get(normalizeForCompare(file)) ?? 0) === 0)
    .map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/'));
}

function isActualTestCompletion(event) {
  const data = event?.data;

  return (
    (event?.type === 'test:pass' || event?.type === 'test:fail') &&
    typeof completionEntryFile(data) === 'string' &&
    data?.details?.type === 'test'
  );
}

// node:test 事件在 Node 26 用 entryFile 标注来源文件，Node 22-24 只有 file；
// 两者都缺失时仍按零用例 fail-closed，不放松 T-0 门禁。
function completionEntryFile(data) {
  return data?.entryFile ?? data?.file;
}

function isMainModule() {
  return (
    typeof process.argv[1] === 'string' &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  );
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fail(message) {
  console.error(`[test-gate] ${message}`);
  process.exit(1);
}
