import { createSign, generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

export async function createCertificateAuthority(keyPath, certPath, commonName) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const name = derName(commonName);
  await writeCertificate(certPath, createCertificate({
    publicKey,
    issuerName: name,
    subjectName: name,
    signingKey: privateKey,
    serial: 1,
    extensions: [basicConstraints(true)],
  }));
  return { signingKey: privateKey, subjectName: name };
}

export async function makeCertificateSignedByAuthority(authority, keyPath, certPath, commonName, serial = 1) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await writeCertificate(certPath, createCertificate({
    publicKey,
    issuerName: authority.subjectName,
    subjectName: derName(commonName),
    signingKey: authority.signingKey,
    serial,
    extensions: [basicConstraints(false), extendedKeyUsage(commonName === 'localhost' ? 'server' : 'client')],
  }));
}

export async function makeCertificateRevocationList(authority, crlPath, revokedSerials) {
  const algorithm = derSequence([derOid([1, 2, 840, 113549, 1, 1, 11]), der(0x05, Buffer.alloc(0))]);
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const revokedCertificates = derSequence(revokedSerials.map((serial) => derSequence([
    derInteger(serial),
    derUtcTime(now),
  ])));
  const tbs = derSequence([
    derInteger(1),
    algorithm,
    authority.subjectName,
    derUtcTime(now),
    derUtcTime(later),
    revokedCertificates,
  ]);
  const signer = createSign('sha256');
  signer.update(tbs);
  const crl = derSequence([tbs, algorithm, derBitString(signer.sign(authority.signingKey))]);
  await writeFile(crlPath, `-----BEGIN X509 CRL-----\n${crl.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END X509 CRL-----\n`);
}

async function writeCertificate(certPath, certificate) {
  await writeFile(certPath, `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`);
}

function createCertificate({ publicKey, issuerName, subjectName, signingKey, serial, extensions }) {
  const algorithm = derSequence([derOid([1, 2, 840, 113549, 1, 1, 11]), der(0x05, Buffer.alloc(0))]);
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tbs = derSequence([
    der(0xa0, derInteger(2)),
    derInteger(serial),
    algorithm,
    issuerName,
    derSequence([derUtcTime(now), derUtcTime(later)]),
    subjectName,
    publicKey.export({ format: 'der', type: 'spki' }),
    ...(extensions.length === 0 ? [] : [der(0xa3, derSequence(extensions))]),
  ]);
  const signer = createSign('sha256');
  signer.update(tbs);
  return derSequence([tbs, algorithm, derBitString(signer.sign(signingKey))]);
}

function basicConstraints(ca) {
  return derSequence([
    derOid([2, 5, 29, 19]),
    der(0x01, Buffer.from([0xff])),
    der(0x04, derSequence([...(ca ? [der(0x01, Buffer.from([0xff]))] : [])])),
  ]);
}

function extendedKeyUsage(purpose) {
  const oid = purpose === 'server' ? [1, 3, 6, 1, 5, 5, 7, 3, 1] : [1, 3, 6, 1, 5, 5, 7, 3, 2];
  return derSequence([
    derOid([2, 5, 29, 37]),
    der(0x04, derSequence([derOid(oid)])),
  ]);
}

function derName(commonName) {
  return derSequence([
    derSet(derSequence([derOid([2, 5, 4, 3]), derString(commonName)])),
  ]);
}

function der(tag, value) {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function derSequence(items) {
  return der(0x30, Buffer.concat(items));
}

function derSet(value) {
  return der(0x31, value);
}

function derInteger(value) {
  return der(0x02, Buffer.from([value]));
}

function derString(value) {
  return der(0x0c, Buffer.from(value, 'utf8'));
}

function derUtcTime(value) {
  const text = `${String(value.getUTCFullYear()).slice(-2)}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}${String(value.getUTCHours()).padStart(2, '0')}${String(value.getUTCMinutes()).padStart(2, '0')}${String(value.getUTCSeconds()).padStart(2, '0')}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

function derBitString(value) {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function derOid(arcs) {
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f];
    let rest = arc >>> 7;
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function derLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
