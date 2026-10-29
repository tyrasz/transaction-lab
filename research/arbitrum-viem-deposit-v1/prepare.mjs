import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { inventory, save, sha, SOURCE_ROOTS } from './artifacts.mjs';
import { ENDPOINT, LIMITS, METHODS, STATIC_CODE } from './policy.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const scenario = fs.readFileSync(path.join(root, 'scenario.json'));
assert.equal(sha(scenario), '5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/viem/package.json')));
assert.equal(packageJson.version, '2.57.13');
const roots = SOURCE_ROOTS;
const source = { schemaVersion: 1, roots, files: inventory(root, roots) };
const sourceEntry = save(root, 'source-manifest.json', source);
const plan = { schemaVersion: 1, declaredAt: new Date().toISOString(), endpoint: ENDPOINT, chainId: '0xa4b1', scenarioSha256: sha(scenario),
  sourceManifestSha256: sourceEntry.sha256, node: { version: process.version, sha256: sha(fs.readFileSync(process.execPath)) }, viem: packageJson.version,
  limits: LIMITS, methods: METHODS, originalCall: { gas: '2000000', gasPrice: '0', validation: false },
  helperCodeSha256: sha(Buffer.from(STATIC_CODE.slice(2), 'hex')), selection: 'one_fresh_latest_number_with_before_after_full_header_check',
  sequence: ['chainId', 'latestHeader', 'USDC.balanceOf(sender)', 'USDC.allowance(sender,TokenMessengerV2)', 'nativeBalance(sender)', 'code(sender)', 'viem.simulateCalls_once', 'sameNumberHeader'],
  scope: 'Provider-backed source-chain development experiment on the exact existing public scenario. No destination credit, attestation, signing, broadcast, wallet replacement or balance/allowance override.',
  timing: '120s collection/execution including RPC settlement; source/dependency hashing before and after and offline sealing are excluded from this live window.',
  partialMeasurements: 'viem may omit failed asset queries. Raw omissions remain; no complete asset inventory or fee accuracy claim.',
};
const planEntry = save(root, 'plan.json', plan);
save(root, 'FROZEN.json', { schemaVersion: 1, frozenAt: new Date().toISOString(), planSha256: planEntry.sha256, sourceManifestSha256: sourceEntry.sha256 });
console.log(JSON.stringify({ plan: planEntry, source: sourceEntry, sourceFiles: source.files.length }, null, 2));
