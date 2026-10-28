import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { ethereumUsedGas } from '../ethereum-profile.js';
import { factoryCode, initcode } from './lifecycle-fixture.js';
import { authorizationFixture, signAuthorization, AUTHORITY, DELEGATE, SECOND_DELEGATE, TX_SENDER, TEST_KEY,
  TARGET, designation, query, REVERT, word } from './authorization-fixture.js';

function recount(output) {
  output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs,
    ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}), ...(output.authorizationProcessing ? { authorizationProcessing: output.authorizationProcessing } : {}) }));
}
function reprice(output) {
  output.gasAccounting = Object.fromEntries(Object.entries(ethereumUsedGas({
    messageGasUsed: BigInt(output.execution.executionGasUsed), refundCounter: BigInt(output.execution.gasRefundCounter) + BigInt(output.authorizationProcessing?.gasRefundCounter ?? '0'),
    intrinsic: BigInt(output.profile.intrinsicGas), floor: BigInt(output.profile.calldataFloor),
  })).map(([k, v]) => [k, v.toString()]));
}
const run = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
async function tamper(t, f, change, queries) {
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          change(message.result); changed = true;
          if (queries) {
            recount(message.result.preview.original.output);
            for (const row of message.result.preview.measurements) for (const side of [row.before, row.after]) if (side?.output) recount(side.output);
          } else recount(message.result.output);
          values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = queries ? await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries }) : await run(f);
    assert.equal(changed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(queries ? result.preview : result.output, null); assert.equal(result.broker.pendingAtReturn, 0);
  } finally { mock.mock.restore(); }
}

test('parent independently derives every ordered authority decision and refund', async t => {
  const f = await authorizationFixture(), positive = await run(f);
  assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
  for (const change of [
    r => { delete r.output.authorizationProcessing; },
    r => { r.output.authorizationProcessing.entries[0].authority = TX_SENDER; },
    r => { r.output.authorizationProcessing.entries[0].index = 1; },
    r => { r.output.authorizationProcessing.entries[0].status = 'skipped'; r.output.authorizationProcessing.entries[0].reason = 'nonce_mismatch'; },
    r => { r.output.authorizationProcessing.entries[0].claimedSigner = AUTHORITY; },
    r => { r.output.authorizationProcessing.gasRefundCounter = '0'; reprice(r.output); },
    r => { r.output.profile.authorizationList[0].r = '0x1'; },
  ]) await tamper(t, await authorizationFixture(), change);
});

test('parent requires exact retained code, nonce and materialization for authenticated absent authorities', async t => {
  for (const change of [
    r => { r.changes.accounts = r.changes.accounts.filter(row => row.address !== AUTHORITY); },
    r => { r.changes.accounts.find(row => row.address === AUTHORITY).code.after = designation(SECOND_DELEGATE); },
    r => { r.changes.accounts.find(row => row.address === AUTHORITY).nonce.after = '0x2'; },
    r => { r.changes.accounts.find(row => row.address === AUTHORITY).existence.basis = 'unsigned_sender_nonce_materialization'; },
    r => { r.changes.accounts.find(row => row.address === AUTHORITY).existence.basis = 'internal_contract_creation'; },
    r => { r.changes.accounts.find(row => row.address === AUTHORITY).storage[0].before = word(1); },
  ]) await tamper(t, await authorizationFixture({ authority: null, to: AUTHORITY, delegateCode: '0x602a60005500' }), change);
});

test('message REVERT cannot discard preceding authorization state or retain message writes', async t => {
  const make = () => authorizationFixture({ to: AUTHORITY, delegateCode: '0x602a600055' + REVERT });
  const positive = await run(await make()); assert.equal(positive.status, 'completed'); assert.equal(positive.output.execution.status, 'reverted');
  for (const change of [
    r => { r.changes.accounts = r.changes.accounts.filter(row => row.address !== AUTHORITY); },
    r => { r.changes.accounts.find(row => row.address === AUTHORITY).storage = [{ slot: word(0), before: word(0), after: word(42) }]; },
    r => { r.changes.accounts.find(row => row.address === TX_SENDER).nonce.after = '0x3'; },
  ]) await tamper(t, await make(), change);
});

