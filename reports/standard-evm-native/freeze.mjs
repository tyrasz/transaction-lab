// Freeze is read-only with respect to product and older observations. It never
// binds a socket or contacts the public provider. Run once after source review.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HERE, REPO, PROVIDER, IMPLEMENTATION_FILES, SOURCE_FILES, INPUT_FILES, LIMITS,
  sha, requireCheck, writeJson, fileInfo, fingerprint, selectedCases, listFiles, verifyPacket } from './run.mjs';

export async function freezePacket() {
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
  const cases = selectedCases(HERE);
  for (const item of cases) api.validateStandardSimulation(structuredClone(item.input));
  // Finish with another full source comparison; no plan is accepted if source
  // changed during archive loading or input validation.
  for (const source of sources) requireCheck(sha(readFileSync(resolve(REPO, source.path))) === source.sha256, 'SOURCE_CHANGED_DURING_PREFLIGHT');
  const plan = { schemaVersion: '1.0', frozenAt, developmentOnly: true, title: 'Three fixed native ETH development simulations',
    provider: PROVIDER, chainId: 1, route: '/api/evm/simulate', method: 'POST', implementation: api.implementation,
    limits: LIMITS, cases, sources: sources.map(({ data, ...entry }) => entry), inputs: inputs.map(({ data, ...entry }) => entry),
    protocol: ['Exactly three cases in declared order, once each; no retries, replacements, fallback providers or new selection.',
      'Run uses the complete archived application source with the production bounded Ethereum transport and fixed public endpoint.',
      'STARTED.json is created exclusively before socket binding or public network. Any interrupted run is retained and cannot be relaunched.',
      'API requests omit explicit token queries; the engine discovers its bounded token/native account set.',
      'Native amounts must come from validated before/after state; candidate net-value diagnostics are not measurements.',
      'No funding overrides, original signed fee settlement, account ownership claim, independent engine oracle or general coverage score.'] };
  writeJson(resolve(HERE, 'plan.json'), plan);
  const planSha256 = sha(readFileSync(resolve(HERE, 'plan.json')));
  writeJson(resolve(HERE, 'FROZEN.json'), { schemaVersion: '1.0', frozenAt, planSha256, implementationSha256: api.implementation.sourceSha256, sourceFiles: sources.length, cases: cases.length });
  await verifyPacket();
  console.log(JSON.stringify({ status: 'frozen', planSha256, implementationSha256: api.implementation.sourceSha256, sourceFiles: sources.length, cases: cases.map(x => x.id), networkCalls: 0 }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireCheck(process.argv.length === 2, 'INVALID_ARGUMENTS');
  await freezePacket();
}
