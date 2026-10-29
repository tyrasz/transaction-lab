import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createAuthenticatedAncestry, validateAncestryEvidence } from '../authenticated-ancestry.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { validateInputFacts } from '../input-facts.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { SEPOLIA_AMSTERDAM, ETHEREUM_NETWORK_SCHEDULES } from '../ethereum-network.js';
import { proofFixture, A, C, word } from './proof-fixture.js';

const CHAIN = 11155111, activation = BigInt(SEPOLIA_AMSTERDAM.timestamp);
const template = JSON.parse(readFileSync(new URL('./fixtures/sepolia-network/header-12018196.json', import.meta.url)));
const quantity = n => '0x' + BigInt(n).toString(16);
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash','blockAccessListHash','slotNumber'];
const integers = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas','slotNumber']);
function rehash(header) {
  const values = order.filter(k => Object.hasOwn(header, k)).map(k => {
    let value = header[k].slice(2);
    if (integers.has(k)) { value = BigInt(header[k]) === 0n ? '' : BigInt(header[k]).toString(16); if (value.length % 2) value = '0' + value; }
    return Buffer.from(value, 'hex');
  });
  return { ...header, hash: '0x' + Buffer.from(keccak_256(RLP.encode(values))).toString('hex') };
}

// Synthetic initial trie and linked headers straddling activation. The saved
// public header supplies only a field template; these are not chain observations.
async function fixture(chainId = CHAIN) {
  const proof = await proofFixture({ requested: [] }), blocks = [], calls = [];
  let parentHash = word(99);
  for (let distance = 2; distance >= 0; distance--) {
    const header = { ...template, stateRoot: proof.input.stateRoot, parentHash,
      number: quantity(BigInt(template.number) - BigInt(distance)), timestamp: quantity(activation - BigInt(distance * 12)) };
    if (distance > 0) { delete header.blockAccessListHash; delete header.slotNumber; }
    const linked = rehash(header); blocks.push(linked); parentHash = linked.hash;
  }
  const header = blocks.at(-1), byHash = new Map(blocks.map(h => [h.hash, h]));
  const rpc = { async call(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'eth_getBlockByHash') { assert.deepEqual(params, [params[0], false]); return structuredClone(byHash.get(params[0])); }
    assert(['eth_getProof', 'eth_getCode'].includes(method));
    assert.deepEqual(params.at(-1), { blockHash: header.hash, requireCanonical: true });
    const result = await proofFixture({ address: params[0], requested: method === 'eth_getProof' ? params[1] : [] });
    return method === 'eth_getProof' ? result.input.proof : result.input.code;
  } };
  return { header, blocks, calls, stateRoot: proof.input.stateRoot, collector: createRpcStateInputs({ chainId, header, blockHash: header.hash, rpc }) };
}

test('Sepolia sparse facts require an explicit parent-selected chain even when the proof cache is warm', async () => {
  const f = await fixture(), c = f.collector;
  assert.equal(await c.getStorage(A, word(0)), word(7));
  assert.equal(await c.getStorage(C, word(99)), word(0));
  const args = { inputs: c.snapshotInputs(), inputEvidence: c.snapshotEvidence(), stateRoot: f.stateRoot, cache: new Map() };
  assert.equal(args.inputs.context.chainId, CHAIN);
  assert.equal(await validateInputFacts({ ...args, chainId: CHAIN }), true);
  await assert.rejects(validateInputFacts(args), { code: 'LOCAL_INPUT_FACTS_INVALID' });
  for (const chainId of [1, 999, '11155111', 11155111n, null]) await assert.rejects(validateInputFacts({ ...args, chainId }));
  const changed = structuredClone(args.inputs); changed.context.chainId = 1;
  await assert.rejects(validateInputFacts({ ...args, inputs: changed, chainId: CHAIN }));
  assert.equal(await validateInputFacts({ ...args, chainId: CHAIN }), true);
  assert.deepEqual(args.inputs.accounts[C], { exists: false });
});

test('Sepolia authenticated ancestry selects each ancestor fork across the Amsterdam boundary', async () => {
  const f = await fixture(), c = f.collector, height = BigInt(f.header.number);
  assert.equal(verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: CHAIN }).headerFields, 23);
  assert.equal(verifyEthereumHeader({ header: f.blocks[1], expectedHash: f.blocks[1].hash, chainId: CHAIN }).headerFields, 21);
  assert.equal(Buffer.from((await c.blockchain.getBlock(height - 1n)).hash()).toString('hex'), f.header.parentHash.slice(2));
  assert.equal(f.calls.length, 0);
  assert.equal(Buffer.from((await c.blockchain.getBlock(height - 3n)).hash()).toString('hex'), word(99).slice(2));
  assert.deepEqual(f.calls, f.blocks.slice(0, 2).reverse().map(h => ({ method: 'eth_getBlockByHash', params: [h.hash, false] })));
  const snapshot = c.snapshotInputs().ancestry, evidence = c.snapshotEvidence();
  assert.equal(snapshot.chainId, CHAIN); assert.equal(snapshot.forkSchedule, ETHEREUM_NETWORK_SCHEDULES[CHAIN]);
  assert.deepEqual(snapshot.headers.map(h => h.hardfork), ['bpo2', 'bpo2']);
  assert(snapshot.headers.every(h => h.chainId === CHAIN && h.headerFields === 21));
  validateAncestryEvidence(f.header, snapshot, evidence, CHAIN);
  assert.throws(() => validateAncestryEvidence(f.header, snapshot, evidence));
});

test('network labels, ancestor fork claims and committed fields cannot replace parent-selected verification', async () => {
  const f = await fixture(), c = f.collector;
  await c.blockchain.getBlock(BigInt(f.header.number) - 3n);
  const original = c.snapshotInputs().ancestry, evidence = c.snapshotEvidence();
  for (const mutate of [s => { s.chainId = 1; }, s => { delete s.chainId; }, s => { s.forkSchedule = ETHEREUM_NETWORK_SCHEDULES[1]; }, s => { s.headers[0].hardfork = 'amsterdam'; }, s => { s.headers[0].chainId = 1; }]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => validateAncestryEvidence(f.header, changed, evidence, CHAIN));
  }
  const changedEvidence = structuredClone(evidence); changedEvidence[0].result.slotNumber = '0x1';
  assert.throws(() => validateAncestryEvidence(f.header, original, changedEvidence, CHAIN));
  const cursor = createAuthenticatedAncestry(f.header, CHAIN);
  assert.throws(() => cursor.accept({ ...f.blocks[1], timestamp: f.header.timestamp }, 1));
  assert.throws(() => validateAncestryEvidence(f.header, undefined, [], '11155111'));
});

test('wrong or unsupported ancestry network rejects before transport dispatch', async () => {
  for (const chainId of [1, 999]) {
    const f = await fixture(chainId);
    await assert.rejects(f.collector.blockchain.getBlock(BigInt(f.header.number) - 2n));
    assert.equal(f.calls.length, 0); assert.equal(f.collector.snapshotUsage().status, 'unavailable');
  }
});

test('Sepolia BLOCKHASH range rules need no extra RPC outside the committed 256-block window', async () => {
  const f = await fixture(), height = BigInt(f.header.number), c = f.collector;
  for (const number of [height, height + 1n, height - 257n]) assert.equal(Buffer.from((await c.blockchain.getBlock(number)).hash()).toString('hex'), word(0).slice(2));
  assert.equal(f.calls.length, 0); assert.deepEqual(c.snapshotInputs().ancestry.lookups, []);
  validateAncestryEvidence(f.header, c.snapshotInputs().ancestry, [], CHAIN);
});
