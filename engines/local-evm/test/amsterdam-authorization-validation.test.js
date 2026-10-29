// Pure parent derivation controls. Synthetic facts model already reverified
// proof inputs; these tests neither execute a VM nor establish client accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Common, Sepolia, Hardfork } from '@ethereumjs/common';
import { recoverAuthorization } from '../authorization-list.js';
import { ethereumCallGas, ethereumCommon } from '../ethereum-profile.js';
import { deriveAmsterdamAuthorizationPreparation as derive, validateAmsterdamAuthorizationProcessing as validate } from '../amsterdam-authorization-validation.js';
import { TEST_KEY, AUTHORITY, TX_SENDER as SENDER, TARGET, DELEGATE, SECOND_DELEGATE, ZERO, designation, signAuthorization } from './authorization-fixture.js';

const header = JSON.parse(readFileSync(new URL('./fixtures/sepolia-network/header-12018196.json', import.meta.url)));
const common = ethereumCommon(header, 11155111), CHAIN = 11155111n;
const ACCOUNT = 183600n, INDICATOR = 35190n, WRITE = 9000n, REGULAR = 16777216n;
const auth = extra => signAuthorization({ chainId: CHAIN, ...extra });
const fact = (extra = {}) => ({ exists: true, nonce: '0', balance: '7', code: '0x', ...extra });
function fixture({ request = {}, accounts = {} } = {}) {
  return { header, common, request: { from: SENDER, to: TARGET, data: '0x', value: '0', gas: '1000000', authorizationList: [auth()], ...request },
    inputs: { accounts: { [SENDER]: fact({ nonce: '1', balance: '1000000000000000000000000' }),
      [TARGET]: fact({ nonce: '1', balance: '0', code: '0x00' }), [AUTHORITY]: fact(), ...accounts } } };
}
function pool(f, amount) {
  f.request.gas = (ethereumCallGas(f.request.data, common, f.request).intrinsic + amount).toString(); return f;
}
const row = (out, key) => out.snapshot.accounts.find(row => row.address === key);
const copy = value => structuredClone(value);

test('independent facts determine empty-account state charges and fee-free materialization', () => {
  for (const input of [{ exists: false }, fact({ balance: '0' }), fact({ balance: '0', storage: { ignored: '7' } })]) {
    const f = fixture({ accounts: { [AUTHORITY]: input } }), before = copy(f.inputs), out = derive(f);
    assert.equal(out.attempt.authorizationGasUsed, WRITE + ACCOUNT + INDICATOR);
    assert.equal(out.attempt.executionStateGasUsed, ACCOUNT + INDICATOR);
    assert.equal(out.processing.gasRefundCounter, '0'); assert.equal(out.retained, true);
    assert.equal(out.accounts.get(AUTHORITY).current.nonce, 1n);
    assert.equal(row(out, AUTHORITY).existence?.basis, input.exists ? undefined : 'eip7702_authorization_materialization');
    assert.deepEqual(f.inputs, before);
  }
  for (const input of [fact(), fact({ nonce: '4', balance: '0' })]) {
    const out = derive(fixture({ request: { authorizationList: [auth({ nonce: BigInt(input.nonce) })] }, accounts: { [AUTHORITY]: input } }));
    assert.equal(out.attempt.executionStateGasUsed, INDICATOR); assert.equal(out.attempt.authorizationGasUsed, WRITE + INDICATOR);
  }
});

