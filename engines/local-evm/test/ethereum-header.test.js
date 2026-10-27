import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { verifyEthereumHeader } from '../ethereum-header.js';

const raw = readFileSync(new URL('../../../reports/ethereum-proof-capability/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(raw).digest('hex'), 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
const original = JSON.parse(raw).selectedHeader;
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const run = header => verifyEthereumHeader({ header, expectedHash: original.hash });

test('real two-provider Ethereum header independently hashes to its selected block identity', () => {
  const result = run(original);
  assert.deepEqual(result, { status: 'verified', blockHash: original.hash, stateRoot: original.stateRoot, parentHash: original.parentHash, number: '26277709', timestamp: '1793027927', hardfork: 'bpo2', encodedBytes: 649, headerFields: 21, consensusVerified: false, finalityVerified: false, bodyVerified: false });
});

test('tampering any execution-header commitment is rejected despite unchanged declared block hash', () => {
  for (const field of ['parentHash', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'mixHash', 'withdrawalsRoot', 'parentBeaconBlockRoot', 'requestsHash']) assert.throws(() => run({ ...original, [field]: word(1) }), /do not hash/);
  for (const field of ['number', 'timestamp', 'gasLimit', 'gasUsed', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']) assert.throws(() => run({ ...original, [field]: '0x' + (BigInt(original[field]) + 1n).toString(16) }), /do not hash/);
});

test('header byte widths, required fork suffixes and canonical integers cannot be guessed', () => {
  for (const field of ['withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash']) { const header = { ...original }; delete header[field]; assert.throws(() => run(header)); }
  for (const change of [{ number: '0x0190f74d' }, { gasLimit: '0x10000000000000000' }, { miner: word(1) }, { logsBloom: word(1) }, { extraData: '0x' + 'ab'.repeat(33) }, { nonce: '0x0' }, { difficulty: '0x1' }, { sha3Uncles: word(1) }, { gasUsed: '0xffffffffff' }]) assert.throws(() => run({ ...original, ...change }));
});

test('wrong requested hash and unknown future header fields fail closed', () => {
  assert.throws(() => verifyEthereumHeader({ header: original, expectedHash: word(1) }), /differs/);
  assert.throws(() => run({ ...original, blockAccessListHash: word(1) }), /Unsupported header field/);
  const accessor = { ...original }; Object.defineProperty(accessor, 'stateRoot', { enumerable: true, get() { throw new Error('must not evaluate'); } });
  assert.throws(() => run(accessor), /Unsupported header field/);
});

test('Shanghai and Cancun suffix shapes are selected from time and reject later-fork fields', () => {
  // Synthetic historical-shape controls; the real header above supplies the
  // external hash oracle. These controls exercise fork-dependent field counts.
  for (const [timestamp, fieldCount, remove] of [['0x643730d7', 17, ['blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash']], ['0x65f1b057', 20, ['requestsHash']]]) {
    const header = { ...original, timestamp }; for (const key of remove) delete header[key];
    const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot',...(fieldCount === 20 ? ['blobGasUsed','excessBlobGas','parentBeaconBlockRoot'] : [])];
    const integerFields = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
    const values = order.map(key => { let s = header[key].slice(2); if (integerFields.has(key)) { s = BigInt(header[key]) === 0n ? '' : BigInt(header[key]).toString(16); if (s.length % 2) s = '0' + s; } return Buffer.from(s, 'hex'); });
    header.hash = '0x' + Buffer.from(keccak_256(RLP.encode(values))).toString('hex');
    assert.equal(verifyEthereumHeader({ header, expectedHash: header.hash }).headerFields, fieldCount);
    assert.throws(() => verifyEthereumHeader({ header: { ...header, [remove.at(-1)]: original[remove.at(-1)] }, expectedHash: header.hash }), /before their configured fork/);
  }
});

test('RPC body lists are outside the header-commitment claim', () => {
  const result = run({ ...original, transactions: [], withdrawals: [], uncles: [] });
  assert.equal(result.status, 'verified'); assert.equal(result.bodyVerified, false);
});
