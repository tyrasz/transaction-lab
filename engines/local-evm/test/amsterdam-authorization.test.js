import test from 'node:test';
import assert from 'node:assert/strict';
import { Common, Mainnet, Sepolia, Hardfork } from '@ethereumjs/common';
import { hexToBytes } from '@ethereumjs/util';
import { amsterdamAuthorizationDecision, chargeAmsterdamAuthorizationGas, applyAmsterdamAuthorizations,
  amsterdamPreparationHalt, AMSTERDAM_AUTHORIZATION_COSTS as COST } from '../amsterdam-authorization.js';
import { authorizationStateDecision } from '../authorization-list.js';
import { AUTH_KEY, TEST_KEY, SECOND_DELEGATE, ZERO, designation } from './authorization-fixture.js';
import { signedStateGasCase, accountAt, TARGET as REF_TARGET } from './state-gas-fixture.js';
import { preparationFixture, authorization, signAuthorization, AUTHORITY, DELEGATE, SENDER, TARGET,
  account, code, address, commonForStateGas, EMPTY_AUTHORITY_CASE, word } from './amsterdam-authorization-fixture.js';

const facts = extra => ({ exists: true, nonce: 0n, balance: 7n, code: '0x', ...extra });
const track = extra => ({ written: false, indicatorCovered: false, ...extra });
const context = extra => ({ authority: AUTHORITY, sender: SENDER, to: TARGET, value: 0n, ...extra });
const decision = (extra = {}, tracking = {}, ctx = {}, tuple = authorization()) =>
  amsterdamAuthorizationDecision(tuple, facts(extra), track(tracking), context(ctx));
const gas = extra => ({ gasLimit: 1000000n, stateGasReservoir: 0n, executionStateGasUsed: 0n, stateGasSpilled: 0n, ...extra });

test('state eligibility charges absent and EIP161-empty authorities, not funded/nonce/code-existing accounts', () => {
  for (const exists of [false, true]) {
    assert.equal(decision({ exists, balance: 0n }).stateGas, COST.newAccount + COST.delegationIndicator);
  }
  assert.equal(decision().stateGas, COST.delegationIndicator);
  assert.equal(decision({ balance: 0n, nonce: 1n }, {}, {}, authorization({ nonce: 1n })).stateGas, COST.delegationIndicator);
  assert.equal(decision({ balance: 0n, code: designation(DELEGATE) }).stateGas, 0n);
  assert.equal(decision({}, {}, {}, authorization({ address: ZERO })).stateGas, 0n);
  assert.equal(decision({ exists: false, balance: 0n }, {}, {}, authorization({ address: ZERO })).stateGas, COST.newAccount);
  assert.equal(decision().executionGas, 9000n);
  for (const ctx of [{ sender: AUTHORITY }, { to: AUTHORITY, value: 1n }]) assert.equal(decision({}, {}, ctx).executionGas, 0n);
  assert.equal(decision({}, {}, { to: AUTHORITY }).executionGas, 9000n);
  assert.equal(decision({}, { written: true }).executionGas, 0n);
  assert.equal(decision({}, { indicatorCovered: true }).stateGas, 0n);
  // Older forks deliberately retain their original existence-based refund.
  assert.equal(authorizationStateDecision(authorization(), facts({ balance: 0n })).gasRefund, 12500n);
});

test('combined charge is atomic at exact execution/state boundaries and tracks reservoir spill once', () => {
  const cost = { executionGas: 9000n, stateGas: 218790n };
  for (const reservoir of [0n, 50000n, 218790n, 300000n]) {
    const spill = reservoir >= cost.stateGas ? 0n : cost.stateGas - reservoir;
    const initial = gas({ gasLimit: cost.executionGas + spill, stateGasReservoir: reservoir });
    const exact = chargeAmsterdamAuthorizationGas(initial, cost);
    assert.equal(exact.outOfGas, false); assert.equal(exact.gasLimit, 0n);
    assert.equal(exact.stateGasSpilled, spill); assert.equal(exact.executionStateGasUsed, 218790n);
    const short = { ...initial, gasLimit: initial.gasLimit - 1n };
    assert.deepEqual(chargeAmsterdamAuthorizationGas(short, cost), { ...short, outOfGas: true });
  }
  for (const invalid of [{ gasLimit: -1n }, { stateGasReservoir: 1n << 32n }, { stateGasSpilled: 1n }]) {
    assert.throws(() => chargeAmsterdamAuthorizationGas(gas(invalid), cost));
  }
  assert.throws(() => chargeAmsterdamAuthorizationGas(gas(), { ...cost, stateGas: -1n }));
});

