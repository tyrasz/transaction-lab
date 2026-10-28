// Provider extensions are never silently discarded. The sole admitted extra
// field is a Keccak-256 claim checked against explicit code in the same record.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { canonicalStateDiff } from '../../src/state-diff.js';
import { failState } from '../../src/state.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;

function fields(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) failState('Provider state diff contains an invalid object record.');
  const keys = Reflect.ownKeys(record);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) failState('Provider state diff contains unsupported object fields.');
  }
  return keys;
}

/** This proves only consistency between two provider-supplied fields. It does
 * not authenticate deployment bytecode, source code, or blockchain state. */
export function normalizeProviderStateDiff(raw) {
  const root = fields(raw);
  if (root.length !== 2 || !root.includes('pre') || !root.includes('post')) failState('Provider state diff requires only complete pre and post maps.');
  const stripped = { pre: {}, post: {} }, claims = [];
  const accounts = new Set();
  for (const phase of ['pre', 'post']) {
    const keys = fields(raw[phase]);
    if (keys.length > 100) failState('Provider state diff exceeds the 100-account limit.');
    const seen = new Set();
    for (const key of keys) {
      if (!ADDRESS.test(key)) failState('Provider state diff contains an invalid account address.');
      const address = key.toLowerCase();
      if (seen.has(address)) failState('Provider state diff contains colliding normalized account addresses.');
      seen.add(address); accounts.add(address);
      if (accounts.size > 100) failState('Provider state diff exceeds the 100-account limit.');
      const account = raw[phase][key], names = fields(account);
      if (names.some(name => !['balance', 'nonce', 'code', 'storage', 'codeHash'].includes(name))) failState('Provider state diff contains unsupported account fields.');
      if (Object.hasOwn(account, 'codeHash')) {
        if (typeof account.codeHash !== 'string' || !WORD.test(account.codeHash)) failState('Provider state diff contains a malformed codeHash.');
        if (!Object.hasOwn(account, 'code')) failState('Provider codeHash requires explicit runtime code in the same record.');
        claims.push({ phase, address, codeHash: account.codeHash.toLowerCase() });
      }
      stripped[phase][address] = Object.fromEntries(names.filter(name => name !== 'codeHash').map(name => [name, account[name]]));
    }
  }
  // Validate every quantity, storage slot, code byte and size limit before
  // hashing. Unknown fields, absent fields and explicit zero remain distinct.
  const diff = canonicalStateDiff(stripped);
  const codeHashChecks = claims.map(claim => {
    const code = Buffer.from(diff[claim.phase][claim.address].code.slice(2), 'hex');
    const computed = '0x' + Buffer.from(keccak_256(code)).toString('hex');
    if (computed !== claim.codeHash) failState('Provider codeHash does not match the supplied runtime code.');
    return { ...claim, codeBytes: code.length };
  }).sort((a, b) => a.phase.localeCompare(b.phase) || a.address.localeCompare(b.address));
  return { diff, codeHashChecks };
}
