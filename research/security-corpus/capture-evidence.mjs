// Read-only historical evidence capture. Never signs, simulates, or broadcasts.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const endpoint = 'https://ethereum-rpc.publicnode.com';
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const cases = [
  ['lifi-2024-07-16', '0xd82fe84e63b1aa52e1ce540582ee0895ba4a71ec5e7a632a3faa1aff3e763873'],
  ['socket-2024-01-16', '0xc6c3331fa8c2d30e1ef208424c08c039a89e510df2fb6ae31e5aa40722e28fd6'],
  ['usdc-permit-2026-03-16', '0xfd7417af8433e3d9bcbed3f965307c800a24eb4e98f42cebfab6ca6064f5a642'],
];
const allowed = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByHash']);
let id = 0;
async function rpc(method, params) {
  if (!allowed.has(method)) throw new Error('Read-only method allowlist rejected request');
  const request = { jsonrpc: '2.0', id: ++id, method, params };
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || body.result == null) throw new Error(JSON.stringify(body.error || 'Missing result'));
  return { request, response: body };
}
await mkdir(directory, { recursive: true });
const chain = await rpc('eth_chainId', []);
if (chain.response.result !== '0x1') throw new Error('Unexpected chain');
for (const [name, hash] of cases) {
  const transaction = await rpc('eth_getTransactionByHash', [hash]);
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (transaction.response.result.hash !== hash || receipt.response.result.transactionHash !== hash || transaction.response.result.blockHash !== receipt.response.result.blockHash) throw new Error('Inconsistent transaction evidence');
  const block = await rpc('eth_getBlockByHash', [receipt.response.result.blockHash, false]);
  const capturedAt = new Date().toISOString();
  const record = { schemaVersion: '1.0', candidateId: name, capturedAt, endpoint, chain, transaction, receipt, block, limitations: ['Receipt and transaction evidence only; no execution trace or before/after balances were captured.', 'No original wallet signing prompt or typed-data request is established by this record.'] };
  await writeFile(path.join(directory, `${name}-rpc.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ candidateId: name, capturedAt, chainId: 1, transactionHash: hash, blockNumber: Number(BigInt(receipt.response.result.blockNumber)), timestamp: new Date(Number(BigInt(block.response.result.timestamp)) * 1000).toISOString(), from: transaction.response.result.from, to: transaction.response.result.to, contractAddress: receipt.response.result.contractAddress, status: receipt.response.result.status, logCount: receipt.response.result.logs.length }));
}
