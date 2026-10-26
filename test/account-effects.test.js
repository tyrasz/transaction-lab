import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectAccountEffects } from '../src/account-effects.js';
import { analyzeTrace } from '../src/analyze.js';
import { analyzePermissions } from '../src/permissions.js';
import { USDC, HUSDC, VUSDC, METADATA } from '../src/config.js';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40), UNKNOWN = '0x' + '4'.repeat(40), ZERO = '0x' + '0'.repeat(40);
const movement = (from, to, amountRaw = '1000000', address = USDC) => ({ from, to, amountRaw, address, basis: 'transfer_event' });
const input = movements => ({ request: { chainId: 999, from: A }, analysis: { execution: { status: 'success' }, movements }, permissions: { observations: [] } });
const tokenAt = (result, account, token = USDC) => result.accounts.find(item => item.address === account)?.tokens.find(item => item.asset.address === token);

test('observed router includes all five USDC event participants, with exact independent event nets', async () => {
  const capture = JSON.parse(await readFile(new URL('../reports/permission-discovery/router-permit-candidate-verified.json', import.meta.url)));
  const tx = capture.captures.transaction.response.result, trace = capture.captures.callTrace.response.result;
  const request = { chainId: 999, from: tx.from, to: tx.to, data: tx.input, value: BigInt(tx.value).toString() };
  const analysis = analyzeTrace({ request, trace, metadata: METADATA });
  const permissions = analyzePermissions({ request, trace, metadata: METADATA });
  const result = projectAccountEffects({ request, analysis, permissions });
  const expected = {
    '0x0c71073344e27e33cb57fcb587fc412d689dfd1d': '-25000000',
    '0x693f12e9e6b35b34458793546065e8b08e0299d6': '0',
    '0x04de1ef694923844bae419d4f832196f21767f86': '24812304',
    '0x7fe37fc2f987eb981a0fc63cf1eabf04463550d4': '196',
    '0xb4894380282533a86cb241145fac54aaac995f18': '187500',
  };
  assert.equal(result.status, 'observed');
  const actual = Object.fromEntries(result.accounts.flatMap(account => account.tokens.filter(token => token.asset.address === USDC && token.events.status === 'observed').map(token => [account.address, token.events.netRaw])));
  assert.deepEqual(actual, expected);
  assert.equal(result.summary.measuredBalancePairs, 0);
  const router = tokenAt(result, '0x693f12e9e6b35b34458793546065e8b08e0299d6');
  assert.equal(router.events.incomingRaw, '25000000');
  assert.equal(router.events.outgoingRaw, '25000000');
  assert.equal(router.balance.status, 'not_measured', 'An event-net zero is not a measured no-op');
  assert.ok(router.permissionReferences.some(item => item.role === 'owner'));
});

test('observed direct transferFrom retains the owner distinct from submitting recipient', async () => {
  const capture = JSON.parse(await readFile(new URL('../reports/affected-account-discovery/direct-transferfrom-a-evidence.json', import.meta.url)));
  const tx = capture.captures.transaction.response.result, trace = capture.captures.callTrace.response.result;
  const request = { chainId: 999, from: tx.from, to: tx.to, data: tx.input, value: '0' };
  const analysis = analyzeTrace({ request, trace, metadata: METADATA });
  const permissions = analyzePermissions({ request, trace, metadata: METADATA });
  const result = projectAccountEffects({ request, analysis, permissions });
  assert.equal(result.summary.accountCount, 2);
  assert.equal(result.summary.nonSubmitterAccountCount, 1);
  const owner = result.accounts.find(item => item.address === '0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379');
  assert.equal(owner.isSubmitter, false);
  assert.equal(owner.tokens[0].events.net, '-1.277067');
  assert.equal(tokenAt(result, tx.from).events.net, '1.277067');
  assert.equal(owner.tokens[0].balance.status, 'not_measured');
  assert.equal(analysis.security.status, 'not_assessed');
});

test('self-transfer, zero events and absent events remain different observations', () => {
  const args = input([movement(A, A), movement(B, A, '0')]);
  args.permissions.observations.push({ id: 'permission-1', kind: 'approval_request', tokenVerified: true, asset: { address: USDC }, owner: C, spender: A });
  const result = projectAccountEffects(args);
  assert.equal(tokenAt(result, A).events.netRaw, '0');
  assert.equal(tokenAt(result, A).events.incomingRaw, '1000000');
  assert.deepEqual(tokenAt(result, A).events.movementIndexes, [0, 1]);
  assert.equal(tokenAt(result, B).events.status, 'observed');
  assert.equal(tokenAt(result, B).events.net, '0');
  assert.equal(tokenAt(result, C).events.status, 'not_observed');
  assert.equal(tokenAt(result, C).events.net, null);
  assert.ok(result.accounts.every(account => account.tokens.every(token => token.balance.status === 'not_measured')));
});

