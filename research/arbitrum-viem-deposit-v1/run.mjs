import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createPublicClient, custom } from 'viem';
import { arbitrum } from 'viem/chains';
import { simulateCalls } from 'viem/actions';
import { inventory, verifyInventory, save, artifactWriter, sha, text, safeError } from './artifacts.mjs';
import { ENDPOINT, LIMITS, METHODS, USDC, balanceData, allowanceData } from './policy.mjs';
import { createRecordingTransport } from './transport.mjs';

export async function executeScenario({ scenario, recorder, write, invoke = simulateCalls }) {
  const result = { status: 'unavailable', selectedHeader: null, prechecks: [], viem: { attempted: false, result: null, error: null }, finalHeader: null, headerConfirmed: false,
    error: null, drain: null, usable: false, transport: null };
  try {
    assert.equal(await recorder.request({ method: 'eth_chainId', params: [] }), '0xa4b1', 'Unexpected chain identity.');
    const header = await recorder.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    assert.match(header?.number, /^0x(?:0|[1-9a-f][0-9a-f]*)$/); assert.match(header?.hash, /^0x[0-9a-f]{64}$/);
    result.selectedHeader = header; write('selected-header.json', header); recorder.pin(header); recorder.setPhase('prechecks');
    const prechecks = [
      ['usdc_balance', 'eth_call', [{ to: USDC, data: balanceData(scenario.from) }, header.number]],
      ['usdc_allowance', 'eth_call', [{ to: USDC, data: allowanceData(scenario.from, scenario.to) }, header.number]],
      ['native_balance', 'eth_getBalance', [scenario.from, header.number]],
      ['sender_code', 'eth_getCode', [scenario.from, header.number]],
    ];
    for (const [name, method, params] of prechecks) {
      const row = { name, status: 'unavailable', value: null, error: null };
      try {
        row.value = await recorder.request({ method, params });
        if (method === 'eth_call') assert.match(row.value, /^0x[0-9a-f]{64}$/i);
        else if (method === 'eth_getBalance') assert.match(row.value, /^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
        else assert.match(row.value, /^0x(?:[0-9a-f]{2})*$/i);
        row.status = 'observed';
      } catch (error) { row.error = safeError(error); }
      result.prechecks.push(row); write('prechecks/' + name + '.json', row);
    }
    // Observed funds/allowance never change the envelope or manufacture state.
    recorder.setPhase('viem');
    const client = createPublicClient({ chain: arbitrum, batch: { multicall: false }, ccipRead: false, cacheTime: 0,
      transport: custom(recorder, { retryCount: 0, methods: { include: METHODS } }) });
    const invocation = { account: scenario.from, blockNumber: BigInt(header.number), calls: [{ to: scenario.to, data: scenario.data, value: BigInt(scenario.value), gas: 2000000n, gasPrice: 0n }],
      traceAssetChanges: true, traceTransfers: true, validation: false };
    write('viem-invocation.json', invocation); result.viem.attempted = true;
    try { result.viem.result = await invoke(client, invocation); }
    catch (error) { result.viem.error = safeError(error); }
    finally { recorder.endPhase(); result.drain = await recorder.drain(); }
    const serialized = text(result.viem);
    if (Buffer.byteLength(serialized) > LIMITS.retainedOutputBytes) throw new Error('Decoded viem output limit exceeded; raw evidence retained.');
    write('viem-output.json', serialized);
    recorder.setPhase('final');
    try {
      result.finalHeader = await recorder.request({ method: 'eth_getBlockByNumber', params: [header.number, false] });
      write('final-header.json', result.finalHeader); assert.deepEqual(result.finalHeader, header); result.headerConfirmed = true;
    } catch (error) { result.error = safeError(error); }
  } catch (error) { result.error = safeError(error); }
  finally { recorder.endPhase(); result.drain = await recorder.drain(); recorder.finish(); result.transport = recorder.snapshot(); }
  result.usable = result.headerConfirmed && result.drain.complete && result.transport.withinBounds && !result.transport.hardFailure && result.transport.deniedCount === 0 && result.transport.discardedCount === 0;
  result.assetObservation = { inventoryComplete: false, libraryMayOmitFailedProbes: true, successfulEmptyTokenPreReadMayBeInferredZero: true, returnedEntries: result.viem.result?.assetChanges?.length ?? 0,
    scope: "Library-derived provider observations only, including viem's empty-pre-read zero inference; omitted or failed probes do not establish no effects. Exact probe returns/errors remain in wire records.",
    destinationCreditVerified: false };
  result.status = result.usable ? result.viem.error ? 'viem_unavailable' : result.viem.attempted ? 'observed' : 'unavailable' : 'unconfirmed';
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(process.argv[2], 'run', 'Use run with the reviewed exact plan SHA-256.');
  const planBytes = fs.readFileSync(path.join(root, 'plan.json')); assert.equal(sha(planBytes), process.argv[3]);
  const plan = JSON.parse(planBytes), sourceBytes = fs.readFileSync(path.join(root, 'source-manifest.json'));
  assert.equal(sha(sourceBytes), plan.sourceManifestSha256); const source = JSON.parse(sourceBytes); verifyInventory(root, source);
  assert.equal(plan.node.version, process.version); assert.equal(plan.node.sha256, sha(fs.readFileSync(process.execPath)));
  assert.equal(plan.endpoint, ENDPOINT); assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.methods, METHODS); assert.equal(plan.viem, '2.57.13');
  const scenarioBytes = fs.readFileSync(path.join(root, 'scenario.json')); assert.equal(sha(scenarioBytes), plan.scenarioSha256);
  const scenario = JSON.parse(scenarioBytes); assert.equal(scenario.chainId, '42161'); assert.equal(scenario.value, '0');
  const capture = path.join(root, 'capture'); fs.mkdirSync(capture);
  const writer = artifactWriter(capture), write = writer.write;
  const frozenBytes = fs.readFileSync(path.join(root, 'FROZEN.json'));
  write('STARTED.json', { schemaVersion: 1, startedAt: new Date().toISOString(), pid: process.pid, planSha256: sha(planBytes), sourceManifestSha256: plan.sourceManifestSha256 });
  const recorder = createRecordingTransport({ scenario, save: write });
  const result = await executeScenario({ scenario, recorder, write });
  writer.verify();
  result.sourceUnchanged = false;
  try { verifyInventory(root, source); assert.equal(sha(fs.readFileSync(path.join(root, 'plan.json'))), sha(planBytes)); assert.equal(sha(fs.readFileSync(path.join(root, 'source-manifest.json'))), sha(sourceBytes)); assert.deepEqual(fs.readFileSync(path.join(root, 'FROZEN.json')), frozenBytes); result.sourceUnchanged = true; } catch (error) { result.integrityError = safeError(error); result.usable = false; result.status = 'unconfirmed'; }
  result.planSha256 = sha(planBytes); result.sourceManifestSha256 = plan.sourceManifestSha256;
  result.scope = plan.scope; result.finishedAt = new Date().toISOString();
  write('results.json', result); write('measurement-overrides.json', result.transport.measurementOverrides);
  writer.verify();
  const files = inventory(capture, fs.readdirSync(capture));
  const manifest = write('evidence-manifest.json', { schemaVersion: 1, planSha256: sha(planBytes), sourceManifestSha256: plan.sourceManifestSha256, files });
  writer.verify();
  console.log(text({ manifest, assetObservation: result.assetObservation, status: result.status, usable: result.usable, sourceUnchanged: result.sourceUnchanged, calls: result.transport.calls,
    bytes: result.transport.retainedBytes, durationMs: result.transport.elapsedMs, viemError: result.viem.error, sourceChainResults: result.viem.result?.results?.map(row => ({ status: row.status, data: row.data, gasUsed: row.gasUsed })), assetChanges: result.viem.result?.assetChanges }));
}
