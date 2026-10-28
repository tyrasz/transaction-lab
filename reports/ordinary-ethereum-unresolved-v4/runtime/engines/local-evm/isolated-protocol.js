// Fixed, JSON-only IPC protocol. Limits describe parsed JSON bytes, not wire/RSS.
import { types } from 'node:util';
export const ISOLATED_LIMITS = Object.freeze({ wallMs: 145000, requestMs: 25000, drainMs: 25000, killWaitMs: 1000,
  heapMiB: 256, calls: 256, responseBytes: 8 * 1024 * 1024, totalResponseBytes: 32 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024, stdioBytes: 65536 });
const INPUT_LIMITS = { accounts: 128, slots: 1024, codeBytes: 131072, reads: 200000, wallMs: 240000 };
const EXECUTION_LIMITS = { gas: 5000000, steps: 1000000, frames: 1000, depth: 32, logs: 2000, memoryBytes: 1048576,
  returnBytes: 1048576, calldataBytes: 32768, traceBytes: 8388608, wallMs: 120000 };
export const PROTOCOL_VERSION = 1;
export class IsolationError extends Error {
  constructor(code, message) { super(message); this.name = 'IsolationError'; this.code = code; }
}
export const need = (ok, code = 'LOCAL_ISOLATED_PROTOCOL', message = 'The isolated worker protocol was invalid.') => { if (!ok) throw new IsolationError(code, message); };
export function fields(value, names, required = names) {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  need(keys.every(key => typeof key === 'string' && names.includes(key)) && required.every(key => Object.hasOwn(value, key)));
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); need(d.enumerable && Object.hasOwn(d, 'value')); }
}
function jsonData(value, depth = 0, counter = { n: 0 }) {
  need(++counter.n <= 2_000_000 && depth <= 128);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { need(Number.isFinite(value)); return; }
  need(value && typeof value === 'object' && !types.isProxy(value));
  if (Array.isArray(value)) {
    need(Object.getPrototypeOf(value) === Array.prototype);
    need(Reflect.ownKeys(value).length === value.length + 1);
    for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); need(d?.enumerable && Object.hasOwn(d, 'value')); jsonData(d.value, depth + 1, counter); }
  } else {
    need(Object.getPrototypeOf(value) === Object.prototype);
    for (const key of Reflect.ownKeys(value)) { const d = Object.getOwnPropertyDescriptor(value, key); need(typeof key === 'string' && d.enumerable && Object.hasOwn(d, 'value')); jsonData(d.value, depth + 1, counter); }
  }
}
export function encode(value, maxBytes) {
  jsonData(value); const text = JSON.stringify(value);
  need(Buffer.byteLength(text) <= maxBytes, 'LOCAL_ISOLATED_SIZE', 'Isolated JSON exceeded its byte limit.'); return text;
}
export function decode(text, maxBytes) {
  need(typeof text === 'string' && text.length <= maxBytes && Buffer.byteLength(text) <= maxBytes, 'LOCAL_ISOLATED_SIZE', 'Isolated JSON exceeded its byte limit.');
  let value; try { value = JSON.parse(text); } catch { need(false); }
  jsonData(value); return value;
}
function tighten(value, ceiling) {
  fields(value, Object.keys(ceiling), []); const result = { ...ceiling };
  for (const [key, amount] of Object.entries(value)) { need(Number.isSafeInteger(amount) && amount > 0 && amount <= ceiling[key], 'LOCAL_ISOLATED_INPUT', 'Limits may only tighten the fixed ceilings.'); result[key] = amount; }
  return result;
}
export function normalizeLimits(raw = {}) {
  fields(raw, [...Object.keys(ISOLATED_LIMITS), 'inputs', 'execution'], []);
  const { inputs = {}, execution = {}, ...processLimits } = raw;
  const limits = tighten(processLimits, ISOLATED_LIMITS);
  need(limits.heapMiB >= 64, 'LOCAL_ISOLATED_INPUT', 'The V8 old-space cap must be at least 64 MiB.');
  limits.inputs = tighten(inputs, INPUT_LIMITS); limits.execution = tighten(execution, EXECUTION_LIMITS);
  limits.inputs.wallMs = Math.min(limits.inputs.wallMs, limits.wallMs);
  limits.execution.wallMs = Math.min(limits.execution.wallMs, limits.wallMs);
  return limits;
}
export function envelope(value, type, names) {
  fields(value, ['v', 'type', 'id', ...names]);
  need(value.v === PROTOCOL_VERSION && value.type === type && Number.isSafeInteger(value.id) && value.id >= 1);
}
export function validateRpcRequest(message, blockHash, expectedId) {
  envelope(message, 'rpc', ['method', 'params']); need(message.id === expectedId);
  const p = message.params, address = /^0x[0-9a-f]{40}$/, word = /^0x[0-9a-f]{64}$/;
  need(Array.isArray(p) && typeof p[0] === 'string' && address.test(p[0]));
  need(message.method === 'eth_getProof' || message.method === 'eth_getCode');
  need(p.length === (message.method === 'eth_getProof' ? 3 : 2));
  const selector = p.at(-1); fields(selector, ['blockHash', 'requireCanonical']);
  need(selector.blockHash === blockHash && selector.requireCanonical === true);
  if (message.method === 'eth_getProof') need(Array.isArray(p[1]) && p[1].length <= 1024 && p[1].every(slot => typeof slot === 'string' && word.test(slot)) && new Set(p[1]).size === p[1].length);
  return message;
}
