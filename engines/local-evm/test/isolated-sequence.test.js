// Real fixed-worker/parent controls over authenticated synthetic initial state.
// No public deployment, RPC, signed replay or independent-client accuracy claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumSequence } from '../isolated-call.js';
import { sequenceFixture, SEQUENCE_SENDER, SEQUENCE_TOKEN, SEQUENCE_VAULT, SEQUENCE_RECIPIENT,
  encodeSequenceCall, balanceSlot, allowanceSlot, shareSlot } from './sequence-fixture.js';

const LIMITS = { wallMs: 30000, requestMs: 2000, drainMs: 1000, killWaitMs: 1000, execution: { wallMs: 20000 } };
const native = account => ({ kind: 'native_balance', account });
const balance = (to, owner) => ({ to, data: encodeSequenceCall('balanceOf', [owner]) });
const allowance = { to: SEQUENCE_TOKEN, data: encodeSequenceCall('allowance', [SEQUENCE_SENDER, SEQUENCE_VAULT]) };
const queries = [allowance, balance(SEQUENCE_TOKEN, SEQUENCE_SENDER), balance(SEQUENCE_VAULT, SEQUENCE_SENDER), native(SEQUENCE_SENDER)];
const row = (changes, address) => changes.accounts.find(item => item.address === address);
const quantity = n => '0x' + BigInt(n).toString(16);
const field = (f, changes, address, name) => BigInt(row(changes, address)?.[name]?.after ?? f.allocation[address]?.[name] ?? 0);
const storage = (f, changes, address, slot) => BigInt(row(changes, address)?.storage?.find(item => item.slot === slot)?.after ?? f.allocation[address]?.storage[slot] ?? 0);
const run = (f, requests = [f.requests.approve, f.requests.deposit], queryList = queries, extra = {}) => executeIsolatedEthereumSequence({
  requests, header: f.header, chainId: f.chainId, rpc: f.rpc, queries: queryList, limits: LIMITS, ...extra,
});
function closed(result) {
  assert.equal(result.isolation?.processSeparated, true);
  assert.equal(result.isolation.processClosed, true);
  assert.notEqual(result.isolation.childPid, process.pid);
  assert.equal(result.broker.pendingAtReturn, 0);
}
function accepted(result, status = 'complete') {
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.error, null);
  assert.equal(result.sequence.status, status, JSON.stringify(result.sequence.error));
  closed(result); assert.equal(result.isolation.exitCode, 0); assert.equal(result.isolation.exitSignal, null);
}
function measured(step, index, before, after) {
  const value = step.measurements[index]; assert.equal(value.status, 'measured', value.reason);
  assert.equal(value.values.length, 1);
  assert.deepEqual(Object.fromEntries(['beforeRaw', 'afterRaw', 'deltaRaw'].map(key => [key, value.values[0][key]])), {
    beforeRaw: String(before), afterRaw: String(after), deltaRaw: (BigInt(after) - BigInt(before)).toString(),
  });
}
function originalPrefix(f, sequence) {
  for (let i = 0; i < sequence.steps.length; i++) {
    const original = sequence.steps[i].original;
    if (!original) continue;
    assert.deepEqual(original.startingChanges, i === 0 ? { scope: original.changes.scope, accounts: [] } : sequence.steps[i - 1].original.changes);
    assert.deepEqual(original.inputEvidence, sequence.inputEvidence.slice(0, original.inputUsage.calls));
    assert.equal(original.inputs.context.blockHash, f.header.hash);
    assert.equal(original.inputs.context.chainId, f.chainId);
  }
}