test('trusted fork/chain and malformed envelopes fail before state reads; universal tuple and explicit mainnet work', async () => {
  let calls = 0;
  const stateManager = { async getAccount() { calls++; }, async getCode() { calls++; return new Uint8Array(); }, async applyAuthorization() { calls++; } };
  const base = { request: { from: SENDER, to: TARGET, value: '0', authorizationList: [authorization()] },
    common: commonForStateGas(), stateManager, gasLimit: 1000000n, stateGasReservoir: 0n };
  for (const common of [new Common({ chain: Sepolia, hardfork: Hardfork.Osaka }), null]) await assert.rejects(applyAmsterdamAuthorizations({ ...base, common }));
  await assert.rejects(applyAmsterdamAuthorizations({ ...base, request: { ...base.request, authorizationList: [] } }));
  await assert.rejects(applyAmsterdamAuthorizations({ ...base, request: { ...base.request, to: null } }));
  assert.equal(calls, 0);
  const wrong = await applyAmsterdamAuthorizations({ ...base, common: new Common({ chain: Mainnet, hardfork: Hardfork.Amsterdam }) });
  assert.equal(wrong.entries[0].reason, 'wrong_chain'); assert.equal(calls, 0);
  for (const chainId of [0n, 1n]) {
    const f = await preparationFixture({ authorizationList: [signAuthorization({ chainId })] }); await f.begin();
    const out = await f.apply({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Amsterdam }) });
    assert.equal(out.entries[0].status, 'applied'); assert.equal(out.gasRefundCounter, 0n);
  }
});

test('recovery-before-access order preserves skipped authority reads, rejects nonexact designation, never warms delegate', async () => {
  const list = [authorization({ chainId: 1n }), authorization({ nonce: (1n << 64n) - 1n }),
    authorization({ patch: { yParity: '0xff' } }), authorization({ nonce: 9n }), authorization()];
  const f = await preparationFixture({ authorizationList: list }); await f.begin(); const out = await f.apply();
  assert.deepEqual(out.entries.map(e => e.reason), ['wrong_chain', 'nonce_overflow', 'invalid_signature', 'nonce_mismatch', null]);
  assert.deepEqual(out.accesses, [{ index: 3, authority: AUTHORITY }, { index: 4, authority: AUTHORITY }]);
  assert.equal(out.writes.length, 1); assert(!out.accesses.some(e => e.authority === DELEGATE));
  for (const malformed of ['0xef0100', designation(DELEGATE) + '00', '0x00']) {
    const x = await preparationFixture({ authority: { nonce: 9n, balance: 7n, code: malformed }, authorizationList: [authorization()] });
    await x.begin(); const result = await x.apply();
    assert.equal(result.entries[0].reason, 'authority_has_code', 'code eligibility precedes nonce mismatch');
    assert.equal(result.accesses.length, 1); assert.equal(result.authorizationGasUsed, 0n); assert.equal(result.writes.length, 0);
  }
});

