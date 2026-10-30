// Product execution only. Initial declarations are unchanged from v033; no
// reference output or expected poststate is read by this process or its child.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { declaration, fixture, PRODUCT_LIMITS } from '../amsterdam-storage-creation-v033/cases.mjs';
import { normalizeAllocation } from '../amsterdam-storage-creation-v033/observations.mjs';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';

const bytes = fs.readFileSync(process.argv[2]), input = JSON.parse(bytes);
const report = { id: input.id, workerPid: process.pid, inputSha256: createHash('sha256').update(bytes).digest('hex'),
  scope: 'isolated_unsigned_priced_product_call_from_unchanged_initial_declaration',
  expectedPoststateConsumed: false, otherClientOutputsConsumed: false,
  attempt: null, processClosureValid: false, proofRecords: [], error: null };
try {
  assert.deepEqual(input, JSON.parse(JSON.stringify(await declaration(input.index))));
  const f = await fixture(input.index);
  assert.deepEqual(f.request, input.request); assert.deepEqual(f.header, input.header);
  assert.deepEqual(normalizeAllocation(f.allocation), input.allocation);
  const rpc = { async call(method, params, options) {
    const row = { method, params: structuredClone(params) }; report.proofRecords.push(row);
    try { row.result = await f.rpc.call(method, params, options); return structuredClone(row.result); }
    catch (error) { row.error = { name: error.name, message: error.message }; throw error; }
  } };
  report.attempt = await executeIsolatedEthereumCall({ request: input.request, header: input.header,
    chainId: input.chainId, rpc, limits: PRODUCT_LIMITS });
  const a = report.attempt;
  report.processClosureValid = a.broker.pendingAtReturn === 0 &&
    (a.isolation === null ? a.broker.calls === 0 : a.isolation.processClosed === true);
} catch (error) { report.error = { name: error?.name ?? null, message: error?.message ?? String(error) }; }
console.log(JSON.stringify(report));
