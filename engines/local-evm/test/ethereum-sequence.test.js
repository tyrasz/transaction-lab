// Actual local-core sequence regressions over synthetic initial proofs.
// No public protocol/network evidence or independent reference-client claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEthereumSequence } from '../ethereum-sequence.js';
import { feeFixture } from './fee-fixture.js';
import { word } from './proof-fixture.js';
import { sequenceFixture, SEQUENCE_SENDER, SEQUENCE_TOKEN, SEQUENCE_VAULT, SEQUENCE_RECIPIENT, encodeSequenceCall, balanceSlot, allowanceSlot, shareSlot } from './sequence-fixture.js';

const native = account => ({ kind: 'native_balance', account });
const balance = (to, owner) => ({ to, data: encodeSequenceCall('balanceOf', [owner]) });
const allowance = () => ({ to: SEQUENCE_TOKEN, data: encodeSequenceCall('allowance', [SEQUENCE_SENDER, SEQUENCE_VAULT]) });
const run = (f, requests, queries = [native(SEQUENCE_SENDER)], extra = {}) => executeEthereumSequence({ requests, header: f.header, chainId: f.chainId, rpc: f.rpc, queries, ...extra });
const row = (changes, address) => changes.accounts.find(a => a.address === address);
const field = (f, changes, address, key) => BigInt(row(changes, address)?.[key]?.after ?? f.allocation[address]?.[key] ?? 0);
const slot = (f, changes, address, key) => BigInt(row(changes, address)?.storage?.find(s => s.slot === key)?.after ?? f.allocation[address]?.storage[key] ?? 0);
const summary = result => ({ status: result.status, error: result.error, steps: result.steps.map(s => ({ status: s.status, reason: s.reason, execution: s.original?.output?.execution, measurements: s.measurements.map(m => ({ status: m.status, reason: m.reason })) })) });
function success(result, count) {
  assert.equal(result.status, 'complete', JSON.stringify(summary(result)));
  assert.equal(result.steps.length, count); assert(result.steps.every(s => s.status === 'completed' && s.original.output.execution.status === 'success'));
}
function measure(step, index, before, after) {
  const m = step.measurements[index]; assert.equal(m.status, 'measured', m.reason);
  assert.equal(m.values.length, 1); assert.deepEqual(Object.fromEntries(['beforeRaw', 'afterRaw', 'deltaRaw'].map(k => [k, m.values[0][k]])), { beforeRaw: String(before), afterRaw: String(after), deltaRaw: (BigInt(after) - BigInt(before)).toString() });
}
function tokenState(f, changes) {
  return { sender: slot(f, changes, SEQUENCE_TOKEN, balanceSlot(SEQUENCE_SENDER)), vault: slot(f, changes, SEQUENCE_TOKEN, balanceSlot(SEQUENCE_VAULT)), recipient: slot(f, changes, SEQUENCE_TOKEN, balanceSlot(SEQUENCE_RECIPIENT)), allowance: slot(f, changes, SEQUENCE_TOKEN, allowanceSlot(SEQUENCE_SENDER, SEQUENCE_VAULT)), shares: slot(f, changes, SEQUENCE_VAULT, shareSlot(SEQUENCE_SENDER)) };
}

for (const fork of ['osaka', 'amsterdam']) test(`${fork}: approve → deposit → transfer → withdraw carries actual token and share storage`, async () => {
  const f = await sequenceFixture({ fork }), r = f.requests;
  const queries = [allowance(), balance(SEQUENCE_TOKEN, SEQUENCE_SENDER), balance(SEQUENCE_TOKEN, SEQUENCE_VAULT), balance(SEQUENCE_VAULT, SEQUENCE_SENDER)];
  const result = await run(f, [r.approve, r.deposit, r.transfer, r.withdraw], queries); success(result, 4);
  const expected = [
    { sender: 1000n, vault: 0n, recipient: 0n, allowance: 100n, shares: 0n },
    { sender: 900n, vault: 100n, recipient: 0n, allowance: 0n, shares: 100n },
    { sender: 875n, vault: 100n, recipient: 25n, allowance: 0n, shares: 100n },
    { sender: 915n, vault: 60n, recipient: 25n, allowance: 0n, shares: 60n },
  ];
  let before = { sender: 1000n, vault: 0n, allowance: 0n, shares: 0n };
  for (let i = 0; i < 4; i++) {
    const step = result.steps[i]; assert.deepEqual(tokenState(f, step.original.changes), expected[i]);
    assert.equal(field(f, step.original.changes, SEQUENCE_SENDER, 'nonce'), BigInt(i + 2));
    if (i) assert.deepEqual(step.original.startingChanges, result.steps[i - 1].original.changes);
    for (const [index, key] of ['allowance', 'sender', 'vault', 'shares'].entries()) measure(step, index, before[key], expected[i][key]);
    before = expected[i];
  }
  assert.deepEqual(result.steps.map(s => s.original.output.logs.length), [1, 2, 1, 2]);
  assert.equal(result.scope.atomic, false); assert.equal(result.scope.stateFeeds, 'originals_only');
  assert.equal(result.scope.ordering, 'all_originals_before_disposable_queries');
  assert.equal(result.usage.executions, 4 + 4 * 4 * 2);
});

