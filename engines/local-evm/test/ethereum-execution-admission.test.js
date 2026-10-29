import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethereumCommon } from '../ethereum-profile.js';
import { ethereumNetworkCommon, SEPOLIA_AMSTERDAM } from '../ethereum-network.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { compilePreviewQueries } from '../preview-queries.js';
import { createRecordedStateManager } from '../recorded-state.js';

const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const from = address(0x1111), to = address(0x2222);
const request = { from, to, data: '0x', value: '17', gas: '75000' };
const mainnet = { number: '20000000', timestamp: '1746612311', gasLimit: '30000000', baseFeePerGas: '17', mixHash: word(9), miner: address(0x5555), parentHash: word(99), hash: word(100), stateRoot: word(101) };
const sepolia = JSON.parse(readFileSync(new URL('./fixtures/sepolia-network/header-12018196.json', import.meta.url)));
const noState = () => {
  let reads = 0;
  return { manager: new Proxy({}, { get() { reads++; throw Error('Execution admission must precede state access'); } }), reads: () => reads };
};

test('valid Sepolia header and query support do not imply transaction execution admission', async () => {
  assert.equal(verifyEthereumHeader({ header: sepolia, expectedHash: sepolia.hash, chainId: 11155111 }).status, 'verified');
  assert.equal(compilePreviewQueries([{ kind: 'native_balance', account: from }], { chainId: 11155111 })[0].identity.chainId, '11155111');
  assert.equal(ethereumNetworkCommon(sepolia, 11155111).hardfork(), 'amsterdam');
  const guard = noState(), result = await executeEthereumCall({ request, header: sepolia, stateManager: guard.manager, chainId: 11155111 });
  assert.equal(result.execution.status, 'unsupported'); assert.equal(result.execution.error.code, 'LOCAL_ETHEREUM_FORK_UNSUPPORTED');
  assert.equal(result.execution.executionGasUsed, null); assert.equal(result.execution.returnData, null);
  assert.equal(result.profile, null); assert.equal(result.trace, null); assert.deepEqual(result.logs, []);
  assert.equal(result.stateDisposition, 'unchanged'); assert.equal(guard.reads(), 0);
});

test('the execution allowlist remains closed for Sepolia before and after Amsterdam activation', async () => {
  for (const timestamp of [BigInt(SEPOLIA_AMSTERDAM.timestamp) - 1n, BigInt(SEPOLIA_AMSTERDAM.timestamp)]) {
    const header = { ...sepolia, timestamp: '0x' + timestamp.toString(16) };
    assert(['bpo2', 'amsterdam'].includes(ethereumNetworkCommon(header, 11155111).hardfork()));
    assert.throws(() => ethereumCommon(header, 11155111), { code: 'LOCAL_ETHEREUM_FORK_UNSUPPORTED' });
    const guard = noState(), result = await executeEthereumCall({ request, header, stateManager: guard.manager, chainId: 11155111 });
    assert.equal(result.execution.status, 'unsupported'); assert.equal(guard.reads(), 0);
  }
});

test('unknown or noncanonical trusted chain values reject before state reads', async () => {
  for (const chainId of [0, 999, 42161, '1', '11155111', 1n, 11155111n, null, NaN, {}, []]) {
    const guard = noState(), result = await executeEthereumCall({ request, header: mainnet, stateManager: guard.manager, chainId });
    assert.equal(result.execution.status, 'unsupported'); assert.equal(result.execution.error.code, 'LOCAL_ETHEREUM_CHAIN_UNSUPPORTED');
    assert.equal(result.stateDisposition, 'unchanged'); assert.equal(guard.reads(), 0);
  }
});

test('request and header metadata cannot override the trusted execution network', async () => {
  const guard = noState();
  const bad = await executeEthereumCall({ request: { ...request, chainId: 11155111 }, header: mainnet, stateManager: guard.manager });
  assert.equal(bad.execution.status, 'invalid'); assert.equal(guard.reads(), 0);
  // Ethereum execution headers do not carry a chain id. Adding a field here
  // cannot switch the execution selector, even before separate header reproof.
  assert.equal(ethereumCommon({ ...mainnet, chainId: 11155111 }).chainId(), 1n);
  assert.throws(() => ethereumCommon(sepolia));
});

test('default and explicitly selected mainnet execute with identical stable outputs and state changes', async () => {
  const outputs = [];
  for (const options of [{}, { chainId: 1 }]) {
    const stateManager = await createRecordedStateManager({ accounts: {
      [from]: { exists: true, nonce: '1', balance: '1000', code: '0x', storage: {} },
      [to]: { exists: true, nonce: '1', balance: '7', code: '0x', storage: {} },
    } });
    const result = await executeEthereumCall({ request, header: mainnet, stateManager, ...options });
    assert.equal(result.execution.status, 'success');
    outputs.push({ execution: result.execution, profile: result.profile, gasAccounting: result.gasAccounting,
      environment: result.environment, logs: result.logs, state: stateManager.snapshotChanges() });
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(outputs[0].profile.chainId, 1); assert.equal(outputs[0].gasAccounting.gasUsed, '21000');
  assert.equal(outputs[0].profile.forkSchedule, 'pinned_ethereumjs_common_10.1.3_mainnet');
  assert.throws(() => ethereumCommon({ number: '17000000', timestamp: '1681338454' }), /Shanghai through BPO2/);
});
