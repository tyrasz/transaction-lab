// Header control for free-call versus priced-call semantics. No broadcasts.
import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('.', import.meta.url);
const e = JSON.parse(await readFile(new URL('../lending-discovery/withdraw-evidence.json', base)));
const tx = e.captures.transaction.response.result, block = e.captures.block.response.result;
const probeAddress = '0x000000000000000000000000000000000000ba1a';
const code = '0x43600052426020524560405248606052446080524160a0524660c0527f' + (BigInt(block.number)-1n).toString(16).padStart(64,'0') + '4060e0526101006000f3';
const context = {blockNumber:{blockHash:block.hash,requireCanonical:true},transactionIndex:4};
const report = { retrievedAt:new Date().toISOString(), fields:['number','timestamp','gasLimit','baseFee','prevRandao','coinbase','chainId','parentHash'], expected:[block.number,block.timestamp,block.gasLimit,block.baseFeePerGas,block.mixHash,block.miner,'0x3e7',block.parentHash], captures:[] };
for(const endpoint of ['https://hyperliquid.drpc.org','https://rpc.hyperlend.finance/archive']){
  const request={jsonrpc:'2.0',id:1,method:'debug_traceCallMany',params:[[{transactions:[{from:tx.from,to:probeAddress,data:'0x',gasPrice:tx.gasPrice}]}],context,{tracer:'callTracer',stateOverrides:{[probeAddress]:{code}}}]};
  let response;
  try { const http=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(20000)});response=await http.json(); }catch{response={localError:'Public read-only RPC request failed.'};}
  const output=response.result?.[0]?.[0]?.output;
  const values=output?.length===514?Array.from({length:8},(_,i)=>'0x'+output.slice(2+i*64,66+i*64)):null;
  const matches=values?.map((value,i)=>BigInt(value)===BigInt(report.expected[i]));
  report.captures.push({endpoint,request,response,values,matches});console.log(JSON.stringify({endpoint,values,matches}));
}
await writeFile(new URL('priced-header-validation.json',base),JSON.stringify(report,null,2)+'\n');