for (const fork of ['osaka', 'amsterdam']) test(`${fork}: priced originals retain cumulative sender nonce, charge, and coinbase tip`, async () => {
  const f = await sequenceFixture({ fork, priced: true });
  const result = await run(f, [f.requests.approve, f.requests.deposit], [native(SEQUENCE_SENDER), native(f.addresses.coinbase)]); success(result, 2);
  let totalGas = 0n;
  for (let i = 0; i < 2; i++) {
    const step = result.steps[i], gas = BigInt(step.original.output.gasAccounting.gasUsed), beforeGas = totalGas; totalGas += gas;
    assert(gas > 0n); assert.equal(field(f, step.original.changes, SEQUENCE_SENDER, 'nonce'), BigInt(i + 2));
    assert.equal(field(f, step.original.changes, SEQUENCE_SENDER, 'balance'), BigInt(f.allocation[SEQUENCE_SENDER].balance) - totalGas * 10n);
    assert.equal(field(f, step.original.changes, f.addresses.coinbase, 'balance'), totalGas * 3n);
    measure(step, 0, BigInt(f.allocation[SEQUENCE_SENDER].balance) - beforeGas * 10n, BigInt(f.allocation[SEQUENCE_SENDER].balance) - totalGas * 10n);
    measure(step, 1, beforeGas * 3n, totalGas * 3n);
  }
  assert.deepEqual(result.scope.feesSettled, [true, true]); assert.equal(result.usage.executions, 2, 'Native reads must not execute extra EVM calls');
});

for (const [method, status] of [['depositThenRevert', 'reverted'], ['depositThenOutOfGas', 'failed']]) test(`${method}: completed failure rolls back token/share writes, retains approval and fees, then stops`, async () => {
  const f = await sequenceFixture({ priced: true }), r = f.requests;
  const result = await run(f, [r.approve, r[method], r.transfer, r.withdraw], [allowance(), balance(SEQUENCE_TOKEN, SEQUENCE_SENDER), balance(SEQUENCE_VAULT, SEQUENCE_SENDER)]);
  assert.equal(result.status, 'partial', JSON.stringify(summary(result))); assert.equal(result.error, null);
  assert.deepEqual(result.steps.map(s => s.status), ['completed', 'completed', 'not_attempted', 'not_attempted']);
  const [first, failed] = result.steps; assert.equal(first.original.output.execution.status, 'success'); assert.equal(failed.original.output.execution.status, status);
  assert(failed.original.output.trace.calls.some(c => c.to === SEQUENCE_TOKEN && c.error === null), 'Token child must have returned successfully before the later parent failure');
  assert.equal(failed.original.output.logs.length, 0);
  assert(failed.original.output.usage.logOpcodes >= 2, 'Token transfer and vault deposit logs must execute after their writes before the parent failure discards them');
  assert.deepEqual(failed.original.startingChanges, first.original.changes);
  assert.deepEqual(tokenState(f, failed.original.changes), { sender: 1000n, vault: 0n, recipient: 0n, allowance: 100n, shares: 0n });
  const charged = result.steps.slice(0, 2).reduce((n, s) => n + BigInt(s.original.output.gasAccounting.gasUsed), 0n);
  assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'nonce'), 3n);
  assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'balance'), BigInt(f.allocation[SEQUENCE_SENDER].balance) - charged * 10n);
  assert.equal(field(f, failed.original.changes, f.addresses.coinbase, 'balance'), charged * 3n);
  measure(failed, 0, 100n, 100n); measure(failed, 1, 1000n, 1000n); measure(failed, 2, 0n, 0n);
  for (const step of result.steps.slice(2)) { assert.equal(step.original, null); assert(step.measurements.every(m => m.status === 'not_attempted' && m.values === null)); }
  assert.deepEqual(result.scope.feesSettled, [true, true, false, false]);
  if (method === 'depositThenOutOfGas') assert.equal(failed.original.output.gasAccounting.gasUsed, r[method].gas);
});

