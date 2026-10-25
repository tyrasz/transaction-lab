// Offline evidence review only. This program makes no network calls.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const directory = new URL('./', import.meta.url);
const require = createRequire(new URL('../../../../../work/dynamic-cctp-app/package.json', import.meta.url));
const { keccak_256 } = require('@noble/hashes/sha3.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const keccak = hex => '0x'+Buffer.from(keccak_256(Buffer.from(hex.replace(/^0x/,''),'hex'))).toString('hex');
const original = JSON.parse(await readFile(new URL('../../../research/security-corpus/sources/lifi-2024-07-16-rpc.json',import.meta.url)));
const tx=original.transaction.response.result, receipt=original.receipt.response.result, block=original.block.response.result;
const token='0xdac17f958d2ee523a2206206994597c13d831ec7', owner='0xabe45ea636df7ac90fb7d8d8c74a081b169f92ef';
const diamond='0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', facet='0xf28a352377663ca134bd27b582b1a9a4dad7e534';
const word=n=>BigInt(n).toString(16).padStart(64,'0'), addressWord=a=>a.slice(2).padStart(64,'0');
const checks=[];
function check(name, predicate) { assert.ok(predicate,name); checks.push({name,status:'pass'}); }
async function artifact(name) {const data=JSON.parse(await readFile(new URL(name+'.json',directory))); check(name+': valid response identity',data.response?.jsonrpc==='2.0'&&data.response.id===data.request.id&&!data.response.error&&Object.hasOwn(data.response,'result'));return data;}
async function result(name) {return (await artifact(name)).response.result;}
function frameCount(frame){return 1+(frame.calls||[]).reduce((s,f)=>s+frameCount(f),0);}
function flatten(frame,path='0'){return [{...frame,path},...(frame.calls||[]).flatMap((f,i)=>flatten(f,path+'.'+i))];}
function logs(frame){return [...(frame.logs||[]),...(frame.calls||[]).flatMap(logs)];}
function eventContent(items){return items.map(x=>JSON.stringify({address:x.address.toLowerCase(),topics:x.topics.map(x=>x.toLowerCase()),data:x.data.toLowerCase()})).sort();}
function decimal(raw,decimals=6){const n=BigInt(raw),sign=n<0n?'-':'',s=(n<0n?-n:n).toString().padStart(decimals+1,'0');return sign+s.slice(0,-decimals)+'.'+s.slice(-decimals);}
check('both providers report Ethereum mainnet',(await result('publicnode-chain'))==='0x1'&&(await result('drpc-chain'))==='0x1');
const trace=await result('drpc-call-trace'), replay=(await result('drpc-original-position-replay'))[0][0];
check('original-position replay equals historical full call trace',JSON.stringify(trace)===JSON.stringify(replay));
check('trace root matches transaction and receipt',trace.from===tx.from&&trace.to===tx.to&&trace.input===tx.input&&trace.value===tx.value&&trace.gasUsed===receipt.gasUsed&&!trace.error&&receipt.status==='0x1');
check('all historical trace event contents match receipt',JSON.stringify(eventContent(logs(trace)))===JSON.stringify(eventContent(receipt.logs)));
const canonical=await result('drpc-canonical-block'), rechecked=await result('drpc-receipt-rechecked');
check('canonical original block and zero-based index match',canonical.hash===block.hash&&canonical.number===block.number&&canonical.timestamp===block.timestamp&&canonical.transactions[168]===tx.hash);
check('receipt identity remains unchanged',rechecked.transactionHash===tx.hash&&rechecked.blockHash===block.hash&&rechecked.transactionIndex==='0xa8'&&rechecked.gasUsed===receipt.gasUsed&&JSON.stringify(eventContent(rechecked.logs))===JSON.stringify(eventContent(receipt.logs)));
const full=await result('drpc-prestate-full'), diff=await result('drpc-prestate-diff');
const frames=flatten(trace);
check('observed diamond delegate targets reported facet',frames.some(f=>f.type==='DELEGATECALL'&&f.from===diamond&&f.to===facet&&f.input.startsWith('0x3d86ea87')));
const transfer=frames.find(f=>f.from===diamond&&f.to===token&&f.input.startsWith('0x23b872dd'));
check('transferFrom executes in the diamond spending context',transfer?.type==='CALL'&&transfer.input==='0x23b872dd'+addressWord(owner)+addressWord(tx.from)+word(2276295880553n)&&!transfer.error);
const historical={}, queryWrapperEffects=[];
for(const position of [168,169]) {
  const witness=(await result('drpc-header-witness-'+position))[0][0];
  const expected='0x'+[block.number,block.timestamp,block.gasLimit,block.baseFeePerGas,block.mixHash,block.miner,'0x1',block.parentHash].map(word).join('');
  check('original execution header at position '+position,witness.output===expected&&!witness.error);
  historical[position]={};
  for(const name of ['owner-balance','recipient-balance','owner-allowance']) {
    const captured=await artifact('drpc-'+name+'-'+position), query=captured.request.params[0][0].transactions[0], frame=captured.response.result[0][0];
    check(name+': pinned request at '+position,captured.request.params[1].blockNumber.blockHash===block.hash&&captured.request.params[1].blockNumber.requireCanonical===true&&captured.request.params[1].transactionIndex===position);
    check(name+': direct successful token read at '+position,frame.type==='CALL'&&frame.from===tx.from&&frame.to===token&&frame.input===query.data&&!frame.error&&!frame.revertReason&&!(frame.calls||[]).length&&!(frame.logs||[]).length&&/^0x[0-9a-f]{64}$/.test(frame.output));
    historical[position][name]=BigInt(frame.output).toString();
    const queryDiff=(await result('drpc-'+name+'-'+position+'-diff'))[0][0];
    const accounts=new Set([...Object.keys(queryDiff.pre),...Object.keys(queryDiff.post)]);
    check(name+': query nonce and native prestate agree at '+position,queryDiff.post[tx.from].nonce===position-159&&queryDiff.pre[tx.from].nonce===position-160&&queryDiff.pre[tx.from].balance===(position===168?diff.pre[tx.from].balance:diff.post[tx.from].balance));
    check(name+': no query token storage/code effects at '+position,[...accounts].every(a=>[tx.from,block.miner].includes(a))&&[...Object.values(queryDiff.pre),...Object.values(queryDiff.post)].every(account=>Object.keys(account).every(k=>['balance','nonce'].includes(k))));
    let wrapper;
    if(queryDiff.post[tx.from].balance===undefined) {
      check(name+': nonce-only wrapper has no other accounts at '+position,accounts.size===1&&Object.keys(queryDiff.post[tx.from]).length===1);
      wrapper='nonce_only_no_native_fee';
    } else {
      const gas=BigInt(frame.gasUsed),price=BigInt(tx.gasPrice),tip=gas*(price-BigInt(block.baseFeePerGas));
      check(name+': charged native fee and tip exactly reconcile at '+position,BigInt(queryDiff.pre[tx.from].balance)-BigInt(queryDiff.post[tx.from].balance)===gas*price&&BigInt(queryDiff.post[block.miner].balance)-BigInt(queryDiff.pre[block.miner].balance)===tip&&queryDiff.post[block.miner].nonce===undefined);
      wrapper='original_effective_fee_and_tip';
    }
    queryWrapperEffects.push({query:name,position,wrapper});
  }
}
const ownerDelta=BigInt(historical[169]['owner-balance'])-BigInt(historical[168]['owner-balance']);
const recipientDelta=BigInt(historical[169]['recipient-balance'])-BigInt(historical[168]['recipient-balance']);
check('exact owner loss and recipient gain independently reconcile',ownerDelta===-2276295880553n&&recipientDelta===2276295880553n);
check('maximum allowance is unchanged',historical[168]['owner-allowance']===((1n<<256n)-1n).toString()&&historical[168]['owner-allowance']===historical[169]['owner-allowance']);
const slots={ownerBalance:keccak(addressWord(owner)+word(2)),recipientBalance:keccak(addressWord(tx.from)+word(2)),ownerAllowance:keccak(addressWord(diamond)+keccak(addressWord(owner)+word(5)).slice(2))};
check('balance mapping slot prestate and clearing independently corroborate loss',BigInt(full[token].storage[slots.ownerBalance]).toString()===historical[168]['owner-balance']&&BigInt(diff.pre[token].storage[slots.ownerBalance]).toString()===historical[168]['owner-balance']&&!Object.hasOwn(diff.post[token].storage,slots.ownerBalance));
check('recipient storage change independently corroborates gain',BigInt(diff.pre[token].storage[slots.recipientBalance]).toString()===historical[168]['recipient-balance']&&BigInt(diff.post[token].storage[slots.recipientBalance]).toString()===historical[169]['recipient-balance']);
check('maximum allowance slot is read and not changed',BigInt(full[token].storage[slots.ownerAllowance]).toString()===historical[168]['owner-allowance']&&!Object.hasOwn(diff.pre[token].storage,slots.ownerAllowance)&&!Object.hasOwn(diff.post[token].storage,slots.ownerAllowance));
const decimals=(await result('drpc-usdt-decimals-168'))[0][0], symbol=(await result('drpc-usdt-symbol-168'))[0][0], deprecated=(await result('drpc-usdt-deprecated-168'))[0][0];
check('token metadata at original position',BigInt(decimals.output)===6n&&symbol.output==='0x'+word(32)+word(4)+Buffer.from('USDT').toString('hex').padEnd(64,'0')&&BigInt(deprecated.output)===0n);
const bytecodes=Object.entries(full).filter(([,account])=>account.code).map(([address,account])=>({address,basis:'original_transaction_prestateTracer',byteLength:(account.code.length-2)/2,sha256:hash(Buffer.from(account.code.slice(2),'hex')),keccak256:keccak(account.code),code:account.code}));
for(const f of frames.filter(f=>f.type==='CREATE')) bytecodes.push({address:f.to,basis:'original_CREATE_frame_output',framePath:f.path,byteLength:(f.output.length-2)/2,sha256:hash(Buffer.from(f.output.slice(2),'hex')),keccak256:keccak(f.output),code:f.output});
const artifacts=[];
for(const filename of (await readdir(directory)).filter(x=>/^(drpc|publicnode)-.*\.json$/.test(x)).sort()){const data=await readFile(new URL(filename,directory));const doc=JSON.parse(data);artifacts.push({filename,sha256:hash(data),bytes:data.byteLength,capturedAt:doc.capturedAt,method:doc.request.method,provider:new URL(doc.endpoint).hostname,rpcError:doc.response?.error?.code??null});}
const validation={schemaVersion:'1.0',status:'single_reviewer_evidence_verified_not_admitted',candidateId:'lifi-2024-07-16',reviewer:'codex-agent-build_preview_ui',checks,observed:{chainId:1,transactionHash:tx.hash,blockHash:block.hash,blockNumber:BigInt(block.number).toString(),transactionIndex:168,postTransactionIndex:169,timestamp:new Date(Number(BigInt(block.timestamp))*1000).toISOString(),gasUsed:BigInt(trace.gasUsed).toString(),frameCount:frameCount(trace),logCount:logs(trace).length,token,tokenDecimals:6,owner,recipient:tx.from,spender:diamond,before:historical[168],after:historical[169],ownerDeltaRaw:ownerDelta.toString(),ownerDelta:decimal(ownerDelta),recipientDeltaRaw:recipientDelta.toString(),recipientDelta:decimal(recipientDelta),allowanceChangeRaw:'0',allowanceKind:'uint256_max',slots,diamondObservedStorage:full[diamond].storage,createFrameCount:frames.filter(f=>f.type==='CREATE').length,selfdestructFrameCount:frames.filter(f=>f.type==='SELFDESTRUCT').length,queryWrapperEffects},artifacts,scope:{archiveTraceProvidersVerified:1,chainIdentityProvidersVerified:2,cryptographicStateProof:false,originalVictimSigningRequest:false,sourceToBytecodeRecompilation:false,independentAdmissionReviewsCompleted:0,blindEvaluation:false},limitations:['Trace, prestate and original-position queries share one archive provider; they are independent RPC methods, not independent providers.','The USDT mapping layout was derived from published Tether source and corroborated by balance/allowance calls and captured storage. No compiler-to-runtime source verification was performed.','Read-call diffs contain two observed native wrapper behaviors: nonce-only and normal effective-fee/tip charging. Both were checked explicitly and neither changes token storage; consistent native-fee simulation is not established.','The original attacker-submitted transaction is not the victim signing prompt. Maliciousness attribution is held outside feature inputs.','No engine security verdict or benchmark score is produced.']};
const feature={schemaVersion:'1.0',task:'historical_execution_reproduction',chainId:1,transaction:{from:tx.from,to:tx.to,data:tx.input,value:tx.value,gas:tx.gas,nonce:tx.nonce,type:tx.type,gasPrice:tx.gasPrice,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas,accessList:tx.accessList},context:{blockHash:block.hash,blockNumber:block.number,transactionIndex:168,timestamp:block.timestamp}};
const oracle={schemaVersion:'1.0',use:'development_effects_only_not_security_scoring',transactionHash:tx.hash,execution:{status:'success',gasUsed:BigInt(trace.gasUsed).toString()},balanceChanges:[{token,account:owner,beforeRaw:historical[168]['owner-balance'],afterRaw:historical[169]['owner-balance'],deltaRaw:ownerDelta.toString()},{token,account:tx.from,beforeRaw:historical[168]['recipient-balance'],afterRaw:historical[169]['recipient-balance'],deltaRaw:recipientDelta.toString()}],allowances:[{token,owner,spender:diamond,beforeRaw:historical[168]['owner-allowance'],afterRaw:historical[169]['owner-allowance'],changed:false,kind:'uint256_max'}],semanticRequirements:['Keep submitting and affected accounts separate.','Do not infer a new owner approval or numerical allowance consumption from the transfer.','Do not assign ERC20 semantics to the unverified token-like contract 0xf929ba2aeec16cffcfc66858a9434e194baaf80d solely from selectors.','Retain intermediate CREATE and SELFDESTRUCT behavior even if final account diffs omit the temporary contracts.'],labelInputPolicy:'This oracle is retrospective development ground truth. Do not pass it, source reports, incident labels, or file paths into detector inputs.'};
if(!process.argv.includes('--check'))for(const[name,value]of Object.entries({'validation.json':validation,'bytecode-identities.json':{schemaVersion:'1.0',source:'drpc-prestate-full.json and drpc-call-trace.json',bytecodes},'feature-input.json':feature,'effects-oracle.json':oracle}))await writeFile(new URL(name,directory),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({checksPassed:checks.length,ownerDelta:decimal(ownerDelta),recipientDelta:decimal(recipientDelta),allowanceUnchanged:true,bytecodeRecords:bytecodes.length,rpcArtifacts:artifacts.length}));
