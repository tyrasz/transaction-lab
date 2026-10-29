// Offline synthetic MPT proofs and actual isolated children. These controls
// establish parent arithmetic/context checks, not independent-client agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { deriveVerifiedGas } from '../gas-validation.js';
import { deriveVerifiedFees } from '../fee-validation.js';
import { ethereumCallGas, ethereumCommon } from '../ethereum-profile.js';
import { ethereumStateGasBudget, settleEthereumStateGas } from '../ethereum-state-gas.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { feeFixture, TX_SENDER, TARGET, word, bytes } from './fee-fixture.js';
import { integer } from './proof-fixture.js';

const CHAIN = 11155111;
const template = JSON.parse(readFileSync(new URL('./fixtures/sepolia-network/header-12018196.json', import.meta.url)));
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash','blockAccessListHash','slotNumber'];
const numeric = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas','slotNumber']);
const strings = row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
async function fixture({ priced = false, ...options } = {}) {
  const f = await feeFixture(options), { stateRoot, miner, baseFeePerGas } = f.header;
  Object.assign(f.header, template, { stateRoot, miner, baseFeePerGas, gasUsed: '0x0', blobGasUsed: '0x0' });
  f.header.hash = '0x' + Buffer.from(keccak_256(RLP.encode(order.map(key => numeric.has(key) ? integer(BigInt(f.header[key])) : bytes(f.header[key]))))).toString('hex');
  assert.equal(verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: CHAIN }).hardfork, 'amsterdam');
  if (!priced) { delete f.request.executionProfile; delete f.request.fees; }
  return f;
}
const options = f => ({ request: f.request, header: f.header, rpc: f.rpc, chainId: CHAIN });
const run = f => executeIsolatedEthereumCall(options(f));
function recount(output) {
  output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs,
    ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}),
    ...(output.authorizationProcessing ? { authorizationProcessing: output.authorizationProcessing } : {}),
    ...(output.feeAccounting ? { feeAccounting: output.feeAccounting } : {}),
    ...(output.stateGasAccounting ? { stateGasAccounting: output.stateGasAccounting } : {}) }));
}
async function tamper(t, change, make = () => fixture()) {
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...args) {
      if (event === 'message' && typeof args[0] === 'string') {
        const message = JSON.parse(args[0]);
        if (message.type === 'result') { change(message.result); changed = true; args[0] = JSON.stringify(message); }
      }
      return emit.call(this, event, ...args);
    }; return child;
  });
  try {
    const result = await run(await make()); assert.equal(changed, true);
    assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(result.output, null); assert.equal(result.isolation.processClosed, true);
  } finally { mock.mock.restore(); }
}
function synthetic(f, patch = {}) {
  const costs = ethereumCallGas(f.request.data, ethereumCommon(f.header, CHAIN), f.request);
  const budget = ethereumStateGasBudget({ gasLimit: BigInt(f.request.gas), intrinsicRegular: costs.intrinsic, floor: costs.floor }, ethereumCommon(f.header, CHAIN));
  const counters = { messageGasUsed: 100000n, authorizationGasUsed: 0n, stateGasReservoir: 0n, executionStateGasUsed: 0n,
    messageRefundCounter: 0n, authorizationRefundCounter: 0n, postTargetOutOfGas: false, ...patch };
  const settled = settleEthereumStateGas(budget, counters);
  return { execution: { status: 'success', error: null, executionGasUsed: counters.messageGasUsed.toString(),
    executionStateGasUsed: counters.executionStateGasUsed.toString(), gasRefundCounter: counters.messageRefundCounter.toString() },
    stateGasAccounting: { budget: strings(budget), counters: strings(counters), settled: strings(settled) }, gasAccounting: strings(settled) };
}

