import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { simulateArbitrum } from '../src/arbitrum-simulation.js';

const root = new URL('../research/arbitrum-contract-deposit-v1/capture/', import.meta.url);
const bytes = name => readFileSync(new URL(name, root));
const read = name => JSON.parse(bytes(name));
const sha = value => createHash('sha256').update(value).digest('hex');

test('actual funded contract CCTP recording measures a 100 USDC debit and retains incomplete coverage', async () => {
  assert.equal(sha(bytes('manifest.json')), '51076d500e9176482cd530780d8077e7de57d1e689f3907122bd9e4061b086ab');
  for (const file of read('manifest.json').files) { assert.equal(bytes(file.path).length, file.bytes); assert.equal(sha(bytes(file.path)), file.sha256); }
  const input = read('input.json'); let count = 0;
  const result = await simulateArbitrum(input, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://arb1.arbitrum.io/rpc'); const prefix = 'wire/' + String(++count).padStart(3, '0');
    const request = JSON.parse(options.body), recorded = read(prefix + '-request.body'); assert.deepEqual(request, recorded);
    return new Response(bytes(prefix + '-response.body'), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(count, 10); assert.equal(result.status, 'partial'); assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.gasUsed, '116393'); assert.equal(result.execution.logs.length, 5);
  assert.deepEqual(result.source.header, read('qualification-header.json')); assert.equal(result.source.headerConfirmed, true); assert.equal(result.source.twoPassConsistent, true);
  const usdc = result.assetChanges.find(row => row.token.address === '0xaf88d065e77c8cc2239327c5edb3a432268e5831');
  assert.equal(usdc.status, 'measured'); assert.equal(usdc.beforeRaw, '13162457912'); assert.equal(usdc.afterRaw, '13062457912'); assert.equal(usdc.deltaRaw, '-100000000');
  const messenger = result.assetChanges.find(row => row.token.address === input.to);
  assert.equal(messenger.status, 'unverified'); assert.equal(messenger.beforeRaw, null); assert.equal(messenger.afterRaw, null); assert.equal(messenger.deltaRaw, null);
  assert.equal(result.coverage.inventoryComplete, false); assert.equal(result.coverage.destinationCreditVerified, false); assert.equal(result.coverage.feesVerified, false);
  assert.equal(result.protocol.intent.destination.hypercoreRecipient, input.from); assert.equal(result.protocol.intent.destinationCreditAmount, null);
  assert.equal(result.security.status, 'not_assessed');
});
