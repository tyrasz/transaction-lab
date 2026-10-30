// Native CALL flow is a consistency model, not a balance measurement. The
// engine must independently anchor balances, apply the complete state diff,
// validate its read-only probes and bind the original unsigned request.
import { canonicalStateDiff } from '../../src/state-diff.js';
import { StateValidationError } from '../../src/state.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const MAX = (1n << 256n) - 1n;
const FRAME_FIELDS = new Set(['type','from','to','input','output','value','gasUsed','error','revertReason','logs','calls']);
const LOG_FIELDS = new Set(['address','topics','data','position','index','logIndex']);
export const NATIVE_EFFECT_LIMITS = Object.freeze({maxAccounts:8,maxCandidates:128,maxFrames:1000,maxDepth:32,maxLogs:2000,maxStringBytes:8*1024*1024});
const need = (condition, message) => { if (!condition) throw new StateValidationError(message); };
const address = value => typeof value === 'string' && ADDRESS.test(value);
const lower = value => value.toLowerCase();
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const quantity = value => typeof value === 'string' && value.length <= 78 && DECIMAL.test(value) && BigInt(value) <= MAX ? BigInt(value) : null;

function plain(value, allowed, exact = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= allowed.size && (!exact || keys.length === allowed.size) && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    return typeof key === 'string' && allowed.has(key) && descriptor.enumerable && Object.hasOwn(descriptor,'value');
  });
}
function denseArray(value, max) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({length:value.length}, (_, index) => Object.getOwnPropertyDescriptor(value,String(index))).every(descriptor => descriptor && descriptor.enumerable && Object.hasOwn(descriptor,'value'));
}

/** Accepts semanticTrace-normalized frames, not raw callTracer frames. Its
 * caller must already bind the raw trace to the exact request and gas budget.
 * CALLCODE and DELEGATECALL keep their caller's storage/native account; neither
 * transfers value to its code address. Any reverted ancestor discards flows.
 * Explicit post balances with omitted pre balances remain candidates requiring
 * an independent anchor. Missing post.balance means unchanged, never zero.
 * Selection limits measurement requests only: all bounded candidates and net
 * CALL values remain visible, including self-transfers with zero net value. */
