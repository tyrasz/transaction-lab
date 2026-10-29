// Parent-only preparation derivation from separately reverified immutable
// accounts. Child authority, costs, phase and after-state never supply inputs.
// Geth 1df30b18 core/state_transition.go:887-901,1009-1038,1112-1236;
// retained source SHA b85812dfd250889b4c9f63b1f752281fbcce08cc9e4dd43946aed4c01f7bdb94.
// Signature recovery is shared; the ordered state/cost fold is independent of
// applyAmsterdamAuthorizations and does not execute an EVM.
import { types } from 'node:util';
import { getActivePrecompiles } from '@ethereumjs/evm';
import { normalizeAuthorizationList, recoverAuthorization } from './authorization-list.js';
import { normalizeEvmContext } from '../evm-context.js';
import { ethereumCallGas, ethereumCommon, ethereumQuantity } from './ethereum-profile.js';
import { ethereumStateGasBudget } from './ethereum-state-gas.js';
import { ethereumFeePlan } from './ethereum-fees.js';

const ADDRESS = /^0x[0-9a-f]{40}$/, DESIGNATION = /^0xef0100[0-9a-f]{40}$/;
const UINT64 = (1n << 64n) - 1n, UINT256 = (1n << 256n) - 1n;
const WRITE = 9000n, ACCOUNT = 120n * 1530n, INDICATOR = 23n * 1530n, COLD = 3000n, WARM = 100n;
const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const need = ok => { if (!ok) throw new Error('Amsterdam authorization preparation does not match verified starting facts.'); };
const hex = n => '0x' + n.toString(16);
function record(value) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const copy = {};
  for (const key of Reflect.ownKeys(value)) { const d = Object.getOwnPropertyDescriptor(value,key);
    need(typeof key === 'string' && d.enumerable && Object.hasOwn(d,'value')); Object.defineProperty(copy,key,{value:d.value,enumerable:true}); }
  return copy;
}
function address(value) { need(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)); return value.toLowerCase(); }
function raw(value,max) { need(typeof value === 'string' && value.length <= 78 && /^(?:0|[1-9][0-9]*)$/.test(value)); const n = BigInt(value); need(n <= max); return n; }
const strings = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,typeof value === 'bigint' ? value.toString() : value]));
const copyAccounts = accounts => new Map([...accounts].map(([key,row]) => [key,{initial:{...row.initial},current:{...row.current}}]));

/** No-list calls preserve the separate pre-Amsterdam path. The caller must
 * validate input proofs before supplying inputs; this helper does not establish
 * proof provenance or network membership. Its snapshot deliberately excludes
 * fee balance deltas: the existing native/creation validators apply those once.
 * accounts.current includes prepayment only for eligibility and nonce/code use.
 * Attempted writes/entries and retained writes are intentionally distinct. */
