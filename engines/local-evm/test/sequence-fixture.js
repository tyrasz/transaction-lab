// Synthetic ERC20-shaped token and 1:1 vault, NOT Aave, Morpho, ERC4626, or a
// public deployment. Only initial state/proofs and callable bytecode are built.
// No expected poststate, VM execution, reference output, or network input here.
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { feeFixture, TX_SENDER, COINBASE } from './fee-fixture.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { bytes, hex, word } from './proof-fixture.js';

export const SEQUENCE_SENDER = TX_SENDER;
export const SEQUENCE_TOKEN = '0x' + '71'.repeat(20);
export const SEQUENCE_VAULT = '0x' + '72'.repeat(20);
export const SEQUENCE_RECIPIENT = '0x' + '73'.repeat(20);
export const SEQUENCE_FAULT_SLOT = word(3);
export const SEQUENCE_SCOPE = 'synthetic_token_and_one_to_one_vault_initial_proofs_only';
const MAX = (1n << 256n) - 1n;
const uint = value => { const n = BigInt(value); assert(n >= 0n && n <= MAX); return n; };
const address = value => { assert.equal(typeof value, 'string'); assert.match(value, /^0x[0-9a-f]{40}$/); return value; };
const selector = signature => hex(keccak_256(new TextEncoder().encode(signature))).slice(0, 10);
const topic = signature => hex(keccak_256(new TextEncoder().encode(signature)));
const METHODS = Object.freeze({
  approve: ['approve(address,uint256)', ['address', 'uint']],
  transfer: ['transfer(address,uint256)', ['address', 'uint']],
  transferFrom: ['transferFrom(address,address,uint256)', ['address', 'address', 'uint']],
  balanceOf: ['balanceOf(address)', ['address']],
  allowance: ['allowance(address,address)', ['address', 'address']],
  totalSupply: ['totalSupply()', []],
  deposit: ['deposit(uint256)', ['uint']],
  withdraw: ['withdraw(uint256)', ['uint']],
  depositThenRevert: ['depositThenRevert(uint256)', ['uint']],
  depositThenOutOfGas: ['depositThenOutOfGas(uint256)', ['uint']],
  revertAfterWrite: ['revertAfterWrite()', []],
  outOfGas: ['outOfGas()', []],
});
export const SEQUENCE_SELECTORS = Object.freeze(Object.fromEntries(Object.entries(METHODS).map(([name, [signature]]) => [name, selector(signature)])));
export const SEQUENCE_TOPICS = Object.freeze({
  transfer: topic('Transfer(address,address,uint256)'),
  approval: topic('Approval(address,address,uint256)'),
  deposit: topic('SyntheticDeposit(address,uint256)'),
  withdraw: topic('SyntheticWithdraw(address,uint256)'),
});
export function encodeSequenceCall(method, args = []) {
  assert(Object.hasOwn(METHODS, method)); assert(Array.isArray(args));
  const types = METHODS[method][1]; assert.equal(args.length, types.length);
  return SEQUENCE_SELECTORS[method] + args.map((value, i) => word(types[i] === 'address' ? BigInt(address(value)) : uint(value)).slice(2)).join('');
}
function mapSlot(owner, slot) { return hex(keccak_256(bytes(word(BigInt(address(owner))) + word(slot).slice(2)))); }
export const balanceSlot = owner => mapSlot(owner, 0n);
export const shareSlot = owner => mapSlot(owner, 0n);
export const allowanceSlot = (owner, spender) => hex(keccak_256(bytes(word(BigInt(address(spender))) + mapSlot(owner, 1n).slice(2))));