for (const [fork, priced] of [['osaka', false], ['amsterdam', true]]) test(`${fork}: actual isolated approve → deposit binds carried state and per-step measurements`, async () => {
  const f = await sequenceFixture({ fork, priced });
  const result = await run(f, undefined, [...queries, native(f.addresses.coinbase)]); accepted(result);
  const s = result.sequence; originalPrefix(f, s);
  assert.deepEqual(s.steps.map(step => step.status), ['completed', 'completed']);
  assert.deepEqual(s.steps.map(step => step.original.output.execution.status), ['success', 'success']);
  const [approve, deposit] = s.steps;
  measured(approve, 0, 0, 100); measured(deposit, 0, 100, 0);
  measured(approve, 1, 1000, 1000); measured(deposit, 1, 1000, 900);
  measured(approve, 2, 0, 0); measured(deposit, 2, 0, 100);
  let charged = 0n;
  for (const [index, step] of s.steps.entries()) {
    const prior = charged; charged += priced ? BigInt(step.original.output.feeAccounting.gasCharge) : 0n;
    assert.equal(field(f, step.original.changes, SEQUENCE_SENDER, 'nonce'), BigInt(index + 2));
    measured(step, 3, BigInt(f.allocation[SEQUENCE_SENDER].balance) - prior, BigInt(f.allocation[SEQUENCE_SENDER].balance) - charged);
    const tipBefore = priced ? prior * 3n / 10n : 0n, tipAfter = priced ? charged * 3n / 10n : 0n;
    measured(step, 4, tipBefore, tipAfter);
    for (const m of step.measurements) {
      assert.equal(m.identity.chainId, String(f.chainId));
      assert.deepEqual(m.before.changesBefore, step.original.startingChanges);
      assert.deepEqual(m.after.changesBefore, step.original.changes);
      for (const side of [m.before, m.after]) assert(side.inputEvidenceIds.every(id => id > deposit.original.inputUsage.calls));
    }
    if (priced) assert.equal(step.original.output.profile.hardfork, 'amsterdam');
  }
  assert.equal(storage(f, deposit.original.changes, SEQUENCE_TOKEN, balanceSlot(SEQUENCE_VAULT)), 100n);
  assert.equal(storage(f, deposit.original.changes, SEQUENCE_VAULT, shareSlot(SEQUENCE_SENDER)), 100n);
  assert.deepEqual(s.scope.feesSettled, [priced, priced]);
  assert.equal(s.scope.ordering, 'all_originals_before_disposable_queries');
  assert.equal(s.scope.atomic, false); assert.equal(s.scope.stateFeeds, 'originals_only');
  assert.equal(s.usage.executions, 14, 'Two originals and twelve disposable CALLs; native reads are not EVM executions');
});

for (const [method, outcome] of [['depositThenRevert', 'reverted'], ['depositThenOutOfGas', 'failed']]) test(`actual isolated ${method} preserves earlier approval and current fees, then stops`, async () => {
  const f = await sequenceFixture({ priced: true }), r = f.requests;
  const result = await run(f, [r.approve, r[method], r.transfer, r.withdraw]); accepted(result, 'partial');
  const s = result.sequence, [first, failed] = s.steps; originalPrefix(f, s);
  assert.deepEqual(s.steps.map(step => step.status), ['completed', 'completed', 'not_attempted', 'not_attempted']);
  assert.equal(failed.original.output.execution.status, outcome);
  assert(failed.original.output.trace.calls.some(call => call.to === SEQUENCE_TOKEN && call.error === null));
  assert.deepEqual(failed.original.output.logs, []);
  assert.equal(storage(f, failed.original.changes, SEQUENCE_TOKEN, allowanceSlot(SEQUENCE_SENDER, SEQUENCE_VAULT)), 100n);
  assert.equal(storage(f, failed.original.changes, SEQUENCE_TOKEN, balanceSlot(SEQUENCE_SENDER)), 1000n);
  assert.equal(storage(f, failed.original.changes, SEQUENCE_VAULT, shareSlot(SEQUENCE_SENDER)), 0n);
  const fee = [first, failed].reduce((sum, step) => sum + BigInt(step.original.output.feeAccounting.gasCharge), 0n);
  assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'nonce'), 3n);
  assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'balance'), BigInt(f.allocation[SEQUENCE_SENDER].balance) - fee);
  measured(failed, 0, 100, 100); measured(failed, 1, 1000, 1000); measured(failed, 2, 0, 0);
  for (const step of s.steps.slice(2)) {
    assert.equal(step.original, null);
    assert(step.measurements.every(m => m.status === 'not_attempted' && m.before === null && m.after === null && m.values === null));
  }
  if (outcome === 'failed') assert.equal(failed.original.output.gasAccounting.gasUsed, r[method].gas);
});

