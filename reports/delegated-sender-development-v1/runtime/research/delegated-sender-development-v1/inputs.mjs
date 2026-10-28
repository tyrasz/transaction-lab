// Fixed, previously observed cases. Only request/header enter local execution;
// inherited oracle bodies are opened for comparison after the local seal.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { verifyCohortWireRecord } from '../standard-evm/cohort-verify.mjs';
import { oracleRequests } from './outcomes.mjs';

export const ORIGINAL_MANIFEST_SHA = 'd1c82c2237351ce871ab7a789d72aee264a5006b51c6f42c1207a9cf144ecd40';
export const FIXED_CASES = Object.freeze([
  Object.freeze({ id: '002', transactionHash: '0x31cac6ebe975a4ca6666adf9b107fdb291af2cbeecbcf838397034e60daa03b8', oracleWireIds: Object.freeze([49, 50, 51, 52]) }),
  Object.freeze({ id: '015', transactionHash: '0xcb13cd67f13e57c3cd944c4ede2d9368a7e48c3a6a4aae8179f730c3a2c40314', oracleWireIds: Object.freeze([291, 292, 293, 294]) }),
]);
export const sha = value => createHash('sha256').update(value).digest('hex');
export const need = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
export const INPUT_PATHS = Object.freeze(['evidence-manifest.json', 'plan.json', ...FIXED_CASES.flatMap(c => [`cases/${c.id}/request.json`, `cases/${c.id}/oracle.json`, ...c.oracleWireIds.map(id => `wire/${String(id).padStart(6, '0')}.json`)])].sort());
export function regularBytes(root, path, max = 128 * 1024 * 1024) {
  need(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(p => p && p !== '.' && p !== '..'), 'input_path_invalid');
  let current = resolve(root); need(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'input_root_invalid');
  for (const part of path.split('/').slice(0, -1)) { current = join(current, part); const s = lstatSync(current); need(s.isDirectory() && !s.isSymbolicLink(), 'input_parent_invalid'); }
  const s = lstatSync(join(root, path)); need(s.isFile() && !s.isSymbolicLink() && s.size <= max, 'input_file_invalid');
  const bytes = readFileSync(join(root, path)); need(bytes.length === s.size, 'input_read_changed'); return bytes;
}
function checkBase(root) {
  const raw = regularBytes(root, 'evidence-manifest.json', 8 * 1024 * 1024); need(sha(raw) === ORIGINAL_MANIFEST_SHA, 'original_manifest_differs');
  const manifest = JSON.parse(raw); need(manifest.schemaVersion === '1.0' && Array.isArray(manifest.files), 'original_manifest_invalid');
  const byPath = new Map(manifest.files.map(row => [row.path, row])); need(byPath.size === manifest.files.length, 'original_manifest_duplicate');
  const files = INPUT_PATHS.map(path => {
    const bytes = regularBytes(root, path), entry = { path, bytes: bytes.length, sha256: sha(bytes) };
    if (path !== 'evidence-manifest.json') need(equal(entry, byPath.get(path)), 'original_input_differs');
    return entry;
  });
  need(files.find(f => f.path === 'plan.json').sha256 === manifest.planSha256, 'original_plan_differs');
  return { originalManifestSha256: ORIGINAL_MANIFEST_SHA, originalPlanSha256: manifest.planSha256, files };
}
export function fixedRequests(root) {
  return FIXED_CASES.map(fixed => {
    const source = JSON.parse(regularBytes(root, `cases/${fixed.id}/request.json`));
    need(source.transactionHash === fixed.transactionHash && source.projection.status === 'projectable' && source.projection.transactionHash === fixed.transactionHash && equal(source.parentHeader, source.projection.parentHeader), 'fixed_request_differs');
    verifyEthereumHeader({ header: source.parentHeader, expectedHash: source.parentHeader.hash });
    oracleRequests({ request: source.projection.request, header: source.parentHeader });
    return { id: fixed.id, transactionHash: fixed.transactionHash, request: source.projection.request, header: source.parentHeader };
  });
}
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function copyOriginalInputs({ originalDirectory, outputDirectory }) {
  const inventory = checkBase(originalDirectory), destination = join(outputDirectory, 'inputs', 'original');
  mkdirSync(join(outputDirectory, 'inputs')); mkdirSync(destination); syncDirectory(outputDirectory); syncDirectory(join(outputDirectory, 'inputs'));
  for (const entry of inventory.files) {
    const bytes = regularBytes(originalDirectory, entry.path); need(sha(bytes) === entry.sha256, 'original_input_changed');
    const target = join(destination, entry.path); mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(target, 'wx', 0o444); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(dirname(target));
  }
  need(equal(checkBase(destination), inventory), 'input_copy_differs');
  return { ...inventory, cases: fixedRequests(destination) };
}
export function verifyOriginalInputs({ outputDirectory, expected }) {
  const root = join(outputDirectory, 'inputs', 'original'), actual = { ...checkBase(root), cases: fixedRequests(root) };
  need(equal(actual, expected), 'frozen_inputs_differ'); return actual;
}
export function readRecordedOracle({ outputDirectory, item }) {
  const fixed = FIXED_CASES.find(c => c.id === item.id); need(fixed && fixed.transactionHash === item.transactionHash, 'unknown_case');
  const root = join(outputDirectory, 'inputs', 'original'), oracle = JSON.parse(regularBytes(root, `cases/${item.id}/oracle.json`));
  const records = fixed.oracleWireIds.map(id => JSON.parse(regularBytes(root, `wire/${String(id).padStart(6, '0')}.json`)));
  const expected = oracleRequests({ request: item.request, header: item.header });
  need(oracle.dispatch === 'completed' && equal(oracle.transportWireIds, fixed.oracleWireIds) && equal(oracle.records, records) && records.length === expected.length, 'recorded_oracle_inventory_differs');
  for (let i = 0; i < records.length; i++) {
    verifyCohortWireRecord(records[i]);
    need(records[i].provider === 'drpc' && records[i].profile === 'product' && records[i].globalId === fixed.oracleWireIds[i] && records[i].request.method === expected[i].method && equal(records[i].request.params, expected[i].params), 'recorded_oracle_request_differs');
  }
  return oracle;
}
