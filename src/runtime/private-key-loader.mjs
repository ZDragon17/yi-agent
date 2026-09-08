import { createPrivateKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export function loadPkcs8DerPrivateKey(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('private-key-der must be an absolute path.');
  }
  let status;
  let bytes;
  try {
    status = lstatSync(filePath);
    if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_PRIVATE_KEY_BYTES) {
      throw new Error('private-key-der must be a regular file no larger than 64 KiB.');
    }
    bytes = readFileSync(filePath);
    const afterRead = lstatSync(filePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || bytes.length > MAX_PRIVATE_KEY_BYTES) {
      throw new Error('private-key-der must be a regular file no larger than 64 KiB.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'private-key-der must be a regular file no larger than 64 KiB.') throw error;
    throw new Error('private-key-der could not be read.');
  }
  try {
    return createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('private-key-der is not a valid PKCS#8 DER private key.');
  }
}

export function loadBoundedSecret(filePath, label = 'secret') {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  let status;
  let bytes;
  try {
    status = lstatSync(filePath);
    if (status.isSymbolicLink() || !status.isFile() || status.size === 0 || status.size > MAX_PRIVATE_KEY_BYTES) {
      throw new Error(`${label} must be a non-empty regular file no larger than 64 KiB.`);
    }
    bytes = readFileSync(filePath);
    const afterRead = lstatSync(filePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || bytes.length === 0 || bytes.length > MAX_PRIVATE_KEY_BYTES) {
      throw new Error(`${label} must be a non-empty regular file no larger than 64 KiB.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a non-empty regular file no larger than 64 KiB.`) throw error;
    throw new Error(`${label} could not be read.`);
  }
  return bytes.toString('utf8');
}
