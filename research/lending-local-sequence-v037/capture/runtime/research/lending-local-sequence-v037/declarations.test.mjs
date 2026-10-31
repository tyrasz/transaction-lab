// Offline input and provenance controls only. No client, transport, or EVM is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIGNMENT, MODULE_DEPENDENCIES, SOURCE_FILES, loadLendingSequenceDeclarations } from './declarations.mjs';
import { validateLocalSequence } from '../../src/local-sequence.js';
import { validateStandardSequence } from '../../src/standard-simulation.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const loaded = await loadLendingSequenceDeclarations();
const [aave, kiln] = loaded.cases;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const AAVE_SENDER = '0x48c16c5652add27eddb0f896748a35fc60b8d1b4';
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const KILN_SENDER = '0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668';
const WRAPPER = '0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b';
const VAULT = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
const BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const MARKET = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
const addressWord = address => address.slice(2).padStart(64, '0');
const balance = (token, owner) => ({ to: token, data: '0x70a08231' + addressWord(owner) });
const allowance = (token, owner, spender) => ({ to: token, data: '0xdd62ed3e' + addressWord(owner) + addressWord(spender) });
function decode(data, selector, count) {
  assert.equal(data.slice(0, 10), selector);
  assert.match(data, /^0x[0-9a-f]+$/);
  assert.equal(data.length, 10 + count * 64);
  return Array.from({ length: count }, (_, i) => data.slice(10 + i * 64, 74 + i * 64));
}
const address = word => { assert.equal(word.slice(0, 24), '0'.repeat(24)); return '0x' + word.slice(24); };
const uint = word => BigInt('0x' + word);

