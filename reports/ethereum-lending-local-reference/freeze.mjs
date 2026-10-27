import { readFile, writeFile, mkdir, readdir, lstat, readlink, symlink, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { sha } from './wire.mjs';

const DIR = dirname(fileURLToPath(import.meta.url)), ROOT = join(DIR, '../..');
export const MODULES = ['ethereum-call.js', 'ethereum-profile.js', 'ethereum-header.js', 'execute.js',
  'rpc-state-inputs.js', 'proof-state.js', 'verified-state-proof.js', 'package.json', 'package-lock.json']
  .map(f => 'engines/local-evm/' + f);
export const SCRIPTS = ['freeze.mjs', 'run.mjs', 'wire.mjs', 'wire.test.mjs', 'compare.mjs', 'compare.test.mjs'];
export const INPUTS = [
  { source: 'reports/standard-evm-deposits-v2/plan.json', path: 'inputs/deposit-plan.json', sha256: 'd458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f' },
  { source: 'reports/standard-evm-discovery/raw/025.json', path: 'inputs/aave-parent.json', sha256: 'e07dce6ae8d184dac5a8fe4739034d30535b0283e96f655ca248bca99302cda9' },
  { source: 'reports/standard-evm-discovery/raw/026.json', path: 'inputs/morpho-parent.json', sha256: '6abaf67305776d021e27544f63de446c79b6e779e21d6bcf8e77dbe0bd3541c4' },
];
export async function walk(base, dir) {
  const files = [];
  for (const e of (await readdir(join(base, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    if (e.isDirectory()) files.push(...await walk(base, path)); else files.push(path);
  }
  return files;
}
const save = async (p, v) => writeFile(join(DIR, p), JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
export function deriveCases(depositPlan, parents) {
  const ids = ['aave-usdc-supply-with-permit', 'morpho-kiln-usdc-deposit'];
  if (!Array.isArray(depositPlan.cases) || !equal(depositPlan.cases.map(c => c.id), ids)) throw Error('Original case selection differs');
  return depositPlan.cases.map((c, i) => {
    const header = parents[i]?.response?.result;
    if (!header || header.hash !== c.blockHash || BigInt(header.number).toString() !== c.blockNumber || BigInt(header.timestamp).toString() !== c.parentTimestamp) throw Error('Original parent binding differs');
    if (!equal(Object.keys(c.request).sort(), ['data', 'from', 'gas', 'to', 'value']) || c.request.gas !== '0x4c4b40' || c.request.value !== '0x0') throw Error('Original call envelope differs');
    const request = structuredClone(c.request), apiInput = { chainId: 1, from: request.from, to: request.to, data: request.data, value: BigInt(request.value).toString(), block: header.hash };
    return { id: c.id, label: c.label, originalTransactionHash: c.originalTransactionHash,
      request, header: structuredClone(header), apiInput, parentInput: INPUTS[i + 1].path,
      inputProfile: 'Original calldata and sender at original parent-block end, fixed 5M gas, unsigned and unpriced; not original-position replay.' };
  });
}
export async function freeze() {
  try { await access(join(DIR, 'plan.json')); throw Error('Plan already frozen; do not replace'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Read and validate all selected inputs and scripts before writing an archive.
  const inputBytes = await Promise.all(INPUTS.map(async entry => {
    const bytes = await readFile(join(ROOT, entry.source)); if (sha(bytes) !== entry.sha256) throw Error('Original input changed'); return bytes;
  }));
  const cases = deriveCases(JSON.parse(inputBytes[0]), inputBytes.slice(1).map(b => JSON.parse(b)));
  // Offline only: equality confirms the new flat API envelope, but these old
  // product packets are never archived as inputs or loaded by run.mjs.
  for (const [i, name] of ['aave', 'morpho'].entries()) {
    const old = JSON.parse(await readFile(join(ROOT, `reports/standard-evm-auto/${name}-response.json`)));
    if (!equal(cases[i].apiInput, old.apiRequest)) throw Error('Derived API request differs from prior fixed input');
  }
  const expectedImplementation = JSON.parse(await readFile(join(ROOT, 'reports/standard-evm-sequence/results.json'))).implementation;
  if (expectedImplementation.version !== '0.12.0' || expectedImplementation.sourceSha256 !== '3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60') throw Error('Product identity differs');
  const scripts = await Promise.all(SCRIPTS.map(async path => { const bytes = await readFile(join(DIR, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; }));
  const sourcePaths = [...MODULES, ...await walk(ROOT, 'engines/local-evm/node_modules')].sort(), sources = [];
  for (const path of sourcePaths) {
    const src = join(ROOT, path), dst = join(DIR, 'runtime', path), stat = await lstat(src); await mkdir(dirname(dst), { recursive: true });
    if (stat.isSymbolicLink()) {
      const target = await readlink(src), resolved = resolve(dirname(src), target);
      if (target.startsWith('/') || !resolved.startsWith(resolve(ROOT, 'engines/local-evm/node_modules') + '/')) throw Error('Dependency symlink escapes archive');
      await symlink(target, dst); sources.push({ path, kind: 'symlink', target });
    } else {
      const bytes = await readFile(src); await writeFile(dst, bytes, { flag: 'wx' }); sources.push({ path, kind: 'file', bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  await mkdir(join(DIR, 'inputs'), { recursive: true });
  const inputFiles = [];
  for (const [i, entry] of INPUTS.entries()) {
    await writeFile(join(DIR, entry.path), inputBytes[i], { flag: 'wx' }); inputFiles.push({ ...entry, bytes: inputBytes[i].length });
  }
  const { verifyEthereumHeader } = await import(pathToFileURL(join(DIR, 'runtime/engines/local-evm/ethereum-header.js')));
  for (const c of cases) c.headerVerification = verifyEthereumHeader({ header: c.header, expectedHash: c.apiInput.block });
  const plan = {
    schemaVersion: '1.0', purpose: 'Two fixed selected lending development workloads, each executed locally once from proof/code inputs before any fresh product comparison; no scored cohort.',
    createdAt: new Date().toISOString(), chainId: 1, provider: { id: 'drpc', url: 'https://eth.drpc.org' }, cases,
    limits: { localAttempts: 2, proofCodeCallsPerAttempt: 256, bodyBytes: 8388608,
      localCaseResponseBytes: 33554432, sharedLocalResponseBytes: 67108864,
      requestMs: 25000, attemptMs: 120000, totalMs: 600000,
      apiRequests: 2, apiTimeoutMs: 160000, apiBodyBytes: 67108864,
      apiInternalRpcCallsPerCase: 65, apiInternalResponseBytesPerCase: 33554432,
      totalUnderlyingRpcCalls: 642, totalUnderlyingResponseBytes: 134217728 },
    api: { url: 'http://127.0.0.1:5174/api/evm/simulate', expectedImplementation },
    policy: { retries: 0, replacements: 0, fallback: false,
      limitDecision: 'Use existing collector ceiling 256 per case, chosen before dispatch; the earlier transfer packet tightened this to 64. Engine120s and all other runtime ceilings remain unchanged.',
      ordering: 'Aave local, Morpho local; drain and save each output. Only then Aave product, Morpho product. Retain every declared failure without replacement.',
      stateInputs: 'Only verified eth_getProof and eth_getCode with EIP1898 hash binding, demanded by the independent local engine. No old or new trace, diff, expected output, touched-address list or product query can populate local state.',
      headerTrust: 'Recompute RLP/Keccak execution-header hash against externally selected historical hash; consensus, finality and body are not authenticated.',
      missingBlockhash: 'No ancestry requests; execution requiring unavailable BLOCKHASH context fails closed.',
      wireBytes: 'Count response entity bytes after HTTP decompression. A limit-crossing chunk is counted, only its bounded prefix retained, and the outcome is a resource failure.',
      comparison: 'Fresh product raw results only after local saves; separate execution status, return, committed logs, full observed changed state and transaction-style gas channels. Missing or unsupported evidence remains explicit.',
      effects: 'No outer signature, fee settlement, time advancement, funding override, signed original-position replay or complete economic inventory claim.' },
    runtime: { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch },
    sourceFiles: sources, inputFiles, scripts,
  };
  await save('plan.json', plan);
  console.log(JSON.stringify({ planSha256: sha(await readFile(join(DIR, 'plan.json'))), sourceFiles: sources.length,
    dependencyFiles: sources.filter(x => x.path.includes('/node_modules/')).length, sourceBytes: sources.reduce((s, x) => s + (x.bytes ?? 0), 0), inputFiles: inputFiles.length, scripts: scripts.length, caseIds: cases.map(c => c.id) }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await freeze();