test('repeated set/clear/set charges account and indicator once; original designation survives charge accounting', async () => {
  for (const preDelegated of [false, true]) {
    const f = await preparationFixture({ authority: { balance: 7n, code: preDelegated ? designation(SECOND_DELEGATE) : '0x' },
      authorizationList: [authorization(), authorization({ nonce: 1n, address: ZERO }), authorization({ nonce: 2n })] });
    await f.begin(); const out = await f.apply();
    assert.equal(out.outOfGas, false); assert.equal(out.writes.length, 3);
    assert.equal(out.authorizationGasUsed, COST.accountWrite + (preDelegated ? 0n : COST.delegationIndicator));
    assert.equal(out.executionStateGasUsed, preDelegated ? 0n : COST.delegationIndicator);
    assert.equal((await account(f.stateManager, AUTHORITY)).nonce, 3n);
    assert.equal(await code(f.stateManager, AUTHORITY), designation(DELEGATE));
    assert.equal(out.writes[2].codeBefore, '0x');
  }
  const f = await preparationFixture({ authority: null, authorizationList: [authorization({ address: ZERO }), authorization({ nonce: 1n })] });
  await f.begin(); const out = await f.apply();
  assert.equal(out.executionStateGasUsed, COST.newAccount + COST.delegationIndicator);
});

test('sender compares already-incremented nonce without a second increment and recipient value prepays first write', async () => {
  const f = await preparationFixture({ authorizationList: [authorization({ key: TEST_KEY, nonce: 1n }),
    authorization({ key: TEST_KEY, nonce: 2n }), authorization({ key: TEST_KEY, nonce: 3n, address: ZERO })] });
  await f.begin(); const out = await f.apply();
  assert.deepEqual(out.entries.map(e => e.status), ['skipped', 'applied', 'applied']);
  assert.equal(out.senderAuthorizationIncrements, 2n); assert.equal((await account(f.stateManager, SENDER)).nonce, 4n);
  assert.equal(out.authorizationGasUsed, COST.delegationIndicator);
  for (const value of ['0', '19']) {
    const x = await preparationFixture({ to: AUTHORITY, value }); await x.begin(); const r = await x.apply();
    assert.equal(r.authorizationGasUsed, COST.delegationIndicator + (value === '0' ? COST.accountWrite : 0n));
  }
});

test('late authorization OOG exposes attempted rows and caller rollback discards all writes but retains sender nonce', async () => {
  const second = authorization({ key: '0x' + '03'.repeat(32) });
  const f = await preparationFixture({ authorizationList: [authorization(), second, authorization({ nonce: 1n })] });
  await f.begin(); const initial = { gasLimit: 50000n, stateGasReservoir: 0n };
  const out = await f.apply(initial);
  assert.equal(out.outOfGas, true); assert.equal(out.failedIndex, 1);
  assert.deepEqual(out.entries.map(e => e.status), ['applied', 'out_of_gas']);
  assert.equal(out.writes.length, 1); assert.equal(out.accesses.length, 2);
  assert.equal((await account(f.stateManager, AUTHORITY)).nonce, 1n, 'uncommitted attempted overlay');
  await f.stateManager.revert();
  assert.equal((await account(f.stateManager, AUTHORITY)).nonce, 0n);
  assert.equal(await code(f.stateManager, AUTHORITY), '0x'); assert.equal((await account(f.stateManager, SENDER)).nonce, 2n);
  assert.deepEqual(amsterdamPreparationHalt(initial, 'authorization'), { phase: 'authorization', retained: false,
    gasLimit: 0n, authorizationGasUsed: 50000n, stateGasReservoir: 0n, executionStateGasUsed: 0n,
    stateGasSpilled: 0n, gasRefundCounter: 0n, senderAuthorizationIncrements: 0n });
  await f.stateManager.commit();
});

