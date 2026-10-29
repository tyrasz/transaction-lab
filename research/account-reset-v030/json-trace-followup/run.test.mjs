import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRootTrace, comparePrefix } from './trace.mjs';
import { checkedRaw, checkInherited, ORIGINAL } from './run.mjs';
import { LIMITS, inspectOutputFiles, OutputBoundsError, validProcessOutput, validProcessTime, validTime } from '../run.mjs';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../capture');
const json = p => JSON.parse(fs.readFileSync(path.join(base, p)));
const request = { from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), data: '0x', value: '0', gas: '50000' };
const enter = { type: 'CALL', from: request.from, to: request.to, gas: '0x7148', value: '0x0' };
const op = { pc: 0, op: 0, gas: '0x7148', gasCost: '0x0', memSize: 0, stack: null, depth: 1, refund: 0, opName: 'STOP' };
const exit = { output: 'abcd', gasUsed: '0x3' };
const bytes = events => Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n');
test('balanced final root exit handles nested revert and root outcome without conflating receipt gas', () => {
  const nested = { ...enter, from: request.to, to: request.from, gas: '0x64' };
  const result = parseRootTrace(bytes([enter, op, nested, { ...op, depth: 2 }, { output: 'ff', gasUsed: '0x2', error: 'execution reverted' }, exit]), request);
  assert.deepEqual(result, { output: '0xabcd', gasUsed: '3', error: null, opcodeCount: 2, frameCount: 2, records: 6 });
  assert.equal(parseRootTrace(bytes([enter, { ...exit, error: 'execution reverted' }]), request).error, 'execution reverted');
  assert.equal(parseRootTrace(bytes([enter, { output: '', gasUsed: '0x7148', error: 'out of gas' }]), request).gasUsed, '29000');
});
test('missing/trailing/nested-only/partial/malformed end records cannot impersonate root completion', () => {
  const nested = { ...enter, gas: '0x64' };
  for (const events of [[enter, op], [enter, exit, op], [enter, nested, exit], [exit], [enter, { ...exit, output: '0xab' }], [enter, { ...exit, gasUsed: '0x7149' }], [enter, { ...exit, error: '' }], [enter, { mystery: true }], [enter, { ...op, depth: 2 }, exit], [enter, { ...op, stack: [] }, exit]]) assert.throws(() => parseRootTrace(bytes(events), request));
  assert.throws(() => parseRootTrace(bytes([enter, exit]).subarray(0, -1), request));
  assert.throws(() => parseRootTrace(Buffer.from([0xff, 10]), request));
  assert.throws(() => parseRootTrace(Buffer.alloc(4194305), request));
});
test('root entry binds sender, target, input, value and exact Shanghai message gas', () => {
  for (const patch of [{ from: request.to }, { to: request.from }, { input: '0x00' }, { value: '0x1' }, { gas: '0x7147' }, { type: 'CREATE' }]) assert.throws(() => parseRootTrace(bytes([{ ...enter, ...patch }, exit]), request));
  const r = { ...request, data: '0x0001' }, e = { ...enter, input: r.data, gas: '0x7134' };
  assert.equal(parseRootTrace(bytes([e, exit]), r).output, '0xabcd');
});
test('all five channels retain mismatches including raw message gas and root error', () => {
  const input = json('inputs/001.json'), expected = json('expectations/001.json').result, result = json('geth/001-01/result.json'), body = json('geth/001-01/body.rlp');
  const roots = [{ output: expected.steps[0].execution.returnData, error: null, gasUsed: expected.steps[0].execution.executionGasUsed }];
  assert.equal(comparePrefix(input, 1, expected, result, body, roots).status, 'matched');
  for (const mutate of [(r, t) => r.stateRoot = '0x' + '00'.repeat(32), (r, t) => r.logsHash = '0x' + '11'.repeat(32), (r, t) => r.gasUsed = '0x1', (r, t) => r.receipts[0].gasUsed = '0x1', (r, t) => r.receipts[0].status = '0x0', (r, t) => t[0].output = '0x12', (r, t) => t[0].error = 'execution reverted', (r, t) => t[0].gasUsed = '1']) {
    const r = structuredClone(result), t = structuredClone(roots); mutate(r, t); assert.equal(comparePrefix(input, 1, expected, r, body, t).status, 'mismatched');
  }
  assert.throws(() => comparePrefix(input, 1, expected, result, '0xc0', roots));
  const r = structuredClone(result); r.receipts[0].transactionHash = '0x' + '33'.repeat(32); assert.throws(() => comparePrefix(input, 1, expected, r, body, roots));
});
test('saved expectation decoding requires clean bounded process and exact raw payload identity', () => {
  const b = fs.readFileSync(path.join(base, 'expectations/001.json'));
  assert.equal(checkedRaw(b).id, 'delete_fund_inspect');
  for (const mutate of [r => r.process.status = 1, r => r.process.signal = 'SIGKILL', r => r.stdout.bytes++, r => r.stdout.sha256 = '0'.repeat(64), r => r.result.steps[0].gasUsed = '1', r => r.process.elapsedMs = 15001]) { const r = JSON.parse(b); mutate(r); assert.throws(() => checkedRaw(Buffer.from(JSON.stringify(r)))); }
});
test('portable inherited inputs/products/expectations bind first manifest and seals; modified expectation cannot pass', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-jsonl-inherited-'));
  try {
    const inherited = path.join(temp, 'inherited'), paths = ['manifest.json', 'plan.json', 'source-manifest.json'];
    json('plan.json').declarations.forEach((d, i) => { [d.files.declaration, d.files.alloc, d.files.env, ...d.files.prefixes].forEach(f => paths.push(f.path)); for (const phase of ['product', 'expectations']) paths.push(`${phase}/${String(i + 1).padStart(3, '0')}.json`, `${phase}/${String(i + 1).padStart(3, '0')}.json.seal.json`); });
    for (const p of paths) { const to = path.join(inherited, p); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(base, p), to); }
    assert.deepEqual(checkInherited(temp).map(r => r.input.requests.length), [3, 3, 5, 2, 2]);
    const p = path.join(inherited, 'expectations/001.json'); fs.appendFileSync(p, ' '); assert.throws(() => checkInherited(temp));
    assert.equal(ORIGINAL.manifest, 'df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('inherited stat-first caps and process clocks globally reject overflow/late completion', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-jsonl-cap-'));
  try {
    fs.writeFileSync(path.join(temp, 'raw.jsonl'), ''); fs.truncateSync(path.join(temp, 'raw.jsonl'), LIMITS.outputFileBytes + 1);
    assert.throws(() => inspectOutputFiles(temp, 0), e => e instanceof OutputBoundsError && e.files[0].bytes === LIMITS.outputFileBytes + 1);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  assert.equal(validProcessOutput({ process: { error: { code: 'ENOBUFS' } }, stdout: { bytes: 1 }, stderr: { bytes: 0 } }), false);
  assert.equal(validProcessTime({ timeoutMs: 15000, elapsedMs: 15000.1, wallElapsedMs: 14999 }), false);
  assert.equal(validTime(180001, 1), false);
});