test('mint/burn excludes zero-address pseudo-account and preserves liability and unknown units', () => {
  const result = projectAccountEffects(input([movement(ZERO, A, '1000000', HUSDC), movement(A, ZERO, '7', VUSDC), movement(A, B, '900719925474099312345678901234567890', UNKNOWN)]));
  assert.equal(result.accounts.some(account => account.address === ZERO), false);
  assert.equal(tokenAt(result, A, VUSDC).role, 'liability');
  assert.equal(tokenAt(result, A, HUSDC).role, 'receipt_token');
  const unknown = tokenAt(result, A, UNKNOWN);
  assert.equal(unknown.events.netRaw, '-900719925474099312345678901234567890');
  assert.equal(unknown.events.net, null);
  assert.equal(unknown.asset.symbol, null);
  assert.equal(unknown.tokenVerified, false);
});

test('separate receipt-token state delta is preserved when interest changes event total', () => {
  const args = input([movement(ZERO, A, '1200000', HUSDC)]);
  args.balanceChanges = { status: 'measured', basis: 'historical_transaction_position_balanceOf', assets: [{ account: A, asset: { address: HUSDC }, beforeRaw: '5000000', afterRaw: '6000000', deltaRaw: '1000000', delta: 'untrusted display text' }] };
  const result = projectAccountEffects(args), entry = tokenAt(result, A, HUSDC);
  assert.equal(entry.events.net, '1.2');
  assert.equal(entry.balance.delta, '1');
  assert.equal(entry.balance.balanceChangeIndex, 0);
  assert.equal(result.summary.measuredBalancePairs, 1);
  assert.equal(result.summary.unmeasuredBalancePairs, 0);
});

test('unavailable balances do not become zeros or reference stale assets', () => {
  const args = input([movement(A, B)]);
  args.balanceChanges = { status: 'unavailable', assets: [{ account: C, asset: { address: USDC }, beforeRaw: '0', afterRaw: '0', deltaRaw: '0' }] };
  const result = projectAccountEffects(args);
  assert.equal(result.accounts.length, 2);
  assert.equal(tokenAt(result, A).balance.beforeRaw, undefined);
});

test('final zero allowance is linked to both owner and spender without claiming no spending', () => {
  const args = input([movement(A, B)]);
  args.allowanceChanges = { status: 'measured', allowances: [{ asset: { address: USDC }, owner: A, spender: B, beforeRaw: '0', afterRaw: '0', deltaRaw: '0' }] };
  const result = projectAccountEffects(args);
  assert.deepEqual(tokenAt(result, A).allowanceIndexes, [0]);
  assert.deepEqual(tokenAt(result, B).allowanceIndexes, [0]);
  assert.equal(result.summary.measuredAllowancePairs, 1);
  assert.equal(tokenAt(result, A).events.net, '-1');
});

test('failed execution and unsupported chain never project effective account changes', () => {
  const args = input([movement(A, B)]);
  args.analysis.execution.status = 'reverted';
  assert.equal(projectAccountEffects(args).status, 'not_applicable');
  assert.deepEqual(projectAccountEffects(args).accounts, []);
  args.analysis.execution.status = 'success'; args.request.chainId = 1;
  assert.deepEqual(projectAccountEffects(args).accounts, []);
});

test('malformed amounts, inconsistent measurements and duplicate balance references are withheld', () => {
  const invalid = input([movement(A, B, '-1')]);
  assert.equal(projectAccountEffects(invalid).status, 'unavailable');
  const args = input([movement(A, B)]);
  const entry = { account: A, asset: { address: USDC }, beforeRaw: '2', afterRaw: '1', deltaRaw: '1' };
  args.balanceChanges = { status: 'measured', basis: 'prestate_diff_balanceOf', assets: [entry] };
  assert.equal(projectAccountEffects(args).status, 'unavailable');
  entry.deltaRaw = '-1'; args.balanceChanges.assets.push({ ...entry });
  assert.equal(projectAccountEffects(args).status, 'unavailable');
});

test('bounded account and observation limits fail explicitly rather than silently dropping victims', () => {
  const args = input(Array.from({ length: 65 }, (_, i) => movement(A, '0x' + (i + 100).toString(16).padStart(40, '0'))));
  const result = projectAccountEffects(args);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.accounts, []);
  assert.match(result.warnings.at(-1), /limit/);
  const many = input(Array.from({ length: 257 }, () => movement(A, B)));
  assert.equal(projectAccountEffects(many).status, 'unavailable');
});
