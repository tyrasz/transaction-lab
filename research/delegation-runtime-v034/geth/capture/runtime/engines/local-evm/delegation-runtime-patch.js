// Explicit, byte-pinned local ESM patch. This module never patches on import.
// Install scripts are intentionally not used; apply/check are operator actions.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE = '@ethereumjs/evm', VERSION = '10.1.3';
const LOCAL_PACKAGE = fileURLToPath(new URL('./node_modules/@ethereumjs/evm/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const replacement = (before, after) => Object.freeze({ before, after });
export const DELEGATION_RUNTIME_PATCH = Object.freeze({
  package: PACKAGE, version: VERSION,
  files: Object.freeze([
    Object.freeze({ path: 'dist/esm/evm.js',
      originalSha256: 'e978f659e72aeb8ee22ebc4559bafb37e4760b0557512224f734b5b46da22f46',
      patchedSha256: 'fcc46a02ca958fcdb9a74626f532e9181165e056bef467a3ad40c631310ac440',
      replacements: Object.freeze([
        replacement('if (equalsBytes(recipientCode.slice(0, 3), DELEGATION_7702_FLAG)) {',
          'if (recipientCode.length === 23 && equalsBytes(recipientCode.slice(0, 3), DELEGATION_7702_FLAG)) {'),
        replacement('                    equalsBytes(message.code.slice(0, 3), DELEGATION_7702_FLAG)) {',
          '                    message.code.length === 23 && equalsBytes(message.code.slice(0, 3), DELEGATION_7702_FLAG)) {'),
      ]),
    }),
    Object.freeze({ path: 'dist/esm/opcodes/gas.js',
      originalSha256: '72087f58b0b78e2f5dc7fed7cfa48aeee6000c5dbff4f3d851622f40c5a900c4',
      patchedSha256: 'b014bb84c89c87a222e990ef10dffd6b91ee1eb19ab58539d2d6bc6763680970',
      replacements: Object.freeze([
        replacement('if (equalsBytes(code.slice(0, 3), DELEGATION_7702_FLAG)) {',
          'if (code.length === 23 && equalsBytes(code.slice(0, 3), DELEGATION_7702_FLAG)) {'),
      ]),
    }),
  ]),
});

function need(condition) {
  if (!condition) throw new Error('Unexpected package version, runtime bytes, or file kind.');
}
function checked(action) {
  try { return action(); }
  catch (cause) {
    const error = new Error('The pinned local EthereumJS delegation runtime is unverified.', { cause });
    error.code = 'LOCAL_EVM_RUNTIME_UNVERIFIED';
    throw error;
  }
}
function readRegular(directory, relative) {
  let current = directory;
  need(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink());
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    need(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()));
    if (index === parts.length - 1) {
      need(stat.size <= 1024 * 1024);
      return { path: current, bytes: fs.readFileSync(current), mode: stat.mode & 0o777 };
    }
  }
}
function inspect(packageDirectory) {
  need(typeof packageDirectory === 'string');
  const directory = path.resolve(packageDirectory), metadata = readRegular(directory, 'package.json');
  const pkg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.bytes));
  need(pkg.name === PACKAGE && pkg.version === VERSION);
  const files = DELEGATION_RUNTIME_PATCH.files.map(spec => {
    const file = readRegular(directory, spec.path), hash = sha(file.bytes);
    need(hash === spec.originalSha256 || hash === spec.patchedSha256);
    return { spec, ...file, hash };
  });
  return { directory, metadata, files };
}
function identity(files) {
  return Object.freeze({ package: PACKAGE, version: VERSION,
    files: Object.freeze(files.map(({ spec }) => Object.freeze({ path: spec.path, sha256: spec.patchedSha256 }))) });
}

/** Verify the expected local dependency without mutation or code evaluation.
 * The explicit directory argument permits isolated temporary-file controls;
 * execution uses the default local package path. No result is cached here. */
export function assertDelegationRuntimePatched(packageDirectory = LOCAL_PACKAGE) {
  return checked(() => {
    const { files } = inspect(packageDirectory);
    need(files.every(file => file.hash === file.spec.patchedSha256));
    return identity(files);
  });
}

/** Apply only the three declared conditions, explicitly and idempotently.
 * All input files are validated before the first write. A process interruption
 * can leave an original/patched mixture; another explicit apply completes it.
 * The read-only assertion rejects that mixture until every file is patched. */
export function applyDelegationRuntimePatch(packageDirectory = LOCAL_PACKAGE) {
  return checked(() => {
    const snapshot = inspect(packageDirectory);
    const changes = snapshot.files.filter(file => file.hash === file.spec.originalSha256).map(file => {
      let text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
      for (const { before, after } of file.spec.replacements) {
        need(text.split(before).length === 2 && !text.includes(after));
        text = text.replace(before, after);
      }
      const bytes = Buffer.from(text); need(sha(bytes) === file.spec.patchedSha256);
      return { ...file, correctedBytes: bytes };
    });
    // Recheck the complete snapshot before any writes, including package metadata.
    need(readRegular(snapshot.directory, 'package.json').bytes.equals(snapshot.metadata.bytes));
    for (const file of snapshot.files) need(readRegular(snapshot.directory, file.spec.path).bytes.equals(file.bytes));
    for (const file of changes) {
      need(readRegular(snapshot.directory, file.spec.path).bytes.equals(file.bytes));
      const temporary = file.path + '.delegation-patch-' + process.pid + '-' + randomBytes(8).toString('hex');
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', file.mode);
        fs.writeFileSync(fd, file.correctedBytes); fs.fchmodSync(fd, file.mode); fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file.path);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    const verified = assertDelegationRuntimePatched(snapshot.directory);
    return Object.freeze({ ...verified, changed: Object.freeze(changes.map(file => file.spec.path)) });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['apply', 'check'].includes(command)) {
    throw new Error('Use delegation-runtime-patch.js apply or check; only the local ESM package is selected.');
  }
  console.log(JSON.stringify(command === 'apply' ? applyDelegationRuntimePatch() : assertDelegationRuntimePatched(), null, 2));
}