test('invalid sequence and differing sender are rejected before a child or proof request', async t => {
  const f = await sequenceFixture(); let forks = 0, reads = 0;
  const mock = t.mock.method(childProcess, 'fork', () => { forks++; throw Error('Invalid input must not launch a child'); });
  const rpc = { async call() { reads++; throw Error('Invalid input must not request state'); } };
  try {
    const normal = [f.requests.approve, f.requests.deposit];
    for (const extra of [
      { requests: normal.slice(0, 1) }, { requests: [...normal, ...normal, normal[0]] },
      { requests: [normal[0], { ...normal[1], from: SEQUENCE_RECIPIENT }] },
      { requests: [normal[0], { ...normal[1], data: '0x' + '00'.repeat(32769) }] },
      { chainId: 42161 }, { queries: [] }, { requests: [normal[0], { ...normal[1], gas: '1' }] },
    ]) {
      const result = await run(f, normal, queries, { ...extra, rpc });
      assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_INPUT');
      assert.equal(result.sequence, null); assert.equal(result.isolation, null); assert.equal(result.broker.calls, 0);
    }
    assert.equal(forks, 0); assert.equal(reads, 0);
  } finally { mock.mock.restore(); }
});

test('four maximum-calldata requests fit the shared startup envelope and retain every row', async () => {
  const f = await sequenceFixture(), data = '0x' + '00'.repeat(32768);
  const requests = Array.from({ length: 4 }, () => ({ ...f.requests.approve, data }));
  requests[1].from = '0x' + SEQUENCE_SENDER.slice(2).toUpperCase();
  assert(Buffer.byteLength(JSON.stringify(requests)) > 256 * 1024);
  const result = await run(f, requests, [native(SEQUENCE_SENDER)]); accepted(result, 'partial');
  assert.equal(result.sequence.steps[0].original.output.execution.status, 'reverted');
  assert.deepEqual(result.sequence.steps.map(step => step.status), ['completed', 'not_attempted', 'not_attempted', 'not_attempted']);
  for (const step of result.sequence.steps) { assert.equal(step.request.from, SEQUENCE_SENDER); assert.equal(step.request.data, data); }
});

test('unavailable second-original storage proof rolls back that invocation without losing the first', async () => {
  const f = await sequenceFixture({ priced: true }); let denied = 0;
  const rpc = { async call(method, params, options) {
    if (method === 'eth_getProof' && params[0] === SEQUENCE_TOKEN && params[1].includes(balanceSlot(SEQUENCE_VAULT))) {
      denied++; throw Error('Synthetic second-step storage proof unavailable');
    }
    return f.rpc.call(method, params, options);
  } };
  const result = await run(f, [f.requests.approve, f.requests.deposit, f.requests.transfer], queries, { rpc }); accepted(result, 'partial');
  const [first, failed, skipped] = result.sequence.steps;
  assert.equal(denied, 1); assert.equal(first.status, 'completed'); assert.equal(failed.status, 'unavailable');
  assert.equal(first.original.output.execution.status, 'success');
  assert.equal(failed.original.output.stateDisposition, 'rolled_back');
  assert.deepEqual(failed.original.startingChanges, first.original.changes);
  assert.deepEqual(failed.original.changes, first.original.changes);
  assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'nonce'), 2n);
  assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'balance'), BigInt(f.allocation[SEQUENCE_SENDER].balance) - BigInt(first.original.output.feeAccounting.gasCharge));
  assert.equal(skipped.status, 'not_attempted'); assert.equal(skipped.original, null);
  assert(result.sequence.steps.every(step => step.measurements.every(m => m.values === null)));
  assert.equal(result.sequence.inputUsage.status, 'unavailable');
});

test('one shared root-return budget stops the next original but still permits native observations', async () => {
  const f = await sequenceFixture();
  const result = await run(f, undefined, [native(SEQUENCE_SENDER)], { limits: { ...LIMITS, execution: { ...LIMITS.execution, returnBytes: 32 } } }); accepted(result, 'partial');
  assert.equal(result.sequence.usage.executions, 1); assert.equal(result.sequence.usage.rootReturnBytes, 32);
  assert.deepEqual(result.sequence.steps.map(step => step.status), ['completed', 'not_attempted']);
  measured(result.sequence.steps[0], 0, BigInt(f.allocation[SEQUENCE_SENDER].balance), BigInt(f.allocation[SEQUENCE_SENDER].balance));
});