export function deriveAmsterdamAuthorizationPreparation({request,header,inputs,common}) {
  const list = normalizeAuthorizationList(request);
  if (list === undefined) return null;
  const r = record(request), h = record(header), chainId = common?.chainId();
  need([1n,11155111n].includes(chainId) && common.hardfork() === 'amsterdam'
    && [7702,2780,7928,8037].every(eip => common.isActivatedEIP(eip)));
  const trusted = ethereumCommon(h,Number(chainId));
  need(trusted.hardfork() === common.hardfork() && trusted.chainId() === chainId);
  need(r.to !== null && r.blobVersionedHashes === undefined);
  const sender = address(r.from), to = address(r.to), value = ethereumQuantity(r.value), gasLimit = ethereumQuantity(r.gas);
  const context = normalizeEvmContext(r), costs = ethereumCallGas(r.data,trusted,r);
  const budget = ethereumStateGasBudget({gasLimit,intrinsicRegular:costs.intrinsic,floor:costs.floor},trusted);
  const feePlan = ethereumFeePlan(r,h,Number(chainId)), prepaidGasDebit = feePlan?.upfrontGasDebit ?? 0n;
  const facts = record(record(inputs).accounts), accounts = new Map(), tracking = new Map();
  const applied = new Set(), entries = [], accesses = [], writes = [];
  function account(key) {
    if (!accounts.has(key)) {
      need(Object.hasOwn(facts,key)); const fact = record(facts[key]); need(typeof fact.exists === 'boolean');
      let initial = {exists:false,nonce:0n,balance:0n,code:'0x'};
      if (fact.exists) {
        const code = fact.code; need(typeof code === 'string' && code.length <= 2+131072*2 && /^0x(?:[0-9a-f]{2})*$/.test(code));
        initial = {exists:true,nonce:raw(fact.nonce,UINT64),balance:raw(fact.balance,UINT256),code};
      } else need(Object.keys(fact).length === 1);
      accounts.set(key,{initial,current:{...initial}});
    }
    return accounts.get(key).current;
  }
  const caller = account(sender);
  need(caller.code === '0x' || DESIGNATION.test(caller.code)); need(caller.nonce < UINT64);
  need(caller.balance >= (feePlan?.maximumRequiredBalance ?? value));
  caller.balance -= prepaidGasDebit; caller.exists = true; caller.nonce++;
  const initialSender = {...caller};
  let gas = budget.messageGasLimit, reservoir = budget.stateGasReservoirInitial, stateUsed = 0n, spilled = 0n, senderIncrements = 0n;
  let failedIndex = null;
  for (const [index,tuple] of list.entries()) {
    const recovered = recoverAuthorization(tuple,chainId);
    if (recovered.reason !== null) { entries.push({index,authority:null,status:'skipped',reason:recovered.reason}); continue; }
    const authority = address(recovered.authority), current = account(authority);
    accesses.push({index,authority});
    const reason = current.code !== '0x' && !DESIGNATION.test(current.code) ? 'authority_has_code'
      : current.nonce !== BigInt(tuple.nonce) ? 'nonce_mismatch' : null;
    if (reason !== null) { entries.push({index,authority,status:'skipped',reason}); continue; }
    const previous = tracking.get(authority) ?? {written:false,indicatorCovered:DESIGNATION.test(current.code)};
    const setting = BigInt(tuple.address) !== 0n;
    const regularCost = previous.written || authority === sender || authority === to && value > 0n ? 0n : WRITE;
    const stateCost = (current.nonce === 0n && current.balance === 0n && current.code === '0x' ? ACCOUNT : 0n)
      + (setting && !previous.indicatorCovered ? INDICATOR : 0n);
    const spill = stateCost > reservoir ? stateCost-reservoir : 0n;
    if (regularCost+spill > gas) { failedIndex = index; entries.push({index,authority,status:'out_of_gas',reason:'out_of_gas'}); break; }
    gas -= regularCost+spill; reservoir = reservoir > stateCost ? reservoir-stateCost : 0n; stateUsed += stateCost; spilled += spill;
    const codeAfter = setting ? '0xef0100'+tuple.address.slice(2) : '0x';
    writes.push({index,authority,nonceBefore:current.nonce,nonceAfter:current.nonce+1n,codeBefore:current.code,codeAfter});
    current.exists = true; current.nonce++; current.code = codeAfter; applied.add(authority);
    tracking.set(authority,{written:true,indicatorCovered:previous.indicatorCovered||setting});
    if (authority === sender) senderIncrements++;
    entries.push({index,authority,status:'applied',reason:null});
  }
  const attempt = {gasLimit:gas,authorizationGasUsed:budget.messageGasLimit-gas,stateGasReservoir:reservoir,
    executionStateGasUsed:stateUsed,stateGasSpilled:spilled,gasRefundCounter:0n,senderAuthorizationIncrements:senderIncrements,
    outOfGas:failedIndex!==null,failedIndex,entries,accesses,writes,accounts:copyAccounts(accounts),applied:new Set(applied),tracking:new Map(tracking)};
  let phase = failedIndex === null ? 'message' : 'authorization_out_of_gas';
  let recipient = null;
  if (failedIndex === null) {
    const current = account(to), warm = new Set([sender,to,address(h.miner),...getActivePrecompiles(trusted).keys()].map(key => key.startsWith('0x') ? key : '0x'+key));
    for (const entry of context.accessList ?? []) warm.add(entry.address);
    for (const access of accesses) warm.add(access.authority);
    const stateCost = value > 0n && current.nonce === 0n && current.balance === 0n && current.code === '0x' ? ACCOUNT : 0n;
    const spill = stateCost > reservoir ? stateCost-reservoir : 0n;
    // The exact designation is mandatory for a protocol delegation. Do not
    // infer a target from truncated/extended indicator-looking runtime bytes.
    need(!current.code.startsWith('0xef0100') || DESIGNATION.test(current.code));
    const delegatedTo = DESIGNATION.test(current.code) ? '0x'+current.code.slice(8) : null;
    const accessCost = delegatedTo === null ? 0n : warm.has(delegatedTo) ? WARM : COLD;
    const stateOutOfGas = spill > gas, delegationOutOfGas = !stateOutOfGas && accessCost > gas-spill;
    recipient = {stateGas:stateCost,stateGasSpilled:stateOutOfGas?0n:spill,delegatedTo,
      delegationWarm:delegatedTo===null?null:warm.has(delegatedTo),delegationAccessGas:accessCost,
      outOfGas:stateOutOfGas||delegationOutOfGas,outOfGasAt:stateOutOfGas?'value':delegationOutOfGas?'delegation':null,
      gasLimitAfter:stateOutOfGas||delegationOutOfGas?null:gas-spill-accessCost,
      stateGasReservoirAfter:stateOutOfGas?reservoir:reservoir>stateCost?reservoir-stateCost:0n};
    if (recipient.outOfGas) phase = 'recipient_out_of_gas';
  }
  const retained = phase === 'message';
  if (!retained) {
    for (const [key,row] of accounts) row.current = key === sender ? {...initialSender} : {...row.initial};
    applied.clear();
  }
  const rows = [];
  for (const [key,{initial,current}] of accounts) {
    const row = {address:key};
    if (!initial.exists && current.exists) row.existence = {before:false,after:true,
      basis:applied.has(key)?'eip7702_authorization_materialization':'unsigned_sender_nonce_materialization'};
    if (initial.nonce !== current.nonce) row.nonce = {before:hex(initial.nonce),after:hex(current.nonce)};
    if (initial.code !== current.code) row.code = {before:initial.code,after:current.code};
    if (Object.keys(row).length > 1) rows.push(row);
  }
  rows.sort((a,b)=>a.address.localeCompare(b.address));
  const preparation = {phase,retained,failedIndex,authorizationGasUsed:phase==='authorization_out_of_gas'?budget.messageGasLimit:attempt.authorizationGasUsed,
    stateGasReservoir:retained?reservoir:budget.stateGasReservoirInitial,executionStateGasUsed:retained?stateUsed:0n,
    stateGasSpilled:retained?spilled:0n,senderAuthorizationIncrements:retained?senderIncrements:0n};
  return {accounts,applied,snapshot:{scope:SCOPE,accounts:rows},budget,feePlan,prepaidGasDebit,attempt,retained,recipient,
    recipientPreparationGasLimit:phase==='authorization_out_of_gas'?null:gas,
    processing:{entries,gasRefundCounter:'0',preparation:strings(preparation)}};
}

/** Exact shape comparison without invoking claimed getters. This binds a child
 * metadata record to the independent derivation, not vice versa. */
export function validateAmsterdamAuthorizationProcessing(preparation,claimed) {
  need(preparation && preparation.processing);
  function same(actual,expected) {
    if (expected === null || typeof expected !== 'object') { need(actual === expected); return; }
    if (Array.isArray(expected)) {
      need(Array.isArray(actual) && !types.isProxy(actual) && Object.getPrototypeOf(actual)===Array.prototype);
      const d=Object.getOwnPropertyDescriptors(actual); need(d.length.value===expected.length && Reflect.ownKeys(d).length===expected.length+1);
      for(let i=0;i<expected.length;i++){need(d[i]?.enumerable&&Object.hasOwn(d[i],'value'));same(d[i].value,expected[i]);} return;
    }
    const data=record(actual); need(Object.keys(data).length===Object.keys(expected).length);
    for(const key of Object.keys(expected)){need(Object.hasOwn(data,key));same(data[key],expected[key]);}
  }
  same(claimed,preparation.processing); return preparation;
}