test('unexpected state/clock failures propagate unchanged and whole-attempt rollback preserves prior overlay', async () => {
  for (const hook of ['getAccount', 'getCode', 'applyAuthorization', 'check']) for (const error of [Error('host fault'), undefined, null]) {
    const f = await preparationFixture();
    await f.stateManager.checkpoint(); const prior = await account(f.stateManager, TARGET); prior.balance = 123n;
    await f.stateManager.putAccount(address(TARGET), prior); await f.stateManager.commit();
    const baseline = f.stateManager.snapshotChanges(); await f.begin();
    let triggered = false, checks = 0; const extra = {};
    // The fifth check follows applyAuthorization, proving post-write deadline
    // failure rolls back rather than only testing an early admission stop.
    if (hook === 'check') extra.check = () => { if (++checks === 5) { triggered = true; throw error; } };
    else {
      const original = f.stateManager[hook].bind(f.stateManager);
      f.stateManager[hook] = async (...args) => { if (args[0].toString() === AUTHORITY) {
        if (hook === 'applyAuthorization') await original(...args); triggered = true; throw error;
      } return original(...args); };
    }
    let caught = false;
    try { await f.apply(extra); } catch (actual) { caught = true; assert.equal(actual, error); }
    assert(caught && triggered);
    if (hook === 'check') assert.equal(checks, 5);
    await f.stateManager.revert(); await f.stateManager.revert();
    assert.deepEqual(f.stateManager.snapshotChanges(), baseline);
  }
});

test('real proof manager retains storage and reports absent authorization materialization with authenticated inputs', async () => {
  for (const absent of [false, true]) {
    const f = await preparationFixture({ authority: absent ? null : { balance: 0n, storage: { [word(99)]: 7n } } });
    await f.begin(); const out = await f.apply();
    assert.equal(out.executionStateGasUsed, COST.newAccount + COST.delegationIndicator, 'hidden storage does not affect EIP161 emptiness');
    await f.stateManager.commit(); await f.stateManager.commit();
    const value = await f.stateManager.getStorage(address(AUTHORITY), hexToBytes(word(99)));
    assert.equal(value.length ? BigInt('0x' + Buffer.from(value).toString('hex')) : 0n, absent ? 0n : 7n);
    const row = f.stateManager.snapshotChanges().accounts.find(row => row.address === AUTHORITY);
    if (absent) assert.equal(row.existence.basis, 'eip7702_authorization_materialization'); else assert.equal(row.existence, undefined);
    assert.equal(f.inputs.snapshotInputs().context.chainId, 11155111);
    assert(f.calls.some(call => call.method === 'eth_getProof' && call.params[0] === AUTHORITY));
  }
});

async function comparePreparation(options = {}) {
  const list = options.authorizationList ?? [authorization()];
  const authority = options.authority === undefined ? { balance: 7n } : options.authority;
  const target = options.target ?? { nonce: 1n, code: '0x00' };
  const accounts = { ...(authority === null ? {} : { [AUTHORITY]: authority }), [DELEGATE]: { nonce: 1n, code: '0x00' }, ...options.accounts };
  const reference = await signedStateGasCase({ ...options, target, accounts, authorizationList: list });
  const f = await preparationFixture({ authority, accounts, authorizationList: list, to: options.to ?? TARGET, value: String(options.value ?? 0n) });
  await f.begin();
  const out = await f.apply({ gasLimit: reference.budget.messageGasLimit, stateGasReservoir: reference.budget.stateGasReservoirInitial });
  return { f, out, reference };
}

test('signed full-VM preparation agrees for absent/funded/predelegated and repeated authorities with reservoir/spill', async () => {
  const cases = [
    { authority: null }, {}, { authority: { nonce: 0n, balance: 7n, code: designation(DELEGATE) } },
    { authority: { nonce: 3n, balance: 0n }, authorizationList: [authorization({ nonce: 3n })] },
    { authorizationList: [authorization(), authorization({ nonce: 1n, address: ZERO }), authorization({ nonce: 2n })] },
    { gasLimit: 20000000n, authority: null }, { gasLimit: 16777216n + 50000n, authority: null },
    { to: AUTHORITY, value: 19n },
    { authorizationList: [authorization({ key: TEST_KEY, nonce: 2n })] },
  ];
  for (const options of cases) {
    const { out, reference } = await comparePreparation(options);
    assert.equal(out.outOfGas, false); assert(reference.rootEntry);
    assert.equal(out.gasLimit, reference.rootEntry.gasLimit);
    assert.equal(out.authorizationGasUsed, reference.counters.authorizationGasUsed);
    assert.equal(out.stateGasReservoir, reference.rootEntry.reservoir);
    assert.equal(out.executionStateGasUsed, reference.rootEntry.stateUsed);
    assert.equal(reference.counters.authorizationRefundCounter, 0n);
    for (const write of out.writes) {
      assert.equal((await accountAt(reference.state, write.authority)).nonce, out.writes.filter(w => w.authority === write.authority).at(-1).nonceAfter);
      assert.equal(await code(reference.state, write.authority), out.writes.filter(w => w.authority === write.authority).at(-1).codeAfter);
    }
  }
});

