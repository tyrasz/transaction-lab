// Offline prestate, signature, and bytecode-layout checks. No EVM/client runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CASES, SYSTEMS, declaration, fixture} from './cases.mjs';
import {createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {verifyEthereumHeader} from '../../engines/local-evm/ethereum-header.js';
import {allocationRoot, bytes, hex, word} from '../amsterdam-storage-creation-v033/observations.mjs';

const OUTER = '0x' + '44'.repeat(20), HELPER = '0x' + '66'.repeat(20);
const expectedCases = [
  ['shanghai_root_create_old_equal', 'Shanghai', 'CREATE', true, 'success'],
  ['cancun_internal_create_old_equal', 'Cancun', 'CREATE', false, 'success'],
  ['prague_root_create_old_equal', 'Prague', 'CREATE', true, 'success'],
  ['osaka_internal_create2_old_equal', 'Osaka', 'CREATE2', false, 'success'],
  ['osaka_constructor_revert_caught', 'Osaka', 'CREATE2', false, 'constructor_revert'],
  ['osaka_ancestor_revert_caught', 'Osaka', 'CREATE2', false, 'ancestor_revert'],
  ['amsterdam_root_constructor_revert', 'Amsterdam', 'CREATE', true, 'constructor_revert'],
  ['amsterdam_ancestor_revert_caught', 'Amsterdam', 'CREATE2', false, 'ancestor_revert'],
];
let prepared;
const inputs = () => prepared ??= Promise.all(CASES.map((_, i) => declaration(i)));

// Decode PUSH boundaries so payload bytes cannot masquerade as instructions.
function instructions(code) {
  const data = bytes(code), result = [];
  for (let pc = 0; pc < data.length;) {
    const at = pc, op = data[pc++], size = op >= 0x60 && op <= 0x7f ? op - 0x5f : 0;
    assert(pc + size <= data.length, `truncated PUSH at ${at}`);
    const argument = data.slice(pc, pc + size);
    result.push({pc: at, op, value: size ? BigInt(hex(argument)) : null});
    pc += size;
  }
  return result;
}

const values = ops => ops.map(({op, value}) => [op, value]);
const push = (ops, i, value) => {
  assert(ops[i]?.op >= 0x60 && ops[i].op <= 0x7f, `expected PUSH at index ${i}`);
  assert.equal(ops[i].value, BigInt(value));
};

function copiedPayload(code, expectedPayload) {
  const ops = instructions(code), copy = ops.findIndex(op => op.op === 0x39);
  assert(copy >= 3, 'missing CODECOPY prefix');
  push(ops, copy - 3, bytes(expectedPayload).length);
  const start = Number(ops[copy - 2].value);
  push(ops, copy - 2, start);
  push(ops, copy - 1, 0);
  assert(start > ops[copy].pc, 'payload must follow executable prefix');
  assert.equal(hex(bytes(code).slice(start)), expectedPayload);
  return {ops: instructions(hex(bytes(code).slice(0, start))), start};
}

test('the ordered eight declarations are deterministic and remain input-only', async () => {
  assert.equal(CASES.length, 8);
  assert(Object.isFrozen(CASES) && CASES.every(Object.isFrozen));
  assert.deepEqual(CASES.map(c => [c.id, c.fork, c.kind, c.rootCreate, c.scenario]), expectedCases);
  const declarations = await inputs();
  for (const [i, d] of declarations.entries()) {
    assert.equal(d.index, i);
    assert.deepEqual(await declaration(i), d);
    for (const prohibited of ['expectedPostState', 'expectedResult', 'stateRoot', 'receipt', 'executionStatus']) {
      assert.equal(Object.hasOwn(d, prohibited), false);
    }
    assert.equal(d.chainId, d.fork === 'Amsterdam' ? 11155111 : 1);
  }
  assert.equal(new Set(declarations.map(d => d.id)).size, 8);
});

test('every signed type-2 envelope roundtrips and matches the declared call', async () => {
  for (const [i, d] of (await inputs()).entries()) {
    const f = await fixture(i), signed = bytes(d.signedBytes);
    assert.equal(signed[0], 2);
    const tx = createTxFromRLP(signed, {common: f.common});
    assert(tx.verifySignature());
    assert.equal(tx.getSenderAddress().toString(), d.request.from);
    assert.equal(hex(tx.serialize()), d.signedBytes);
    assert.equal(hex(keccak(signed)), d.transactionHash);
    assert.equal(hex(RLP.encode([signed])), d.transactionBody);
    assert.deepEqual(JSON.parse(JSON.stringify(tx.toJSON())), d.transaction);
    assert.equal(tx.nonce, 1n);
    assert.equal(tx.common.chainId(), BigInt(d.chainId));
    assert.equal(tx.to?.toString() ?? null, d.request.to);
    assert.equal(hex(tx.data), d.request.data);
    assert.equal(tx.value, BigInt(d.request.value));
    assert.equal(tx.gasLimit, BigInt(d.request.gas));
    assert.equal(tx.maxFeePerGas, BigInt(d.request.fees.maxFeePerGas));
    assert.equal(tx.maxPriorityFeePerGas, BigInt(d.request.fees.maxPriorityFeePerGas));
    assert.deepEqual(tx.accessList, []);
    assert.equal(tx.getIntrinsicGas().toString(), d.inputGas.intrinsic);
    assert.equal(d.inputGas.calldataFloor === null, ['Shanghai', 'Cancun'].includes(d.fork));
    const fields = RLP.decode(signed.slice(1));
    assert.equal(fields.length, 12);
    assert.equal(fields[5].length === 0, d.rootCreate);
    assert.deepEqual(fields[8], []);
  }
});

test('fork headers, full allocation roots, and the declared STOP amendment agree', async () => {
  for (const d of await inputs()) {
    const verified = verifyEthereumHeader({header: d.header, expectedHash: d.headerHash, chainId: d.chainId});
    assert.equal(verified.hardfork, d.fork.toLowerCase());
    assert.equal(d.header.hash, d.headerHash);
    assert.equal(await allocationRoot(d.originalAllocation), d.originalStateRoot);
    assert.equal(await allocationRoot(d.allocation), d.initialStateRoot);
    assert.equal(d.header.stateRoot, d.initialStateRoot);
    assert.notEqual(d.initialStateRoot, d.originalStateRoot);
    const restored = structuredClone(d.allocation);
    for (const address of SYSTEMS) {
      assert.equal(Object.hasOwn(d.originalAllocation, address), false);
      assert.deepEqual(restored[address], {nonce: '0x1', balance: '0x0', code: '0x00', storage: {}});
      delete restored[address];
    }
    assert.deepEqual(restored, d.originalAllocation);
    assert.deepEqual(d.amendment.addresses, SYSTEMS);
    assert.equal(Object.hasOwn(d.environment, 'currentExcessBlobGas'), d.fork !== 'Shanghai');
    assert.equal(Object.hasOwn(d.environment, 'parentBeaconBlockRoot'), d.fork !== 'Shanghai');
    assert.equal(Object.hasOwn(d.environment, 'slotNumber'), d.fork === 'Amsterdam');
    assert.deepEqual(d.environment.withdrawals, []);
    assert.deepEqual(d.allocation[d.target], {
      nonce: '0x0', balance: '0x11', code: '0x',
      storage: {[word(0)]: word(999), [word(991)]: word(123456)},
    });
    const targetTrie = await createMPT({useKeyHashing: true});
    for (const [slot, value] of Object.entries(d.allocation[d.target].storage)) {
      const minimal = BigInt(value).toString(16);
      await targetTrie.put(bytes(slot), RLP.encode(bytes(minimal.padStart(Math.ceil(minimal.length / 2) * 2, '0'))));
    }
    assert.equal(hex(targetTrie.root()), d.initialTargetStorageRoot);
  }
});

test('CREATE and CREATE2 targets are derived from the actual creator and initcode', async () => {
  for (const d of await inputs()) {
    const creator = d.rootCreate ? d.request.from : d.scenario === 'ancestor_revert' ? HELPER : OUTER;
    assert.equal(d.creator, creator);
    const nonce = BigInt(d.allocation[creator].nonce);
    assert.equal(nonce, d.rootCreate ? 1n : 7n);
    const preimage = d.kind === 'CREATE'
      ? RLP.encode([bytes(creator), Uint8Array.of(Number(nonce))])
      : bytes('0xff' + creator.slice(2) + word(123).slice(2) + hex(keccak(bytes(d.sentinel.initcode))).slice(2));
    assert.equal(hex(keccak(preimage).slice(-20)), d.target);
    assert.notEqual(d.target, creator);
    if (d.rootCreate) {
      assert.equal(d.request.to, null);
      assert.equal(d.request.value, '5');
      assert.equal(d.request.data, d.sentinel.initcode);
    } else {
      assert.equal(d.request.to, OUTER);
      assert.equal(d.request.value, '0');
      assert.equal(d.request.data, '0x');
    }
  }
});

test('constructors read the hidden slot, write old-equal and fresh values, then return or REVERT', async () => {
  const expectedPrefix = [
    [0x61, 991n], [0x54, null], [0x60, 1n], [0x55, null],
    [0x61, 999n], [0x60, 0n], [0x55, null],
    [0x60, 42n], [0x60, 2n], [0x55, null],
  ];
  for (const d of await inputs()) {
    const ops = instructions(d.sentinel.initcode);
    assert.deepEqual(values(ops.slice(0, expectedPrefix.length)), expectedPrefix);
    if (d.scenario === 'constructor_revert') {
      assert.deepEqual(values(ops.slice(expectedPrefix.length)), [[0x60, 0n], [0x60, 0n], [0xfd, null]]);
    } else {
      const {ops: executable} = copiedPayload(d.sentinel.initcode, d.sentinel.runtime);
      assert.equal(executable.at(-1).op, 0xf3);
      assert.equal(executable.some(op => op.op === 0xfd), false);
      push(executable, executable.length - 3, bytes(d.sentinel.runtime).length);
      push(executable, executable.length - 2, 0);
    }
    assert.deepEqual(d.probes.oldEqualWrite, {slot: word(0), value: word(999)});
    assert.deepEqual(d.probes.hiddenRead, {slot: word(991), destinationSlot: word(1)});
    assert.deepEqual(d.probes.freshWrite, {slot: word(2), value: word(42)});
  }
});

test('internal creation copies exact initcode after the caller dirty write and restores its original value', async () => {
  for (const d of (await inputs()).filter(d => !d.rootCreate && d.scenario !== 'ancestor_revert')) {
    const {ops} = copiedPayload(d.allocation[OUTER].code, d.sentinel.initcode);
    assert.deepEqual(values(ops.slice(0, 3)), [[0x60, 55n], [0x60, 0n], [0x55, null]]);
    const creation = ops.findIndex(op => op.op === (d.kind === 'CREATE2' ? 0xf5 : 0xf0));
    assert(creation > 3);
    push(ops, creation - 1, 5);
    push(ops, creation - 2, 0);
    push(ops, creation - 3, bytes(d.sentinel.initcode).length);
    if (d.kind === 'CREATE2') push(ops, creation - 4, 123);
    assert.deepEqual(values(ops.slice(creation + 1, creation + 6)), [
      [0x60, 0n], [0x52, null], [0x60, 12n], [0x60, 0n], [0x55, null],
    ]);
    assert.equal(ops.at(-1).op, 0xf3);
    assert.equal(ops.some(op => op.op === 0xfd), false);
    assert.equal(d.allocation[OUTER].storage[word(0)], word(12));
  }
});

test('ancestor rollback is a caught CALL failure after successful CREATE2 and helper writes', async () => {
  for (const d of (await inputs()).filter(d => d.scenario === 'ancestor_revert')) {
    const {ops: helper} = copiedPayload(d.allocation[HELPER].code, d.sentinel.initcode);
    assert.deepEqual(values(helper.slice(0, 3)), [[0x60, 43n], [0x60, 1n], [0x55, null]]);
    const creation = helper.findIndex(op => op.op === 0xf5);
    assert(creation > 3);
    push(helper, creation - 1, 5);
    push(helper, creation - 2, 0);
    push(helper, creation - 3, bytes(d.sentinel.initcode).length);
    push(helper, creation - 4, 123);
    assert.deepEqual(values(helper.slice(creation + 1)), [[0x50, null], [0x60, 0n], [0x60, 0n], [0xfd, null]]);
    const root = instructions(d.allocation[OUTER].code), call = root.findIndex(op => op.op === 0xf1);
    assert.deepEqual(values(root.slice(0, 3)), [[0x60, 55n], [0x60, 0n], [0x55, null]]);
    push(root, call - 1, 3000000);
    push(root, call - 2, BigInt(HELPER));
    for (const offset of [3, 4, 5, 6, 7]) push(root, call - offset, 0);
    assert.deepEqual(values(root.slice(call + 1, call + 5)), [[0x50, null], [0x60, 12n], [0x60, 0n], [0x55, null]]);
    assert.equal(root.at(-1).op, 0xf3);
    assert.equal(root.some(op => op.op === 0xfd), false);
    assert.equal(d.allocation[OUTER].storage[word(0)], word(12));
    assert.equal(d.allocation[HELPER].storage[word(1)], word(5));
    assert.equal(d.probes.callerOriginal.address, OUTER);
    assert.equal(d.probes.ancestor.address, HELPER);
  }
});