// Tamper only a real worker's terminal JSON. All actual proof requests and
// process closure remain genuine; the parent must reject inconsistent claims.
async function tamper(t, change, { priced = false } = {}) {
  const f = await sequenceFixture({ priced }), fork = childProcess.fork; let changed = false;
  const queryList = [allowance, native(SEQUENCE_SENDER), balance(SEQUENCE_TOKEN, SEQUENCE_RECIPIENT)];
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          assert.equal(message.result.sequence.status, 'complete', 'Tamper must start from a completed genuine child result');
          assert(message.result.sequence.steps.every(step => step.original?.output?.execution?.status === 'success'));
          change(message.result.sequence, f); changed = true; values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = await run(f, undefined, queryList);
    assert.equal(changed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(result.sequence, null); closed(result);
  } finally { mock.mock.restore(); }
}

test('IPC rejects reordered successful steps even with corrected indexes', async t => tamper(t, value => {
  value.steps.reverse(); value.steps.forEach((step, index) => { step.index = index; });
}));
test('IPC rejects a second original starting from the empty base instead of its accepted prefix', async t => tamper(t, value => {
  value.steps[1].original.startingChanges.accounts = [];
}));
test('IPC rejects coordinated carried-nonce alteration in prefix and next baseline', async t => tamper(t, value => {
  row(value.steps[0].original.changes, SEQUENCE_SENDER).nonce.after = '0x3';
  row(value.steps[1].original.startingChanges, SEQUENCE_SENDER).nonce.after = '0x3';
}));
test('IPC rejects coordinated carried-balance alteration despite matching the next baseline', async t => tamper(t, value => {
  for (const changes of [value.steps[0].original.changes, value.steps[1].original.startingChanges]) {
    const balance = row(changes, SEQUENCE_SENDER).balance; balance.after = quantity(BigInt(balance.after) + 1n);
  }
}, { priced: true }));
test('IPC rejects a second-step before probe replayed from the first step baseline', async t => tamper(t, value => {
  const first = value.steps[0].measurements[0], second = value.steps[1].measurements[0];
  const reads = first.before.stateReads.total;
  value.usage.stateReads += reads - second.before.stateReads.total;
  // Adjust aggregate execution counters too, so the baseline join is tested.
  const original = second.before.output, replacement = first.before.output;
  for (const [sum, count] of [['steps', 'steps'], ['frames', 'frames'], ['logs', 'logOpcodes'], ['traceBytes', 'retainedTraceBytes']]) {
    value.usage[sum] += replacement.usage[count] - original.usage[count];
  }
  second.before = structuredClone(first.before);
  second.values[0].beforeRaw = first.values[0].beforeRaw;
  second.values[0].deltaRaw = (BigInt(second.values[0].afterRaw) - BigInt(second.values[0].beforeRaw)).toString();
}));
test('IPC rejects query evidence relabeled as an original-phase proof', async t => tamper(t, value => {
  const boundary = value.steps[1].original.inputUsage.calls;
  const side = value.steps.flatMap(step => step.measurements.flatMap(m => [m.before, m.after])).find(s => s?.inputEvidenceIds.length);
  assert(side); assert(side.inputEvidenceIds[0] > boundary); assert(boundary > 0);
  side.inputEvidenceIds[0] = boundary;
}));
test('IPC rejects shared execution and state-read counters altered after genuine execution', async t => {
  for (const field of ['executions', 'stateReads']) await tamper(t, value => { value.usage[field]--; });
});

for (const [shared, perOutput] of [['steps', 'steps'], ['frames', 'frames'], ['logs', 'logOpcodes']]) test(`IPC rejects coherent shared ${shared} overflow although each original count fits its ceiling`, async t => tamper(t, value => {
  const first = value.steps[0].original.output.usage[perOutput], second = value.steps[1].original.output.usage;
  const cap = value.usage.limits[shared], after = cap - first + 1;
  assert(first > 0 && first <= cap && after <= cap);
  value.usage[shared] += after - second[perOutput]; second[perOutput] = after;
  assert.equal(first + second[perOutput], cap + 1, 'Only the shared sum must breach this bound');
}));

test('IPC rejects coherent shared state-read overflow at a completed original', async t => tamper(t, value => {
  const reads = value.steps[1].original.stateReads, after = value.usage.limits.reads + 1;
  value.usage.stateReads += after - reads.total; reads.total = after;
}));

test('IPC rejects coherent shared state-read overflow reached by a measured disposable CALL', async t => tamper(t, value => {
  const reads = value.steps[0].measurements[0].before.stateReads;
  const prior = value.steps[1].original.stateReads.total, after = value.usage.limits.reads - prior + 1;
  assert(after > reads.total); value.usage.stateReads += after - reads.total; reads.total = after;
  assert.equal(prior + reads.total, value.usage.limits.reads + 1);
}));