test('canonical Amsterdam arithmetic preserves signed reservoir refills and independently rejects impossible final counters', async () => {
  const f = await fixture(), output = synthetic(f, { stateGasReservoir: 500n, messageRefundCounter: 30000n });
  const args = { request: f.request, header: f.header, output, chainId: CHAIN };
  assert.equal(deriveVerifiedGas(args).reservoirDelta, -500n);
  assert.equal(deriveVerifiedGas(args).gasUsed, 91600n);
  for (const change of [
    o => { o.stateGasAccounting.counters.executionStateGasUsed = '-1'; o.execution.executionStateGasUsed = '-1'; },
    o => { o.stateGasAccounting.counters.stateGasReservoir = '200000'; },
    o => { o.stateGasAccounting.counters.postTargetOutOfGas = true; },
    o => { o.stateGasAccounting.counters.authorizationGasUsed = '1'; },
    o => { o.stateGasAccounting.counters.authorizationRefundCounter = '1'; },
    o => { o.stateGasAccounting.settled.regularGasUsed = '0'; },
  ]) { const changed = structuredClone(output); change(changed); assert.throws(() => deriveVerifiedGas({ ...args, output: changed })); }
});

test('accounting rejects noncanonical values, extra keys, hidden fields and hostile objects before coercion', async () => {
  const f = await fixture(), original = synthetic(f), args = { request: f.request, header: f.header, chainId: CHAIN };
  for (const value of ['00','01','+1','-0','0x1',' 1',1,null,(1n<<256n).toString()]) {
    const output = structuredClone(original); output.stateGasAccounting.counters.messageGasUsed = value;
    assert.throws(() => deriveVerifiedGas({ ...args, output }));
  }
  for (const change of [
    a => { delete a.budget.floor; }, a => { a.budget.extra = '0'; }, a => { a.counters.postTargetOutOfGas = 'false'; },
    a => { a.settled[Symbol('extra')] = '0'; }, a => { Object.defineProperty(a.budget, 'floor', { enumerable: false }); },
  ]) { const output = structuredClone(original); change(output.stateGasAccounting); assert.throws(() => deriveVerifiedGas({ ...args, output })); }
  let touched = false;
  for (const hostile of [
    new Proxy(original.stateGasAccounting.counters, { ownKeys() { touched = true; throw Error('trap'); } }),
    Object.defineProperty({ ...original.stateGasAccounting.counters }, 'messageGasUsed', { enumerable: true, get() { touched = true; return '100000'; } }),
  ]) { const output = structuredClone(original); output.stateGasAccounting.counters = hostile; assert.throws(() => deriveVerifiedGas({ ...args, output })); }
  assert.equal(touched, false);
});

test('actual Sepolia child binds native transfer, CHAINID, slot number and complete split gas dimensions', async () => {
  for (const target of [{ nonce: 1n, code: '0x00' }, null]) {
    const f = await fixture({ target, value: '17' }), result = await run(f);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.output.execution.status, 'success');
    const o = result.output; assert.equal(o.environment.chainId, CHAIN); assert.equal(o.environment.slotNumber, BigInt(template.slotNumber).toString());
    assert.equal(o.execution.executionStateGasUsed, target ? '0' : '183600');
    assert.equal(o.stateGasAccounting.counters.executionStateGasUsed, o.execution.executionStateGasUsed);
    assert.deepEqual(o.gasAccounting, o.stateGasAccounting.settled); assert.equal(o.gasAccounting.gasUsed, target ? '21000' : '204600');
    assert.equal(result.changes.accounts.find(r => r.address === TARGET).balance.after, '0x11');
    assert.equal(result.inputs.context.chainId, CHAIN); assert.equal(result.headerVerification.chainId, CHAIN);
  }
  const f = await fixture({ target: { nonce: 1n, code: '0x4660005260206000f3' } }), result = await run(f);
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(BigInt(result.output.execution.returnData), BigInt(CHAIN));
});

test('actual Amsterdam storage allocation/refund and revert retain their separately recomputed gas and fee effects', async () => {
  for (const [code, storage, status] of [['0x600160005500', {}, 'success'], ['0x600060005500', { [word(0)]: 7n }, 'success'], ['0x600160005560006000fd', {}, 'reverted'], ['0xfe', {}, 'failed']]) {
    const f = await fixture({ priced: true, target: { nonce: 1n, code, storage } }), r = await run(f);
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(r.output.execution.status, status);
    const o = r.output, gas = deriveVerifiedGas({ request: f.request, header: f.header, output: o, chainId: CHAIN });
    assert.equal(o.feeAccounting.chargedGas, gas.gasUsed.toString()); assert.equal(o.feeAccounting.gasCharge, (gas.gasUsed * 10n).toString());
    assert.deepEqual(deriveVerifiedFees({ request: f.request, header: f.header, inputs: r.inputs, output: o, chainId: CHAIN }).accounting, o.feeAccounting);
    if (storage[word(0)]) assert(BigInt(o.stateGasAccounting.counters.messageRefundCounter) > 0n);
    if (status === 'reverted') { assert.equal(o.execution.executionStateGasUsed, '0'); assert(!r.changes.accounts.some(row => row.storage)); }
    if (status === 'failed') assert.equal(o.feeAccounting.chargedGas, f.request.gas);
  }
});