test('entered root REVERT/INVALID retains authorization state and state gas in signed full-VM controls', async () => {
  for (const targetCode of ['0x60006000fd', '0xfe']) {
    const { f, out, reference } = await comparePreparation({ target: { nonce: 1n, code: targetCode } });
    assert.equal(reference.result.execResult.exceptionError.error, targetCode === '0xfe' ? 'invalid opcode' : 'revert');
    assert.equal(reference.counters.executionStateGasUsed, out.executionStateGasUsed);
    await f.stateManager.commit(); // prep stays committed even if message reverts
    assert.equal(await code(f.stateManager, AUTHORITY), await code(reference.state, AUTHORITY));
    assert.equal((await account(f.stateManager, AUTHORITY)).nonce, 1n);
  }
});

test('authorization vs recipient preparation OOG preserves distinction and rolls back the same state in full VM', async () => {
  for (const gasLimit of [64006n, 68000n]) {
    const { f, out, reference } = await comparePreparation({ gasLimit, to: AUTHORITY });
    const phase = out.outOfGas ? 'authorization' : 'recipient';
    assert.equal(phase, gasLimit === 64006n ? 'authorization' : 'recipient');
    assert.equal(reference.rootEntry === undefined, phase === 'authorization');
    assert.equal(reference.result.execResult.exceptionError.error, 'out of gas');
    await f.stateManager.revert();
    const halt = amsterdamPreparationHalt({ gasLimit: reference.budget.messageGasLimit,
      stateGasReservoir: reference.budget.stateGasReservoirInitial }, phase);
    assert.equal(halt.executionStateGasUsed, reference.counters.executionStateGasUsed);
    assert.equal(halt.stateGasReservoir, reference.counters.stateGasReservoir);
    assert.equal(halt.authorizationGasUsed, reference.counters.messageGasUsed + reference.counters.authorizationGasUsed);
    assert.equal((await account(f.stateManager, AUTHORITY)).nonce, (await accountAt(reference.state, AUTHORITY)).nonce);
    assert.equal(await code(f.stateManager, AUTHORITY), await code(reference.state, AUTHORITY));
    assert.equal((await account(f.stateManager, SENDER)).nonce, 2n);
  }
});

test('named pinned-EthereumJS divergence: existing-empty authority misses new-leaf charge, helper follows EIP8037/Geth', async () => {
  const reference = await signedStateGasCase(EMPTY_AUTHORITY_CASE);
  const f = await preparationFixture({ authority: EMPTY_AUTHORITY_CASE.accounts[AUTHORITY] }); await f.begin();
  const out = await f.apply({ gasLimit: reference.budget.messageGasLimit });
  assert.equal(reference.rootEntry.stateUsed, COST.delegationIndicator, 'retained known pinned-library observation');
  assert.equal(out.executionStateGasUsed, COST.newAccount + COST.delegationIndicator, 'intended Empty rule, not a claimed client match');
  assert.equal(out.authorizationGasUsed - reference.counters.authorizationGasUsed, COST.newAccount);
  assert.equal(reference.result.totalGasSpent, 67006n);
  assert.equal(reference.costs.intrinsic + out.authorizationGasUsed, 250606n);
  assert.equal(await code(reference.state, AUTHORITY), await code(f.stateManager, AUTHORITY));
  assert.equal((await accountAt(reference.state, AUTHORITY)).nonce, (await account(f.stateManager, AUTHORITY)).nonce);
  assert.equal(REF_TARGET, TARGET);
});
