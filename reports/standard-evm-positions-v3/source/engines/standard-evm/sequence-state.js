// Pure composition of already validated unsigned-step state. Identity,
// provenance, execution success and canonicality belong to the internal
// continuation owner; this function never admits client-selected overrides.
import { canonicalStateDiff } from '../../src/state-diff.js';
import { buildStateOverrides, StateValidationError } from '../../src/state.js';

const ADDRESS=/^0x[0-9a-f]{40}$/i, WORD=/^0x[0-9a-f]{64}$/i;
const QUANTITY=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const MAX_BALANCE=(1n<<256n)-1n, MAX_NONCE=(1n<<64n)-1n;
const ZERO_WORD='0x'+'0'.repeat(64), MAX_ACCOUNTS=100, MAX_SLOTS=2000, MAX_CHECKS=2200;
const need=(condition,message)=>{if(!condition)throw new StateValidationError(message);};
const own=(record,key)=>Object.hasOwn(record,key);
const hex=value=>'0x'+BigInt(value).toString(16);

function fields(record) {
  need(record!==null&&typeof record==='object'&&!Array.isArray(record)&&[Object.prototype,null].includes(Object.getPrototypeOf(record)),'Sequence state contains an invalid object record.');
  const names=Reflect.ownKeys(record);
  for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(record,name);need(typeof name==='string'&&descriptor.enumerable&&own(descriptor,'value'),'Sequence state contains unsupported object fields.');}
  return names;
}
function normalizedPrevious(previous) {
  const accounts=fields(previous);need(accounts.length<=MAX_ACCOUNTS,'Sequence state exceeds its cumulative 100-account limit.');
  const result={};let slots=0;
  for(const original of accounts){
    need(ADDRESS.test(original),'Sequence state contains an invalid account address.');const account=original.toLowerCase();
    need(!own(result,account),'Sequence state contains colliding normalized account addresses.');
    const value=previous[original],names=fields(value);need(names.every(name=>['balance','nonce','stateDiff'].includes(name)),'Sequence state permits only balance, nonce and individual storage overrides.');
    const record={};
    for(const field of ['balance','nonce'])if(own(value,field)){
      const raw=value[field];need(typeof raw==='string'&&raw.length<=66&&QUANTITY.test(raw),'Sequence state contains a noncanonical basic-state quantity.');
      const amount=BigInt(raw);need(amount<=(field==='nonce'?MAX_NONCE:MAX_BALANCE),'Sequence state contains an overflowing basic-state quantity.');record[field]=hex(amount);
    }
    if(own(value,'stateDiff')){
      const keys=fields(value.stateDiff);need(slots+keys.length<=MAX_SLOTS,'Sequence state exceeds its cumulative 2000-slot limit.');slots+=keys.length;
      const storage={};
      for(const originalSlot of keys){
        const raw=value.stateDiff[originalSlot];need(WORD.test(originalSlot)&&typeof raw==='string'&&WORD.test(raw),'Sequence state contains malformed storage slots.');
        const slot=originalSlot.toLowerCase();need(!own(storage,slot),'Sequence state contains colliding normalized storage slots.');storage[slot]=raw.toLowerCase();
      }
      if(keys.length)record.stateDiff=Object.fromEntries(Object.keys(storage).sort().map(slot=>[slot,storage[slot]]));
    }
    result[account]=record;
  }
  return Object.fromEntries(Object.keys(result).sort().map(account=>[account,result[account]]));
}

/** Compose complete accumulated overrides with one effective pre/post diff.
 * The diff must already include any independently established empty-account
 * normalization. No lifecycle or runtime-code changes are admitted here.
 *
 * Every touched account's carried balance/nonce must match its reported pre
 * value; an omitted basic prefield is accepted only for an explicit carried
 * zero. For changed storage slots, missing pre means prior zero (Geth diff
 * insertion semantics), and missing post means cleared zero. Unchanged slots
 * and accounts need not appear and are carried without being discarded.
 *
 * overlapChecks uses decimal strings for balance/nonce and canonical 32-byte
 * hex words for storage. These checks compare provider-reported states; they
 * do not independently attest chain state or validate continuation identity. */
export function composeSequenceOverrides(previousOverrides,effectiveDiff) {
  const previous=normalizedPrevious(previousOverrides),diff=canonicalStateDiff(effectiveDiff);
  const step=buildStateOverrides(diff),accounts=[...new Set([...Object.keys(previous),...Object.keys(diff.pre),...Object.keys(diff.post)])].sort();
  need(accounts.length<=MAX_ACCOUNTS,'Sequence state exceeds its cumulative 100-account limit.');
  const overlapChecks=[];
  function check(account,field,before,expected,slot){
    need(before===expected,field==='storage'?'Sequence carried storage differs from the next step prestate.':'Sequence carried basic state differs from the next step prestate.');
    need(overlapChecks.length<MAX_CHECKS,'Sequence state overlap evidence exceeds its limit.');
    overlapChecks.push({account,field,...(slot===undefined?{}:{slot}),beforeRaw:before,expectedRaw:expected});
  }
  const overrides={};let totalSlots=0;
  for(const account of accounts){
    const carried=previous[account]??{},pre=diff.pre[account],post=diff.post[account];
    if(pre){
      for(const field of ['balance','nonce'])if(own(carried,field))check(account,field,own(pre,field)?pre[field]:'0',BigInt(carried[field]).toString());
      const touchedSlots=[...new Set([...Object.keys(pre.storage??{}),...Object.keys(post.storage??{})])].sort();
      for(const slot of touchedSlots)if(own(carried.stateDiff??{},slot))check(account,'storage',pre.storage?.[slot]??ZERO_WORD,carried.stateDiff[slot],slot);
    }
    const update=step[account]??{},merged={};
    for(const field of ['balance','nonce'])if(own(update,field)||own(carried,field))merged[field]=own(update,field)?update[field]:carried[field];
    const storage={...(carried.stateDiff??{}),...(update.stateDiff??{})},slots=Object.keys(storage).sort();
    totalSlots+=slots.length;need(totalSlots<=MAX_SLOTS,'Sequence state exceeds its cumulative 2000-slot limit.');
    if(slots.length)merged.stateDiff=Object.fromEntries(slots.map(slot=>[slot,storage[slot]]));
    if(Object.keys(merged).length)overrides[account]=merged;
  }
  return {overrides,overlapChecks};
}