// The tiny assembler resolves only constant labels. Every emitted jump target
// and PUSH boundary is checked without evaluating the bytecode.
const push = n => { const s = uint(n).toString(16).padStart(2, '0'), data = s.padStart(Math.ceil(s.length / 2) * 2, '0'); return (0x5f + data.length / 2).toString(16) + data; };
const load = n => push(n) + '51';
const store = n => push(n) + '52';
const label = name => ({ label: name });
const target = name => ({ target: name });
const jump = name => [target(name), '56'];
const jumpIf = name => [target(name), '57'];
const structures = [];
function assemble(name, parts) {
  let size = 0; const labels = new Map(), references = [];
  for (const part of parts) {
    if (typeof part === 'string') { assert.match(part, /^(?:[0-9a-f]{2})*$/); size += part.length / 2; }
    else if (part.label) { assert(!labels.has(part.label)); labels.set(part.label, size); }
    else { assert(part.target); size += 3; }
  }
  assert(size < 24576);
  const code = parts.map(part => {
    if (typeof part === 'string') return part;
    if (part.label) return '';
    assert(labels.has(part.target)); const pc = labels.get(part.target); references.push(pc);
    return '61' + pc.toString(16).padStart(4, '0');
  }).join('');
  const encoded = bytes('0x' + code), boundaries = new Set();
  for (let pc = 0; pc < encoded.length; pc++) { boundaries.add(pc); const op = encoded[pc]; if (op >= 0x60 && op <= 0x7f) { pc += op - 0x5f; assert(pc < encoded.length); } }
  for (const pc of references) { assert(boundaries.has(pc)); assert.equal(encoded[pc], 0x5b); }
  structures.push(Object.freeze({ name, bytes: encoded.length, labels: labels.size, checkedJumpReferences: references.length, codeHash: hex(keccak_256(encoded)) }));
  return '0x' + code;
}
const OWNER = 0x80, OTHER = 0xa0, AMOUNT = 0xc0, SPENDER = 0xe0;
const FROM_KEY = 0x100, TO_KEY = 0x120, ALLOW_KEY = 0x140, MODE = 0x160, CALL_RESULT = 0x200;
const key = (owner, slot, destination) => load(owner) + store(0) + push(slot) + store(32) + push(64) + push(0) + '20' + store(destination);
const allowanceKey = () => key(OWNER, 1, ALLOW_KEY) + load(ALLOW_KEY) + store(32) + load(SPENDER) + store(0) + push(64) + push(0) + '20' + store(ALLOW_KEY);
const arg = (offset, destination, isAddress = false) => [push(offset) + '35', ...(isAddress ? ['80' + push(160) + '1c', ...jumpIf('revert')] : []), store(destination)];
const requireBytes = count => [push(count) + '3610', ...jumpIf('revert')];
const returnWord = expression => expression + store(0) + push(32) + push(0) + 'f3';
const returnTrue = returnWord(push(1));
function dispatch(methods) {
  return ['34', ...jumpIf('revert'), ...requireBytes(4), push(0) + '35' + push(224) + '1c',
    ...methods.flatMap(name => ['80' + push(BigInt(SEQUENCE_SELECTORS[name])) + '14', ...jumpIf(name)]), '50', ...jump('revert')];
}
const entry = name => [label(name), '5b50'];
const logToken = event => load(AMOUNT) + store(0) + load(OTHER) + load(OWNER) + push(BigInt(SEQUENCE_TOPICS[event])) + push(32) + push(0) + 'a3';
const logVault = event => load(AMOUNT) + store(0) + load(OWNER) + push(BigInt(SEQUENCE_TOPICS[event])) + push(32) + push(0) + 'a2';
const faultTail = [
  ...entry('revertAfterWrite'), push(3) + '54' + push(1) + '01' + push(3) + '55' + push(0xc0decafe) + store(0) + push(4) + push(28) + 'a0', ...jump('revert'),
  ...entry('outOfGas'), ...jump('spin'),
  // Warm SLOAD keeps the deliberate EVM OOG path below the host step budget.
  label('spin'), '5b' + push(3) + '5450', ...jump('spin'),
  label('revert'), '5b' + push(0xc0decafe) + store(0) + push(4) + push(28) + 'fd',
];
const tokenMethods = ['approve', 'transfer', 'transferFrom', 'balanceOf', 'allowance', 'totalSupply', 'revertAfterWrite', 'outOfGas'];
export const TOKEN_RUNTIME = assemble('synthetic_token', [
  ...dispatch(tokenMethods),
  ...entry('balanceOf'), ...requireBytes(36), ...arg(4, OWNER, true), key(OWNER, 0, FROM_KEY), returnWord(load(FROM_KEY) + '54'),
  ...entry('allowance'), ...requireBytes(68), ...arg(4, OWNER, true), ...arg(36, SPENDER, true), allowanceKey(), returnWord(load(ALLOW_KEY) + '54'),
  ...entry('totalSupply'), returnWord(push(2) + '54'),
  ...entry('approve'), ...requireBytes(68), '33' + store(OWNER), ...arg(4, SPENDER, true), ...arg(36, AMOUNT), allowanceKey(), load(AMOUNT) + load(ALLOW_KEY) + '55', load(SPENDER) + store(OTHER), logToken('approval'), returnTrue,
  ...entry('transfer'), ...requireBytes(68), '33' + store(OWNER), ...arg(4, OTHER, true), ...arg(36, AMOUNT), ...jump('move'),
  ...entry('transferFrom'), ...requireBytes(100), ...arg(4, OWNER, true), ...arg(36, OTHER, true), ...arg(68, AMOUNT), '33' + store(SPENDER), allowanceKey(),
  load(AMOUNT) + load(ALLOW_KEY) + '5410', ...jumpIf('revert'), load(AMOUNT) + load(ALLOW_KEY) + '5403' + load(ALLOW_KEY) + '55', ...jump('move'),
  label('move'), '5b', load(OTHER) + '15', ...jumpIf('revert'), key(OWNER, 0, FROM_KEY), key(OTHER, 0, TO_KEY),
  load(AMOUNT) + load(FROM_KEY) + '5410', ...jumpIf('revert'),
  load(AMOUNT) + load(FROM_KEY) + '5403' + load(FROM_KEY) + '55',
  load(AMOUNT) + load(TO_KEY) + '5401' + load(TO_KEY) + '55', logToken('transfer'), returnTrue,
  ...faultTail,
]);
function tokenCall(method, length) {
  return [push(BigInt(SEQUENCE_SELECTORS[method])) + push(224) + '1b' + store(0),
    ...(method === 'transferFrom' ? [load(OWNER) + store(4) + '30' + store(36) + load(AMOUNT) + store(68)] : [load(OWNER) + store(4) + load(AMOUNT) + store(36)]),
    push(32) + push(CALL_RESULT) + push(length) + push(0) + push(0) + push(BigInt(SEQUENCE_TOKEN)) + '5af115', ...jumpIf('revert'),
    '3d' + push(32) + '1415', ...jumpIf('revert'), load(CALL_RESULT) + push(1) + '1415', ...jumpIf('revert')];
}
const depositEntry = (name, mode) => [...entry(name), ...requireBytes(36), '33' + store(OWNER), ...arg(4, AMOUNT), push(mode) + store(MODE), ...jump('depositBody')];
export const VAULT_RUNTIME = assemble('synthetic_one_to_one_vault', [
  ...dispatch(['deposit', 'withdraw', 'balanceOf', 'totalSupply', 'depositThenRevert', 'depositThenOutOfGas', 'revertAfterWrite', 'outOfGas']),
  ...entry('balanceOf'), ...requireBytes(36), ...arg(4, OWNER, true), key(OWNER, 0, FROM_KEY), returnWord(load(FROM_KEY) + '54'),
  ...entry('totalSupply'), returnWord(push(1) + '54'),
  ...depositEntry('deposit', 0), ...depositEntry('depositThenRevert', 1), ...depositEntry('depositThenOutOfGas', 2),
  label('depositBody'), '5b', ...tokenCall('transferFrom', 100), key(OWNER, 0, FROM_KEY),
  load(AMOUNT) + load(FROM_KEY) + '5401' + load(FROM_KEY) + '55', load(AMOUNT) + push(1) + '5401' + push(1) + '55', logVault('deposit'),
  load(MODE) + push(1) + '14', ...jumpIf('revert'), load(MODE) + push(2) + '14', ...jumpIf('spin'), returnWord(load(AMOUNT)),
  ...entry('withdraw'), ...requireBytes(36), '33' + store(OWNER), ...arg(4, AMOUNT), key(OWNER, 0, FROM_KEY),
  load(AMOUNT) + load(FROM_KEY) + '5410', ...jumpIf('revert'),
  load(AMOUNT) + load(FROM_KEY) + '5403' + load(FROM_KEY) + '55', load(AMOUNT) + push(1) + '5403' + push(1) + '55',
  ...tokenCall('transfer', 68), logVault('withdraw'), returnWord(load(AMOUNT)),
  ...faultTail,
]);