export function collectNativeEffects(trace, diff, {maxAccounts = 8} = {}) {
  need(Number.isInteger(maxAccounts) && maxAccounts >= 0 && maxAccounts <= NATIVE_EFFECT_LIMITS.maxAccounts,'Native account selection limit must be between zero and eight.');
  const normalizedDiff = canonicalStateDiff(diff), net = new Map(), seen = new WeakSet();
  let frames = 0, logs = 0, stringBytes = 0;
  function text(value) {
    need(typeof value === 'string','Native trace contains a non-string text field.');
    need(value.length <= NATIVE_EFFECT_LIMITS.maxStringBytes,'Native trace exceeds its bounded text evidence limit.');
    stringBytes += Buffer.byteLength(value,'utf8');
    need(stringBytes <= NATIVE_EFFECT_LIMITS.maxStringBytes,'Native trace exceeds its bounded text evidence limit.');
    return value;
  }
  function candidate(account) {
    if (!net.has(account)) {
      need(net.size < NATIVE_EFFECT_LIMITS.maxCandidates,'Native trace exceeds its distinct candidate limit.');
      net.set(account,0n);
    }
  }
  function walk(frame, parent, depth) {
    need(++frames <= NATIVE_EFFECT_LIMITS.maxFrames && depth <= NATIVE_EFFECT_LIMITS.maxDepth,'Native trace exceeds its frame or depth limit.');
    need(plain(frame,FRAME_FIELDS,true) && !seen.has(frame),'Native trace contains a malformed, repeated or cyclic normalized frame.');seen.add(frame);
    need(['CALL','STATICCALL','DELEGATECALL','CALLCODE'].includes(frame.type),'Native trace contains unsupported lifecycle or execution behavior.');
    need(address(frame.from) && address(frame.to),'Native trace contains malformed execution addresses.');text(frame.type);text(frame.from);text(frame.to);
    need(BYTES.test(text(frame.input)) && BYTES.test(text(frame.output)),'Native trace contains malformed execution bytes.');
    const value = quantity(frame.value), gasUsed = quantity(frame.gasUsed);
    need(value !== null && gasUsed !== null,'Native trace requires canonical normalized value and gas quantities.');text(frame.value);text(frame.gasUsed);
    for (const field of ['error','revertReason']) if (frame[field] !== null) {
      need(typeof frame[field] === 'string' && frame[field].length > 0 && frame[field].length <= 2000,'Native trace contains malformed failure metadata.');text(frame[field]);
    }
    need(denseArray(frame.calls,NATIVE_EFFECT_LIMITS.maxFrames) && denseArray(frame.logs,NATIVE_EFFECT_LIMITS.maxLogs),'Native trace contains malformed child or event arrays.');
    const from = lower(frame.from), to = lower(frame.to), delegate = frame.type === 'DELEGATECALL', callcode = frame.type === 'CALLCODE';
    if (parent) {
      need(from === parent.context,'Native trace child caller differs from the executing storage account.');
      if (delegate) need(value === parent.value,'Native trace delegate value differs from its inherited value.');
    } else need(frame.type === 'CALL' && gasUsed > 0n,'Native trace requires one original CALL root with positive gas use.');
    const isStatic = Boolean(parent?.isStatic || frame.type === 'STATICCALL');
    // EIP-214 explicitly permits value-bearing CALLCODE in a static context;
    // a following DELEGATECALL inherits that value without moving funds.
    need((frame.type !== 'STATICCALL' && !(isStatic && frame.type === 'CALL')) || value === 0n,'Native trace contains a prohibited native-value call inside a static context.');
    const context = delegate || callcode ? parent.context : to;
    const failed = Boolean(parent?.failed || frame.error || frame.revertReason);
    for (const log of frame.logs) {
      need(++logs <= NATIVE_EFFECT_LIMITS.maxLogs,'Native trace exceeds its event limit.');
      need(plain(log,LOG_FIELDS) && address(log.address) && denseArray(log.topics,4),'Native trace contains malformed event fields.');text(log.address);
      need(log.topics.every(topic => WORD.test(text(topic))) && BYTES.test(text(log.data)),'Native trace contains malformed event bytes or topics.');
      need(lower(log.address) === context,'Native trace event emitter differs from the executing storage account.');
      for (const field of ['position','index','logIndex']) if (Object.hasOwn(log,field)) {
        const index = quantity(log[field]);need(index !== null,'Native trace contains malformed normalized event positions.');text(log[field]);
        if (field === 'position') need(index <= BigInt(frame.calls.length),'Native trace event position exceeds its direct child count.');
      }
    }
    if (!failed && !isStatic && frame.type === 'CALL' && value > 0n) {
      candidate(from);candidate(to);
      if (from !== to) { net.set(from,net.get(from)-value);net.set(to,net.get(to)+value); }
    }
    for (const child of frame.calls) walk(child,{context,value,isStatic,failed},depth+1);
  }
  walk(trace,null,0);
  for (const [account, after] of Object.entries(normalizedDiff.post)) {
    const before = normalizedDiff.pre[account];
    if (Object.hasOwn(after,'balance') && (!before || !Object.hasOwn(before,'balance') || before.balance !== after.balance)) candidate(account);
  }
  const sender = lower(trace.from), recipient = lower(trace.to), priority = account => account === sender ? 0 : account === recipient ? 1 : 2;
  const candidates = [...net].sort(([a],[b]) => priority(a)-priority(b) || lexical(a,b)).map(([account,value], index) => ({account,netValueRaw:value.toString(),selected:index < maxAccounts,reason:index < maxAccounts ? 'selected' : 'account-limit'}));
  const selectedAccounts = candidates.filter(candidate => candidate.selected).map(candidate => candidate.account);
  return {status:'complete',feeScope:'excluded',maxAccounts,candidates,selectedAccounts,netValueByAccount:Object.fromEntries(candidates.map(candidate => [candidate.account,candidate.netValueRaw])),counts:{candidates:candidates.length,selected:selectedAccounts.length,omitted:candidates.length-selectedAccounts.length}};
}
