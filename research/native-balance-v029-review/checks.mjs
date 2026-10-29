import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const IDS = ['fee_transfer_unused_accounts', 'sender_is_coinbase', 'completed_revert', 'blob_completed_revert', 'shanghai_miner_deletion', 'created_account_deletion'];
export const UNIT = { kind: 'native_wei', scale: '1000000000000000000' };
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function relative(p) {
  assert.equal(typeof p, 'string'); assert(p.length > 0 && !p.startsWith('/') && !p.includes('\\'));
  assert(p.split('/').every(part => part !== '' && part !== '.' && part !== '..')); return p;
}
export function parsePhase(phase) {
  for (const name of ['stdout', 'stderr']) {
    const stream = phase[name], bytes = Buffer.from(stream.base64, 'base64');
    assert.equal(bytes.toString('base64'), stream.base64);
    assert.equal(bytes.length, stream.bytes); assert.equal(sha(bytes), stream.sha256);
  }
  if (phase.process.status !== 0 || phase.process.signal !== null || phase.process.error !== null) {
    assert.equal(phase.result, null); return null;
  }
  if (phase.parseError !== null) { assert.equal(phase.result, null); return null; }
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(phase.stdout.base64, 'base64')));
  assert.deepEqual(phase.result, decoded); return decoded;
}
export function nativeRow(row, query, before, after, changes) {
  assert.deepEqual(row.descriptor, query); assert.equal(row.query, null); assert.equal(row.returnBytes, 0);
  assert.deepEqual(row.identity, { ...query, chainId: '1' });
  assert.deepEqual(row.fields, [{ name: 'balance', bits: 256, unit: UNIT }]);
  assert.equal(row.status, 'measured'); assert.equal(row.reason, null);
  assert.deepEqual(row.values, [{ name: 'balance', beforeRaw: String(before), afterRaw: String(after), deltaRaw: String(after - before), unit: UNIT }]);
  for (const [name, expected] of [['before', before], ['after', after]]) {
    const side = row[name]; assert.equal(side.status, 'measured'); assert.equal(side.reason, null);
    assert.equal(side.output, null); assert.equal(side.readMethod, 'proof_state_account_balance');
    assert.deepEqual(side.values, [{ name: 'balance', raw: String(expected), unit: UNIT }]);
    assert.deepEqual(side.stateReads, { total: 1, distinct: 1, reads: [{ kind: 'account', address: query.account }] });
    assert.deepEqual(side.changesBefore, side.changesAfter);
    if (name === 'before') assert.deepEqual(side.changesBefore.accounts, []);
    else assert.deepEqual(side.changesBefore, changes);
    // Phase IDs are diagnostic contiguous in-range subsets. The verifier joins
    // all actual input records separately; it does not infer exact phase timing.
    assert(Array.isArray(side.inputEvidenceIds));
  }
}
function fakeExponential(numerator, denominator) {
  let sum = 0n, term = denominator;
  for (let i = 1n; i <= 1024n; i++) {
    sum += term; term = term * numerator / (denominator * i);
    if (term === 0n) return sum / denominator;
  }
  throw Error('Bounded blob price series did not terminate');
}
export function feeAccounting(input, output) {
  const request = input.request, header = input.header;
  // This fixed corpus contains no access list, authorizations or root CREATE.
  assert.equal(request.data, '0x'); assert(request.to !== null);
  assert.equal(request.accessList, undefined); assert.equal(request.authorizationList, undefined);
  const gas = BigInt(request.gas), base = BigInt(header.baseFeePerGas), cap = BigInt(request.fees.maxFeePerGas);
  const priorityCap = BigInt(request.fees.maxPriorityFeePerGas), tip = priorityCap < cap - base ? priorityCap : cap - base;
  assert(base >= 0n && tip >= 0n); const price = base + tip;
  const preRefund = 21000n + BigInt(output.execution.executionGasUsed), counter = BigInt(output.execution.gasRefundCounter);
  const refund = counter < preRefund / 5n ? counter : preRefund / 5n;
  const used = preRefund - refund < 21000n ? 21000n : preRefund - refund;
  assert(used <= gas); assert.deepEqual(output.gasAccounting, { beforeRefund: String(preRefund), appliedRefund: String(refund), floorAdjustment: String(used - (preRefund - refund)), gasUsed: String(used) });
  const blob = request.executionProfile === 'unsigned_eip4844_block_end';
  assert.equal(request.executionProfile, blob ? 'unsigned_eip4844_block_end' : 'unsigned_eip1559_block_end');
  let extra = {}, maximum = gas * cap + BigInt(request.value), blobBurn = 0n;
  if (blob) {
    assert.equal(input.id, IDS[3]);
    const count = BigInt(request.blobVersionedHashes.length), blobGas = count * 131072n;
    const blobPrice = fakeExponential(BigInt(header.excessBlobGas), 5007716n), maxBlob = BigInt(request.fees.maxFeePerBlobGas);
    blobBurn = blobGas * blobPrice; maximum += blobGas * maxBlob;
    extra = { blobCount: count, blobGasUsed: blobGas, maxFeePerBlobGas: maxBlob, blobBaseFeePerGas: blobPrice,
      blobFeeBurn: blobBurn, totalUpfrontDebit: gas * price + blobBurn, totalFeeCharge: used * price + blobBurn, totalFeeBurn: used * base + blobBurn };
  }
  const expected = { kind: blob ? 'eip4844' : 'eip1559', ...Object.fromEntries(Object.entries({ gasLimit: gas,
    effectiveGasPrice: price, baseFeePerGas: base, priorityFeePerGas: tip, maximumRequiredBalance: maximum,
    upfrontGasDebit: gas * price, chargedGas: used, gasCharge: used * price, senderRefund: (gas - used) * price,
    baseFeeBurn: used * base, coinbaseTip: used * tip, ...extra }).map(([k, v]) => [k, String(v)])), coinbase: header.miner };
  assert.deepEqual(output.feeAccounting, expected);
  return expected;
}
export async function applyChanges(state, changes, lib) {
  assert.equal(new Set(changes.accounts.map(row => row.address)).size, changes.accounts.length);
  for (const row of changes.accounts) {
    const address = lib.createAddressFromString(row.address), initial = await state.getAccount(address);
    if (row.existence) assert.equal(initial !== undefined, row.existence.before);
    for (const name of ['balance', 'nonce']) if (row[name]) assert.equal(initial?.[name] ?? 0n, BigInt(row[name].before));
    if (row.code) assert.equal(lib.bytesToHex(await state.getCode(address)), row.code.before);
    for (const slot of row.storage ?? []) {
      const bytes = await state.getStorage(address, lib.hexToBytes(slot.slot));
      assert.equal(bytes.length ? BigInt(lib.bytesToHex(bytes)) : 0n, BigInt(slot.before));
    }
    if (row.existence?.after === false) { await state.deleteAccount(address); continue; }
    if (!initial) await state.putAccount(address, lib.createAccount({ nonce: 0n, balance: 0n }));
    for (const name of ['balance', 'nonce']) if (row[name]) await state.modifyAccountFields(address, { [name]: BigInt(row[name].after) });
    if (row.code) await state.putCode(address, lib.hexToBytes(row.code.after));
    for (const slot of row.storage ?? []) await state.putStorage(address, lib.hexToBytes(slot.slot), lib.bigIntToBytes(BigInt(slot.after)));
  }
  return lib.bytesToHex(await state.getStateRoot());
}