function request(method, args, { priced = false, gas = '5000000' } = {}) {
  assert.equal(typeof priced, 'boolean'); assert(uint(gas) > 0n && uint(gas) <= 5000000n);
  const tokenMethod = ['approve', 'transfer', 'transferFrom', 'allowance'].includes(method);
  return { from: SEQUENCE_SENDER, to: tokenMethod ? SEQUENCE_TOKEN : SEQUENCE_VAULT, data: encodeSequenceCall(method, args), value: '0', gas: uint(gas).toString(),
    ...(priced ? { executionProfile: 'unsigned_eip1559_block_end', fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3' } } : {}) };
}
export function sequenceRequests({ amount = 100n, transferAmount = 25n, withdrawAmount = 40n, priced = false, gas = '5000000' } = {}) {
  const options = { priced, gas };
  return {
    approve: request('approve', [SEQUENCE_VAULT, amount], options),
    deposit: request('deposit', [amount], options),
    transfer: request('transfer', [SEQUENCE_RECIPIENT, transferAmount], options),
    withdraw: request('withdraw', [withdrawAmount], options),
    revert: request('revertAfterWrite', [], options),
    outOfGas: request('outOfGas', [], { priced, gas: '60000' }),
    depositThenRevert: request('depositThenRevert', [amount], options),
    depositThenOutOfGas: request('depositThenOutOfGas', [amount], { priced, gas: '500000' }),
  };
}
export function sequenceQueries() {
  return [
    { to: SEQUENCE_TOKEN, data: encodeSequenceCall('balanceOf', [SEQUENCE_SENDER]) },
    { to: SEQUENCE_TOKEN, data: encodeSequenceCall('allowance', [SEQUENCE_SENDER, SEQUENCE_VAULT]) },
    { to: SEQUENCE_TOKEN, data: encodeSequenceCall('balanceOf', [SEQUENCE_VAULT]) },
    { to: SEQUENCE_VAULT, data: encodeSequenceCall('balanceOf', [SEQUENCE_SENDER]) },
    { to: SEQUENCE_TOKEN, data: encodeSequenceCall('balanceOf', [SEQUENCE_RECIPIENT]) },
    { kind: 'native_balance', account: SEQUENCE_SENDER },
    { kind: 'native_balance', account: COINBASE },
  ];
}
export async function sequenceFixture({ fork = 'osaka', priced = false, initialBalance = 1000n, initialAllowance = 0n, initialVaultAssets = 0n, initialShares = 0n, amount = 100n, transferAmount = 25n, withdrawAmount = 40n, gas = '5000000', limits } = {}) {
  assert(['shanghai', 'cancun', 'prague', 'osaka', 'amsterdam'].includes(fork)); assert.equal(typeof priced, 'boolean');
  for (const n of [initialBalance, initialAllowance, initialVaultAssets, initialShares]) uint(n);
  assert(uint(initialShares) <= uint(initialVaultAssets), 'Initial synthetic shares must be backed by vault assets');
  const total = uint(uint(initialBalance) + uint(initialVaultAssets));
  const tokenStorage = { [balanceSlot(SEQUENCE_SENDER)]: uint(initialBalance), [balanceSlot(SEQUENCE_VAULT)]: uint(initialVaultAssets), [allowanceSlot(SEQUENCE_SENDER, SEQUENCE_VAULT)]: uint(initialAllowance), [word(2)]: total };
  const shareStorage = { [shareSlot(SEQUENCE_SENDER)]: uint(initialShares), [word(1)]: uint(initialShares) };
  const requests = sequenceRequests({ amount, transferAmount, withdrawAmount, priced, gas });
  const options = { baseFee: priced ? 7n : 0n, maxFee: priced ? 13n : 0n, priorityFee: priced ? 3n : 0n, target: null, to: SEQUENCE_TOKEN, data: requests.approve.data, gas, limits,
    accounts: { [SEQUENCE_TOKEN]: { nonce: 1n, balance: 0n, code: TOKEN_RUNTIME, storage: tokenStorage }, [SEQUENCE_VAULT]: { nonce: 1n, balance: 0n, code: VAULT_RUNTIME, storage: shareStorage } } };
  const f = fork === 'amsterdam' ? await amsterdamExecutionFixture({ ...options, priced }) : await feeFixture({ ...options, fork });
  // The RPC closure stays attached to these initial tries for every step. It
  // never returns a predicted poststate; sequence overlays belong to the host.
  return { ...f, request: requests.approve, chainId: fork === 'amsterdam' ? 11155111 : 1, scope: SEQUENCE_SCOPE,
    addresses: { sender: SEQUENCE_SENDER, token: SEQUENCE_TOKEN, vault: SEQUENCE_VAULT, recipient: SEQUENCE_RECIPIENT, coinbase: COINBASE }, requests, queries: sequenceQueries(),
    makeRequest(method, args = [], options = {}) { return request(method, args, { priced, gas, ...options }); },
    slots: { senderBalance: balanceSlot(SEQUENCE_SENDER), vaultBalance: balanceSlot(SEQUENCE_VAULT), senderVaultAllowance: allowanceSlot(SEQUENCE_SENDER, SEQUENCE_VAULT), senderShares: shareSlot(SEQUENCE_SENDER), tokenSupply: word(2), shareSupply: word(1), fault: SEQUENCE_FAULT_SLOT } };
}
// Source/input checks only. They do not assert or manufacture execution results.
export const SEQUENCE_BYTECODE_CHECKS = Object.freeze(structures);
assert.equal(SEQUENCE_SELECTORS.approve, '0x095ea7b3');
assert.equal(SEQUENCE_SELECTORS.transfer, '0xa9059cbb');
assert.equal(SEQUENCE_SELECTORS.transferFrom, '0x23b872dd');
assert.equal(SEQUENCE_SELECTORS.balanceOf, '0x70a08231');
assert.equal(SEQUENCE_SELECTORS.allowance, '0xdd62ed3e');
assert.equal(SEQUENCE_SELECTORS.deposit, '0xb6b55f25');
assert.equal(SEQUENCE_SELECTORS.withdraw, '0x2e1a7d4d');
assert.equal(new Set(Object.values(SEQUENCE_SELECTORS)).size, Object.keys(SEQUENCE_SELECTORS).length);
assert.equal(new Set([SEQUENCE_SENDER, SEQUENCE_TOKEN, SEQUENCE_VAULT, SEQUENCE_RECIPIENT, COINBASE]).size, 5);
assert(sequenceQueries().length <= 8);
