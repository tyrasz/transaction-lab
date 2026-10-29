import assert from 'node:assert/strict';
export const ENDPOINT='https://arb1.arbitrum.io/rpc';
export const TOKEN='0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const MESSENGER='0x28b5a0e9c621a5badaa536219b3a228c8168cf5d';
export const KNOWN='0xe721a0532a7828df67ad519aa25c602da076159a';
export const TOPIC='0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5';
export const LIMITS=Object.freeze({calls:28,candidates:8,windowBlocks:40000,logs:4096,responseBytes:4194304,totalBytes:16777216,requestBytes:16384,requestMs:25000,collectionMs:110000,totalMs:120000});
export const quantity=s=>{assert.equal(typeof s,'string');assert.match(s,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);return BigInt(s);};
export const hex=n=>'0x'+BigInt(n).toString(16);
export const balanceCall=a=>({to:TOKEN,data:'0x70a08231'+a.slice(2).padStart(64,'0')});
export const allowanceCall=a=>({to:TOKEN,data:'0xdd62ed3e'+a.slice(2).padStart(64,'0')+MESSENGER.slice(2).padStart(64,'0')});
export function blockWindow(header){const to=quantity(header.number);assert.match(header.hash,/^0x[0-9a-f]{64}$/);return{fromBlock:hex(to>=39999n?to-39999n:0n),toBlock:header.number};}
export function logFilter(header){return{address:MESSENGER,...blockWindow(header),topics:[TOPIC,'0x'+TOKEN.slice(2).padStart(64,'0')]};}
export function candidatesFromLogs(logs,header){
  assert(Array.isArray(logs)&&logs.length<=LIMITS.logs);const range=blockWindow(header),identities=new Set(),positions=new Set(),blocks=new Map();
  const decoded=logs.map(log=>{
    assert.equal(log.address?.toLowerCase(),MESSENGER);assert.equal(log.removed,false);assert(Array.isArray(log.topics)&&log.topics.length===4);
    const topics=log.topics.map(x=>{assert.match(x,/^0x[0-9a-fA-F]{64}$/);return x.toLowerCase();});
    assert.equal(topics[0],TOPIC);assert.equal(topics[1],'0x'+TOKEN.slice(2).padStart(64,'0'));
    assert.match(topics[2],/^0x0{24}[0-9a-f]{40}$/);assert.match(topics[3],/^0x0{56}[0-9a-f]{8}$/);
    const address='0x'+topics[2].slice(26);assert.notEqual(address,'0x'+'0'.repeat(40));
    const block=quantity(log.blockNumber),transactionIndex=quantity(log.transactionIndex),logIndex=quantity(log.logIndex);
    assert(block>=quantity(range.fromBlock)&&block<=quantity(range.toBlock));assert.match(log.blockHash,/^0x[0-9a-f]{64}$/);assert.match(log.transactionHash,/^0x[0-9a-f]{64}$/);
    if(blocks.has(log.blockNumber))assert.equal(blocks.get(log.blockNumber),log.blockHash);else blocks.set(log.blockNumber,log.blockHash);
    const key=log.transactionHash+':'+log.logIndex,position=log.blockNumber+':'+log.logIndex;assert(!identities.has(key)&&!positions.has(position));identities.add(key);positions.add(position);
    assert.match(log.data,/^0x(?:[0-9a-fA-F]{2})*$/);const data=log.data.slice(2).toLowerCase();assert(data.length>=512);const word=i=>data.slice(i*64,(i+1)*64);
    assert.match(word(2),/^0{56}[0-9a-f]{8}$/);assert.equal(BigInt('0x'+word(6)),224n);const length=BigInt('0x'+word(7));assert(length<=4096n);
    const padded=Number((length+31n)/32n)*64;assert.equal(data.length,512+padded);assert(/^0*$/.test(data.slice(512+Number(length)*2)));
    return{address,blockNumber:log.blockNumber,transactionIndex:log.transactionIndex,logIndex:log.logIndex,transactionHash:log.transactionHash,blockHash:log.blockHash,block,tx:transactionIndex,index:logIndex};
  }).sort((a,b)=>a.block!==b.block?a.block>b.block?-1:1:a.tx!==b.tx?a.tx>b.tx?-1:1:a.index>b.index?-1:1);
  const selected=[],seen=new Set();for(const row of decoded){if(seen.has(row.address))continue;seen.add(row.address);const{block,tx,index,...origin}=row;selected.push({address:row.address,origin:{kind:'provider_reported_deposit_log',...origin}});}
  if(!seen.has(KNOWN))selected.push({address:KNOWN,origin:{kind:'preserved_public_scenario',scenarioSha256:'5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa'}});
  return{logCount:logs.length,uniqueLogDepositors:seen.size,candidates:selected.slice(0,LIMITS.candidates),order:'descending_block_transaction_log_then_preserved_sender',notProbedCandidates:Math.max(0,selected.length-LIMITS.candidates)};
}
export function assessCandidate(row){
  try{for(const key of ['balance','allowance','code'])assert.equal(row[key].status,'observed');
    for(const key of ['balance','allowance'])assert.match(row[key].value,/^0x[0-9a-fA-F]{64}$/);assert.match(row.code.value,/^0x(?:[0-9a-fA-F]{2})*$/);
    const balance=BigInt(row.balance.value),allowance=BigInt(row.allowance.value);return{status:balance>=100000000n&&allowance>=100000000n?'eligible':'ineligible',balanceRaw:balance.toString(),allowanceRaw:allowance.toString(),code:row.code.value};
  }catch{return{status:'unavailable',balanceRaw:null,allowanceRaw:null,code:null};}
}