test('ordered set-clear-set and original designation cover indicator and first-write costs once', () => {
  for (const original of ['0x', designation(SECOND_DELEGATE)]) {
    const out = derive(fixture({ request: { authorizationList: [auth(), auth({ nonce: 1n, address: ZERO }), auth({ nonce: 2n })] },
      accounts: { [AUTHORITY]: fact({ code: original }) } }));
    assert.deepEqual(out.processing.entries.map(e => e.status), ['applied','applied','applied']);
    assert.equal(out.attempt.authorizationGasUsed, WRITE + (original === '0x' ? INDICATOR : 0n));
    assert.equal(out.accounts.get(AUTHORITY).current.nonce, 3n);
    assert.equal(out.accounts.get(AUTHORITY).current.code, designation(DELEGATE));
    assert.equal(out.attempt.writes[2].codeBefore, '0x');
  }
  const cleared = derive(fixture({ accounts: { [AUTHORITY]: { exists: false } },
    request: { authorizationList: [auth({ address: ZERO }), auth({ nonce: 1n })] } }));
  assert.equal(cleared.attempt.executionStateGasUsed, ACCOUNT + INDICATOR);
  assert.equal(cleared.attempt.authorizationGasUsed, WRITE + ACCOUNT + INDICATOR);
});

test('recovery and skip ordering never uses a claimed authority or warms a designation target', () => {
  const list = [auth({ chainId: 1n }), auth({ nonce: (1n << 64n) - 1n }), auth({ patch: { yParity: '0xff' } }), auth({ nonce: 9n }), auth()];
  const out = derive(fixture({ request: { authorizationList: list } }));
  assert.deepEqual(out.processing.entries.map(e => e.reason), ['wrong_chain','nonce_overflow','invalid_signature','nonce_mismatch',null]);
  assert.deepEqual(out.attempt.accesses, [{ index: 3, authority: AUTHORITY }, { index: 4, authority: AUTHORITY }]);
  assert(!out.accounts.has(DELEGATE));
  for (const code of ['0x00', '0xef0100', designation(DELEGATE) + '00']) {
    const r = derive(fixture({ accounts: { [AUTHORITY]: fact({ nonce: '9', code }) } }));
    assert.equal(r.processing.entries[0].reason, 'authority_has_code'); assert.equal(r.attempt.authorizationGasUsed, 0n);
  }
  const missing = fixture({ request: { authorizationList: list.slice(0,3) } }); delete missing.inputs.accounts[AUTHORITY];
  assert.equal(derive(missing).processing.entries.length, 3);
  missing.request.authorizationList.push(auth()); assert.throws(() => derive(missing));
  assert.equal(derive(fixture({ request: { authorizationList: [auth({ chainId: 0n })] } })).processing.entries[0].status, 'applied');
});

test('outer nonce and fee prepayment precede self-authorization, but snapshot never debits fees', () => {
  const f = fixture({ request: { authorizationList: [auth({ key: TEST_KEY, nonce: 1n }), auth({ key: TEST_KEY, nonce: 2n }), auth({ key: TEST_KEY, nonce: 3n, address: ZERO })],
    executionProfile: 'unsigned_eip1559_block_end', fees: { maxFeePerGas: '100000000000', maxPriorityFeePerGas: '1' } } });
  const out = derive(f);
  assert.deepEqual(out.processing.entries.map(e => e.status), ['skipped','applied','applied']);
  assert.equal(out.attempt.authorizationGasUsed, INDICATOR); assert.equal(out.processing.preparation.senderAuthorizationIncrements, '2');
  assert.equal(out.accounts.get(SENDER).current.nonce, 4n);
  assert.equal(out.accounts.get(SENDER).current.balance, BigInt(f.inputs.accounts[SENDER].balance) - out.feePlan.upfrontGasDebit);
  assert.deepEqual(row(out,SENDER).nonce, { before:'0x1', after:'0x4' });
  assert(out.snapshot.accounts.every(r => !Object.hasOwn(r,'balance')));
  const absent = derive(fixture({ accounts: { [SENDER]: { exists:false } },
    request: { authorizationList: [auth({ key: TEST_KEY, nonce: 1n })] } }));
  assert.equal(row(absent,SENDER).existence.basis, 'eip7702_authorization_materialization');
  assert.equal(absent.attempt.executionStateGasUsed, INDICATOR, 'outer nonce makes the sender nonempty before auth');
  for (const value of ['0','19']) {
    const x = derive(fixture({ request: { to: AUTHORITY, value } }));
    assert.equal(x.attempt.authorizationGasUsed, INDICATOR + (value === '0' ? WRITE : 0n));
    assert.equal(x.recipient.delegationWarm, false); assert.equal(x.recipient.delegationAccessGas, 3000n);
  }
});