test('actual cross-frame storage refill retains a negative reservoir delta without inventing negative final state usage', async () => {
  const child = '0x' + '55'.repeat(20);
  const delegate = '600060006000600073' + child.slice(2) + '620f4240f45000';
  const f = await fixture({ target: { nonce: 1n, code: '0x6001600055' + delegate },
    accounts: { [child]: { nonce: 1n, code: '0x600060005500' } } });
  const r = await run(f); assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(r.output.execution.status, 'success');
  const a = r.output.stateGasAccounting;
  assert(BigInt(a.counters.stateGasReservoir) > BigInt(a.budget.stateGasReservoirInitial));
  assert(BigInt(a.settled.reservoirDelta) < 0n); assert.equal(a.counters.executionStateGasUsed, '0');
  assert.equal(a.settled.stateGasUsed, '0'); assert(!r.changes.accounts.some(row => row.storage));
});

test('parent rejects changed budgets, counter bindings, settlement, trace accounting and priced charges from actual children', async t => {
  for (const change of [
    o => { delete o.stateGasAccounting; },
    o => { o.stateGasAccounting.budget.gasLimit = '4999999'; },
    o => { o.stateGasAccounting.budget.intrinsicRegular = '21000'; },
    o => { o.stateGasAccounting.counters.messageGasUsed = '1'; },
    o => { o.stateGasAccounting.counters.executionStateGasUsed = '1'; },
    o => { o.stateGasAccounting.counters.messageRefundCounter = '1'; },
    o => { o.stateGasAccounting.counters.authorizationGasUsed = '1'; },
    o => { o.stateGasAccounting.counters.authorizationRefundCounter = '1'; },
    o => { o.stateGasAccounting.counters.postTargetOutOfGas = true; },
    o => { o.stateGasAccounting.settled.blockGasUsed = '0'; },
    o => { o.gasAccounting.gasUsed = '0'; },
    o => { o.environment.slotNumber = '1'; },
    o => { o.profile.chainId = 1; },
  ]) await tamper(t, r => { change(r.output); recount(r.output); });
  await tamper(t, r => { r.output.usage.retainedTraceBytes--; });
  await tamper(t, r => { r.output.feeAccounting.chargedGas = '21000'; recount(r.output); }, () => fixture({ priced: true }));
});

test('Sepolia native and disposable CALL queries retain chain identity and fresh unpriced Amsterdam gas accounting', async () => {
  const f = await fixture({ priced: true, target: { nonce: 1n, code: '0x4660005260206000f3' } });
  const queries = [{ kind: 'native_balance', account: TX_SENDER }, { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') }];
  const result = await executeIsolatedEthereumPreview({ ...options(f), queries });
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.preview.status, 'complete');
  const p = result.preview; assert.equal(p.scope.chainId, CHAIN); assert(p.measurements.every(m => m.identity.chainId === String(CHAIN)));
  assert.equal(p.measurements[0].values[0].deltaRaw, '-' + p.original.output.feeAccounting.gasCharge);
  assert.equal(p.measurements[1].values[0].beforeRaw, String(CHAIN)); assert.equal(p.measurements[1].values[0].afterRaw, String(CHAIN));
  for (const side of ['before','after']) {
    const o = p.measurements[1][side].output; assert.equal(o.profile.feesSettled, false); assert.equal(o.feeAccounting, undefined);
    assert.equal(o.stateGasAccounting.budget.gasLimit, '1000000'); assert.equal(o.environment.chainId, CHAIN);
    assert.deepEqual(o.gasAccounting, o.stateGasAccounting.settled);
  }
});
