// Synthetic BPO2 header + authenticated initial MPT; no public Sepolia data.
// The signed full-VM reference shares EthereumJS, not an independent client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '@ethereumjs/util';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { ethereumNetworkCommon, SEPOLIA_AMSTERDAM } from '../ethereum-network.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { deriveAuthorizationPreparation } from '../authorization-validation.js';
import { authorizationFixture, signAuthorization, blockFor, appliedRoot, compareExecution, bytes, TEST_KEY,
  TX_SENDER, TARGET, AUTHORITY, DELEGATE, designation, query } from './authorization-fixture.js';

async function fixture(authorizationList, options = {}) {
  const f = await authorizationFixture({ authorizationList, ...options });
  Object.assign(f.header, { number: '0xb76213', timestamp: '0x' + (BigInt(SEPOLIA_AMSTERDAM.timestamp) - 1n).toString(16) });
  f.common = ethereumNetworkCommon(f.header, 11155111); assert.equal(f.common.hardfork(), 'bpo2');
  f.block = blockFor(f, f.common); f.header.hash = bytesToHex(f.block.hash());
  assert.equal(verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: 11155111 }).hardfork, 'bpo2');
  f.inputs = createRpcStateInputs({ chainId: 11155111, blockHash: f.header.hash, header: f.header, rpc: f.rpc });
  f.stateManager = createProofStateManager({ inputs: f.inputs });
  return f;
}
const run = f => executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager,
  blockchain: f.inputs.blockchain, chainId: 11155111 });
const isolated = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
async function compare(f, output, changes) {
  const state = await loadState(f.allocation, f.common);
  assert.equal(bytesToHex(await state.getStateRoot()), f.header.stateRoot);
  const vm = await createVM({ common: f.common, stateManager: state, blockchain: {
    async getBlock() { throw Error('No synthetic ancestry supplied'); }, shallowCopy() { return this; },
  } });
  const r = f.request, tx = createTx({ type: 4, chainId: 11155111n, nonce: 1n, gasLimit: BigInt(r.gas),
    to: r.to, value: BigInt(r.value), data: r.data, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
    authorizationList: r.authorizationList }, { common: f.common }).sign(bytes(TEST_KEY));
  assert.equal(tx.getSenderAddress().toString(), TX_SENDER); assert(tx.verifySignature());
  const result = await runTx(vm, { tx, block: f.block }); compareExecution(output, result);
  assert.equal(await appliedRoot(f, changes, f.common), bytesToHex(await state.getStateRoot()), 'full postroot including authorization changes');
}

test('historical Sepolia root and actual parent bind tuples to11155111; mainnet skips and wildcard applies', async () => {
  for (const chainId of [11155111n, 1n, 0n]) {
    const list = [signAuthorization({ chainId })], f = await fixture(list);
    const output = await run(f); assert.equal(output.execution.status, 'success');
    const expected = { index: 0, authority: chainId === 1n ? null : AUTHORITY,
      status: chainId === 1n ? 'skipped' : 'applied', reason: chainId === 1n ? 'wrong_chain' : null };
    assert.deepEqual(output.authorizationProcessing.entries, [expected]);
    assert.equal(output.authorizationProcessing.gasRefundCounter, chainId === 1n ? '0' : '12500');
    await compare(f, output, f.stateManager.snapshotChanges());
    const child = await isolated(await fixture(list));
    assert.equal(child.status, 'completed', JSON.stringify(child.error));
    assert.deepEqual(child.output.authorizationProcessing, output.authorizationProcessing);
    assert.deepEqual(child.changes, f.stateManager.snapshotChanges());
    assert.equal(child.inputs.context.chainId, 11155111); assert.equal(child.output.profile.chainId, 11155111);
    assert.equal(child.isolation.processClosed, true);
  }
});

test('historical Sepolia self-authorization and fresh delegated query semantics pass actual parent independently', async () => {
  const list = [signAuthorization({ key: TEST_KEY, nonce: 2n, chainId: 11155111n })];
  const f = await fixture(list, { to: TX_SENDER });
  const output = await run(f); assert.equal(output.execution.status, 'success');
  assert.deepEqual(output.semantics.senderDelegation, { address: DELEGATE, authorizationListProcessed: true });
  assert.equal(f.stateManager.snapshotChanges().accounts.find(r => r.address === TX_SENDER).nonce.after, '0x3');
  await compare(f, output, f.stateManager.snapshotChanges());
  const child = await isolated(await fixture(list, { to: TX_SENDER }));
  assert.equal(child.status, 'completed', JSON.stringify(child.error));
  const p = await fixture(list, { to: TARGET });
  const preview = await executeIsolatedEthereumPreview({ request: p.request, header: p.header, rpc: p.rpc,
    chainId: 11155111, queries: [query(DELEGATE)] });
  assert.equal(preview.status, 'completed', JSON.stringify(preview.error)); assert.equal(preview.preview.status, 'complete');
  const m = preview.preview.measurements[0];
  assert.equal(m.before.output.semantics.senderDelegation, undefined);
  assert.deepEqual(m.after.output.semantics.senderDelegation, { address: DELEGATE, authorizationListProcessed: false });
  assert.equal(m.after.output.authorizationProcessing, undefined);
  assert.equal(m.before.output.profile.chainId, 11155111); assert.equal(m.after.output.profile.chainId, 11155111);
});

test('authorization parent fold rejects unsupported chains and never infers chain from tuple or input labels', async () => {
  const f = await fixture([signAuthorization({ chainId: 11155111n })]); await run(f);
  const inputs = f.stateManager.snapshotInputs();
  const prepared = deriveAuthorizationPreparation({ request: f.request, inputs, common: f.common });
  assert.equal(prepared.processing.entries[0].status, 'applied');
  const mainnet = { chainId: () => 1n, isActivatedEIP: eip => eip === 7702 };
  const wrong = deriveAuthorizationPreparation({ request: f.request, inputs, common: mainnet });
  assert.equal(wrong.processing.entries[0].reason, 'wrong_chain');
  for (const chainId of [999n, 42161n, 11155111, '11155111']) assert.throws(() => deriveAuthorizationPreparation({
    request: f.request, inputs, common: { ...mainnet, chainId: () => chainId },
  }));
});
