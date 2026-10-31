// Actual API adapter, ProofRpcClient and isolated child over synthetic proofs.
// The injected fetch serves only fixed initial state; no public RPC is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { InputError } from '../src/validate.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { LOCAL_SEQUENCE_CAPABILITIES, validateLocalSequence, withholdLocalSequence, simulateLocalSequence } from '../src/local-sequence.js';
import { sequenceFixture, SEQUENCE_SENDER, SEQUENCE_TOKEN, SEQUENCE_VAULT, SEQUENCE_RECIPIENT,
  encodeSequenceCall, balanceSlot } from '../engines/local-evm/test/sequence-fixture.js';

const native = account => ({ kind: 'native_balance', account });
const balance = (to, account) => ({ to, data: encodeSequenceCall('balanceOf', [account]) });
const allowance = { to: SEQUENCE_TOKEN, data: encodeSequenceCall('allowance', [SEQUENCE_SENDER, SEQUENCE_VAULT]) };
const queries = [allowance, balance(SEQUENCE_TOKEN, SEQUENCE_SENDER), balance(SEQUENCE_VAULT, SEQUENCE_SENDER), native(SEQUENCE_SENDER)];
const callOf = ({ from, ...call }) => call;
const inputFor = (f, methods = ['approve', 'deposit'], extra = {}) => ({ chainId: f.chainId, from: SEQUENCE_SENDER,
  block: 'latest', calls: methods.map(name => callOf(f.requests[name])), queries, ...extra });
function transport(f, { rpcChain, finalHeader, failStorage, failAccount, cancelFinal, drainComplete = true, limits } = {}) {
  const wires = [], failures = []; let headers = 0;
  const rpc = new ProofRpcClient({ chainId: f.chainId, url: 'https://synthetic.invalid', ...(limits ? { limits } : {}),
    fetchImpl: async (_url, options) => {
      try {
        const request = JSON.parse(options.body); wires.push(request);
        assert.equal(request.id, wires.length); assert.equal(request.jsonrpc, '2.0'); assert.equal(options.redirect, 'error');
        let result, error;
        if (request.method === 'eth_chainId') {
          assert.equal(wires.length, 1); assert.deepEqual(request.params, []);
          result = rpcChain ?? '0x' + f.chainId.toString(16);
        } else if (['eth_getBlockByNumber', 'eth_getBlockByHash'].includes(request.method)) {
          headers++;
          if (headers === 1) { assert.equal(wires.length, 2); result = f.header; }
          else {
            assert.equal(headers, 2); assert.equal(request.method, 'eth_getBlockByNumber');
            assert.deepEqual(request.params, [f.header.number, false]);
            result = finalHeader ? finalHeader(structuredClone(f.header)) : f.header;
            cancelFinal?.abort();
          }
        } else {
          assert(['eth_getProof', 'eth_getCode'].includes(request.method));
          assert.deepEqual(request.params.at(-1), { blockHash: f.header.hash, requireCanonical: true });
          if (request.method === 'eth_getProof' && request.params[0] === failAccount) {
            error = { code: -32000, message: 'private provider diagnostic must not reach the frontend' };
          } else if (request.method === 'eth_getProof' && request.params[0] === SEQUENCE_TOKEN && request.params[1].includes(failStorage)) {
            error = { code: -32000, message: 'Declared synthetic storage proof is unavailable' };
          } else result = await f.rpc.call(request.method, request.params);
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }));
      } catch (error) { failures.push(error.message); throw error; }
    } });
  if (!drainComplete) {
    const drain = rpc.drain.bind(rpc);
    rpc.drain = async options => ({ ...await drain(options), complete: false, adapterPending: 1 });
  }
  return { rpc, wires, check(report) {
    assert.deepEqual(failures, [], 'Transport fixture assertions must not be swallowed by the adapter');
    assert.equal(report.transportEvidence.length, wires.length);
    report.transportEvidence.forEach((item, i) => assert.deepEqual(JSON.parse(item.requestText), wires[i]));
    assert.equal(report.usage.pending, 0); assert.equal(report.usage.adapterPending, 0);
  } };
}
function complete(report) {
  assert.equal(report.status, 'complete', JSON.stringify(report.error));
  assert.equal(report.kind, 'local_proof_sequence'); assert.equal(report.schemaVersion, '1.0');
  assert.equal(report.source.canonicalStatus, 'verified');
  assert.equal(report.attempt.status, 'completed'); assert.equal(report.attempt.sequence.status, 'complete');
  assert.equal(report.attempt.isolation.processSeparated, true); assert.notEqual(report.attempt.isolation.childPid, process.pid);
  assert.equal(report.attempt.isolation.processClosed, true); assert.equal(report.attempt.broker.pendingAtReturn, 0);
  assert.equal(report.drain.complete, true);
}
function measured(step, index, before, after) {
  const row = step.measurements[index]; assert.equal(row.status, 'measured'); assert.equal(row.values.length, 1);
  assert.deepEqual(Object.fromEntries(['beforeRaw', 'afterRaw', 'deltaRaw'].map(key => [key, row.values[0][key]])), {
    beforeRaw: String(before), afterRaw: String(after), deltaRaw: (BigInt(after) - BigInt(before)).toString(),
  });
}
function withheld(report, code, originals = true) {
  assert.equal(report.status, 'unavailable'); assert.equal(report.error.code, code);
  assert.equal(report.source.canonicalStatus, 'unverified');
  assert(report.steps.every(step => step.status === 'unavailable' && step.execution.status === 'unavailable' && step.measurements.length === 0));
  if (originals) {
    assert.equal(report.attempt.sequence, null); assert.equal(report.attempt.status, 'unavailable');
    assert.equal(report.audit.status, 'unverified_not_a_measurement'); assert.equal(report.audit.originals.length, report.apiRequest.calls.length);
    assert(report.audit.originals.every(step => !Object.hasOwn(step, 'measurements')));
    assert.equal(report.audit.originals[0].original.output.execution.status, 'success');
    assert(!JSON.stringify(report.audit).includes('"beforeRaw"'));
  }
}