test('every original finishes before query-only input is demanded, including a failing query proof', async () => {
  const f = await sequenceFixture(), querySlot = balanceSlot(SEQUENCE_RECIPIENT); let queryAttempts = 0;
  const rpc = { async call(method, params, options) {
    if (method === 'eth_getProof' && params[0] === SEQUENCE_TOKEN && params[1].includes(querySlot)) { queryAttempts++; throw Error('Declared query-only proof is deliberately unavailable'); }
    return f.rpc.call(method, params, options);
  } };
  const result = await run(f, [f.requests.approve, f.requests.deposit], [balance(SEQUENCE_TOKEN, SEQUENCE_RECIPIENT)], { rpc });
  assert.equal(result.status, 'partial', JSON.stringify(summary(result))); assert.equal(queryAttempts, 1);
  assert(result.steps.every(s => s.status === 'completed' && s.original.output.execution.status === 'success'));
  for (const step of result.steps) assert(!step.original.inputEvidence.some(e => e.request.method === 'eth_getProof' && e.request.params[1].includes(querySlot)), 'Query proof entered an original input snapshot');
  assert.deepEqual(tokenState(f, result.steps[1].original.changes), { sender: 900n, vault: 100n, recipient: 0n, allowance: 0n, shares: 100n });
  assert(result.steps.every(s => s.measurements[0].values === null));
});

test('root-return budget is shared across originals while native probes do not spend execution budget', async () => {
  const f = await sequenceFixture();
  const result = await run(f, [f.requests.approve, f.requests.deposit], [native(SEQUENCE_SENDER)], { limits: { rootReturnBytes: 32 } });
  assert.equal(result.status, 'partial', JSON.stringify(summary(result))); assert.equal(result.usage.executions, 1); assert.equal(result.usage.rootReturnBytes, 32);
  assert.equal(result.steps[0].status, 'completed'); assert.equal(result.steps[1].status, 'not_attempted'); assert.equal(result.steps[1].original, null);
  assert.deepEqual(tokenState(f, result.steps[0].original.changes), { sender: 1000n, vault: 0n, recipient: 0n, allowance: 100n, shares: 0n });
  measure(result.steps[0], 0, BigInt(f.allocation[SEQUENCE_SENDER].balance), BigInt(f.allocation[SEQUENCE_SENDER].balance));
  assert.equal(result.steps[1].measurements[0].status, 'not_attempted');
});

test('mutating balanceOf-shaped probes are withheld and independent queries retain each original snapshot', async () => {
  const base = await sequenceFixture(), mutator = '0x' + '74'.repeat(20);
  const accounts = Object.fromEntries(Object.entries(base.allocation).map(([address, a]) => [address, { nonce: BigInt(a.nonce), balance: BigInt(a.balance), code: a.code, storage: Object.fromEntries(Object.entries(a.storage).map(([k, v]) => [k, BigInt(v)])) }]));
  accounts[mutator] = { nonce: 1n, balance: 0n, code: '0x60005460010160005560005460005260206000f3', storage: { [word(0)]: 7n } };
  const proof = await feeFixture({ fork: 'osaka', baseFee: 0n, maxFee: 0n, priorityFee: 0n, target: null, accounts });
  const f = { ...base, ...proof, chainId: 1 };
  const result = await run(f, [base.requests.approve, base.requests.deposit], [balance(mutator, SEQUENCE_SENDER), allowance(), balance(SEQUENCE_VAULT, SEQUENCE_SENDER)]);
  assert.equal(result.status, 'partial', JSON.stringify(summary(result))); assert.equal(result.error, null);
  for (const step of result.steps) {
    assert.equal(step.status, 'completed'); assert.equal(step.original.output.execution.status, 'success'); assert.equal(row(step.original.changes, mutator), undefined);
    const m = step.measurements[0]; assert.equal(m.status, 'unavailable'); assert.equal(m.values, null); assert.equal(m.before.output.execution.status, 'success'); assert.equal(m.before.output.execution.returnData, word(8)); assert.equal(m.after, null);
    assert.equal(row(m.before.changesAfter, mutator).storage[0].after, word(8));
  }
  measure(result.steps[0], 1, 0n, 100n); measure(result.steps[1], 1, 100n, 0n);
  measure(result.steps[0], 2, 0n, 0n); measure(result.steps[1], 2, 0n, 100n);
  assert.deepEqual(result.steps[1].original.startingChanges, result.steps[0].original.changes);
  assert.deepEqual(tokenState(f, result.steps[1].original.changes), { sender: 900n, vault: 100n, recipient: 0n, allowance: 0n, shares: 100n });
});
