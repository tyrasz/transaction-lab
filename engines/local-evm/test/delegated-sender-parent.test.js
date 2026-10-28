// Real isolated workers over synthetic authenticated MPT inputs. These tests
// alter the child result only; no expected output enters execution or proofs.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { validateExecutionChanges } from '../execution-changes.js';
import { ethereumCommon } from '../ethereum-profile.js';
import { lifecycleFixture, factoryCode, initcode, SENDER, FACTORY } from './lifecycle-fixture.js';

const DELEGATE = '0x4444444444444444444444444444444444444444';
const GETTER = '0x5555555555555555555555555555555555555555';
const CALLBACK = '0x6666666666666666666666666666666666666666';
const indicator = '0xef0100' + DELEGATE.slice(2);
const creationCode = factoryCode(initcode('00', ''), { value: 0, tail: '5000' });
const call = address => '6000600060006000600073' + address.slice(2) + '620f4240f15000';
const query = { to: GETTER, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') };
async function fixture({ code = creationCode, senderCode = indicator, callback = false } = {}) {
  const f = await lifecycleFixture({ accounts: {
    [SENDER]: { nonce: 1n, balance: 1000000n, code: senderCode },
    [DELEGATE]: { nonce: 1n, code },
    [GETTER]: { nonce: 1n, code: '0x602a60005260206000f3' },
    [CALLBACK]: { nonce: 1n, code: '0x' + call(SENDER) },
  } });
  f.request.to = callback ? CALLBACK : SENDER;
  return f;
}
const run = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
const preview = f => executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: [query] });
function recount(output) {
  output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs, ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}) }));
}
async function tamper(t, f, change, { previewMode = false } = {}) {
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          change(message.result); if (!previewMode) recount(message.result.output);
          changed = true; values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = await (previewMode ? preview(f) : run(f));
    assert.equal(changed, true); assert.equal(result.status, 'unavailable');
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(previewMode ? result.preview : result.output, null);
  } finally { mock.mock.restore(); }
}
function cancun(f) {
  const header = f.header; header.timestamp = '0x' + (1746612310).toString(16); delete header.requestsHash;
  const order = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot'];
  const quantities = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
  header.hash = '0x' + Buffer.from(keccak_256(RLP.encode(order.map(key => {
    let raw = header[key].slice(2);
    if (quantities.has(key)) { raw = BigInt(header[key]) === 0n ? '' : BigInt(header[key]).toString(16); if (raw.length % 2) raw = '0' + raw; }
    return Buffer.from(raw, 'hex');
  })))).toString('hex');
  assert.equal(ethereumCommon(header).hardfork(), 'cancun'); return f;
}

test('parent derives delegated sender eligibility and rejects missing, altered or extra declaration fields', async t => {
  const result = await run(await fixture());
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.output.execution.status, 'success');
  assert.deepEqual(result.output.semantics.senderDelegation, { address: DELEGATE, authorizationListProcessed: false });
  assert.deepEqual(result.changes.accounts.find(row => row.address === SENDER).nonce, { before: '0x1', after: '0x3' });
  for (const change of [
    r => { delete r.output.semantics.senderDelegation; },
    r => { r.output.semantics.senderDelegation.address = FACTORY; },
    r => { r.output.semantics.senderDelegation.authorizationListProcessed = true; },
    r => { r.output.semantics.senderDelegation.chainId = 1; },
    r => { r.output.semantics.callerNonce = 'runCall_increments_once_including_EVM_revert'; },
  ]) await tamper(t, await fixture(), change);
});

test('parent rejects undercounted and overcounted sender creation attempts', async t => {
  for (const after of ['0x2', '0x4']) await tamper(t, await fixture(), r => { r.changes.accounts.find(row => row.address === SENDER).nonce.after = after; });
});