async function copiedSources(fn) {
  const root = await mkdtemp(join(tmpdir(), 'lending-v037-declaration-control-'));
  try {
    for (const source of SOURCE_FILES) {
      const destination = join(root, source.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(ROOT, source.path), destination);
    }
    return await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function changeText(root, id, edit) {
  const source = SOURCE_FILES.find(row => row.id === id);
  assert(source);
  const path = join(root, source.path), previous = await readFile(path, 'utf8'), changed = edit(previous);
  assert.notEqual(changed, previous, 'The negative control must alter its source');
  await writeFile(path, changed);
  return { source, previous, changed };
}
const rejectHash = async (root, source) => assert.rejects(loadLendingSequenceDeclarations({ root }),
  error => error.code === 'ERR_ASSERTION' && error.message.includes('Source hash changed: ' + source.path));

test('exact two-case request/header fingerprints and source inventory are fixed', () => {
  assert.equal(loaded.schemaVersion, '1.0');
  assert.deepEqual(loaded.cases.map(c => c.id), ['aave-usdc-approve-supply-withdraw-half', 'morpho-kiln-usdc-approve-deposit-withdraw-half']);
  assert.deepEqual(loaded.cases.map(c => [hash(c.localInput), hash(c.providerInput), hash(c.header)]), [
    ['56f153f878cf0eb819290517a1e3bf992604a7673c973c0ee2b14ddd01779da9', 'f7d75a7f0c55134c3bc1a21884b7562b9e71228f6d3541de221c1fa4ed504372', '818a554f3bf8b240b92e7bc2b3fe01de255e9865ba70ded3cb06fb26d481772f'],
    ['79dde6af3d04748a56c5be75396e7bbd020187dfdf84a2b5af5e1a305867959e', '4cbaf00b85578d6c217506e90f4bda708f4baddf9be10df1df946bba4e108dfd', '6618ecbd075861562803d261632d2253eebc58c56ad0ad458f5d751a91c17bc6'],
  ]);
  // This fixed digest includes every source id, exact path, byte count, SHA-256,
  // and order; changing both the fixture and its recorded hash still fails here.
  assert.equal(hash(SOURCE_FILES), 'b034e0290e0ac88d250cf3da9a9b90d9d73530f363ae5aeab5ecf71f9cbdd9ff');
  assert.equal(SOURCE_FILES.length, 10);
  assert.equal(SOURCE_FILES.reduce((sum, row) => sum + row.bytes, 0), 1830942);
  assert.equal(hash(MODULE_DEPENDENCIES), 'aeb696fb76dee7c2585adba82b14d33d2d3c3643b94b9e2682e5f36a1255493b');
  const alteredInventory = structuredClone(SOURCE_FILES);
  alteredInventory[0].sha256 = '0'.repeat(64);
  assert.notEqual(hash(alteredInventory), hash(SOURCE_FILES));
});

test('both public APIs normalize each declaration without silently dropping or altering fields', () => {
  for (const c of loaded.cases) {
    assert.deepEqual(validateLocalSequence(c.localInput), c.localInput);
    assert.deepEqual(validateStandardSequence(c.providerInput), c.providerInput);
    assert.equal(c.localInput.from, c.from); assert.equal(c.providerInput.from, c.from);
    assert.equal(c.localInput.block, c.header.hash); assert.equal(c.providerInput.block, c.header.hash);
    assert.equal(c.localInput.chainId, 1); assert.equal(c.providerInput.chainId, 1);
    assert.equal(c.localInput.calls.length, 3); assert.equal(c.providerInput.calls.length, 3);
    assert.equal(Object.hasOwn(c.providerInput, 'queries'), false);
    for (let i = 0; i < 3; i++) {
      const { gas, ...local } = c.localInput.calls[i], { queries, ...provider } = c.providerInput.calls[i];
      assert.equal(gas, '5000000'); assert.equal(local.value, '0');
      assert.deepEqual(local, provider); assert.deepEqual(queries, c.localInput.queries);
      assert.deepEqual(c.steps[i].request, local);
    }
  }
});

test('Aave calldata uses the retained USDC amount, Pool approval, sender beneficiary, and rounded-down half withdrawal', () => {
  assert.equal(aave.from, AAVE_SENDER);
  assert.deepEqual(aave.localInput.calls.map(call => call.to), [USDC, POOL, POOL]);
  const [spender, approved] = decode(aave.localInput.calls[0].data, '0x095ea7b3', 2);
  const [asset, supplied, beneficiary, referral] = decode(aave.localInput.calls[1].data, '0x617ba037', 4);
  const [withdrawAsset, amount, recipient] = decode(aave.localInput.calls[2].data, '0x69328dec', 3);
  assert.equal(address(spender), POOL); assert.equal(uint(approved), 3962903485n);
  assert.equal(address(asset), USDC); assert.equal(uint(supplied), 3962903485n);
  assert.equal(address(beneficiary), AAVE_SENDER); assert.equal(uint(referral), 0n);
  assert.equal(address(withdrawAsset), USDC); assert.equal(address(recipient), AAVE_SENDER);
  assert.equal(uint(amount), 1981451742n); assert.equal(2n * uint(amount) + 1n, uint(supplied));
  assert.equal(aave.amounts.depositRaw, '3962903485'); assert.equal(aave.amounts.withdrawRaw, '1981451742');
});

test('Kiln withdrawal is assets-denominated with sender as receiver and owner, not a direct Blue redeem', () => {
  assert.equal(kiln.from, KILN_SENDER);
  assert.deepEqual(kiln.localInput.calls.map(call => call.to), [USDC, WRAPPER, WRAPPER]);
  const [spender, approved] = decode(kiln.localInput.calls[0].data, '0x095ea7b3', 2);
  const [deposited, beneficiary] = decode(kiln.localInput.calls[1].data, '0x6e553f65', 2);
  const [amount, receiver, owner] = decode(kiln.localInput.calls[2].data, '0xb460af94', 3);
  assert.equal(address(spender), WRAPPER); assert.equal(uint(approved), 350000000000n);
  assert.equal(uint(deposited), 350000000000n); assert.equal(address(beneficiary), KILN_SENDER);
  assert.equal(uint(amount), 175000000000n); assert.equal(uint(amount) * 2n, uint(deposited));
  assert.equal(address(receiver), KILN_SENDER); assert.equal(address(owner), KILN_SENDER);
  assert.equal(kiln.steps[2].signature, 'withdraw(uint256,address,address)');
  assert.notEqual(kiln.localInput.calls[2].to, BLUE);
  assert.equal(kiln.amounts.depositRaw, '350000000000'); assert.equal(kiln.amounts.withdrawRaw, '175000000000');
});

test('Aave query order distinguishes sender receipt balance, reserve underlying, allowance, and account data', () => {
  const expected = [balance(USDC, AAVE_SENDER), balance(ATOKEN, AAVE_SENDER), balance(USDC, ATOKEN),
    allowance(USDC, AAVE_SENDER, POOL), { kind: 'aave_v3_user_account_data', contract: POOL, user: AAVE_SENDER }];
  assert.deepEqual(aave.localInput.queries, expected);
  assert.deepEqual(aave.queryRoles.map(row => row.descriptor), expected);
  assert.deepEqual(aave.queryRoles.map(row => row.id), ['owner-usdc', 'beneficiary-aethusdc', 'reserve-usdc', 'owner-pool-usdc', 'aave-account-data']);
  assert.deepEqual(aave.queryRoles.map(row => row.index), [0, 1, 2, 3, 4]);
  assert.equal(aave.queryRoles[2].subject.account, ATOKEN);
  assert.equal(aave.queryRoles[3].subject.spender, POOL);
  assert.match(aave.queryRoles[4].subject.units, /unknown_currency_and_scale/);
});

test('Kiln eight-query tuple preserves wrapper/vault ownership and binds Blue position to vault, not wallet', () => {
  const expected = [balance(USDC, KILN_SENDER), balance(WRAPPER, KILN_SENDER), balance(VAULT, WRAPPER),
    balance(USDC, WRAPPER), balance(USDC, VAULT), balance(USDC, BLUE), allowance(USDC, KILN_SENDER, WRAPPER),
    { kind: 'morpho_blue_position', contract: BLUE, user: VAULT, marketId: MARKET }];
  assert.deepEqual(kiln.localInput.queries, expected);
  assert.deepEqual(kiln.queryRoles.map(row => row.descriptor), expected);
  assert.deepEqual(kiln.queryRoles.map(row => row.id), ['owner-usdc', 'beneficiary-wrapper-shares', 'wrapper-vault-shares',
    'wrapper-usdc', 'vault-usdc', 'blue-usdc', 'owner-wrapper-usdc', 'inner-vault-blue-position']);
  assert.deepEqual(kiln.queryRoles.map(row => row.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(kiln.queryRoles[1].subject.decimals, 6); assert.equal(kiln.queryRoles[2].subject.decimals, 18);
  assert.equal(kiln.queryRoles[2].subject.account, WRAPPER);
  assert.equal(kiln.queryRoles[7].subject.account, VAULT); assert.notEqual(kiln.queryRoles[7].subject.account, KILN_SENDER);
  assert.match(kiln.queryRoles[7].subject.units, /without_asset_conversion/);
});

test('scope keeps novel withdrawals and gas-context differences explicit; returned declarations are immutable', () => {
  assert.equal(loaded.scope.status, 'input_only_preparation'); assert.equal(loaded.scope.newWithdrawalsExecuted, 0);
  assert.equal(loaded.scope.expectedOutputsSupplied, false); assert.equal(loaded.scope.previousTracesOrDiffsUsedAsInitialState, false);
  assert.deepEqual(aave.steps.map(step => step.previouslyCaptured), [true, true, false]);
  assert.deepEqual(kiln.steps.map(step => step.previouslyCaptured), [false, true, false]);
  for (const c of loaded.cases) {
    assert.equal(c.provenance.withdrawalHasPriorCapture, false); assert.equal(c.provenance.selectedSequenceIsOriginalHistory, false);
  }
  assert.equal(ALIGNMENT.localQueryGas, '1000000'); assert.equal(ALIGNMENT.providerQueryGas, '300000');
  assert.equal(ALIGNMENT.identicalQueryExecutionContext, false); assert.equal(ALIGNMENT.queryGasComparison, 'excluded');
  assert.equal(ALIGNMENT.executionBaseFee, '0'); assert.equal(ALIGNMENT.gasPrice, '0'); assert.equal(ALIGNMENT.feesSettled, false);
  assert.throws(() => { SOURCE_FILES[0].sha256 = '0'.repeat(64); }, TypeError);
  assert.throws(() => { aave.localInput.calls[2].data = '0x'; }, TypeError);
  assert.throws(() => { kiln.queryRoles[7].descriptor.user = KILN_SENDER; }, TypeError);
});

test('an isolated exact source copy reproduces both fixed requests', async () => copiedSources(async root => {
  const copied = await loadLendingSequenceDeclarations({ root });
  assert.deepEqual(copied, loaded);
}));

test('same-length provenance URL tampering is rejected by source hash before ABI use', async () => copiedSources(async root => {
  const changed = await changeText(root, 'kilnDocsMetadata', text => text.replace('raw.githubusercontent.com', 'bad.githubusercontent.com'));
  assert.equal(Buffer.byteLength(changed.previous), Buffer.byteLength(changed.changed));
  assert.notEqual(JSON.parse(changed.previous).request.url, JSON.parse(changed.changed).request.url);
  await rejectHash(root, changed.source);
}));

test('same-length change to Aave original supply calldata is refused, not silently re-declared', async () => copiedSources(async root => {
  const oldData = aave.localInput.calls[1].data;
  const newData = oldData.slice(0, -1) + (oldData.endsWith('0') ? '1' : '0');
  const changed = await changeText(root, 'aaveSequence', text => text.split(oldData).join(newData));
  assert.equal(Buffer.byteLength(changed.previous), Buffer.byteLength(changed.changed));
  assert.equal(JSON.parse(changed.changed).apiRequest.calls[1].data, newData);
  await rejectHash(root, changed.source);
}));

test('same-length change to Kiln original deposit beneficiary is refused by pinned source identity', async () => copiedSources(async root => {
  const oldData = kiln.localInput.calls[1].data;
  const newData = oldData.slice(0, -1) + (oldData.endsWith('0') ? '1' : '0');
  const changed = await changeText(root, 'lendingPlan', text => text.split(oldData).join(newData));
  assert.equal(Buffer.byteLength(changed.previous), Buffer.byteLength(changed.changed));
  assert.equal(JSON.parse(changed.changed).cases[1].request.data, newData);
  await rejectHash(root, changed.source);
}));

test('same-length saved header mutation cannot move the fixed initial state', async () => copiedSources(async root => {
  const changed = await changeText(root, 'aaveParent', text => text.replace(aave.header.stateRoot,
    aave.header.stateRoot.slice(0, -1) + (aave.header.stateRoot.endsWith('0') ? '1' : '0')));
  assert.equal(Buffer.byteLength(changed.previous), Buffer.byteLength(changed.changed));
  assert.notEqual(JSON.parse(changed.changed).response.result.stateRoot, aave.header.stateRoot);
  await rejectHash(root, changed.source);
}));

test('saved ABI content changes and byte-count changes both fail closed', async () => copiedSources(async root => {
  const changed = await changeText(root, 'kilnDocs', text => text.replace('0xb460af94', '0xb460af95'));
  assert.equal(Buffer.byteLength(changed.previous), Buffer.byteLength(changed.changed));
  await rejectHash(root, changed.source);
  await writeFile(join(root, changed.source.path), changed.previous + '\n');
  await assert.rejects(loadLendingSequenceDeclarations({ root }), /Source byte count changed/);
}));

test('fixture symlink is refused even when its target has the exact trusted bytes', async () => copiedSources(async root => {
  const source = SOURCE_FILES[0], path = join(root, source.path);
  await rm(path); await symlink(join(ROOT, source.path), path);
  await assert.rejects(loadLendingSequenceDeclarations({ root }), /Source must be a regular file/);
}));