test('auth charges are atomic at exact gas, reservoir and spill boundaries', () => {
  for (const reservoir of [0n,50000n,ACCOUNT+INDICATOR,300000n]) {
    const f = fixture({ accounts: { [AUTHORITY]: { exists:false } } });
    if (reservoir) f.request.gas = (REGULAR + reservoir).toString();
    else pool(f, WRITE+ACCOUNT+INDICATOR);
    const out = derive(f), spill = reservoir >= ACCOUNT+INDICATOR ? 0n : ACCOUNT+INDICATOR-reservoir;
    assert.equal(out.attempt.authorizationGasUsed, WRITE+spill); assert.equal(out.attempt.stateGasSpilled, spill);
    assert.equal(out.attempt.stateGasReservoir, reservoir > ACCOUNT+INDICATOR ? reservoir-ACCOUNT-INDICATOR : 0n);
    assert.equal(out.processing.preparation.phase, 'message');
  }
  const short = derive(pool(fixture({ accounts: { [AUTHORITY]: { exists:false } } }), WRITE+ACCOUNT+INDICATOR-1n));
  assert.equal(short.processing.preparation.phase,'authorization_out_of_gas'); assert.equal(short.recipientPreparationGasLimit,null);
  assert.equal(short.processing.preparation.authorizationGasUsed, (WRITE+ACCOUNT+INDICATOR-1n).toString());
  assert.equal(short.attempt.authorizationGasUsed,0n); assert.equal(short.attempt.writes.length,0);
  assert.equal(short.processing.preparation.executionStateGasUsed,'0'); assert.equal(short.applied.size,0);
  assert.deepEqual(row(short,SENDER).nonce,{before:'0x1',after:'0x2'}); assert.equal(row(short,AUTHORITY),undefined);
});

