import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { savedChannels, diagnose } from './diagnose.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), capture = path.join(here, 'capture');
const read = p => JSON.parse(fs.readFileSync(path.join(capture, p)));
test('saved artifacts retain original denominator and missing-return status', () => {
  const d = diagnose(capture);
  assert.deepEqual(d.originalCounts, { matched: 5, mismatched: 0, unavailable: 10, not_attempted: 0 });
  assert.deepEqual(d.totals, { prefixes: 15, transactionReceipts: 33, fourChannelAgreements: 15, emptyTraceFiles: 18, originalWholePrefixReturnAvailable: 5 });
});
test('each diagnostic channel independently preserves mismatches', () => {
  const input = read('inputs/001.json'), expected = read('expectations/001.json').result, body = read('geth/001-02/body.rlp');
  for (const [channel, mutate] of [
    ['stateRoot', r => r.stateRoot = '0x' + '11'.repeat(32)],
    ['logsHash', r => r.logsHash = '0x' + '22'.repeat(32)],
    ['gas', r => r.receipts[1].gasUsed = '0x1'],
    ['gas', r => r.receipts[1].cumulativeGasUsed = '0x1'],
    ['gas', r => r.gasUsed = '0x1'],
    ['receiptStatus', r => r.receipts[1].status = '0x0'],
  ]) {
    const result = read('geth/001-02/result.json'); mutate(result);
    assert.equal(savedChannels(input, 2, expected, result, body)[channel], false);
  }
});
test('diagnostic refuses unbound bodies, omitted/reordered receipts and rejected transactions', () => {
  const input = read('inputs/001.json'), expected = read('expectations/001.json').result, body = read('geth/001-02/body.rlp');
  assert.throws(() => savedChannels(input, 2, expected, read('geth/001-02/result.json'), '0x'));
  for (const mutate of [r => r.receipts.pop(), r => r.receipts.reverse(), r => r.receipts[1].transactionIndex = '0x0', r => r.rejected = [{ index: 1, error: 'bad' }]]) {
    const result = read('geth/001-02/result.json'); mutate(result);
    assert.throws(() => savedChannels(input, 2, expected, result, body));
  }
});
