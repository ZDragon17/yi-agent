#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const root = await realpath(process.cwd());
const scopes = process.argv.slice(2);

if (scopes.length === 0) {
  fail('Usage: node scripts/source-manifest.mjs <scope> [...]');
}

const filesByPath = new Map();
const seenDirectories = new Set();

for (const scope of scopes) {
  const resolved = path.resolve(root, scope);
  assertInsideRoot(resolved, scope);
  await collectFiles(resolved, scope);
}

const entries = [];

for (const [relativePath, absolutePath] of filesByPath) {
  entries.push({
    path: relativePath,
    sha256: await sha256File(absolutePath),
  });
}

entries.sort((left, right) => compareText(left.path, right.path));

for (const entry of entries) {
  process.stdout.write(`${entry.path}\t${entry.sha256}\n`);
}

async function collectFiles(candidatePath, displayPath) {
  let linkStatus;

  try {
    linkStatus = await lstat(candidatePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`Scope does not exist: ${displayPath}`);
    }
    throw error;
  }

  const realCandidate = await realpath(candidatePath);
  assertInsideRoot(realCandidate, displayPath);

  const entryStatus = linkStatus.isSymbolicLink()
    ? await stat(candidatePath)
    : linkStatus;

  if (entryStatus.isDirectory()) {
    const directoryKey = normalizeForCompare(realCandidate);

    if (seenDirectories.has(directoryKey)) {
      return;
    }

    seenDirectories.add(directoryKey);

    const entries = await readdir(candidatePath, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      await collectFiles(
        path.join(candidatePath, entry.name),
        path.join(displayPath, entry.name),
      );
    }

    return;
  }

  if (entryStatus.isFile()) {
    const relativePath = toManifestPath(candidatePath);
    filesByPath.set(relativePath, candidatePath);
    return;
  }

  fail(`Scope entry is not a regular file or directory: ${displayPath}`);
}

function toManifestPath(absolutePath) {
  const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');

  if (
    relativePath === '' ||
    relativePath.includes('\n') ||
    relativePath.includes('\r') ||
    relativePath.includes('\t')
  ) {
    fail(`Path cannot be represented in manifest: ${absolutePath}`);
  }

  return relativePath;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

function assertInsideRoot(candidatePath, displayPath) {
  const relativePath = path.relative(
    normalizeForCompare(root),
    normalizeForCompare(candidatePath),
  );

  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    fail(`Scope escapes workspace root: ${displayPath}`);
  }
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  console.error(`[source-manifest] ${message}`);
  process.exit(1);
}