test('entered reverted constructors and collisions retain their creator nonce increment', async t => {
  for (const [code, expected] of [
    [factoryCode('60006000fd', { value: 0, tail: '5000' }), '0x3'],
    [factoryCode(initcode('00', ''), { kind: 'CREATE2', value: 0, repeat: 2, tail: '5000' }), '0x4'],
  ]) {
    const result = await run(await fixture({ code })); assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(result.output.execution.status, 'success'); assert.notEqual(result.output.trace.calls.at(-1).error, null);
    assert.equal(result.changes.accounts.find(row => row.address === SENDER).nonce.after, expected);
    await tamper(t, await fixture({ code }), r => { r.changes.accounts.find(row => row.address === SENDER).nonce.after = '0x' + (BigInt(expected) - 1n).toString(16); });
  }
});

test('reverted parent ancestry cannot justify an extra sender nonce even when its CREATE succeeded', async t => {
  const code = factoryCode(initcode('00', ''), { value: 0, tail: '5060006000fd' });
  for (const callback of [false, true]) {
    const r = await run(await fixture({ code, callback })); assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.equal(r.output.execution.status, callback ? 'success' : 'reverted');
    assert.deepEqual(r.changes.accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
    await tamper(t, await fixture({ code, callback }), r => { r.changes.accounts[0].nonce.after = '0x3'; });
  }
});

test('parent rejects laundering a callback execution account to hide sender creation attempts', async t => {
  const r = await run(await fixture({ callback: true })); assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.equal(r.output.trace.calls[0].calls[0].from, SENDER);
  await tamper(t, await fixture({ callback: true }), r => {
    const callback = r.output.trace.calls[0]; callback.executionAddress = DELEGATE;
    callback.calls[0].from = DELEGATE; callback.calls[0].caller = DELEGATE;
    r.changes.accounts.find(row => row.address === SENDER).nonce.after = '0x2';
  });
});

test('an empty-code sender cannot acquire delegation authority through metadata or forged input facts', async t => {
  for (const forgeInput of [false, true]) {
    const f = await lifecycleFixture();
    await tamper(t, f, r => {
      r.output.semantics.senderDelegation = { address: DELEGATE, authorizationListProcessed: false };
      r.output.semantics.callerNonce = 'runCall_increment_and_committed_sender_creation_attempts';
      if (forgeInput) r.inputs.accounts[SENDER].code = indicator;
    });
  }
});

test('trusted pre-Prague fork and exact indicator length remain required at the parent boundary', async t => {
  const validFixture = await fixture(), valid = await run(validFixture); assert.equal(valid.status, 'completed');
  const args = { changes: valid.changes, inputs: valid.inputs, output: valid.output, sender: SENDER, destination: SENDER };
  assert.throws(() => validateExecutionChanges(args));
  assert.doesNotThrow(() => validateExecutionChanges({ ...args, common: ethereumCommon(validFixture.header) }));
  const priorFork = ethereumCommon(cancun(await fixture()).header);
  assert.throws(() => validateExecutionChanges({ ...args, common: priorFork }));
  for (const f of [cancun(await fixture()), await fixture({ senderCode: indicator + '00' }), await fixture({ senderCode: '0xef0100' })]) {
    const result = await run(f); assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(result.output.execution.status, 'unsupported'); assert.equal(result.output.semantics.senderDelegation, undefined);
    await tamper(t, f, r => {
      r.output.semantics.senderDelegation = { address: DELEGATE, authorizationListProcessed: false };
      r.output.semantics.callerNonce = 'runCall_increment_and_committed_sender_creation_attempts';
    });
  }
});

test('measured probes use the same authenticated delegation but still normalize only one sender nonce', async t => {
  const result = await preview(await fixture()); assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.preview.status, 'complete');
  for (const phase of ['before', 'after']) {
    const side = result.preview.measurements[0][phase];
    assert.deepEqual(side.output.semantics.senderDelegation, { address: DELEGATE, authorizationListProcessed: false });
    assert.equal(side.changesAfter.accounts.find(row => row.address === SENDER).nonce.after, phase === 'before' ? '0x2' : '0x4');
  }
  await tamper(t, await fixture(), r => { r.preview.measurements[0].after.output.semantics.senderDelegation.address = FACTORY; }, { previewMode: true });
  await tamper(t, await fixture(), r => { r.preview.measurements[0].after.changesAfter.accounts.find(row => row.address === SENDER).nonce.after = '0x5'; }, { previewMode: true });
});
