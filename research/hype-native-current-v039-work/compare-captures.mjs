import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const root = new URL('../hype-native-current-v039/', import.meta.url);
const sha = b => createHash('sha256').update(b).digest('hex');
const pins = [
  ['044f99cb954c798550c34b602c92aac62c4c61b60bda15e90ca3bb63f7ffb2de', '923e96af3cfb6de2562ad4bbdcf88dc2b3692254722c8d76aa6d0c389bf34ad4'],
  ['9c2c776f6e17e557119f13f3fc95fa2112f396f0a9929403cadf44804e34bbcb', '2807490426c72ad5384673b03b68e5f0ad747b49740fc843aad2dfb44b3dc45c'],
];
const packets = [];
for (const [i, [manifestPin, terminalPin]] of pins.entries()) {
  const directory = new URL(`capture-00${i + 1}/`, root), read = name => fs.readFile(new URL(name, directory));
  const mb = await read('manifest.json'), tb = await read('terminal.json'); assert.equal(sha(mb), manifestPin); assert.equal(sha(tb), terminalPin);
  const manifest = JSON.parse(mb), terminal = JSON.parse(tb);
  for (const file of manifest.files) { const b = await read(file.path); assert.equal(sha(b), file.sha256); assert.equal(b.length, file.bytes); }
  const selectionBytes = await read('selection.json'); assert.equal(sha(selectionBytes), terminal.selectionSha256);
  const attempts = []; for (const row of terminal.outcomes) { const b = await read(row.file); assert.equal(sha(b), row.sha256); attempts.push(JSON.parse(b)); }
  packets.push({ manifest, terminal, attempts, plan: JSON.parse(await read('plan.json')), selected: JSON.parse(selectionBytes).selected });
}
const [before, after] = packets;
assert.deepEqual(before.plan.cases, after.plan.cases); assert.deepEqual(before.plan.providers, after.plan.providers);
for (const field of ['hash', 'number', 'timestamp', 'parentHash', 'mixHash', 'miner', 'gasLimit', 'baseFeePerGas']) assert.equal(before.selected[field], after.selected[field]);
const changedRuntimeFiles = before.manifest.files.filter(x => x.path.startsWith('runtime/') &&
  x.sha256 !== after.manifest.files.find(y => y.path === x.path)?.sha256).map(x => x.path);
assert.deepEqual(changedRuntimeFiles, ['runtime/src/current-state.js']);
assert.equal(before.attempts.length, 10); assert.equal(after.attempts.length, 10);
const outcomes = before.attempts.map((first, i) => {
  const second = after.attempts[i]; assert.equal(first.id, second.id); assert.deepEqual(first.input, second.input); assert.deepEqual(first.provider, second.provider);
  assert.equal(first.error, null); assert.equal(second.error, null);
  assert.deepEqual(first.report.execution, second.report.execution, 'Original execution changed');
  assert.deepEqual(first.report.evidence.traceResponse, second.report.evidence.traceResponse, 'Original trace changed');
  const originalDiff = packet => packet.records.find(r => r.method === 'debug_traceCall' && r.params[0].to === packet.input.to &&
    r.params[0].data === packet.input.data && r.params[2].tracer === 'prestateTracer' && !r.params[2].stateOverrides);
  const a = originalDiff(first), b = originalDiff(second); assert.equal(Boolean(a), Boolean(b));
  if (a) { assert.deepEqual(a.params, b.params); assert.deepEqual(a.result, b.result, 'Original state diff changed'); }
  return { id: first.id, execution: second.report.execution.status, originalTraceUnchanged: true, originalStateDiffUnchanged: a ? true : null,
    nativeStatusBefore: first.report.nativeBalanceChanges.status, nativeStatusAfter: second.report.nativeBalanceChanges.status,
    deltaRaw: second.report.nativeBalanceChanges.assets.map(x => ({ account: x.account, deltaRaw: x.deltaRaw })) };
});
const metadataDifferences = [...new Set([...Object.keys(before.selected), ...Object.keys(after.selected)])]
  .filter(k => !isDeepStrictEqual(before.selected[k], after.selected[k])).map(field => ({ field, before: before.selected[field], after: after.selected[field] }));
console.log(JSON.stringify({ status: 'fixed_inputs_originals_and_single_source_fix_verified', changedRuntimeFiles,
  block: { number: BigInt(after.selected.number).toString(), hash: after.selected.hash }, metadataDifferences,
  outcomes, scope: 'Saved parsed-response comparison. Original failures preserved; no new execution, network or general accuracy claim.' }, null, 2));
