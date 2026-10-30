import { types } from 'node:util';
import { bigIntToUnpaddedBytes, eoaCode7702RecoverAuthority, hexToBytes } from '@ethereumjs/util';

export const MAX_AUTHORIZATIONS = 16;
export const AUTHORIZATION_REASONS = Object.freeze(['wrong_chain', 'nonce_overflow', 'invalid_signature', 'authority_has_code', 'nonce_mismatch']);
const ADDRESS = /^0x[0-9a-f]{40}$/i, QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const MAX_NONCE = (1n << 64n) - 1n;
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const FIELDS = ['chainId', 'address', 'nonce', 'yParity', 'r', 's'];
function need(ok) { if (!ok) throw Object.assign(new Error('The bounded authorization list is malformed.'), { code: 'LOCAL_AUTHORIZATION_INPUT' }); }
function plain(value) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function q(value, bits) {
  need(typeof value === 'string' && value.length <= 66 && QUANTITY.test(value));
  need(BigInt(value) < 1n << BigInt(bits)); return value.toLowerCase();
}
/** Structural admission only: invalid signatures/parity/chain/nonces are
 * protocol-skipped tuples, not malformed envelopes. No caller-supplied signer. */
export function normalizeAuthorizationList(request) {
  plain(request);
  const descriptor = Object.getOwnPropertyDescriptor(request, 'authorizationList');
  if (descriptor === undefined) return undefined;
  need(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  const list = descriptor.value;
  need(list && typeof list === 'object' && !types.isProxy(list) && Array.isArray(list) && Object.getPrototypeOf(list) === Array.prototype && list.length > 0 && list.length <= MAX_AUTHORIZATIONS && Reflect.ownKeys(list).length === list.length + 1);
  return Object.freeze(Array.from({ length: list.length }, (_, index) => {
    const itemDescriptor = Object.getOwnPropertyDescriptor(list, String(index));
    need(itemDescriptor?.enumerable && Object.hasOwn(itemDescriptor, 'value'));
    const item = itemDescriptor.value; plain(item);
    need(Reflect.ownKeys(item).length === FIELDS.length && FIELDS.every(key => {
      const d = Object.getOwnPropertyDescriptor(item, key); return d?.enumerable && Object.hasOwn(d, 'value');
    }));
    need(typeof item.address === 'string' && ADDRESS.test(item.address));
    return Object.freeze({ chainId: q(item.chainId, 256), address: item.address.toLowerCase(), nonce: q(item.nonce, 64), yParity: q(item.yParity, 8), r: q(item.r, 256), s: q(item.s, 256) });
  }));
}
/** Pure signature/chain stage. State is deliberately absent from this helper. */
export function recoverAuthorization(tuple, chainId = 1n) {
  if (BigInt(tuple.chainId) !== 0n && BigInt(tuple.chainId) !== chainId) return { authority: null, reason: 'wrong_chain' };
  if (BigInt(tuple.nonce) >= MAX_NONCE) return { authority: null, reason: 'nonce_overflow' };
  const r = BigInt(tuple.r), s = BigInt(tuple.s), parity = BigInt(tuple.yParity);
  if (parity > 1n || r === 0n || r >= ORDER || s === 0n || s > ORDER / 2n) return { authority: null, reason: 'invalid_signature' };
  try {
    const bytes = [bigIntToUnpaddedBytes(BigInt(tuple.chainId)), hexToBytes(tuple.address), bigIntToUnpaddedBytes(BigInt(tuple.nonce)), bigIntToUnpaddedBytes(parity), bigIntToUnpaddedBytes(r), bigIntToUnpaddedBytes(s)];
    return { authority: eoaCode7702RecoverAuthority(bytes).toString(), reason: null };
  } catch { return { authority: null, reason: 'invalid_signature' }; }
}
/** The parent may fold this decision over independently reverified facts.
 * Existence (including an existing empty account), not emptiness, earns refund. */
export function authorizationStateDecision(tuple, { exists, nonce, code }) {
  need(typeof exists === 'boolean' && typeof nonce === 'bigint' && nonce >= 0n && nonce <= MAX_NONCE && typeof code === 'string');
  const skipped = reason => ({ reason, nonceAfter: null, codeAfter: null, gasRefund: 0n });
  if (code !== '0x' && !/^0xef0100[0-9a-f]{40}$/.test(code)) return skipped('authority_has_code');
  if (nonce !== BigInt(tuple.nonce)) return skipped('nonce_mismatch');
  need(nonce < MAX_NONCE);
  return { reason: null, nonceAfter: nonce + 1n, codeAfter: BigInt(tuple.address) === 0n ? '0x' : '0xef0100' + tuple.address.slice(2), gasRefund: exists ? 12500n : 0n };
}