test('sequence validation normalizes one shared context and rejects nested overrides before any I/O', async t => {
  const f = await sequenceFixture(); let forks = 0, reads = 0, getterCalls = 0;
  const minimal = inputFor(f, undefined, { from: '0x' + SEQUENCE_SENDER.slice(2).toUpperCase() });
  delete minimal.block; delete minimal.calls[0].gas; delete minimal.calls[0].value;
  const normalized = validateLocalSequence(minimal);
  assert.equal(normalized.from, SEQUENCE_SENDER); assert.equal(normalized.block, 'latest');
  assert.equal(normalized.calls[0].gas, '5000000'); assert.equal(normalized.calls[0].value, '0');
  assert(normalized.calls.every(call => !Object.hasOwn(call, 'from') && !Object.hasOwn(call, 'block') && !Object.hasOwn(call, 'queries')));
  const hostile = inputFor(f); Object.defineProperty(hostile.calls[1], 'to', { enumerable: true, get() { getterCalls++; return SEQUENCE_VAULT; } });
  const sparse = inputFor(f); delete sparse.calls[1];
  const candidates = [hostile, sparse,
    ...['from', 'block', 'queries', 'chainId', 'overrides'].map(key => {
      const input = inputFor(f); input.calls[1][key] = key === 'from' ? SEQUENCE_SENDER : null; return input;
    }),
    ...[0, 1, 5].map(count => inputFor(f, undefined, { calls: Array.from({ length: count }, () => callOf(f.requests.approve)) })),
    inputFor(f, undefined, { chainId: '1' }), inputFor(f, undefined, { chainId: 42161 }),
    inputFor(f, undefined, { queries: [] }), inputFor(f, undefined, { extra: true }),
  ];
  const mock = t.mock.method(childProcess, 'fork', () => { forks++; throw Error('Invalid input must not launch a child'); });
  try {
    for (const input of candidates) await assert.rejects(simulateLocalSequence(input, { call() { reads++; } }), InputError);
    assert.equal(forks, 0); assert.equal(reads, 0); assert.equal(getterCalls, 0);
  } finally { mock.mock.restore(); }
  assert.deepEqual(LOCAL_SEQUENCE_CAPABILITIES.chainIds, [1, 11155111]);
  assert.equal(LOCAL_SEQUENCE_CAPABILITIES.calls.atomic, false);
  assert.equal(LOCAL_SEQUENCE_CAPABILITIES.limits.scope, 'shared_across_all_originals_and_queries');
  assert.equal(LOCAL_SEQUENCE_CAPABILITIES.limits.wallMs, 145000);
  assert.equal(LOCAL_SEQUENCE_CAPABILITIES.limits.finalHeaderReserveMs, 25000);
  assert.equal(LOCAL_SEQUENCE_CAPABILITIES.limits.apiOutputBytes, 96 * 1024 * 1024);
});

