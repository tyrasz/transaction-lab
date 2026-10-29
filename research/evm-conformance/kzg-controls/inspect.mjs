// Declaration inspection only: no EVM, product executor, Geth or RPC calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Common, Mainnet, Hardfork } from '../../../engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createTx, createTxFromRLP } from '../../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { bytesToHex, hexToBytes } from '../../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';

const base = path.dirname(fileURLToPath(import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const planBytes = fs.readFileSync(path.join(base, 'acquisition-plan.json'));
assert.equal(sha(planBytes), '4d2f16f9bd87d513cf5b05926376141cfa49456a412ba0d57fdafec5292ea403');
const plan = JSON.parse(planBytes), acquisition = JSON.parse(fs.readFileSync(path.join(base, 'acquisition-result.json')));
assert.equal(acquisition.status, 'complete');
assert.equal(acquisition.archiveSha256Before, plan.archive.sha256);
assert.equal(acquisition.archiveSha256After, plan.archive.sha256);
assert.equal(acquisition.planSha256, sha(planBytes));
const common = new Common({ chain: Mainnet, hardfork: Hardfork.Osaka });
const records = [], cache = new Map(), encountered = new Map();
const quantity = value => BigInt(value);
const count = (object, value) => { object[value] = (object[value] ?? 0) + 1; };
const opcodes = code => {
  const bytes = hexToBytes(code), out = new Set();
  for (let offset = 0; offset < bytes.length; offset++) {
    const op = bytes[offset]; out.add(op.toString(16).padStart(2, '0'));
    if (op >= 0x60 && op <= 0x7f) offset += op - 0x5f;
  }
  return [...out].sort();
};
for (const row of acquisition.files) {
  const bytes = fs.readFileSync(path.join(base, row.path));
  assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
  cache.set(row.path.slice('official-inputs/'.length), JSON.parse(bytes));
}
for (const selected of plan.selectedRows) {
  const fixture = cache.get(selected.json_path)?.[selected.id];
  assert.ok(fixture); assert.equal(fixture._info.hash, selected.fixture_hash);
  assert.equal(fixture._info['fixture-format'], 'state_test');
  assert.deepEqual(Object.keys(fixture.post), ['Osaka']);
  assert.equal(fixture.post.Osaka.length, 1);
  const keys = encountered.get(selected.json_path) ?? new Set();
  assert.ok(!keys.has(selected.id)); keys.add(selected.id); encountered.set(selected.json_path, keys);
  const post = fixture.post.Osaka[0], tx = fixture.transaction, env = fixture.env, ix = post.indexes;
  assert.equal(post.expectException, undefined);
  const acl = tx.accessLists?.[ix.data];
  const type = acl == null ? 0 : 1;
  assert.deepEqual(Object.keys(tx).sort(), ['chainId','data','gasLimit','gasPrice','nonce','secretKey','sender','to','value', ...(tx.accessLists ? ['accessLists'] : [])].sort());
  const data = tx.data[ix.data], gas = quantity(tx.gasLimit[ix.gas]), value = quantity(tx.value[ix.value]);
  const fields = { type, nonce: quantity(tx.nonce), gasPrice: quantity(tx.gasPrice), gasLimit: gas,
    to: tx.to || undefined, data, value, ...(type ? { chainId: 1n, accessList: acl } : {}) };
  assert.equal(quantity(tx.chainId), 1n);
  const rebuilt = createTx(fields, { common }).sign(hexToBytes(tx.secretKey));
  assert.equal(bytesToHex(rebuilt.serialize()), post.txbytes.toLowerCase());
  const signed = createTxFromRLP(hexToBytes(post.txbytes), { common });
  assert.equal(signed.type, type); assert.ok(signed.verifySignature());
  assert.equal(signed.getSenderAddress().toString(), tx.sender.toLowerCase());
  assert.equal(quantity(fixture.pre[tx.sender].nonce), signed.nonce);
  assert.equal(quantity(env.currentTimestamp), 1000n); assert.equal(quantity(env.currentNumber), 1n);
  assert.deepEqual(Object.keys(post).sort(), ['hash','indexes','logs','receipt','state','txbytes']);
  assert.match(post.hash, /^0x[0-9a-f]{64}$/); assert.match(post.logs, /^0x[0-9a-f]{64}$/);
  const codeRows = Object.entries(fixture.pre).filter(([,a]) => a.code !== '0x').map(([address,a]) => ({ address, bytes: (a.code.length - 2) / 2, opcodes: opcodes(a.code) }));
  const allOps = [...new Set(codeRows.flatMap(r => r.opcodes))].sort();
  const reasons = ['fixture_osaka_does_not_match_mainnet_fork_at_timestamp_1000_block_1'];
  if (gas > 5000000n) reasons.push('declared_gas_exceeds_product_5000000');
  records.push({ index: records.length + 1, id: selected.id, sourcePath: selected.json_path,
    fixtureHash: selected.fixture_hash, postIndex: 0, family: path.basename(selected.json_path, '.json'),
    status: 'unsupported_by_current_public_profile', reasons,
    envelope: { signedType: type, sender: tx.sender, nonce: signed.nonce.toString(), to: tx.to,
      value: value.toString(), gas: gas.toString(), gasPrice: signed.gasPrice.toString(),
      calldataBytes: (data.length - 2) / 2, accessListEntries: acl?.length ?? 0,
      transactionSha256: sha(hexToBytes(post.txbytes)), signedFieldsAndSenderVerified: true },
    environment: env, fork: 'Osaka', preAccounts: Object.keys(fixture.pre).length,
    preStorageSlots: Object.values(fixture.pre).reduce((n,a) => n + Object.keys(a.storage).length, 0),
    codeRows, staticOpcodes: allOps,
    staticContextConcerns: ['40','49','4a','f0','f5','ff'].filter(op => allOps.includes(op)),
    expected: { fullStatePresent: true, stateRoot: post.hash, logsHash: post.logs,
      receiptPresent: true, receiptStatus: post.receipt.status, cumulativeGasUsed: post.receipt.cumulativeGasUsed,
      expectedAdmissionException: null },
  });
}
for (const [file, fixture] of cache) assert.deepEqual(Object.keys(fixture).sort(), [...encountered.get(file)].sort());
assert.equal(records.length, 180);
const summary = { selected: records.length, currentPublicProfileEligible: 0, unsupported: records.length,
  forkMismatch: records.length, gasOver5000000: 0, families: {}, signedTypes: {}, gasLimits: {},
  expectedReceiptStatuses: {}, staticContextOpcodes: {}, maximumPreAccounts: 0, maximumPreSlots: 0,
  maximumCalldataBytes: 0, targetExecutions: 0, publicRpcRequests: 0 };
for (const row of records) {
  count(summary.families, row.family); count(summary.signedTypes, row.envelope.signedType);
  count(summary.gasLimits, row.envelope.gas); count(summary.expectedReceiptStatuses, row.expected.receiptStatus);
  for (const op of row.staticContextConcerns) count(summary.staticContextOpcodes, op);
  if (row.reasons.includes('declared_gas_exceeds_product_5000000')) summary.gasOver5000000++;
  summary.maximumPreAccounts = Math.max(summary.maximumPreAccounts, row.preAccounts);
  summary.maximumPreSlots = Math.max(summary.maximumPreSlots, row.preStorageSlots);
  summary.maximumCalldataBytes = Math.max(summary.maximumCalldataBytes, row.envelope.calldataBytes);
}
const report = { schema: 1, scope: 'Source, signature and structural inspection only; expected fields are publisher declarations, not observations.',
  sourceCommit: plan.sourceCommit, productBaseline: 'ae2438742f9b5429f83e266196cb037f4e131795',
  acquisitionPlanSha256: sha(planBytes), acquisitionResultSha256: sha(fs.readFileSync(path.join(base, 'acquisition-result.json'))),
  inspectorSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), summary, records,
  limitations: ['Static opcode scan excludes PUSH data but is not execution or proof that dynamically supplied code cannot run.',
    'No fork override, gas reduction, environment replacement or expected-state-as-input is permitted.',
    'State tests specify an isolated transaction transition, not block-start system calls or chain/header authenticity.',
    'Signed transaction validation here is metadata verification, not product signature admission.',
    'All 180 fixture identities remain in the denominator; no current-product accuracy result exists for this corpus.'] };
fs.writeFileSync(path.join(base, 'structural-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary, null, 2));
