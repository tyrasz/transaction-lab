// Separate development diagnostic. Never changes the failed prospective pilot.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { EvaluationBudget, safeEvaluationError } from './frozen/evaluation-budget.js';

const directory = new URL('./', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const planBytes = await readFile(new URL('plan.json', directory));
const plan = JSON.parse(planBytes);
assert.equal(plan.scriptSha256, sha(await readFile(new URL('capture.mjs', directory))));
for (const dependency of plan.dependencies) assert.equal(sha(await readFile(new URL(dependency.path, directory))), dependency.sha256);
assert.equal(plan.users.length, 5);
assert.equal(plan.systemPrefixLength, 3);
assert.equal(plan.limits.totalRpc, 86);
if (process.argv[2] === '--validate') {
  console.log(json({ status: 'validated_without_rpc', planSha256: sha(planBytes), maxRequests: plan.limits.totalRpc }));
} else if (process.argv[2] === '--run') {
  const t0 = Date.now();
  const budget = new EvaluationBudget({ t0, limits: plan.limits });
  const capture = { schemaVersion: '1.0', planSha256: sha(planBytes), startedAt: new Date(t0).toISOString(), status: 'running', providers: [], records: budget.records };
  const output = new URL('capture.json', directory);
  await writeFile(output, json(capture), { flag: 'wx' });
  const save = async () => { capture.budget = budget.snapshot(); await writeFile(output, json(capture)); };
  async function observe(client, method, params) {
    const before = budget.rpcCount;
    try { const result = await client.call(method, params); return { rpcId: budget.rpcCount, result }; }
    catch (error) { return { rpcId: budget.rpcCount > before ? budget.rpcCount : null, error: safeEvaluationError(error) }; }
    finally { await save(); }
  }
  const tracers = {
    call: { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } },
    diff: { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } },
  };
  const qty = value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
  const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
  for (const provider of ['A', 'B']) {
    const client = budget.client(provider, { phase: 'system_position_diagnostic' });
    const observed = { provider, chain: await observe(client, 'eth_chainId', []), block: await observe(client, 'eth_getBlockByNumber', [plan.blockNumber, false]), cases: [] };
    capture.providers.push(observed);
    const bound = observed.chain.result === '0x3e7' && observed.block.result?.hash === plan.blockHash && observed.block.result?.number === plan.blockNumber;
    for (const [ordinaryIndex, transactionHash] of plan.users.entries()) {
      const item = { transactionHash, ordinaryIndex, extendedIndex: ordinaryIndex + plan.systemPrefixLength, replays: [] };
      observed.cases.push(item);
      if (!bound) { item.skipped = 'Provider chain or block identity unavailable; no substitution.'; continue; }
      const caseClient = budget.client(provider, { phase: 'system_position_diagnostic', caseId: provider + ':' + transactionHash });
      item.transaction = await observe(caseClient, 'eth_getTransactionByHash', [transactionHash]);
      item.receipt = await observe(caseClient, 'eth_getTransactionReceipt', [transactionHash]);
      item.originalTrace = await observe(caseClient, 'debug_traceTransaction', [transactionHash, tracers.call]);
      item.originalDiff = await observe(caseClient, 'debug_traceTransaction', [transactionHash, tracers.diff]);
      const tx = item.transaction.result, receipt = item.receipt.result;
      if (!tx || tx.hash !== transactionHash || tx.blockHash !== plan.blockHash || tx.blockNumber !== plan.blockNumber || tx.chainId !== '0x3e7' || !address(tx.from) || !address(tx.to) || typeof tx.input !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.input) || !['0x0', '0x1', '0x2'].includes(tx.type) || !['gas', 'gasPrice', 'nonce', 'value', 'transactionIndex'].every(key => qty(tx[key])) || !receipt || receipt.transactionHash !== transactionHash || receipt.blockHash !== plan.blockHash || receipt.blockNumber !== plan.blockNumber || receipt.transactionIndex !== tx.transactionIndex || receipt.effectiveGasPrice !== tx.gasPrice || ['authorizationList', 'blobVersionedHashes', 'maxFeePerBlobGas'].some(key => tx[key] != null)) {
        item.skipped = 'Transaction envelope or receipt is outside the fixed effective-gas-price replay profile.';
        continue;
      }
      // Matches the frozen historical adapter's unsigned reconstruction. Type-1/2
      // fee-cap substitution remains explicitly incomplete, not exact signed replay.
      const call = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, gasPrice: tx.gasPrice, nonce: tx.nonce, ...(tx.accessList === undefined ? {} : { accessList: structuredClone(tx.accessList) }) };
      item.envelopeProfile = 'unsigned_original_nonce_effective_gas_price';
      for (const position of [ordinaryIndex, ordinaryIndex + plan.systemPrefixLength]) {
        const params = config => [[{ transactions: [call] }], { blockNumber: { blockHash: plan.blockHash, requireCanonical: true }, transactionIndex: position }, config];
        item.replays.push({ position, trace: await observe(caseClient, 'debug_traceCallMany', params(tracers.call)), diff: await observe(caseClient, 'debug_traceCallMany', params(tracers.diff)) });
      }
      await save();
      console.log(json({ provider, ordinaryIndex, reportedIndex: tx.transactionIndex, completedVariants: item.replays.length }));
    }
    observed.canonicalAfter = await observe(client, 'eth_getBlockByNumber', [plan.blockNumber, false]);
  }
  await budget.waitForIdle();
  capture.completedAt = new Date().toISOString();
  capture.status = budget.exhaustion ? 'budget_exhausted' : 'completed_fixed_matrix';
  await save();
  console.log(json({ status: capture.status, requests: budget.rpcCount, responseBytes: budget.responseBytes, captureSha256: sha(await readFile(output)) }));
} else throw new Error('Choose --validate or --run explicitly.');