for (const [fork, priced, selection] of [['osaka', false, 'latest'], ['amsterdam', true, 'number'], ['osaka', false, 'hash']]) test(`actual ${fork} ${selection} sequence uses one child, one pin and one final confirmation`, async t => {
  const f = await sequenceFixture({ fork, priced }), p = transport(f);
  const block = selection === 'number' ? f.header.number : selection === 'hash' ? f.header.hash : 'latest';
  const input = inputFor(f, undefined, { block }); let forks = 0;
  const forkChild = childProcess.fork, mock = t.mock.method(childProcess, 'fork', (...args) => { forks++; return forkChild(...args); });
  let report;
  try { report = await simulateLocalSequence(input, p.rpc); } finally { mock.mock.restore(); }
  p.check(report); complete(report); assert.equal(forks, 1); assert.deepEqual(report.apiRequest, input);
  assert.equal(report.source.chainId, f.chainId); assert.equal(report.source.blockSelection.blockHash, f.header.hash);
  assert.equal(report.source.blockSelection.headerVerification.chainId ?? 1, f.chainId);
  const headerWires = p.wires.filter(wire => wire.method.startsWith('eth_getBlock'));
  assert.equal(headerWires.length, 2);
  assert.deepEqual(headerWires[0].params, [block, false]);
  assert.equal(headerWires[0].method, selection === 'hash' ? 'eth_getBlockByHash' : 'eth_getBlockByNumber');
  assert.deepEqual(headerWires[1].params, [f.header.number, false]);
  assert.equal(p.wires.at(-1).id, headerWires[1].id);
  assert.deepEqual(report.steps.map(step => step.status), ['completed', 'completed']);
  assert.deepEqual(report.steps.map(step => step.execution.status), ['success', 'success']);
  measured(report.steps[0], 0, 0, 100); measured(report.steps[1], 0, 100, 0);
  measured(report.steps[0], 1, 1000, 1000); measured(report.steps[1], 1, 1000, 900);
  measured(report.steps[0], 2, 0, 0); measured(report.steps[1], 2, 0, 100);
  let debit = 0n;
  for (const [index, step] of report.steps.entries()) {
    const before = BigInt(f.allocation[SEQUENCE_SENDER].balance) - debit;
    if (priced) debit += BigInt(report.attempt.sequence.steps[index].original.output.feeAccounting.gasCharge);
    measured(step, 3, before, BigInt(f.allocation[SEQUENCE_SENDER].balance) - debit);
    assert.equal(step.request.from, SEQUENCE_SENDER);
    assert(step.measurements.every(row => row.identity.chainId === String(f.chainId)));
  }
  assert.deepEqual(report.attempt.sequence.scope.feesSettled, [priced, priced]);
  const serialized = JSON.parse(JSON.stringify(report)); assert.deepEqual(serialized.steps, report.steps);
});

test('completed second-step revert is partial and keeps earlier approval plus fee effects', async () => {
  const f = await sequenceFixture({ priced: true }), p = transport(f);
  const report = await simulateLocalSequence(inputFor(f, ['approve', 'depositThenRevert', 'transfer']), p.rpc); p.check(report);
  assert.equal(report.status, 'partial', JSON.stringify(report.error)); assert.equal(report.source.canonicalStatus, 'verified');
  assert.deepEqual(report.steps.map(step => step.status), ['completed', 'completed', 'not_attempted']);
  assert.deepEqual(report.steps.map(step => step.execution.status), ['success', 'reverted', 'not_attempted']);
  measured(report.steps[1], 0, 100, 100); measured(report.steps[1], 1, 1000, 1000); measured(report.steps[1], 2, 0, 0);
  assert(BigInt(report.steps[1].measurements[3].values[0].deltaRaw) < 0n);
  assert(report.steps[2].measurements.every(row => row.status === 'not_attempted' && row.values === null));
});

test('query-only missing proof preserves every original and withholds affected measurements', async () => {
  const f = await sequenceFixture(), p = transport(f, { failStorage: balanceSlot(SEQUENCE_RECIPIENT) });
  const input = inputFor(f, undefined, { queries: [allowance, balance(SEQUENCE_TOKEN, SEQUENCE_RECIPIENT)] });
  const report = await simulateLocalSequence(input, p.rpc); p.check(report);
  assert.equal(report.status, 'partial', JSON.stringify(report.error)); assert.equal(report.source.canonicalStatus, 'verified');
  assert(report.steps.every(step => step.status === 'completed' && step.execution.status === 'success'));
  measured(report.steps[0], 0, 0, 100);
  assert.equal(report.steps[0].measurements[1].status, 'unavailable'); assert.equal(report.steps[0].measurements[1].values, null);
  assert(report.steps[1].measurements.every(row => row.values === null));
  for (const step of report.attempt.sequence.steps) assert(!step.original.inputEvidence.some(wire => wire.request.method === 'eth_getProof' && wire.request.params[1].includes(balanceSlot(SEQUENCE_RECIPIENT))));
});

