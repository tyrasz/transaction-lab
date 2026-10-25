// Bounded, read-only historical evidence collection. No signing or broadcasting.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('./', import.meta.url);
const original = JSON.parse(await readFile(new URL('../../../research/security-corpus/sources/lifi-2024-07-16-rpc.json', import.meta.url)));
export const tx = original.transaction.response.result;
export const receipt = original.receipt.response.result;
export const block = original.block.response.result;
export const endpoints = { publicnode: 'https://ethereum-rpc.publicnode.com', drpc: 'https://eth.drpc.org' };
const allowed = new Set(['eth_chainId','debug_traceTransaction','debug_traceCallMany','eth_getCode','eth_call','eth_getBlockByHash','eth_getBlockByNumber','eth_getTransactionReceipt']);
let count = 0;
export async function capture(label, method, params, provider = 'publicnode') {
  if (!/^[a-z0-9-]+$/.test(label) || !allowed.has(method) || !endpoints[provider] || ++count > 40) throw new Error('Capture outside configured read-only bounds');
  const file = new URL(`${provider}-${label}.json`, directory);
  try { return JSON.parse(await readFile(file)); } catch (error) { if(error.code !== 'ENOENT') throw error; }
  const request = { jsonrpc:'2.0', id:count, method, params };
  const artifact = { schemaVersion:'1.0', candidateId:'lifi-2024-07-16', capturedAt:new Date().toISOString(), endpoint:endpoints[provider], request };
  try {
    const response = await fetch(endpoints[provider], {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(45000)});
    artifact.httpStatus = response.status;
    const chunks=[]; let size=0;
    for await (const chunk of response.body) { size += chunk.byteLength; if(size>16*1024*1024) throw new Error('Response exceeds 16 MiB'); chunks.push(Buffer.from(chunk)); }
    const data=Buffer.concat(chunks);
    artifact.responseBodySha256=createHash('sha256').update(data).digest('hex');
    try {artifact.response=JSON.parse(data.toString());} catch {artifact.failure={code:'INVALID_JSON',message:'Provider did not return JSON.'};}
  } catch(error) {artifact.failure={code:error.name==='TimeoutError'?'TIMEOUT':'READ_FAILED',message:'Public historical RPC read failed.'};}
  await mkdir(directory,{recursive:true});
  await writeFile(file,JSON.stringify(artifact,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({label,provider,method,ok:Object.hasOwn(artifact.response||{},'result'),rpcError:artifact.response?.error?.code??null,failure:artifact.failure?.code??null}));
  return artifact;
}
if(process.argv[2]==='initial') {
  await capture('chain','eth_chainId',[]);
  await Promise.all([
    capture('call-trace','debug_traceTransaction',[tx.hash,{tracer:'callTracer',timeout:'20s',tracerConfig:{withLog:true}}]),
    capture('prestate-diff','debug_traceTransaction',[tx.hash,{tracer:'prestateTracer',timeout:'20s',tracerConfig:{diffMode:true}}]),
  ]);
  await capture('prestate-full','debug_traceTransaction',[tx.hash,{tracer:'prestateTracer',timeout:'20s'}]);
}
if(process.argv[2]==='alternate') {
  const chain=await capture('chain','eth_chainId',[],'drpc');
  if(chain.response?.result==='0x1') {
    const traced=await capture('call-trace','debug_traceTransaction',[tx.hash,{tracer:'callTracer',timeout:'20s',tracerConfig:{withLog:true}}],'drpc');
    if(traced.response?.result) await Promise.all([
      capture('prestate-diff','debug_traceTransaction',[tx.hash,{tracer:'prestateTracer',timeout:'20s',tracerConfig:{diffMode:true}}],'drpc'),
      capture('prestate-full','debug_traceTransaction',[tx.hash,{tracer:'prestateTracer',timeout:'20s'}],'drpc'),
    ]);
  }
}
if(process.argv[2]==='positions') {
  const at=(index,call,options={})=>[[{transactions:[call]}],{blockNumber:{blockHash:block.hash,requireCanonical:true},transactionIndex:index},{tracer:'callTracer',timeout:'20s',tracerConfig:{withLog:true},...options}];
  const originalCall={from:tx.from,to:tx.to,data:tx.input,value:tx.value,gas:tx.gas,gasPrice:tx.gasPrice,nonce:tx.nonce,accessList:tx.accessList};
  const replay=await capture('original-position-replay','debug_traceCallMany',at(168,originalCall),'drpc');
  if(Array.isArray(replay.response?.result)) {
    const token='0xdac17f958d2ee523a2206206994597c13d831ec7',owner='0xabe45ea636df7ac90fb7d8d8c74a081b169f92ef',spender='0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
    const wordAddress=a=>a.slice(2).padStart(64,'0');
    const queries={owner_balance:'0x70a08231'+wordAddress(owner),recipient_balance:'0x70a08231'+wordAddress(tx.from),owner_allowance:'0xdd62ed3e'+wordAddress(owner)+wordAddress(spender)};
    for(const [name,data] of Object.entries(queries)) for(const position of [168,169]) {
      const label=name.replaceAll('_','-')+'-'+position;
      const call={from:tx.from,to:token,data,value:'0x0',gas:'0x493e0',gasPrice:tx.gasPrice};
      await capture(label,'debug_traceCallMany',at(position,call),'drpc');
      await capture(label+'-diff','debug_traceCallMany',at(position,call,{tracer:'prestateTracer',tracerConfig:{diffMode:true}}),'drpc');
    }
    const probe='0x000000000000000000000000000000000000ba1a';
    const code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(BigInt(block.number)-1n).toString(16).padStart(64,'0')+'4060e0526101006000f3';
    for(const position of [168,169]) await capture('header-witness-'+position,'debug_traceCallMany',at(position,{from:tx.from,to:probe,data:'0x',value:'0x0',gas:'0x493e0',gasPrice:tx.gasPrice},{stateOverrides:{[probe]:{code}}}),'drpc');
    await capture('canonical-block','eth_getBlockByNumber',[block.number,false],'drpc');
    await capture('receipt-rechecked','eth_getTransactionReceipt',[tx.hash],'drpc');
  }
}
if(process.argv[2]==='metadata') {
  for(const [name,data] of [['decimals','0x313ce567'],['symbol','0x95d89b41'],['deprecated','0x0e136b19']]) {
    const call={from:tx.from,to:'0xdac17f958d2ee523a2206206994597c13d831ec7',data,value:'0x0',gas:'0x493e0',gasPrice:tx.gasPrice};
    await capture('usdt-'+name+'-168','debug_traceCallMany',[[{transactions:[call]}],{blockNumber:{blockHash:block.hash,requireCanonical:true},transactionIndex:168},{tracer:'callTracer',timeout:'20s',tracerConfig:{withLog:true}}],'drpc');
  }
}
