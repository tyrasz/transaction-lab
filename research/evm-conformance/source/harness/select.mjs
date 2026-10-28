import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const base=path.dirname(fileURLToPath(import.meta.url));
const digest=x=>createHash('sha256').update(x).digest('hex');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]).sort();
export const limits=Object.freeze({gas:16777216,calldataBytes:32768,preAccounts:128,preStorageSlots:1024,fileBytes:8388608,vectorMs:10000,totalMs:360000});
export function family(p){
 if(p.includes('/ported_static/stCallCodes/call_chain/'))return 'call_context_gas';
 if(['/berlin/eip2929_gas_cost_increases/warm_status_revert/','/berlin/eip2930_access_list/acl/','/istanbul/eip2200_net_gas_metering/','/prague/eip7623_increase_calldata_cost/refunds/','/cancun/eip1153_tstore/'].some(s=>p.includes(s)))return 'storage_warm_cold_refund_rollback';
 if(['/frontier/identity_precompile/','/frontier/precompiles/ecrecover/','/frontier/precompiles/ripemd/','/byzantium/eip198_modexp_precompile/','/istanbul/eip152_blake2/','/osaka/eip7951_p256verify_precompiles/eip_mainnet/'].some(s=>p.includes(s)))return 'non_kzg_precompile';
 return null;
}
export function buildSelection(){
 const idx=JSON.parse(fs.readFileSync(path.join(base,'acquisition/osaka-state-index.json'))), byId=new Map(idx.rows.map(r=>[`${r.json_path}\n${r.id}`,r]));
 const candidates=[],excluded=[];
 for(const filename of walk(path.join(base,'candidates'))){
  const rel=path.relative(path.join(base,'candidates'),filename), group=family('/'+rel);if(!group)continue;
  const raw=fs.readFileSync(filename);if(raw.length>limits.fileBytes)throw Error('Source file exceeds frozen bound');
  const fixtures=JSON.parse(raw);
  for(const id of Object.keys(fixtures).sort()){
   const f=fixtures[id],source=byId.get(`${rel}\n${id}`);if(!source || source.fixture_hash!==f._info.hash)throw Error('Release index identity mismatch');
   for(const [postIndex,post]of f.post.Osaka.entries()){
    const ix=post.indexes,gas=BigInt(f.transaction.gasLimit[ix.gas]),data=f.transaction.data[ix.data];
    const row={family:group,file:'candidates/'+rel,fileSha256:digest(raw),id,postIndex,fork:'Osaka',fixtureHash:f._info.hash,transactionSha256:digest(Buffer.from(post.txbytes.slice(2),'hex'))};
    const reasons=[];if(gas>BigInt(limits.gas))reasons.push('gas');if((data.length-2)/2>limits.calldataBytes)reasons.push('calldata');if(Object.keys(f.pre).length>limits.preAccounts)reasons.push('accounts');if(Object.values(f.pre).reduce((n,a)=>n+Object.keys(a.storage).length,0)>limits.preStorageSlots)reasons.push('storage');
    if(reasons.length)excluded.push({...row,reasons});else candidates.push(row);
   }
  }
 }
 const selected=[];const counts={call_context_gas:12,storage_warm_cold_refund_rollback:12,non_kzg_precompile:8};
 for(const [group,count]of Object.entries(counts)){
  if(group==='storage_warm_cold_refund_rollback'){
   for(const prefix of ['/berlin/eip2929_gas_cost_increases/warm_status_revert/','/istanbul/eip2200_net_gas_metering/','/cancun/eip1153_tstore/','/prague/eip7623_increase_calldata_cost/refunds/']){
    const files=[...new Set(candidates.filter(r=>r.family===group&&r.file.includes(prefix)).map(r=>r.file))].sort();
    const bins=files.map(file=>candidates.filter(r=>r.family===group&&r.file===file).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.postIndex-b.postIndex));
    const chosen=[];for(let round=0;chosen.length<3;round++){let n=0;for(const bin of bins)if(bin[round]&&chosen.length<3){chosen.push(bin[round]);n++;}if(!n)throw Error('Insufficient storage subgroup');}selected.push(...chosen);
   }continue;
  }
  const files=[...new Set(candidates.filter(r=>r.family===group).map(r=>r.file))].sort();
  const bins=files.map(file=>candidates.filter(r=>r.family===group&&r.file===file).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.postIndex-b.postIndex));
  const rows=[];for(let round=0;rows.length<count;round++){
   let added=0;for(const bin of bins)if(bin[round]&&rows.length<count){rows.push(bin[round]);added++;}if(!added)throw Error(`Insufficient ${group} fixtures`);
  }
  selected.push(...rows);
 }
 return {schemaVersion:1,release:'tests@v21.0.2',releaseCommit:'e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e',assetSha256:'e2fa7ea2ea516459f9ab92284b2927892f318f4e1f78ca802cb05a6c3b479ed9',selectionRule:'Within each fixed family, source paths then IDs/post indexes sort lexically/numerically; round-robin by source file, taking one per file per round. Storage has fixed three-each subquotas: reverted warmth, SSTORE, transient, refunds. Structural resource bounds only; no execution outcome inspected.',limits,counts,eligible:candidates.length,excluded,selected:selected.map((r,i)=>({index:i+1,...r}))};
}
if(process.argv[1]===fileURLToPath(import.meta.url))fs.writeFileSync(path.join(base,'selection.json'),JSON.stringify(buildSelection(),null,2)+'\n',{flag:'wx'});
