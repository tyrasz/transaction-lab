import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { decodeCctpHypercoreIntent as decode, DEPLOYMENT_METADATA as metadata } from './interpret.mjs';
const read = p => fs.readFileSync(new URL(p, import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const raw = read('./retained/scenario.json'), scenario = JSON.parse(raw);
const other = '0x1111111111111111111111111111111111111111';
const word = n => BigInt(n).toString(16).padStart(64, '0');
const alterWord = (n, value) => ({ ...scenario, data: scenario.data.slice(0, 10 + n * 64) + value + scenario.data.slice(10 + (n + 1) * 64) });
const alterHook = (offset, hex) => {
  const start = 10 + 9 * 64 + offset * 2;
  return { ...scenario, data: scenario.data.slice(0, start) + hex + scenario.data.slice(start + hex.length) };
};
const status = (input, expected, reason) => {
  const value = decode(input); assert.equal(value.status, expected); assert.equal(value.reason, reason);
  assert.equal(value.intent, null); return value;
};

test('actual scenario and declared deployment/source/ABI bindings are unchanged', () => {
  assert.equal(sha(raw), '5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa');
  assert.equal(sha(read('./deployment-metadata.json')), '5fcf1f1e92ad0c08a73c8f6f78f9f8047cc9b6dbf7ece38ed445745db948b630');
  for (const row of JSON.parse(read('./source-provenance.json')).files) {
    const bytes = read('./' + row.path); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    if (row.gitBlobSha1) assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), row.gitBlobSha1);
  }
  const abi = JSON.parse(read('./abi-selection.json'));
  const method = abi.contracts[0].entries.find(x => x.name === 'depositForBurnWithHook');
  const signature = method.name + '(' + method.inputs.map(x => x.type).join(',') + ')';
  assert.equal(signature, metadata.signature);
  assert.equal('0x' + Buffer.from(keccak_256(Buffer.from(signature))).toString('hex').slice(0, 8), metadata.selector);
  assert.equal(method.stateMutability, 'nonpayable');
  assert.ok(Object.isFrozen(metadata) && Object.isFrozen(metadata.sources));
});

test('100 USDC is an intent with exact perps recipient, never an observed effect', () => {
  const r = decode(scenario); assert.equal(r.status, 'recognized_intent');
  const i = r.intent;
  assert.deepEqual(i.requestedBurn, { token: metadata.token, symbol: 'USDC', decimals: 6, amountRaw: '100000000', amountFormatted: '100' });
  assert.equal(i.destination.hypercoreRecipient, scenario.from); assert.equal(i.destination.recipientIsSender, true);
  assert.equal(i.destination.destinationDex, '0'); assert.equal(i.destination.requestedBalance, 'perps');
  assert.equal(i.destination.mintRecipient, metadata.forwarder); assert.equal(i.destination.destinationCaller, metadata.forwarder);
  assert.deepEqual(i.maxFee, { raw: '200000', formatted: '0.2', kind: 'cap_not_quote' });
  assert.equal(i.minFinalityThreshold, 1000); assert.equal(i.hook.totalBytes, 56);
  for (const field of ['sourceExecution','measuredOutgoingAmount','destinationSettlement','destinationCreditAmount']) assert.equal(i[field], null);
  assert.equal(i.basis.contractIdentityVerified, false); assert.equal(i.basis.sourceExecutionObserved, false);
  assert.equal(i.basis.balancesRead, false); assert.equal(i.basis.allowanceRead, false);
  assert.equal(i.basis.destinationRecipientValidationVerified, false);
  assert.ok(Object.isFrozen(i.destination));
});

test('wrong chain, target and selector do not receive a generic deposit label', () => {
  status({ ...scenario, chainId: '1' }, 'unrecognized', 'chain_or_target');
  status({ ...scenario, to: other }, 'unrecognized', 'chain_or_target');
  status({ ...scenario, data: '0x12345678' + scenario.data.slice(10) }, 'unrecognized', 'selector');
  status({ ...scenario, data: '0x' }, 'unrecognized', 'selector');
});

test('token, domain and both forwarder identities are independently bound', () => {
  for (const index of [2, 3, 4]) status(alterWord(index, other.slice(2).padStart(64, '0')), 'unsupported', 'undeclared_route');
  status(alterWord(1, word(0)), 'unsupported', 'undeclared_route');
  status(alterWord(4, word(0)), 'unsupported', 'undeclared_route');
  status(alterWord(2, '1' + scenario.data.slice(10 + 2 * 64 + 1, 10 + 3 * 64)), 'unsupported', 'non_evm_recipient_encoding');
});

test('uint32 and address ABI high bits are rejected rather than truncated', () => {
  for (const index of [1, 6]) status(alterWord(index, word(1n << 32n)), 'malformed', 'abi_word_width');
  status(alterWord(3, word(1n << 160n)), 'malformed', 'abi_word_width');
});

test('dynamic offsets, lengths, gaps, padding and appended calldata must be canonical', () => {
  for (const n of [0, 32, 255, 257, 288, (1n << 256n) - 1n]) status(alterWord(7, word(n)), 'malformed', 'abi_offset_or_length');
  for (const n of [0, 24, 52, 55, 57, 64, (1n << 256n) - 1n]) status(alterWord(8, word(n)), 'malformed', 'abi_offset_or_length');
  status({ ...scenario, data: scenario.data + '00' }, 'malformed', 'calldata_length');
  status({ ...scenario, data: scenario.data.slice(0, -2) }, 'malformed', 'calldata_length');
  status(alterHook(56, '01'), 'malformed', 'abi_tail_padding');
  const shifted = alterWord(7, word(288)); shifted.data = shifted.data.slice(0, 10 + 8 * 64) + '00'.repeat(32) + shifted.data.slice(10 + 8 * 64);
  status(shifted, 'malformed', 'calldata_length');
});