test('late auth OOG retains attempted entries but rolls back all authorization state', () => {
  const second = auth({ key: '0x'+'03'.repeat(32) }), other = recoverAuthorization(second,CHAIN).authority;
  const out = derive(pool(fixture({ request: { authorizationList: [auth(),second,auth({ nonce:1n })] },
    accounts: { [other]:{exists:false} } }),50000n));
  assert.deepEqual(out.processing.entries.map(e=>e.status),['applied','out_of_gas']);
  assert.equal(out.processing.preparation.failedIndex,1); assert.equal(out.processing.preparation.authorizationGasUsed,'50000');
  assert.equal(out.attempt.authorizationGasUsed,WRITE+INDICATOR); assert.equal(out.attempt.writes.length,1);
  assert.equal(out.attempt.accounts.get(AUTHORITY).current.nonce,1n);
  assert.equal(out.accounts.get(AUTHORITY).current.nonce,0n); assert.equal(out.accounts.get(AUTHORITY).current.code,'0x');
  assert.equal(out.processing.preparation.stateGasSpilled,'0'); assert.equal(out.processing.preparation.senderAuthorizationIncrements,'0');
  assert.deepEqual(out.snapshot.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
});

test('recipient value and delegation preparation independently predict OOG after the ordered auth fold', () => {
  const spent = WRITE+INDICATOR;
  for (const extra of [ACCOUNT-1n,ACCOUNT]) {
    const out = derive(pool(fixture({ request:{value:'1'},accounts:{[TARGET]:{exists:false}} }),spent+extra));
    assert.equal(out.recipientPreparationGasLimit,extra); assert.equal(out.recipient.stateGas,ACCOUNT);
    assert.equal(out.processing.preparation.phase,extra===ACCOUNT?'message':'recipient_out_of_gas');
    assert.equal(out.processing.preparation.authorizationGasUsed,spent.toString());
    assert.equal(out.accounts.get(AUTHORITY).current.nonce,extra===ACCOUNT?1n:0n);
    assert.equal(out.processing.preparation.executionStateGasUsed,extra===ACCOUNT?INDICATOR.toString():'0');
  }
  for (const warm of [false,true]) for (const remaining of [99n,100n,2999n,3000n]) {
    const out = derive(pool(fixture({ request: warm?{accessList:[{address:DELEGATE,storageKeys:[]}]}:{},
      accounts:{[TARGET]:fact({nonce:'1',code:designation(DELEGATE)})} }),spent+remaining));
    const charge = warm?100n:3000n;
    assert.equal(out.recipient.delegationAccessGas,charge);
    assert.equal(out.processing.preparation.phase,remaining>=charge?'message':'recipient_out_of_gas');
    assert.equal(out.recipientPreparationGasLimit,remaining);
  }
  // A recovered-but-skipped authority is warm; merely installing a delegation
  // does not warm its target. Neither case needs a target code proof here.
  const skipped = derive(pool(fixture({ request:{authorizationList:[auth({nonce:9n})]},
    accounts:{[TARGET]:fact({nonce:'1',code:designation(AUTHORITY)})} }),100n));
  assert.equal(skipped.recipient.delegationWarm,true); assert.equal(skipped.processing.preparation.phase,'message');
});

test('strict metadata binds phase, counters, retained state and entries without invoking accessors', () => {
  const out = derive(fixture()); assert.equal(validate(out,copy(out.processing)),out);
  for (const mutate of [x=>x.preparation.phase='recipient_out_of_gas',x=>x.preparation.retained=false,
    x=>x.preparation.authorizationGasUsed='0',x=>x.preparation.executionStateGasUsed='035190',
    x=>x.preparation.senderAuthorizationIncrements='1',x=>x.preparation.failedIndex=0,x=>x.gasRefundCounter='12500',
    x=>x.entries[0].authority=SENDER,x=>x.entries[0].status='skipped',x=>x.entries.push(copy(x.entries[0])),
    x=>x.preparation.after={nonce:'1'},x=>delete x.preparation.stateGasReservoir]) {
    const bad=copy(out.processing);mutate(bad);assert.throws(()=>validate(out,bad));
  }
  let invoked=false; const bad=copy(out.processing);
  Object.defineProperty(bad.preparation,'phase',{enumerable:true,get(){invoked=true;return 'message';}});
  assert.throws(()=>validate(out,bad));assert.equal(invoked,false);
  const array=copy(out.processing);Object.defineProperty(array.entries,'0',{enumerable:true,get(){invoked=true;return out.processing.entries[0];}});
  assert.throws(()=>validate(out,array));assert.equal(invoked,false);
});

test('trusted fork, strict starting facts and envelope checks fail closed without mutating inputs', () => {
  assert.equal(derive({request:{},header:null,inputs:null,common:null}),null);
  const invalid = [f=>f.common=new Common({chain:Sepolia,hardfork:Hardfork.Osaka}),f=>f.common={chainId:()=>2n},
    f=>f.header={...header,timestamp:'0x1'},f=>f.request.to=null,f=>f.request.blobVersionedHashes=[],
    f=>f.inputs.accounts[SENDER].nonce=((1n<<64n)-1n).toString(),f=>f.inputs.accounts[SENDER].balance='01',
    f=>f.inputs.accounts[SENDER].code='0x00',f=>f.inputs.accounts[AUTHORITY].balance=(1n<<256n).toString(),
    f=>f.inputs.accounts[AUTHORITY]={exists:false,nonce:'0'},f=>delete f.inputs.accounts[TARGET],
    f=>{f.request.value='8';f.inputs.accounts[SENDER].balance='7';}];
  for(const mutate of invalid){const f=fixture();mutate(f);assert.throws(()=>derive(f));}
  let invoked=false;const f=fixture();Object.defineProperty(f.inputs.accounts[AUTHORITY],'nonce',{enumerable:true,get(){invoked=true;return '0';}});
  assert.throws(()=>derive(f));assert.equal(invoked,false);
});
