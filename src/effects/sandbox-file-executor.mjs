import { lstat, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest } from '../runtime/schema.mjs';

export const SANDBOX_MARKER = '.yi-agent-sandbox';
const SANDBOX_MARKER_CONTENT = 'yi-agent-sandbox-v1\n';

export class SandboxFileExecutorError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'SandboxFileExecutorError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function createSandboxFileExecutor({ sandboxRoot }) {
  if (typeof sandboxRoot !== 'string' || !path.isAbsolute(sandboxRoot)) {
    throw new SandboxFileExecutorError('INVALID_INPUT', 'Sandbox root must be an absolute path.', { field: 'sandboxRoot' });
  }
  const root = path.normalize(sandboxRoot);

  return Object.freeze({
    async execute(intent) {
      const paths = await resolveMove(intent, root);
      const source = await safeStat(root, paths.source);
      const destination = await safeStat(root, paths.destination);
      if (source?.isSymbolicLink() || destination?.isSymbolicLink()) return rejected('SYMLINK_NOT_ALLOWED');
      if (source?.isFile() && destination === null) {
        await rename(paths.source, paths.destination);
        return appliedReceipt(intent, paths, 'destination-present');
      }
      if (source === null && destination?.isFile()) return appliedReceipt(intent, paths, 'destination-present');
      if (source === null && destination === null) return rejected('SOURCE_NOT_FOUND');
      return rejected(source?.isDirectory() || destination?.isDirectory() ? 'FILE_ONLY' : 'DESTINATION_EXISTS');
    },

    async reconcile(intent) {
      const paths = await resolveMove(intent, root);
      const source = await safeStat(root, paths.source);
      const destination = await safeStat(root, paths.destination);
      if (source?.isFile() && destination === null) return { status: 'ABSENT' };
      if (source === null && destination?.isFile()) return appliedReceipt(intent, paths, 'destination-present');
      return { status: 'UNKNOWN' };
    },

    async compensate(intent) {
      const paths = await resolveMove(intent, root);
      const source = await safeStat(root, paths.source);
      const destination = await safeStat(root, paths.destination);
      if (source?.isSymbolicLink() || destination?.isSymbolicLink()) return { status: 'UNKNOWN' };
      if (source?.isFile() && destination === null) return reversedReceipt(intent, paths);
      if (source === null && destination?.isFile()) {
        await rename(paths.destination, paths.source);
        return reversedReceipt(intent, paths);
      }
      return { status: 'UNKNOWN' };
    },

    async reconcileCompensation(intent) {
      const paths = await resolveMove(intent, root);
      const source = await safeStat(root, paths.source);
      const destination = await safeStat(root, paths.destination);
      if (source?.isFile() && destination === null) return reversedReceipt(intent, paths);
      if (source === null && destination?.isFile()) return { status: 'NOT_REVERSED' };
      return { status: 'UNKNOWN' };
    },
  });
}

export async function assertSandboxRoot(sandboxRoot) {
  if (typeof sandboxRoot !== 'string' || !path.isAbsolute(sandboxRoot)) {
    throw new SandboxFileExecutorError('INVALID_INPUT', 'Sandbox root must be an absolute path.', { field: 'sandboxRoot' });
  }
  const root = path.normalize(sandboxRoot);
  const rootStatus = await lstat(root);
  const markerPath = path.join(root, SANDBOX_MARKER);
  const markerStatus = await lstat(markerPath);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory() || markerStatus.isSymbolicLink() ||
      !markerStatus.isFile() || await readFile(markerPath, 'utf8') !== SANDBOX_MARKER_CONTENT) {
    throw new SandboxFileExecutorError('UNSAFE_PATH', 'Sandbox root is not explicitly marked.', { path: root });
  }
  return root;
}

async function resolveMove(intent, root) {
  if (!intent || typeof intent !== 'object' || !isPlainObject(intent.target) ||
      Object.keys(intent.target).length !== 3 || intent.target.operation !== 'move' ||
      !relativePath(intent.target.from) || !relativePath(intent.target.to)) {
    throw new SandboxFileExecutorError('INVALID_INPUT', 'Sandbox file executor only accepts a relative move target.');
  }
  const source = resolveInside(root, intent.target.from);
  const destination = resolveInside(root, intent.target.to);
  if (samePath(source, destination) || samePath(source, path.join(root, SANDBOX_MARKER)) ||
      samePath(destination, path.join(root, SANDBOX_MARKER))) {
    throw new SandboxFileExecutorError('INVALID_INPUT', 'Sandbox move source and destination must differ.');
  }
  return { source, destination };
}

function resolveInside(root, relative) {
  const resolved = path.resolve(root, relative);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot === '' || relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new SandboxFileExecutorError('INVALID_INPUT', 'Sandbox file path escapes sandboxRoot.', { path: relative });
  }
  return resolved;
}

async function safeStat(root, absolutePath) {
  await assertSandboxRoot(root);
  const relative = path.relative(root, absolutePath);
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let status;
    try {
      status = await lstat(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new SandboxFileExecutorError('UNSAFE_PATH', 'Sandbox path contains a symbolic link.', { path: cursor });
    }
    if (cursor !== absolutePath && !status.isDirectory()) return null;
  }
  return lstat(absolutePath);
}

function appliedReceipt(intent, paths, state) {
  return {
    status: 'APPLIED',
    effectDigest: canonicalDigest({ effectId: intent.effectId, from: paths.source, to: paths.destination, state }),
  };
}

function reversedReceipt(intent, paths) {
  return {
    status: 'REVERSED',
    effectDigest: canonicalDigest({ effectId: intent.effectId, from: paths.source, to: paths.destination, state: 'source-present' }),
  };
}

function rejected(reason) {
  return { status: 'REJECTED', effectDigest: canonicalDigest({ status: 'REJECTED', reason }), rejectionReason: reason };
}

function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.includes('\0') && !/^[a-zA-Z]:/u.test(value) && !path.isAbsolute(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