test('hook magic, zero padding, version and exact payload length bind interpretation', () => {
  for (const [offset, value] of [[0,'00'],[23,'01'],[27,'01'],[31,'17'],[31,'19']]) status(alterHook(offset, value), 'unsupported', 'forwarding_hook_format');
});

test('changed recipient remains explicit and cannot silently retain sender identity', () => {
  const r = decode(alterHook(32, other.slice(2)));
  assert.equal(r.status, 'recognized_intent'); assert.equal(r.intent.destination.hypercoreRecipient, other);
  assert.equal(r.intent.destination.recipientIsSender, false); assert.equal(r.intent.sender, scenario.from);
  const changedSender = decode({ ...scenario, from: other });
  assert.equal(changedSender.intent.destination.hypercoreRecipient, scenario.from);
  assert.equal(changedSender.intent.destination.recipientIsSender, false);
  for (const recipient of ['0x' + '0'.repeat(40), metadata.coreDepositWallet]) status(alterHook(32, recipient.slice(2)), 'unsupported', 'invalid_hypercore_recipient');
  const managedTokenRecipient = decode(alterHook(32, metadata.destinationToken.slice(2)));
  assert.equal(managedTokenRecipient.status, 'recognized_intent');
  assert.equal(managedTokenRecipient.intent.destination.hypercoreRecipient, metadata.destinationToken);
  assert.equal(managedTokenRecipient.intent.basis.destinationRecipientValidationVerified, false);
  assert(managedTokenRecipient.intent.limitations.some(x => x.includes('tokenSystemAddress')));
  assert.equal(managedTokenRecipient.intent.destinationSettlement, null);
});

test('only declared perps and spot dex identities are labeled', () => {
  const spot = decode(alterHook(52, 'ffffffff'));
  assert.equal(spot.status, 'recognized_intent'); assert.equal(spot.intent.destination.requestedBalance, 'spot');
  assert.equal(spot.intent.destination.destinationDex, '4294967295');
  for (const dex of ['00000001','7fffffff','fffffffe']) status(alterHook(52, dex), 'unsupported', 'unknown_destination_dex');
});

test('amount/fee changes remain raw exact intents without presumed net destination amount', () => {
  for (const amount of [200001n, 123456789n, (1n << 256n) - 1n]) {
    const r = decode(alterWord(0, word(amount))); assert.equal(r.status, 'recognized_intent');
    assert.equal(r.intent.requestedBurn.amountRaw, amount.toString()); assert.equal(r.intent.destinationCreditAmount, null);
  }
  assert.equal(decode(alterWord(0, word(123456789))).intent.requestedBurn.amountFormatted, '123.456789');
  status(alterWord(0, word(0)), 'unsupported', 'amount_or_fee_cap');
  status(alterWord(0, word(200000)), 'unsupported', 'amount_or_fee_cap');
  status(alterWord(5, word(100000000)), 'unsupported', 'amount_or_fee_cap');
  assert.equal(decode(alterWord(5, word(0))).intent.maxFee.formatted, '0');
  status({ ...scenario, value: '1' }, 'unsupported', 'nonzero_native_value');
});

test('finality is requested only and unknown thresholds are unsupported', () => {
  assert.equal(decode(alterWord(6, word(2000))).intent.minFinalityThreshold, 2000);
  for (const n of [0, 999, 1001, 1999, 2001, 0xffffffff]) status(alterWord(6, word(n)), 'unsupported', 'finality_threshold');
});

test('plain exact field schema rejects getters, unknown fields and coercions', () => {
  for (const input of [null, [], new Date(), 'scenario']) status(input, 'malformed', 'input_object');
  status({ ...scenario, balance: '100000000' }, 'malformed', 'input_fields');
  const missing = { ...scenario }; delete missing.from; status(missing, 'malformed', 'input_fields');
  const accessor = { ...scenario }; Object.defineProperty(accessor, 'data', { enumerable: true, get() { throw Error('must not run'); } });
  status(accessor, 'malformed', 'input_fields');
  for (const change of [{ chainId: 42161 }, { chainId: '042161' }, { value: '0x0' }, { from: '0x123' }, { data: '0x0' }, { data: '0xzz' }]) status({ ...scenario, ...change }, 'malformed', 'input_encoding');
  status({ ...scenario, from: '0x' + '0'.repeat(40) }, 'malformed', 'zero_sender');
});

test('no input mutation; mixed-case hexadecimal bytes decode to the same intent', () => {
  const frozen = Object.freeze({ ...scenario }); const before = JSON.stringify(frozen);
  const expected = decode(frozen);
  assert.equal(JSON.stringify(frozen), before);
  const upper = { ...scenario, from: '0x' + scenario.from.slice(2).toUpperCase(), to: '0x' + scenario.to.slice(2).toUpperCase(), data: '0x' + scenario.data.slice(2).toUpperCase() };
  assert.deepEqual(decode(upper), expected);
});
