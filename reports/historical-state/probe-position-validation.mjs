// Research only: validate same-block headers and independently query historical position.
import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('.', import.meta.url);
const endpoints = ['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive'];
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const VUSDC = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d';
const report = { retrievedAt: new Date().toISOString(), methodsAreReadOnly: true, captures: [], conclusions: [] };
let nextId = 1, save = Promise.resolve();
async function rpc(endpoint, label, method, params) {
  const request = { jsonrpc: '2.0', id: nextId++, method, params };
  let response, httpStatus;
  try {
    const http = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
    httpStatus = http.status; const text = await http.text();
    response = text.length < 8 * 1024 * 1024 ? JSON.parse(text) : { localError: 'Response exceeded bound.' };
  } catch { response = { localError: 'Public read-only RPC request failed.' }; }
  report.captures.push({ endpoint, label, request, httpStatus, response });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  save = save.then(() => writeFile(new URL('position-validation.json', base), serialized)); await save;
  return response.result;
}
function flattenLogs(trace) { return [...(trace?.logs ?? []), ...(trace?.calls ?? []).flatMap(flattenLogs)].map(({address,topics,data})=>({address,topics,data})); }
function normalizedTrace(trace) {
  if (!trace) return trace;
  // Per-call gas input differs when a query precedes execution; output, gas used,
  // execution shape and all logs remain independent comparison evidence.
  const { gas, ...rest } = trace;
  return { ...rest, ...(trace.calls ? { calls: trace.calls.map(normalizedTrace) } : {}) };
}
await Promise.all(endpoints.map(async endpoint => {
  for (const operation of ['withdraw', 'borrow', 'repay']) {
    const evidence = JSON.parse(await readFile(new URL(`../lending-discovery/${operation}-evidence.json`, base)));
    const tx = evidence.captures.transaction.response.result, block = evidence.captures.block.response.result;
    const index = Number(BigInt(tx.transactionIndex)), pinned = { blockHash: block.hash, requireCanonical: true };
    const owner = operation === 'withdraw' ? tx.from : '0x' + tx.input.slice(operation === 'borrow' ? 10 + 4 * 64 + 24 : 10 + 3 * 64 + 24, operation === 'borrow' ? 10 + 5 * 64 : 10 + 4 * 64);
    const balance = (to, account) => ({ from: tx.from, to, data: '0x70a08231' + account.slice(2).padStart(64, '0') });
    const queries = [balance(USDC, tx.from), balance(operation === 'withdraw' ? HUSDC : VUSDC, owner)];
    const original = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, gasPrice: tx.gasPrice };
    const opts = { tracer: 'callTracer', tracerConfig: { withLog: true } };
    const before = await rpc(endpoint, `${operation}-before-position`, 'debug_traceCallMany', [[{transactions:queries}], { blockNumber:pinned, transactionIndex:index }, opts]);
    const after = await rpc(endpoint, `${operation}-after-position`, 'debug_traceCallMany', [[{transactions:queries}], { blockNumber:pinned, transactionIndex:index+1 }, opts]);
    const replay = await rpc(endpoint, `${operation}-original-position`, 'debug_traceCallMany', [[{transactions:[original]}], { blockNumber:pinned, transactionIndex:index }, opts]);
    const actual = evidence.captures.historicalTrace.response.result;
    const replayTrace = replay?.[0]?.[0];
    const measurement = { endpoint, operation, transactionHash: tx.hash, blockHash: block.hash, transactionIndex:index,
      beforeRaw: before?.[0]?.map(x=>x.output ? BigInt(x.output).toString() : null),
      afterRaw: after?.[0]?.map(x=>x.output ? BigInt(x.output).toString() : null),
      deltaRaw: before?.[0]?.map((x,i)=>x.output && after?.[0]?.[i]?.output ? (BigInt(after[0][i].output)-BigInt(x.output)).toString():null),
      originalGasUsed: actual.gasUsed, replayGasUsed: replayTrace?.gasUsed,
      outputMatches: actual.output===replayTrace?.output,
      logsMatch: JSON.stringify(flattenLogs(actual))===JSON.stringify(flattenLogs(replayTrace)),
      traceMatchesExceptGasInput: JSON.stringify(normalizedTrace(actual))===JSON.stringify(normalizedTrace(replayTrace)),
    };
    report.conclusions.push(measurement); console.log(JSON.stringify(measurement));
    if (operation === 'withdraw') {
      const probeAddress = '0x000000000000000000000000000000000000ba1a';
      // Return NUMBER,TIMESTAMP,GASLIMIT,BASEFEE,PREVRANDAO,COINBASE,CHAINID,BLOCKHASH(N-1).
      const code = '0x43600052426020524560405248606052446080524160a0524660c0527f' + (BigInt(block.number)-1n).toString(16).padStart(64,'0') + '4060e0526101006000f3';
      const header = await rpc(endpoint, 'withdraw-header-witness', 'debug_traceCallMany', [[{transactions:[{from:tx.from,to:probeAddress,data:'0x'}]}], {blockNumber:pinned,transactionIndex:index}, {tracer:'callTracer',stateOverrides:{[probeAddress]:{code}}}]);
      const output = header?.[0]?.[0]?.output;
      const values = output?.length===514 ? Array.from({length:8},(_,i)=>'0x'+output.slice(2+i*64,66+i*64)) : null;
      report.conclusions.push({endpoint,operation:'header_witness',fields:['number','timestamp','gasLimit','baseFee','prevRandao','coinbase','chainId','parentHash'],values,
        expected:[block.number,block.timestamp,block.gasLimit,block.baseFeePerGas,block.mixHash,block.miner,'0x3e7',block.parentHash],
        note:'Probe bytecode exists only in read-only state overrides; it is not deployed.'});
    }
    const canonical = await rpc(endpoint, `${operation}-canonical-after`, 'eth_getBlockByNumber', [block.number,false]);
    measurement.canonicalHashMatches = canonical?.hash===block.hash;
    measurement.transactionIndexMatches = canonical?.transactions?.[index]===tx.hash;
  }
}));
await save;
await writeFile(new URL('position-validation.json',base),JSON.stringify(report,null,2)+'\n');
