import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { auditAttempt, committedNative, nativeNonceOnly, nonceOnly, verifySelectionBinding, witnessCode } from './audit.mjs';

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
  assert.deepEqual([...committedNative({ ...trace, revertReason: 'synthetic failure' })], []);
  assert.deepEqual([...committedNative(frame(sender, target, '0x5', { calls: [frame(target, other, '0x9', { revertReason: 'failed ancestor', calls: [frame(other, sender, '0x7')] })] }))], [[sender, -5n], [target, 5n]]);
  assert.deepEqual([...committedNative(frame(sender, sender, '0x5'))], [[sender, 0n]]);
  assert.throws(() => committedNative(frame(sender, target, '0x5', { calls: [{ type: 'SELFDESTRUCT', from: target, to: sender, value: '0x1' }] })));
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
test('self-transfer permits identical repeated pinned code reads for sender and recipient', async () => {
  const value = await read('002-self-transfer-drpc.json');
  const out = auditAttempt(value, plan.cases[1], plan.providers[0], selection.selected, value.report.implementation.sourceSha256);
  assert.equal(out.classification, 'measured_amounts_bound'); assert.equal(out.measurements[0].deltaRaw, '0');
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

test('native-only selected touches require independent balance/code and leave strict helper unchanged', () => {
  const raw = { pre: { [sender]: { balance: '0xa', nonce: 3 }, [target]: { balance: '0x14', nonce: 0, code: '0x6000' } }, post: { [sender]: { nonce: 4 }, [target]: {} } };
  const copy = structuredClone(raw), expected = new Map([[target, { balance: 20n, code: '0x6000', nonce: 0n }]]);
  nativeNonceOnly(raw, sender, 3n, 10n, expected); assert.deepEqual(raw, copy);
  assert.throws(() => nonceOnly(raw, sender, 3n, 10n));
  const after = structuredClone(raw); after.pre[target].balance = '0x19';
  nativeNonceOnly(after, sender, 3n, 10n, new Map([[target, { balance: 25n, code: '0x6000', nonce: 0n }]]));
  assert.throws(() => nativeNonceOnly(after, sender, 3n, 10n, expected));
});

test('native touches reject storage, changed fields, unknown/probe/not-selected accounts and bad code/nonce', () => {
  const raw = { pre: { [sender]: { balance: '0xa', nonce: 3 }, [target]: { balance: '0x14', code: '0x6000', nonce: 0 } }, post: { [sender]: { nonce: 4 }, [target]: {} } };
  const expected = new Map([[target, { balance: 20n, code: '0x6000', nonce: 0n }]]);
  const changes = [
    d => { d.pre[target].storage = {}; }, d => { d.post[target].storage = {}; },
    d => { d.pre[target].balance = '0x15'; }, d => { delete d.pre[target].balance; },
    d => { d.pre[target].code = '0x6001'; }, d => { d.pre[target].nonce = 1; },
    d => { d.post[target].balance = '0x14'; }, d => { d.post[target].nonce = 0; },
    d => { d.post[target].code = '0x6000'; }, d => { delete d.post[target]; },
    d => { delete d.pre[target]; }, d => { d.pre[target].selfdestruct = true; },
    d => { d.pre[other] = { balance: '0x0' }; d.post[other] = {}; },
    d => { const p = '0x000000000000000000000000000000000000ba1a'; d.pre[p] = { balance: '0x0' }; d.post[p] = {}; },
  ];
  for (const change of changes) { const d = structuredClone(raw); change(d); assert.throws(() => nativeNonceOnly(d, sender, 3n, 10n, expected)); }
  assert.throws(() => nativeNonceOnly(raw, sender, 3n, 10n, new Map()));
  assert.throws(() => nativeNonceOnly(raw, sender, 3n, 10n, new Map([[target, { balance: 20n }]])));
});

test('same-block reference selection binds exact saved reference bytes and the two actual selection calls', () => {
  const bytes = Buffer.from(JSON.stringify(selection)), pin = createHash('sha256').update(bytes).digest('hex');
  const p = { selectionReference: { number: selection.selected.number, hash: selection.selected.hash, selectionSha256: pin, priorManifestSha256: 'a'.repeat(64), priorTerminalSha256: 'b'.repeat(64) } };
  const next = { ...structuredClone(selection), records: [structuredClone(selection.records[0]), structuredClone(selection.records[2])] };
  assert.deepEqual(verifySelectionBinding(p, next, bytes), selection.selected);
  const changed = structuredClone(p); changed.selectionReference.number = '0x1'; assert.throws(() => verifySelectionBinding(changed, next, bytes));
  const changedHash = structuredClone(p); changedHash.selectionReference.hash = '0x' + '00'.repeat(32); assert.throws(() => verifySelectionBinding(changedHash, next, bytes));
  assert.throws(() => verifySelectionBinding(p, next, Buffer.from('{}')));
  assert.throws(() => verifySelectionBinding(p, selection, bytes));
  const failed = structuredClone(next); failed.records[1].error = { code: 'failed' }; assert.throws(() => verifySelectionBinding(p, failed, bytes));
  const sizeOnly = structuredClone(next); sizeOnly.selected.size = '0x1'; sizeOnly.records[1].result.size = '0x1';
  assert.deepEqual(verifySelectionBinding(p, sizeOnly, bytes), sizeOnly.selected);
  const executionField = structuredClone(sizeOnly); executionField.selected.gasLimit = '0x1'; executionField.records[1].result.gasLimit = '0x1';
  assert.throws(() => verifySelectionBinding(p, executionField, bytes));
});

test('BALANCE witness revertReason cannot become a measured result even if raw and public evidence agree', () => {
  const mutation = structuredClone(saved), e = mutation.report.evidence.nativeBalanceMeasurement;
  const response = e.response.find(r => r.id === 11), actual = mutation.records.find(r => r.id === 14);
  response.result.revertReason = 'synthetic failure'; actual.result = structuredClone(response.result); assert.throws(() => run(mutation));
});
