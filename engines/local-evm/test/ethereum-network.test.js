import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sepolia } from '@ethereumjs/common';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ethereumNetworkCommon, ETHEREUM_NETWORK_SCHEDULES, SEPOLIA_AMSTERDAM } from '../ethereum-network.js';
import { verifyEthereumHeader } from '../ethereum-header.js';

const raw = name => readFileSync(new URL('./fixtures/sepolia-network/' + name, import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const provenance = JSON.parse(raw('provenance.json'));
assert.equal(sha(raw(provenance.header.path)), 'dd7eb647ef6be190561896eb8bcef58750cc08ed940081d539fdc592708faceb');
assert.equal(sha(raw(provenance.schedule.path)), SEPOLIA_AMSTERDAM.sha256);
const header = JSON.parse(raw(provenance.header.path)), schedule = JSON.parse(raw(provenance.schedule.path));
const activation = BigInt(SEPOLIA_AMSTERDAM.timestamp), qty = value => '0x' + BigInt(value).toString(16);
const verify = value => verifyEthereumHeader({ header: value, expectedHash: value.hash, chainId: 11155111 });
function hash(value, amsterdam) {
  const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash', ...(amsterdam ? ['blockAccessListHash','slotNumber'] : [])];
  const integers = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas','slotNumber']);
  const fields = order.map(key => {
    let hex = value[key].slice(2);
    if (integers.has(key)) { hex = BigInt(value[key]) === 0n ? '' : BigInt(value[key]).toString(16); if (hex.length % 2) hex = '0' + hex; }
    return Buffer.from(hex, 'hex');
  });
  return '0x' + Buffer.from(keccak_256(RLP.encode(fields))).toString('hex');
}

test('pinned Sepolia activation selects exact fork boundaries without mutating global or returned Common state', () => {
  assert.equal(schedule.chainId, 11155111); assert.equal(String(schedule.amsterdamTime), SEPOLIA_AMSTERDAM.timestamp);
  for (const name of ['shanghai','cancun','prague','osaka','bpo1','bpo2']) {
    const fork = Sepolia.hardforks.find(row => row.name === name);
    assert.equal(String(schedule[name + 'Time']), fork.timestamp);
    assert.equal(ethereumNetworkCommon({ number: header.number, timestamp: qty(fork.timestamp) }, 11155111).hardfork(), name);
  }
  const before = ethereumNetworkCommon({ ...header, timestamp: qty(activation - 1n) }, 11155111);
  const after = ethereumNetworkCommon({ ...header, timestamp: qty(activation) }, 11155111);
  assert.equal(before.hardfork(), 'bpo2'); assert.equal(after.hardfork(), 'amsterdam'); assert.equal(after.chainId(), 11155111n);
  assert.equal(after.isActivatedEIP(7928), true); assert.equal(after.isActivatedEIP(7843), true);
  after.setHardfork('shanghai'); assert.equal(ethereumNetworkCommon(header, 11155111).hardfork(), 'amsterdam');
  assert.equal(Sepolia.hardforks.find(row => row.name === 'amsterdam').timestamp, undefined);
  const mainnet = ethereumNetworkCommon({ ...header, number: '0x190f74d' }); assert.equal(mainnet.chainId(), 1n); assert.equal(mainnet.hardfork(), 'bpo2');
});

test('real saved Sepolia header has the exact 23-field hash and explicit limited network metadata', () => {
  assert.equal(hash(header, true), provenance.header.blockHash);
  const result = verify(header);
  assert.equal(result.blockHash, provenance.header.blockHash); assert.equal(result.number, provenance.header.blockNumber);
  assert.equal(result.headerFields, 23); assert.equal(result.hardfork, 'amsterdam'); assert.equal(result.chainId, 11155111);
  assert.equal(result.forkSchedule, ETHEREUM_NETWORK_SCHEDULES[11155111]);
  assert.equal(result.consensusVerified, false); assert.equal(result.finalityVerified, false); assert.equal(result.bodyVerified, false);
  // The same network-external header must not be silently selected as mainnet:
  // its block number is also incompatible with mainnet's timestamp forks.
  assert.throws(() => verifyEthereumHeader({ header, expectedHash: header.hash }));
});

test('Amsterdam suffix ordering, omission, widths and values cannot be substituted', () => {
  for (const key of ['blockAccessListHash','slotNumber']) { const value = { ...header }; delete value[key]; assert.throws(() => verify(value)); }
  for (const patch of [
    { blockAccessListHash: '0x' + '01'.repeat(32) }, { slotNumber: qty(BigInt(header.slotNumber) + 1n) },
    { blockAccessListHash: '0x' + '01'.repeat(31) }, { slotNumber: '0x00' },
    { slotNumber: '0x10000000000000000' }, { slotNumber: '-1' }, { slotNumber: 1 },
    { blockAccessListHash: header.slotNumber, slotNumber: header.blockAccessListHash },
  ]) assert.throws(() => verify({ ...header, ...patch }));
  assert.throws(() => verifyEthereumHeader({ header, expectedHash: '0x' + '00'.repeat(32), chainId: 11155111 }), /differs/);
});

test('activation boundary requires active suffixes and forbids them before activation', () => {
  const before = { ...header, timestamp: qty(activation - 1n) }; delete before.blockAccessListHash; delete before.slotNumber;
  before.hash = hash(before, false); assert.equal(verify(before).headerFields, 21);
  assert.throws(() => verify({ ...before, blockAccessListHash: header.blockAccessListHash }), /before its configured fork/);
  assert.throws(() => verify({ ...before, slotNumber: header.slotNumber }), /before its configured fork/);
  const after = { ...header, timestamp: qty(activation) }; after.hash = hash(after, true); assert.equal(verify(after).headerFields, 23);
  delete after.slotNumber; assert.throws(() => verify(after));
});

test('chain selectors and hostile header properties reject without invoking caller code', () => {
  for (const chainId of [0, 999, 42161, '1', '11155111', 11155111n, null, {}, NaN]) {
    assert.throws(() => ethereumNetworkCommon(header, chainId), { code: 'LOCAL_ETHEREUM_CHAIN_UNSUPPORTED' });
    assert.throws(() => verifyEthereumHeader({ header, expectedHash: header.hash, chainId }));
  }
  let calls = 0;
  for (const key of ['number','timestamp','slotNumber','blockAccessListHash']) {
    const value = { ...header }; Object.defineProperty(value, key, { enumerable: true, get() { calls++; throw Error('must not execute'); } });
    assert.throws(() => verify(value)); if (key === 'number' || key === 'timestamp') assert.throws(() => ethereumNetworkCommon(value, 11155111));
  }
  const proxy = new Proxy(header, { ownKeys() { calls++; throw Error('must not execute'); }, getPrototypeOf() { calls++; throw Error('must not execute'); } });
  assert.throws(() => verify(proxy)); assert.throws(() => ethereumNetworkCommon(proxy, 11155111));
  const hidden = { ...header }; Object.defineProperty(hidden, 'slotNumber', { value: header.slotNumber, enumerable: false }); assert.throws(() => verify(hidden));
  assert.throws(() => verify({ ...header, [Symbol('extra')]: 1 }));
  for (const patch of [{ timestamp: '0x10000000000000000' }, { number: '0x00' }, { timestamp: '-1' }]) assert.throws(() => ethereumNetworkCommon({ ...header, ...patch }, 11155111));
  assert.equal(calls, 0);
});