test('parent checks repeated self-authorization before committed sender creation attempts', async t => {
  const list = [signAuthorization({ key: TEST_KEY, nonce: 2n, address: SECOND_DELEGATE }), signAuthorization({ key: TEST_KEY, nonce: 3n })];
  const make = () => authorizationFixture({ to: TX_SENDER, authorizationList: list, delegateCode: factoryCode(initcode('00', ''), { value: 0, tail: '5000' }) });
  const positive = await run(await make()); assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
  assert.equal(positive.changes.accounts.find(row => row.address === TX_SENDER).nonce.after, '0x5');
  for (const change of [
    r => { r.changes.accounts.find(row => row.address === TX_SENDER).nonce.after = '0x4'; },
    r => { r.changes.accounts.find(row => row.address === TX_SENDER).nonce.after = '0x6'; },
    r => { r.output.authorizationProcessing.entries.reverse(); },
    r => { r.output.semantics.senderDelegation.address = SECOND_DELEGATE; },
    r => { r.output.semantics.senderDelegation.authorizationListProcessed = false; },
  ]) await tamper(t, await make(), change);
});

test('skipped signatures cannot authorize extra code or nonce changes', async t => {
  const make = () => authorizationFixture({ authorizationList: [signAuthorization({ patch: { yParity: '0x2' } })], to: AUTHORITY });
  const positive = await run(await make()); assert.equal(positive.status, 'completed'); assert.equal(positive.output.authorizationProcessing.entries[0].reason, 'invalid_signature');
  await tamper(t, await make(), r => { r.changes.accounts.push({ address: AUTHORITY, nonce: { before: '0x0', after: '0x1' }, code: { before: '0x', after: designation(DELEGATE) } }); });
  await tamper(t, await make(), r => { r.changes.accounts.push({ address: AUTHORITY, nonce: { before: '0x0', after: '0x5' } }); });
  await tamper(t, await authorizationFixture({ authorizationList: [signAuthorization({ nonce: 1n })] }), r => {
    r.changes.accounts.push({ address: AUTHORITY, nonce: { before: '0x0', after: '0x5' } });
  });
});

test('before/after query sender semantics use original and prepared code separately', async t => {
  const make = clear => authorizationFixture({ sender: clear ? { code: designation(DELEGATE) } : {}, to: TARGET,
    authorizationList: [signAuthorization({ key: TEST_KEY, nonce: 2n, address: clear ? '0x' + '00'.repeat(20) : DELEGATE })] });
  for (const clear of [false, true]) {
    const f = await make(clear), q = [query(DELEGATE)];
    const positive = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: q });
    assert.equal(positive.status, 'completed', JSON.stringify(positive.error)); assert.equal(positive.preview.status, 'complete');
    const m = positive.preview.measurements[0];
    assert.equal(m.before.output.semantics.senderDelegation?.address, clear ? DELEGATE : undefined);
    assert.equal(m.after.output.semantics.senderDelegation?.address, clear ? undefined : DELEGATE);
    await tamper(t, await make(clear), r => {
      const side = r.preview.measurements[0].after;
      if (clear) { side.output.semantics.senderDelegation = { address: DELEGATE, authorizationListProcessed: false }; side.output.semantics.callerNonce = 'runCall_increment_and_committed_sender_creation_attempts'; }
      else { delete side.output.semantics.senderDelegation; side.output.semantics.callerNonce = 'runCall_increments_once_including_EVM_revert'; }
    }, q);
    await tamper(t, await make(clear), r => { r.preview.measurements[0].after.output.authorizationProcessing = structuredClone(r.preview.original.output.authorizationProcessing); }, q);
  }
});
