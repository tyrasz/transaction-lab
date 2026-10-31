import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { auditAttempt, committedNative, nonceOnly, witnessCode } from './audit.mjs';

const sender = '0x' + '11'.repeat(20), target = '0x' + '22'.repeat(20), other = '0x' + '33'.repeat(20);
const frame = (from, to, value, extra = {}) => ({ type: 'CALL', from, to, value, ...extra });
test('independent transfer walk drops failed ancestors and excludes delegate/CALLCODE transfers', () => {
  const trace = frame(sender, target, '0x5', { calls: [
    frame(target, other, '0x9', { error: 'execution reverted', calls: [frame(other, sender, '0x7')] }),
    frame(target, other, '0x5', { type: 'DELEGATECALL', calls: [frame(target, sender, '0x2')] }),
    frame(target, other, '0x8', { type: 'CALLCODE' }),
  ] });
  assert.deepEqual([...committedNative(trace)], [[sender, -3n], [target, 3n]]);
  assert.deepEqual([...committedNative({ ...trace, error: 'execution reverted' })], []);
  assert.deepEqual([...committedNative(frame(sender, sender, '0x5'))], [[sender, 0n]]);
});
test('witness diff enforces only sender nonce with unchanged balance', () => {
  const d = { pre: { [sender]: { balance: '0xa', nonce: 3 } }, post: { [sender]: { nonce: 4 } } };
  nonceOnly(d, sender, 3n, 10n);
  assert.throws(() => nonceOnly({ ...d, post: { [sender]: { nonce: 4, balance: '0x9' } } }, sender, 3n, 10n));
  assert.throws(() => nonceOnly({ ...d, pre: { ...d.pre, [target]: { balance: '0x1', code: '0x00' } }, post: { ...d.post, [target]: {} } }, sender, 3n, 10n));
});
test('witness bytecode directly names selected accounts and independent BALANCE word offsets', () => {
  const code = witnessCode({ number: '0x10' }, [sender, target]);
  assert(code.includes('73' + sender.slice(2) + '3161010052'));
  assert(code.includes('73' + target.slice(2) + '3161012052'));
  assert(code.endsWith('6101406000f3'));
});
const capture = new URL('../hype-native-current-v039/capture-001/', import.meta.url);
const read = async name => JSON.parse(await fs.readFile(new URL(name, capture), 'utf8'));
const plan = await read('plan.json'), selection = await read('selection.json');
const saved = await read('001-wallet-transfer-drpc.json');
const run = a => auditAttempt(a, plan.cases[0], plan.providers[0], selection.selected, saved.report.implementation.sourceSha256);
test('retained wallet parsed-response shape binds anchors, witness words, trace net and original delta', () => {
  const report = run(saved); assert.equal(report.classification, 'measured_amounts_bound'); assert.equal(report.measurements.length, 2);
});
test('mutated public amount, missing raw anchor and non-neutral witness each reject', () => {
  const amount = structuredClone(saved); amount.report.nativeBalanceChanges.assets[0].afterRaw = '1'; assert.throws(() => run(amount));
  const anchor = structuredClone(saved); anchor.records = anchor.records.filter(r => r.id !== 6); assert.throws(() => run(anchor));
  const mutation = structuredClone(saved), e = mutation.report.evidence.nativeBalanceMeasurement;
  const response = e.response.find(r => r.id === 12), actual = mutation.records.find(r => r.id === 15);
  response.result.post[mutation.input.from].balance = '0x1'; actual.result = structuredClone(response.result);
  assert.throws(() => run(mutation));
});
test('changed witness output with a consistent evidence/raw join still fails amount binding', () => {
  const mutation = structuredClone(saved), e = mutation.report.evidence.nativeBalanceMeasurement;
  const response = e.response.find(r => r.id === 11), actual = mutation.records.find(r => r.id === 14);
  response.result.output = response.result.output.slice(0, 2 + 8 * 64) + '0'.repeat(64) + response.result.output.slice(2 + 9 * 64);
  actual.result = structuredClone(response.result); assert.throws(() => run(mutation));
});
test('unavailable WHYPE diagnostics remain unavailable and publish no native amounts', async () => {
  const value = await read('003-whype-deposit-drpc.json');
  const out = auditAttempt(value, plan.cases[2], plan.providers[0], selection.selected, value.report.implementation.sourceSha256);
  assert.equal(out.classification, 'unavailable'); assert.deepEqual(out.measurements, []);
  assert(out.witnessDiffAccountShapes[0].accounts.some(a => a.account === '0x' + '55'.repeat(20) && a.afterFields.length === 0));
});