// A deliberately noncompliant child receives a relaxed inner byte budget,
// executes the genuine same requests, and claims the parent's smaller limits.
// This keeps actual return/trace bytes and all proof/state fields unchanged:
// each output fits the parent cap, while their shared sum exceeds it.
async function tamperByteBudget(t, field, cap) {
  const f = await sequenceFixture(), fork = childProcess.fork; let startChanged = false, resultChanged = false;
  const shared = field === 'returnBytes' ? 'rootReturnBytes' : 'traceBytes';
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), send = child.send, emit = child.emit;
    child.send = function(message, ...rest) {
      if (typeof message === 'string') {
        const parsed = JSON.parse(message);
        if (parsed.type === 'start') {
          assert.equal(parsed.payload.limits.execution[field], cap);
          parsed.payload.limits.execution[field] = field === 'returnBytes' ? 1048576 : 8388608;
          message = JSON.stringify(parsed); startChanged = true;
        }
      }
      return send.call(this, message, ...rest);
    };
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          const s = message.result.sequence; assert.equal(s.status, 'complete');
          const bytes = s.steps.map(step => field === 'returnBytes' ? (step.original.output.execution.returnData.length - 2) / 2 : step.original.output.usage.retainedTraceBytes);
          assert(bytes.every(n => n > 0 && n <= cap)); assert(bytes.reduce((a, b) => a + b, 0) > cap);
          s.usage.limits[shared] = cap; resultChanged = true; values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = await run(f, undefined, [native(SEQUENCE_SENDER)], { limits: { ...LIMITS, execution: { ...LIMITS.execution, [field]: cap } } });
    assert(startChanged && resultChanged); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(result.sequence, null); closed(result);
  } finally { mock.mock.restore(); }
}

test('IPC rejects aggregate actual return/trace bytes above the admitted shared cap', async t => {
  const f = await sequenceFixture(), baseline = await run(f, undefined, [native(SEQUENCE_SENDER)]); accepted(baseline);
  const traceCap = Math.max(...baseline.sequence.steps.map(s => s.original.output.usage.retainedTraceBytes));
  await tamperByteBudget(t, 'returnBytes', 32);
  await tamperByteBudget(t, 'traceBytes', traceCap);
});

test('real budget-failure sentinels remain available as incomplete evidence and preserve the accepted prefix', async () => {
  const base = await sequenceFixture(), baseline = await run(base, undefined, [native(SEQUENCE_SENDER)]); accepted(baseline);
  const first = baseline.sequence.steps[0].original;
  for (const [name, cap] of [['steps', first.output.usage.steps + 1], ['reads', first.stateReads.total + 1]]) {
    const f = await sequenceFixture();
    const limits = name === 'reads' ? { ...LIMITS, inputs: { reads: cap } } : { ...LIMITS, execution: { ...LIMITS.execution, steps: cap } };
    const result = await run(f, [f.requests.approve, f.requests.deposit, f.requests.transfer], [native(SEQUENCE_SENDER)], { limits }); accepted(result, 'partial');
    const [prior, failed, skipped] = result.sequence.steps;
    assert.equal(prior.status, 'completed'); assert.equal(prior.original.output.execution.status, 'success');
    assert.equal(failed.status, 'unavailable'); assert(!['success', 'reverted', 'failed'].includes(failed.original.output.execution.status));
    assert(['unchanged', 'rolled_back'].includes(failed.original.output.stateDisposition), 'Early refusal may precede the invocation checkpoint; either path must preserve the prefix');
    assert.deepEqual(failed.original.startingChanges, prior.original.changes); assert.deepEqual(failed.original.changes, prior.original.changes);
    assert.equal(storage(f, failed.original.changes, SEQUENCE_TOKEN, allowanceSlot(SEQUENCE_SENDER, SEQUENCE_VAULT)), 100n);
    assert.equal(field(f, failed.original.changes, SEQUENCE_SENDER, 'nonce'), 2n);
    assert.equal(skipped.status, 'not_attempted'); assert.equal(skipped.original, null);
    const actual = result.sequence.usage[name === 'reads' ? 'stateReads' : name];
    assert.equal(actual, cap + 1, 'The first refused read/opcode remains an honest over-limit sentinel');
    assert(failed.measurements.every(m => m.status === 'not_attempted' && m.values === null));
  }
});