test('first unavailable account proof remains a distinct input failure through the actual API and worker', async () => {
  const f = await sequenceFixture(), p = transport(f, { failAccount: SEQUENCE_SENDER });
  const report = await simulateLocalSequence(inputFor(f), p.rpc); p.check(report);
  assert.equal(report.source.canonicalStatus, 'verified');
  assert.deepEqual(report.steps.map(step => step.status), ['unavailable', 'not_attempted']);
  assert.equal(report.steps[0].execution.status, 'unavailable');
  assert.equal(report.steps[0].execution.error.code, 'LOCAL_INPUT_UNAVAILABLE');
  assert(report.steps.every(step => step.measurements.every(row => row.values === null)));
  assert.equal(report.attempt.sequence.steps[0].original.output.stateDisposition, 'unchanged');
  assert.equal(report.attempt.isolation.processClosed, true);
  assert.equal(report.attempt.broker.pendingAtReturn, 0);
  assert.equal(report.drain.complete, true);
  assert.equal(p.wires.filter(wire => wire.method === 'eth_getProof').length, 1);
  assert.equal(p.wires.at(-1).method, 'eth_getBlockByNumber');
  assert(!JSON.stringify(report).includes('private provider diagnostic'));
});

test('wrong chain or wrong selected number is withheld before state reads', async () => {
  for (const wrong of ['chain', 'number']) {
    const f = await sequenceFixture(), p = transport(f, { rpcChain: wrong === 'chain' ? '0xaa36a7' : undefined });
    const report = await simulateLocalSequence(inputFor(f, undefined, wrong === 'number' ? { block: '0x1' } : {}), p.rpc); p.check(report);
    withheld(report, 'LOCAL_PREVIEW_PREPARATION', false); assert.equal(report.attempt, null);
    assert(p.wires.every(wire => ['eth_chainId', 'eth_getBlockByNumber'].includes(wire.method)));
    assert.equal(p.wires.length, wrong === 'chain' ? 1 : 2);
  }
});

test('full final-header mismatch removes nested measurements and labels originals as unverified audit', async () => {
  for (const finalHeader of [header => ({ ...header, timestamp: '0x1' }), header => ({ ...header, transactions: [] })]) {
    const f = await sequenceFixture(), p = transport(f, { finalHeader });
    const report = await simulateLocalSequence(inputFor(f), p.rpc); p.check(report); withheld(report, 'LOCAL_PREVIEW_CANONICAL');
    assert.equal(report.audit.originals[1].original.output.execution.status, 'success');
    assert.equal(report.attempt.isolation.processClosed, true);
  }
});

test('cancellation before dispatch or at final confirmation leaves no nested measurements', async () => {
  for (const early of [true, false]) {
    const f = await sequenceFixture(), controller = new AbortController(), p = transport(f, { cancelFinal: early ? undefined : controller });
    if (early) controller.abort();
    const report = await simulateLocalSequence(inputFor(f), p.rpc, { signal: controller.signal }); p.check(report);
    withheld(report, 'LOCAL_PREVIEW_CANCELLED', !early);
    if (early) { assert.equal(p.wires.length, 0); assert.equal(report.attempt, null); }
  }
});

test('failed drain withholds verified execution, and the final-header time reserve prevents a new child', async () => {
  const f = await sequenceFixture(), p = transport(f, { drainComplete: false });
  const report = await simulateLocalSequence(inputFor(f), p.rpc); p.check(report); withheld(report, 'LOCAL_PREVIEW_DRAIN');
  const second = await sequenceFixture(), limited = transport(second, { limits: { wallMs: 25000 } });
  const budget = await simulateLocalSequence(inputFor(second), limited.rpc); limited.check(budget);
  withheld(budget, 'LOCAL_PREVIEW_BUDGET', false); assert.equal(budget.attempt, null); assert.equal(limited.wires.length, 2);
});

test('loader source withholding is repeatable and retains only raw originals as audit', async () => {
  const f = await sequenceFixture(), p = transport(f), report = await simulateLocalSequence(inputFor(f), p.rpc); p.check(report); complete(report);
  const original = structuredClone(report.attempt.sequence.steps[1].original);
  withholdLocalSequence(report, 'LOCAL_PREVIEW_SOURCE_CHANGED'); withheld(report, 'LOCAL_PREVIEW_SOURCE_CHANGED');
  assert.deepEqual(report.audit.originals[1].original, original);
  const audit = JSON.stringify(report.audit);
  withholdLocalSequence(report, 'LOCAL_PREVIEW_SOURCE_CHANGED'); withheld(report, 'LOCAL_PREVIEW_SOURCE_CHANGED');
  assert.equal(JSON.stringify(report.audit), audit);
});
