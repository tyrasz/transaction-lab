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
// The filename and legacy aliases are retained for existing preparation entrypoints.
export const LOCAL_RUNTIME_PATCH = Object.freeze({
  package: PACKAGE, version: VERSION,
  patches: Object.freeze(['eip7702-exact-designation-length-v1', 'nonce-code-creation-collision-v1']),
  files: Object.freeze([
    Object.freeze({ path: 'dist/esm/evm.js',
      originalSha256: 'e978f659e72aeb8ee22ebc4559bafb37e4760b0557512224f734b5b46da22f46',
      previousSha256: 'fcc46a02ca958fcdb9a74626f532e9181165e056bef467a3ad40c631310ac440',
      previousReplacementCount: 2,
      patchedSha256: 'cbe4513aa0b6b82f873582ffbed4338a756ad2587523927f730de34a23b3558f',
      replacements: Object.freeze([
        replacement('if (equalsBytes(recipientCode.slice(0, 3), DELEGATION_7702_FLAG)) {',
          'if (recipientCode.length === 23 && equalsBytes(recipientCode.slice(0, 3), DELEGATION_7702_FLAG)) {'),
        replacement('                    equalsBytes(message.code.slice(0, 3), DELEGATION_7702_FLAG)) {',
          '                    message.code.length === 23 && equalsBytes(message.code.slice(0, 3), DELEGATION_7702_FLAG)) {'),
        replacement([
          '        if ((toAccount.nonce && toAccount.nonce > BIGINT_0) ||',
          '            !(equalsBytes(toAccount.codeHash, KECCAK256_NULL) === true) ||',
          '            // See EIP 7610 and the discussion `https://ethereum-magicians.org/t/eip-7610-revert-creation-in-case-of-non-empty-storage`',
          '            !(equalsBytes(toAccount.storageRoot, KECCAK256_RLP) === true)) {',
        ].join('\n'), [
          '        // EIP-684: storage alone is not a collision in the supported forks.',
          '        if ((toAccount.nonce && toAccount.nonce > BIGINT_0) ||',
          '            !(equalsBytes(toAccount.codeHash, KECCAK256_NULL) === true)) {',
        ].join('\n')),
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
    Object.freeze({ path: 'dist/esm/interpreter.js',
      originalSha256: '27106c4194446a01eb6207a2c5158e13eb242fc6cbb7e180d4b937cd87ba6499',
      patchedSha256: 'abd65f8177f73f9726f3f28d97de63a809ac620bfc2cd42d075e0fc2e739a45c',
      replacements: Object.freeze([
        replacement([
          '        // EELS `generic_create`: a non-deployable target (nonce / code / storage)',
          '        // does not spawn a child. The 63/64 grant is consumed as regular gas on',
          '        // this frame; new-account state gas is refunded only if it was charged',
          '        // (storage-only collision — EIP-7610).',
        ].join('\n'), [
          '        // EELS `generic_create`: a non-deployable target (nonce / code)',
          '        // does not spawn a child. The 63/64 grant is consumed as regular gas on',
          '        // this frame; new-account state gas is refunded only if it was charged.',
        ].join('\n')),
        replacement('                    equalsBytes(toAccount.codeHash, KECCAK256_NULL) === false ||\n                    equalsBytes(toAccount.storageRoot, KECCAK256_RLP) === false)) {',
          '                    equalsBytes(toAccount.codeHash, KECCAK256_NULL) === false)) {'),
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
    const error = new Error('The pinned local EthereumJS execution runtime is unverified.', { cause });
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
  const files = LOCAL_RUNTIME_PATCH.files.map(spec => {
    const file = readRegular(directory, spec.path), hash = sha(file.bytes);
    need(hash === spec.originalSha256 || hash === spec.previousSha256 || hash === spec.patchedSha256);
    return { spec, ...file, hash };
  });
  return { directory, metadata, files };
}
function identity(files) {
  return Object.freeze({ package: PACKAGE, version: VERSION, patches: LOCAL_RUNTIME_PATCH.patches,
    files: Object.freeze(files.map(({ spec }) => Object.freeze({ path: spec.path, sha256: spec.patchedSha256 }))) });
}

/** Verify the expected local dependency without mutation or code evaluation.
 * The explicit directory argument permits isolated temporary-file controls;
 * execution uses the default local package path. No result is cached here. */
export function assertLocalRuntimePatched(packageDirectory = LOCAL_PACKAGE) {
  return checked(() => {
    const { files } = inspect(packageDirectory);
    need(files.every(file => file.hash === file.spec.patchedSha256));
    return identity(files);
  });
}

/** Apply only the declared delegation and creation conditions, explicitly and idempotently.
 * All input files are validated before the first write. A process interruption
 * can leave an original/patched mixture; another explicit apply completes it.
 * The read-only assertion rejects that mixture until every file is patched. */
export function applyLocalRuntimePatch(packageDirectory = LOCAL_PACKAGE) {
  return checked(() => {
    const snapshot = inspect(packageDirectory);
    const changes = snapshot.files.filter(file => file.hash !== file.spec.patchedSha256).map(file => {
      let text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
      if (file.hash === file.spec.previousSha256) {
        for (const { before, after } of file.spec.replacements.slice(0, file.spec.previousReplacementCount)) {
          need(text.split(after).length === 2); text = text.replace(after, before);
        }
        need(sha(Buffer.from(text)) === file.spec.originalSha256);
      }
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
      const temporary = file.path + '.runtime-patch-' + process.pid + '-' + randomBytes(8).toString('hex');
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
    const verified = assertLocalRuntimePatched(snapshot.directory);
    return Object.freeze({ ...verified, changed: Object.freeze(changes.map(file => file.spec.path)) });
  });
}

export const DELEGATION_RUNTIME_PATCH = LOCAL_RUNTIME_PATCH;
export const assertDelegationRuntimePatched = assertLocalRuntimePatched;
export const applyDelegationRuntimePatch = applyLocalRuntimePatch;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['apply', 'check'].includes(command)) {
    throw new Error('Use delegation-runtime-patch.js apply or check; only the local ESM package is selected.');
  }
  console.log(JSON.stringify(command === 'apply' ? applyLocalRuntimePatch() : assertLocalRuntimePatched(), null, 2));
}
