// Freeze is read-only with respect to product and older observations. It never
// binds a socket or contacts the public provider. Run once after source review.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HERE, REPO, PROVIDER, IMPLEMENTATION_FILES, SOURCE_FILES, INPUT_FILES, LIMITS,
  sha, requireCheck, writeJson, fileInfo, fingerprint, selectedCases, validateCases, listFiles, verifyPacket } from './run.mjs';

export async function freezePacket(expectedHash, expectedVersion) {
  requireCheck(/^[0-9a-f]{64}$/.test(expectedHash) && expectedVersion === '0.13.1', 'EXPLICIT_RELEASE_IDENTITY_REQUIRED');
  requireCheck(fingerprint(REPO) === expectedHash, 'LIVE_RELEASE_IDENTITY_MISMATCH');
  requireCheck(!['plan.json', 'FROZEN.json', 'STARTED.json', 'source', 'inputs'].some(path => existsSync(resolve(HERE, path))), 'PACKET_ALREADY_FROZEN_OR_PARTIAL');
  const frozenAt = new Date().toISOString();
  const inputs = INPUT_FILES.map(item => {
    const bytes = readFileSync(resolve(REPO, item.originalPath));
    requireCheck(sha(bytes) === item.sha256, 'ORIGINAL_INPUT_HASH_MISMATCH');
    return { ...item, bytes: bytes.length, data: bytes };
  });
  const sources = SOURCE_FILES.map(path => ({ ...fileInfo(REPO, path), data: readFileSync(resolve(REPO, path)) }));
  for (const source of sources) requireCheck(sha(source.data) === source.sha256, 'SOURCE_CHANGED_WHILE_READING');
  for (const entry of [...sources.map(x => ({ ...x, target: 'source/' + x.path })), ...inputs.map(x => ({ ...x, target: x.path }))]) {
    const target = resolve(HERE, entry.target);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, entry.data, { flag: 'wx', mode: 0o444 });
  }
  const archive = resolve(HERE, 'source');
  requireCheck(isDeepStrictEqual(listFiles(archive), SOURCE_FILES), 'FROZEN_INVENTORY_MISMATCH');
  for (const source of sources) {
    const expected = { path: source.path, bytes: source.bytes, sha256: source.sha256 };
    requireCheck(isDeepStrictEqual(fileInfo(archive, source.path), expected) && isDeepStrictEqual(fileInfo(REPO, source.path), expected), 'SOURCE_CHANGED_DURING_FREEZE');
  }
  const { loadStandardApi } = await import(pathToFileURL(resolve(archive, 'src/standard-loader.js')));
  const api = await loadStandardApi();
  requireCheck(api && isDeepStrictEqual(api.implementation.sourceFiles, IMPLEMENTATION_FILES) && api.implementation.sourceSha256 === fingerprint(archive), 'FROZEN_IMPLEMENTATION_INVALID');
  requireCheck(api.implementation.sourceSha256 === expectedHash && api.implementation.version === expectedVersion, 'RELEASE_IDENTITY_MISMATCH');
  const cases = await selectedCases(HERE);
  validateCases(api, cases);
  // Finish with another full source comparison; no plan is accepted if source
  // changed during archive loading or input validation.
  for (const source of sources) requireCheck(sha(readFileSync(resolve(REPO, source.path))) === source.sha256, 'SOURCE_CHANGED_DURING_PREFLIGHT');
  const plan = { schemaVersion: '1.0', frozenAt, developmentOnly: true, title: 'Fixed Aave and Morpho mixed token and position-query development cases',
    provider: PROVIDER, chainId: 1, routes: ['/api/evm/simulate', '/api/evm/simulate-sequence'], method: 'POST', implementation: api.implementation,
    priorAttempts: [
      { directory: 'reports/standard-evm-positions', planSha256: 'c3fcbbbe8fb48d7b44cced5781c5aceb62afdafb915345e130e6e91268a90e5d', manifestSha256: '91c45895cfaf8ed78ad73fc9b19b8b18438086b474837405c40790fc943d43e3', outcome: 'EPERM before any HTTP or public RPC', attempted: 0, rpcCalls: 0, preserved: true },
      { directory: 'reports/standard-evm-positions-v2', planSha256: '4296ee6765f6e5734f5ebdc1085987eccaa47fe935e83408effe67bf97d3a0eb', manifestSha256: '834962759a7629aabaedc4b778b828f4df92b11b4c8e548ad7b3648ff95d2f13', outcome: 'All executions succeeded; twelve token queries and one Morpho position measured, three Aave position checks unavailable under the delegate-forwarding guard', attempted: 3, rpcCalls: 112, preserved: true },
    ],
    limits: LIMITS, cases, sources: sources.map(({ data, ...entry }) => entry), inputs: inputs.map(({ data, ...entry }) => entry),
    protocol: ['This separately declared post-fix development capture retains the first zero-RPC EPERM packet and v2 partial position coverage. Exact inputs/provider/bounds are unchanged; no prior result is replaced. Dispatch requires approved loopback/public read-only network permission.',
      'Exactly three cases in declared order, once each; no retries, replacements, fallback providers or new selection.',
      'Run uses the complete archived application source with the production bounded Ethereum transport and fixed public endpoint.',
      'STARTED.json is created exclusively before socket binding or public network. Any interrupted run is retained and cannot be relaunched.',
      'Explicit mixed token and position queries are fixed before dispatch; native observations remain automatic.',
      'Aave supplyWithPermit has four original token queries and sender account data; Morpho wrapper deposit has three token queries and the inner-vault Blue position; constructed approve/supply has allowance+account data then four tokens+account data.',
      'Retain reverted, unavailable and skipped outcomes. No amount or tuple is expected or supplied in advance.',
      'Offline verification must decode each before/after query trace word, compare raw values, and bind per-step original/measurement calls to complete composed state. No probe nonce is carried.',
      'Live-run hypotheses do not choose replacements and never become expected output repairs.',
      'No funding overrides, original signed fee settlement, account ownership claim, independent engine oracle or general coverage score.',
      'An ephemeral loopback port hosts the archived handler; the normal app remains untouched.',
      'Independent typed-position trace checks permit different internal delegate ABI input/output while scalar token-query forwarding checks remain strict; context, type, value, event, failure, before/after state and canonical guards remain required.',
      'Position names and units are caller-declared ABI semantics; no deployment attestation, currency conversion, share-to-asset conversion or health judgment is inferred.'] };
  writeJson(resolve(HERE, 'plan.json'), plan);
  const planSha256 = sha(readFileSync(resolve(HERE, 'plan.json')));
  writeJson(resolve(HERE, 'FROZEN.json'), { schemaVersion: '1.0', frozenAt, planSha256, implementationSha256: api.implementation.sourceSha256, sourceFiles: sources.length, cases: cases.length });
  await verifyPacket();
  console.log(JSON.stringify({ status: 'frozen', planSha256, implementationSha256: api.implementation.sourceSha256, sourceFiles: sources.length, cases: cases.map(x => x.id), networkCalls: 0 }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireCheck(process.argv.length === 4, 'INVALID_ARGUMENTS');
  await freezePacket(process.argv[2], process.argv[3]);
}



