// Optional unsigned-call execution context. This validates declared bytes only;
// it does not validate signatures, blob sidecars, KZG proofs or transaction fees.
import { types } from 'node:util';
export const EVM_CONTEXT_LIMITS = Object.freeze({ accessListEntries: 128, storageKeys: 1024, blobVersionedHashes: 32 });
export class EvmContextError extends Error {
  constructor() { super('The optional EVM context is malformed or exceeds its fixed bounds.'); this.code = 'EVM_CONTEXT_INVALID'; }
}
const need = value => { if (!value) throw new EvmContextError(); };
function record(value, exact) {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  if (exact) need(keys.length === exact.length && exact.every(key => keys.includes(key)));
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); need(typeof key === 'string' && d.enumerable && Object.hasOwn(d, 'value')); }
}
function array(value, maximum) {
  need(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum);
  need(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); need(d?.enumerable && Object.hasOwn(d, 'value')); }
}
function bytes(value, length) { need(typeof value === 'string' && value.length === 2 + length * 2 && /^0x[0-9a-f]+$/i.test(value)); return value.toLowerCase(); }
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
/** Only the two optional fields are projected. Envelope consumers separately
 * validate their allowed base keys. Order and duplicates are retained: EIP-2930
 * charges each occurrence even though access warming uses a set. */
export function normalizeEvmContext(request) {
  record(request); const output = {};
  if (Object.hasOwn(request, 'accessList')) {
    array(request.accessList, EVM_CONTEXT_LIMITS.accessListEntries); let keys = 0;
    output.accessList = request.accessList.map(item => {
      record(item, ['address', 'storageKeys']); array(item.storageKeys, EVM_CONTEXT_LIMITS.storageKeys);
      keys += item.storageKeys.length; need(keys <= EVM_CONTEXT_LIMITS.storageKeys);
      return { address: bytes(item.address, 20), storageKeys: item.storageKeys.map(key => bytes(key, 32)) };
    });
  }
  if (Object.hasOwn(request, 'blobVersionedHashes')) {
    array(request.blobVersionedHashes, EVM_CONTEXT_LIMITS.blobVersionedHashes); need(request.blobVersionedHashes.length > 0);
    output.blobVersionedHashes = request.blobVersionedHashes.map(hash => { const result = bytes(hash, 32); need(result.slice(2, 4) === '01'); return result; });
  }
  return freeze(output);
}
/** Match the declared unpriced blob-call profile explicitly. A zero blob fee
 * cap is a simulation choice, not the captured signed transaction's fee cap. */
export function rpcEvmContext(request) {
  const context = normalizeEvmContext(request);
  return freeze({ ...context, ...(context.blobVersionedHashes ? { maxFeePerBlobGas: '0x0' } : {}) });
}
