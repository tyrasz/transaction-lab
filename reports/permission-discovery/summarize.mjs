import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('.',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const write=(f,j)=>fs.writeFileSync(dir+f,JSON.stringify(j,null,2)+'\n');
const max=((1n<<256n)-1n).toString();
const approval='0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const tokens=new Set(['0xb88339cb7199b77e23db6e890353e22632ba630f','0x744e4f26ee30213989216e1632d9be3547c4885b']);
const addr=w=>'0x'+w.slice(-40).toLowerCase();
const dec=v=>BigInt(v).toString();
const files=['approve-usdc-hyperlend','permit-husdc-direct','router-permit-candidate'];
const summaries=[];
for(const name of files){
 const raw=fs.readFileSync(dir+name+'-verified.json'),j=JSON.parse(raw),c=j.captures;
 const tx=c.transaction.response.result,receipt=c.receipt.response.result,block=c.block.response.result,trace=c.callTrace.response.result,diff=c.prestateDiff.response.result;
 const calls=[],delegates=[];
 const walk=(frame,path='0')=>{
  const selector=frame.input?.slice(0,10),words=frame.input?.slice(10).match(/.{64}/g)??[];
  if(frame.type==='CALL'&&tokens.has(frame.to)&&['0xd505accf','0x095ea7b3','0x23b872dd'].includes(selector)){
   const base={path,token:frame.to,selector,immediateCaller:frame.from,successful:!frame.error&&!frame.revertReason};
   if(selector==='0xd505accf')calls.push({...base,operation:'permit',owner:addr(words[0]),spender:addr(words[1]),valueRaw:dec('0x'+words[2]),deadlineRaw:dec('0x'+words[3]),submitter:tx.from,submitterDiffersFromOwner:tx.from!==addr(words[0]),signature:'Retained only in original public transaction/trace evidence; omitted here.'});
   if(selector==='0x095ea7b3')calls.push({...base,operation:'approve',owner:frame.from,spender:addr(words[0]),valueRaw:dec('0x'+words[1])});
   if(selector==='0x23b872dd')calls.push({...base,operation:'transferFrom',owner:addr(words[0]),recipient:addr(words[1]),spender:frame.from,valueRaw:dec('0x'+words[2])});
  }
  if(frame.type==='DELEGATECALL'&&tokens.has(frame.from))delegates.push({path,token:frame.from,implementation:frame.to,selector,successful:!frame.error&&!frame.revertReason});
  (frame.calls??[]).forEach((child,i)=>walk(child,path+'.'+i));
 };
 walk(trace);
 const events=receipt.logs.filter(log=>tokens.has(log.address)&&[approval,transfer].includes(log.topics[0])).map(log=>({event:log.topics[0]===approval?'Approval':'Transfer',token:log.address,logIndex:dec(log.logIndex),...(log.topics[0]===approval?{owner:addr(log.topics[1]),spender:addr(log.topics[2])}:{from:addr(log.topics[1]),to:addr(log.topics[2])}),valueRaw:dec(log.data)}));
 const pre=diff.pre??{},post=diff.post??{},created=Object.keys(post).filter(a=>!(a in pre)),removed=Object.keys(pre).filter(a=>!(a in post));
 const codeChanges=[...new Set([...Object.keys(pre),...Object.keys(post)])].filter(a=>post[a]?.code!==undefined&&post[a].code!==(pre[a]?.code??'0x'));
 const summary={kind:'decoded_observed_public_transaction',rawArtifact:name+'-verified.json',rawSha256:hash(raw),explorerUrl:j.explorerUrl,transactionHash:tx.hash,chainId:999,block:{hash:tx.blockHash,number:dec(tx.blockNumber),transactionIndex:dec(tx.transactionIndex),timestamp:dec(block.timestamp)},execution:{status:receipt.status==='0x1'?'success':'reverted',gasUsed:dec(receipt.gasUsed),submitter:tx.from,rootTo:tx.to,rootSelector:tx.input.slice(0,10),valueRaw:dec(tx.value)},checks:j.checks,calls,delegates,events,prestateDiff:{accountCount:new Set([...Object.keys(pre),...Object.keys(post)]).size,createdAccounts:created,removedAccounts:removed,codeChanges},limits:['Public successful execution verifies contract acceptance at the original position; independent off-chain signature/domain/nonce recovery and signing intent were not assessed.','An Approval event is intermediate evidence, not a final allowance measurement.','These observations do not classify spender reputation or transaction-wide safety.']};
 if(name==='router-permit-candidate')summary.sourceDerivedFinalAllowanceExpectations=[{owner:tx.from,spender:tx.to,afterRaw:(BigInt(max)-25000000n).toString(),basis:'Successful permit(max) then transferFrom(25000000); verified Circle transferFrom always subtracts allowance.'},{owner:tx.to,spender:'0x04de1ef694923844bae419d4f832196f21767f86',afterRaw:'0',basis:'Successful approve(24812500) then transferFrom(24812500).'}];
 write(name+'-decoded.json',summary);summaries.push(summary);
}
const sourceManifest=JSON.parse(fs.readFileSync(dir+'sources/manifest.json'));
const addresses={usdc:'0x003f73f58ca78880da3642c5cb71d7459b3fe4f8',husdc:'0x410aa1ab680b886c875e99a7a4bfaf188508a7a3'};
for(const token of Object.keys(addresses)){
 const input=JSON.parse(fs.readFileSync(dir+`sources/${token}-standard-input.json`));
 for(const [originalPath,content] of Object.entries(input.sources)){
  const savedFile=token+'-'+originalPath.split('/').at(-1);
  if(fs.existsSync(dir+'sources/'+savedFile)&&!sourceManifest.sources.some(x=>x.savedFile===savedFile))sourceManifest.sources.push({token,originalPath,savedFile,sha256:hash(fs.readFileSync(dir+'sources/'+savedFile))});
 }
}
sourceManifest.provenance={method:'Explorer verified implementation source and ABI were downloaded, source JSON extracted without execution, and observed DELEGATECALL targets matched the implementation addresses.',limits:'Explorer verification is relied upon; compiler reproduction and independent runtime bytecode equivalence were not performed.'};
for(const entry of sourceManifest.sources){entry.implementation=addresses[entry.token];entry.sourceUrl=`https://hyperevmscan.io/address/${entry.implementation}#code`;}
sourceManifest.artifacts=[];
for(const token of Object.keys(addresses))for(const suffix of ['implementation.html','standard-input.json','abi.json']){const savedFile=`${token}-${suffix}`;sourceManifest.artifacts.push({token,savedFile,sha256:hash(fs.readFileSync(dir+'sources/'+savedFile)),sourceUrl:`https://hyperevmscan.io/address/${addresses[token]}#code`});}
write('sources/manifest.json',sourceManifest);
write('summary.json',{generatedAt:new Date().toISOString(),kind:'public_permission_discovery',observedSuccessfulTransactions:summaries.length,transactions:summaries.map(s=>({transactionHash:s.transactionHash,decodedArtifact:s.rawArtifact.replace('-verified','-decoded'),rawArtifact:s.rawArtifact,rawSha256:s.rawSha256,block:s.block,checks:s.checks})),scope:'Three observed HyperEVM transactions; no signatures requested, transactions signed or transactions broadcast.',searchBounds:{walletPages:1,usdcFilterPages:2,husdcFilterPages:1,rowsPerPage:100,logScans:0,notes:'Explorer method filters were ignored; retained page contents and found one direct Permit row in the bounded hUSDC page. Discovery stopped after verification.'}});
console.log(JSON.stringify({summaries:summaries.map(s=>({file:s.rawArtifact,checks:Object.values(s.checks).every(Boolean),callCount:s.calls.length,eventCount:s.events.length,prestate:s.prestateDiff,permitDeadline:s.calls.find(c=>c.operation==='permit')?.deadlineRaw}))}));
