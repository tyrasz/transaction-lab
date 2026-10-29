import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Artifact inspection only: no transport, production simulator, EVM or RPC imports.
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../..');
const CAP = path.join(ROOT, 'research/arbitrum-contract-deposit-v1/capture');
const LIB = path.join(ROOT, 'research/arbitrum-viem-deposit-v1');
const PROTOCOL = path.join(ROOT, 'research/arbitrum-deposit-v1');
const SELECTION = path.join(ROOT, 'research/arbitrum-funded-selection-v1/capture');
const pins = {
  capture: '51076d500e9176482cd530780d8077e7de57d1e689f3907122bd9e4061b086ab',
  plan: '125fa912c2763114aa4dc16dd44179435d5685d59514ec035980482af81628ce',
  library: '90888b21c1fc0cd5a13761781fe1ff7422467039018cabb1a1cebf4069b08f52',
  protocol: '707e8b22dcae36093585994fe807c71b27b73fbda0881573f6483192629b928b',
  selection: 'fc3733e901257af80399bb98a26f34a02ab82694cecb15aae6d2c48d901ef16e',
};
const sha = b => createHash('sha256').update(b).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p));
const hex = n => '0x' + BigInt(n).toString(16);
const safe = p => typeof p === 'string' && !p.startsWith('/') && !p.includes('\\') && path.posix.normalize(p) === p && !p.split('/').some(s => s === '..' || s === '.');
function checkFile(root, row) {
  assert(safe(row.path)); const p = path.join(root, row.path), s = fs.lstatSync(p), b = fs.readFileSync(p);
  assert(s.isFile() && !s.isSymbolicLink()); assert.equal(b.length, row.bytes, row.path); assert.equal(sha(b), row.sha256, row.path);
  if (row.mode !== undefined) assert.equal(s.mode & 0o777, row.mode, row.path);
  return b;
}
function files(root, prefix = '') { return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(root, path.posix.join(prefix, e.name)) : [path.posix.join(prefix, e.name)]).sort(); }
function manifest(root, name, pin) {
  const b = fs.readFileSync(path.join(root, name)); assert.equal(sha(b), pin); const m = JSON.parse(b);
  assert.equal(new Set(m.files.map(f => f.path)).size, m.files.length); for (const f of m.files) checkFile(root, f); return m;
}
const m = manifest(CAP, 'manifest.json', pins.capture);
assert.deepEqual(files(CAP), [...m.files.map(f => f.path), 'manifest.json'].sort());
const planBytes = fs.readFileSync(path.join(CAP, 'PLAN.json')); assert.equal(sha(planBytes), pins.plan);
const plan = JSON.parse(planBytes); assert.equal(m.planSha256, pins.plan); assert.equal(plan.selectionManifestSha256, pins.selection);
for (const [name, key] of [['runner.mjs','runnerSha256'],['input.json','inputSha256'],['runtime-manifest.json','runtimeManifestSha256'],['qualification-header.json','qualificationHeaderSha256']]) assert.equal(sha(fs.readFileSync(path.join(CAP, name))), plan[key]);
const runtime = read(path.join(CAP, 'runtime-manifest.json')), response = read(path.join(CAP,'response.json')), input = read(path.join(CAP,'input.json')), header = read(path.join(CAP,'qualification-header.json'));
const lib = manifest(LIB, 'source-manifest.json', pins.library), protocol = manifest(PROTOCOL, 'manifest.json', pins.protocol);
const selection = manifest(SELECTION, 'manifest.json', pins.selection), selected = read(path.join(SELECTION, 'results.json'));
assert.equal(selected.status, 'selected'); assert(selected.usable && selected.headerConfirmed && selected.sourceUnchanged);
assert.deepEqual(header, selected.selectedHeader); assert.deepEqual(header, read(path.join(SELECTION, 'selected-header.json')));
assert.equal(input.from, selected.selected.address); assert.notEqual(selected.selected.code, '0x'); assert.equal(input.block, header.number);
assert.deepEqual(response.request,{...input,gas:input.gas ?? '2000000'});
assert.equal(read(path.join(CAP,'STARTED.json')).planSha256,pins.plan);
assert.equal(response.source.provider,'https://arb1.arbitrum.io/rpc');assert.equal(response.source.chainId,42161);
const libraryRows = new Map(lib.files.map(f => [f.path, f])), rows = new Map(runtime.files.map(f => [f.path, f]));
let dependencyBytes = 0, dependencyFiles = 0, sourceFiles = 0;
for (const f of runtime.files) {
  if (f.path.startsWith('engines/arbitrum-evm/node_modules/')) {
    const n = f.path.replace('engines/arbitrum-evm/', ''); assert.deepEqual({...libraryRows.get(n), path:f.path}, f); dependencyBytes += checkFile(LIB, {...f,path:n}).length; dependencyFiles++;
  } else { checkFile(path.join(CAP, 'source'), f); sourceFiles++; }
}
assert.equal(dependencyFiles, lib.files.filter(f => f.path.startsWith('node_modules/')).length);
assert.deepEqual(files(path.join(CAP, 'source')), runtime.files.filter(f => !f.path.includes('/node_modules/')).map(f => f.path).sort());
assert.equal(sha(fs.readFileSync(runtime.node.executable)), runtime.node.sha256);
assert.equal(response.implementation.runtime.executableSha256, runtime.node.sha256);
// Reconstruct the loader's exact static closure independently, from retained bytes.
const closure = new Set();
function visit(n) {
  if (closure.has(n)) return; closure.add(n); assert(rows.has(n), 'Unarchived static dependency: ' + n);
  const text = fs.readFileSync(n.startsWith('engines/arbitrum-evm/node_modules/') ? path.join(LIB,n.replace('engines/arbitrum-evm/','')) : path.join(CAP,'source',n),'utf8');
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (match[1].startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(n),match[1])));
    else assert(match[1].startsWith('node:') || n.startsWith('engines/arbitrum-evm/'));
  }
}
for (const n of ['src/server.js','src/arbitrum-loader.js','src/arbitrum-simulation.js',...runtime.files.map(f=>f.path).filter(n=>/^engines\/arbitrum-evm\/[^/]+\.js$/.test(n))]) visit(n);
const loaderNames = new Set([...closure,'package.json','engines/arbitrum-evm/package.json','engines/arbitrum-evm/package-lock.json',...runtime.files.filter(f=>f.path.includes('/node_modules/')).map(f=>f.path)]);
const loaderFiles = [...loaderNames].sort().map(n=>({path:n,kind:'file',bytes:rows.get(n).bytes,mode:rows.get(n).mode,sha256:rows.get(n).sha256}));
assert.equal(loaderFiles.length, response.implementation.sourceFileCount);
assert.equal(sha(JSON.stringify({files:loaderFiles,runtime:response.implementation.runtime})), response.implementation.sourceSha256);
// Only ABI encoding/decoding is imported, after every retained library file was rehashed.
const {decodeFunctionData,encodeFunctionData,decodeEventLog,encodeDeployData} = await import(pathToFileURL(path.join(LIB,'node_modules/viem/_esm/index.js')));
const {deploylessCallViaBytecodeBytecode} = await import(pathToFileURL(path.join(LIB,'node_modules/viem/_esm/constants/contracts.js')));
const abi = name => read(path.join(PROTOCOL,'sources/evm-cctp-contracts/docs/abis/',name));
const messengerAbi = abi('cctp/v2/TokenMessengerV2.json'), transmitterAbi = abi('cctp/v2/MessageTransmitterV2.json'), tokenAbi = abi('Usdc.json');
const parsed = decodeFunctionData({abi:messengerAbi,data:input.data}); assert.equal(parsed.functionName,'depositForBurnWithHook');
assert.equal(encodeFunctionData({abi:messengerAbi,functionName:parsed.functionName,args:parsed.args}).toLowerCase(),input.data);
const [amount,domain,mintRecipient,tokenAddress,destinationCaller,maxFee,finality,hook] = parsed.args;
const token = tokenAddress.toLowerCase(), zero = '0x'+'0'.repeat(40), wordAddress = a => '0x'+a.slice(2).padStart(64,'0');
assert.equal(amount,100000000n); assert.equal(domain,19); assert.equal(maxFee,200000n); assert.equal(finality,1000);
assert.equal(token,'0xaf88d065e77c8cc2239327c5edb3a432268e5831'); assert.equal(mintRecipient,destinationCaller);
assert.equal(mintRecipient,wordAddress('0xb21d281dedb17ae5b501f6aa8256fe38c4e45757'));
const hb=Buffer.from(hook.slice(2),'hex'); assert.equal(hb.length,56); assert.equal(hb.subarray(0,24).toString('hex'),Buffer.from('cctp-forward').toString('hex').padEnd(48,'0')); assert.equal(hb.readUInt32BE(24),0); assert.equal(hb.readUInt32BE(28),24); assert.equal('0x'+hb.subarray(32,52).toString('hex'),input.from); assert.equal(hb.readUInt32BE(52),0);
const calls=[],replies=[],records=[]; let wireBytes=0;
for(let i=1;i<=10;i++) {
  const n=String(i).padStart(3,'0'), qb=fs.readFileSync(path.join(CAP,`wire/${n}-request.body`)),sb=fs.readFileSync(path.join(CAP,`wire/${n}-response.body`));
  const q=JSON.parse(qb),s=JSON.parse(sb),r=read(path.join(CAP,`wire/${n}-record.json`));
  assert.equal(q.id,i);assert.equal(s.id,i);assert.equal(q.jsonrpc,'2.0');assert.equal(s.jsonrpc,'2.0');
  assert.equal(r.requestSha256,sha(qb));assert.equal(r.responseSha256,sha(sb));assert.equal(r.requestText,qb.toString());assert.equal(r.responseText,sb.toString());assert.deepEqual(r.request,q);assert.equal(r.httpStatus,200);assert(r.dispatched&&r.responseComplete);assert(qb.length<=131072);assert(sb.length<=4194304);assert.equal(r.observedBytes,sb.length);assert.equal(r.retainedBytes,sb.length);
  assert.deepEqual(r,response.transportEvidence[i-1]); calls.push(q);replies.push(s);records.push(r);wireBytes+=sb.length;
}
assert(wireBytes<=16777216);assert(response.usage.elapsedMs<120000);assert(response.timing.totalMs<120000);assert.equal(response.transportEvidence.length,10);assert.equal(response.usage.calls,10);assert.equal(response.usage.observedBytes,wireBytes);assert.equal(response.usage.retainedBytes,wireBytes);assert(response.usage.withinBounds&&response.usage.drain.complete);assert.equal(response.usage.hardFailure,null);assert.equal(response.usage.pendingAdapterOperations,0);
assert.deepEqual(calls.map(q=>q.method),['eth_chainId','eth_getBlockByNumber','eth_getBalance','eth_getCode','eth_simulateV1','eth_call','eth_call','eth_call','eth_simulateV1','eth_getBlockByNumber']);
assert.deepEqual(calls[0].params,[]); assert.equal(replies[0].result,'0xa4b1');
for (const i of [1,9]) {assert.deepEqual(calls[i].params,[header.number,false]);assert.deepEqual(replies[i].result,header);}
for(const i of [2,3]) assert.deepEqual(calls[i].params,[input.from,header.number]);
assert.equal(replies[2].result,'0x0');assert.equal(replies[3].result,selected.selected.code);
const original={data:input.data,from:input.from,gas:hex(input.gas ?? '2000000'),gasPrice:'0x0',to:input.to,value:hex(input.value)};
assert.deepEqual(calls[4].params,[{blockStateCalls:[{calls:[original]}],traceTransfers:true,validation:false},header.number]);
const viemSource=fs.readFileSync(path.join(LIB,'node_modules/viem/_esm/actions/public/simulateCalls.js'),'utf8');
const literal = n => {const matches=[...viemSource.matchAll(new RegExp(`const ${n} = '(0x[0-9a-f]+)'`,'g'))];assert.equal(matches.length,1);return matches[0][1];};
const staticCode=literal('staticCallCode'), balanceCode=literal('getBalanceCode'), scratch='0x00000000000000000000000000000000deadbeef';
const queryAbi=[{type:'function',name:'query',stateMutability:'view',inputs:[{type:'address',name:'target'},{type:'bytes',name:'data'}],outputs:[]}];
const native=encodeDeployData({abi:[{type:'constructor',inputs:[{type:'bytes'},{type:'bytes'}]}],bytecode:deploylessCallViaBytecodeBytecode,args:[balanceCode,encodeFunctionData({abi:[{type:'function',name:'getBalance',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}],functionName:'getBalance',args:[input.from]})]});
const query=(address,data)=>encodeFunctionData({abi:queryAbi,functionName:'query',args:[address,data]});
const balanceData=encodeFunctionData({abi:tokenAbi,functionName:'balanceOf',args:[input.from]});
const assets=[token,input.to], override={[scratch]:{code:staticCode}};
assert.deepEqual(calls[5].params,[{data:native,from:input.from},header.number]);
for(let i=0;i<2;i++)assert.deepEqual(calls[6+i].params,[{data:query(assets[i],balanceData),from:zero,gas:'0xf4240',to:scratch},header.number,override]);
const blocks=[{calls:[original,{from:input.from,to:zero}]},{calls:[{data:native}]},...[balanceData,'0x313ce567','0xc87b56dd'+'0'.repeat(64),'0x95d89b41'].map(data=>({calls:assets.map(a=>({data:query(a,data),gas:'0xf4240',to:scratch})),stateOverrides:override}))];
assert.deepEqual(calls[8].params,[{blockStateCalls:blocks,traceTransfers:true,validation:false},header.number]);
for(const i of [4,8]) {let parent=header.hash,time=BigInt(header.timestamp);const result=replies[i].result,expected=calls[i].params[0].blockStateCalls;assert.equal(result.length,expected.length);for(let j=0;j<result.length;j++){const b=result[j];assert.equal(BigInt(b.number),BigInt(header.number)+BigInt(j)+1n);assert.equal(b.parentHash,parent);assert(BigInt(b.timestamp)>time);assert.equal(b.calls.length,expected[j].calls.length);parent=b.hash;time=BigInt(b.timestamp);}}
const discovery=replies[4].result[0].calls[0], main=replies[8].result[0].calls[0];
for (const [call, block] of [[discovery,replies[4].result[0]],[main,replies[8].result[0]]]) for (const log of call.logs) {assert.equal(log.blockHash,block.hash);assert.equal(log.blockNumber,block.number);assert.equal(log.removed,false);}
// The main pass adds a zero-address call, so its synthetic block hash differs.
const comparable = call => ({...call,logs:call.logs.map(({blockHash,...log})=>log)});
assert.deepEqual(comparable(main),comparable(discovery));assert.equal(main.status,'0x1');assert.equal(main.returnData,'0x');assert.equal(BigInt(main.gasUsed),116393n);assert.equal(main.logs.length,5);assert.equal(main.error,undefined);
assert.deepEqual(response.execution,{status:'success',data:'0x',gasUsed:'116393',logs:main.logs,error:null});
const strictWord = value => {assert.match(value,/^0x[0-9a-f]{64}$/);return BigInt(value);};
const nativeBefore=strictWord(replies[5].result),nativeAfter=strictWord(replies[8].result[1].calls[0].returnData),before=strictWord(replies[6].result),after=strictWord(replies[8].result[2].calls[0].returnData);
assert.equal(replies[8].result[1].calls[0].status,'0x1');assert.equal(replies[8].result[2].calls[0].status,'0x1');assert.equal(before,13162457912n);assert.equal(after,13062457912n);assert.equal(after-before,-amount);assert.equal(nativeBefore,0n);assert.equal(nativeAfter,0n);
assert(replies[7].error);assert.equal(replies[7].result,undefined);assert.equal(replies[8].result[2].calls[1].status,'0x0');
for(const [i,a,b] of [[0,nativeBefore,nativeAfter],[1,before,after]]){const row=response.assetChanges[i];assert.equal(row.owner,input.from);assert.equal(row.status,'measured');assert.equal(row.beforeRaw,a.toString());assert.equal(row.afterRaw,b.toString());assert.equal(row.deltaRaw,(b-a).toString());}
assert.equal(response.assetChanges[1].token.address,token);assert.equal(response.assetChanges[2].token.address,input.to);assert.equal(response.assetChanges[2].status,'unverified');for(const k of ['beforeRaw','afterRaw','deltaRaw'])assert.equal(response.assetChanges[2][k],null);
const events=main.logs.map((log,i)=>decodeEventLog({abi:i<3?tokenAbi:i===3?transmitterAbi:messengerAbi,data:log.data,topics:log.topics,strict:true}));
assert.deepEqual(events.map(e=>e.eventName),['Transfer','Burn','Transfer','MessageSent','DepositForBurn']);
const minter=events[0].args.to.toLowerCase();assert.equal(events[0].args.from.toLowerCase(),input.from);assert.equal(events[0].args.value,amount);
assert.equal(events[1].args.burner.toLowerCase(),minter);assert.equal(events[1].args.amount,amount);assert.equal(events[2].args.from.toLowerCase(),minter);assert.equal(events[2].args.to,zero);assert.equal(events[2].args.value,amount);
for(let i=0;i<3;i++)assert.equal(main.logs[i].address,token);assert.equal(main.logs[3].address,'0x81d40f21f12a8f0e3252bccb954d722d4c464b64');assert.equal(main.logs[4].address,input.to);
const deposit=events[4].args;for(const [k,v] of Object.entries({amount,destinationDomain:domain,mintRecipient,destinationCaller,maxFee,minFinalityThreshold:finality,hookData:hook}))assert.equal(deposit[k],v,k);
assert.equal(deposit.burnToken.toLowerCase(),token);assert.equal(deposit.depositor.toLowerCase(),input.from);assert.equal(deposit.destinationTokenMessenger,wordAddress(input.to));
const message=Buffer.from(events[3].args.message.slice(2),'hex'),bytes=(offset,len)=>'0x'+message.subarray(offset,offset+len).toString('hex'),num=(offset,len)=>BigInt(bytes(offset,len));
assert.equal(message.length,148+228+hb.length);assert.equal(num(0,4),1n);assert.equal(num(4,4),3n);assert.equal(num(8,4),BigInt(domain));assert.equal(num(12,32),0n);assert.equal(bytes(44,32),wordAddress(input.to));assert.equal(bytes(76,32),deposit.destinationTokenMessenger);assert.equal(bytes(108,32),destinationCaller);assert.equal(num(140,4),BigInt(finality));assert.equal(num(144,4),0n);
assert.equal(num(148,4),1n);assert.equal(bytes(152,32),wordAddress(token));assert.equal(bytes(184,32),mintRecipient);assert.equal(num(216,32),amount);assert.equal(bytes(248,32),wordAddress(input.from));assert.equal(num(280,32),maxFee);assert.equal(num(312,32),0n);assert.equal(num(344,32),0n);assert.equal(bytes(376,hb.length),hook);
assert.equal(response.status,'partial');assert.equal(response.source.headerConfirmed,true);assert.equal(response.source.twoPassConsistent,true);assert.deepEqual(response.source.header,header);assert.equal(response.source.blockHash,header.hash);assert.equal(response.source.blockNumber,BigInt(header.number).toString());
for(const k of ['inventoryComplete','destinationCreditVerified','feesVerified','securityAssessed'])assert.equal(response.coverage[k],false);
const terminal=read(path.join(CAP,'verification.json'));assert(terminal.sourceUnchanged&&terminal.qualificationHeaderConfirmed&&terminal.adapterInvoked);assert.equal(terminal.terminalError,null);assert.deepEqual(read(path.join(CAP,'viem-response.json')),response.rawViem);
const report={schemaVersion:1,kind:'independent_saved_artifact_verification',verified:true,performed:{rpcCalls:0,evmExecutions:0,providerReplays:0},pins,
 inventory:{captureFiles:m.files.length,runtimeFiles:runtime.files.length,archivedSourceFiles:sourceFiles,dependencyFiles,dependencyBytes,dependencyArchive:'research/arbitrum-viem-deposit-v1',node:runtime.node,staticClosureFiles:closure.size,loaderFiles:loaderFiles.length,loaderSourceSha256:response.implementation.sourceSha256,missingStaticClosure:[]},
 request:{from:input.from,to:input.to,value:input.value,gas:input.gas ?? '2000000',calldataBytes:(input.data.length-2)/2,calldataSha256:sha(Buffer.from(input.data.slice(2),'hex')),qualificationBlock:header.number,qualificationHash:header.hash,senderCodeBytes:(replies[3].result.length-2)/2,senderCodeSha256:sha(Buffer.from(replies[3].result.slice(2),'hex')),senderKind:'contract'},
 observation:{status:response.status,execution:'success',gasUsed:'116393',originalCalls:2,rpcCalls:10,rpcResponseBytes:wireBytes,logs:events.map(e=>({event:e.eventName,args:e.args})),balances:{USDC:{beforeRaw:before,afterRaw:after,deltaRaw:after-before,decimals:6},ETH:{beforeRaw:nativeBefore,afterRaw:nativeAfter,deltaRaw:nativeAfter-nativeBefore},messenger:{status:'unverified',reason:'failed_pre_balance',beforeRaw:null,afterRaw:null,deltaRaw:null}},sourceBurnRaw:amount,minter,maximumFeeRaw:maxFee,sourceDomain:3,destinationDomain:domain,hookRecipient:input.from,requestedDex:0,messageBytes:message.length},
 limitations:['Provider observations, not independent Arbitrum/Nitro execution, consensus or state proof verification.','Two matching original simulations within one adapter attempt; measurements use synthetic successor blocks and exact retained code-only helper overrides.','Contract sender: EOA admission, contract authorization and ability to submit a real transaction were not established. Zero ETH and gasPrice zero do not demonstrate a funded transaction.','USDC symbol/decimals are provider metadata; amount100000000 corresponds to100USDC under the pinned six-decimal token declaration. Failed messenger balance probe remains unknown.','No bridge attestation, destination transaction, HyperEVM/HyperCore credit, actual fee or security conclusion. Message nonce/finalityExecuted/feeExecuted/expiration placeholders are zero and do not prove settlement.','Runtime snapshot is not standalone: exact dependencies are retained in the separately pinned prior viem archive; Node binary is identified and checked locally, not embedded.','The reconstructed Arbitrum loader static closure is complete. Unused dynamically loaded Ethereum local/provider engines are outside this packet and were not executed.'],
 sourceChecks:{capturedRunner:plan.runnerSha256,runtimeManifest:plan.runtimeManifestSha256,sourceUnchangedReported:terminal.sourceUnchanged,qualificationHeaderConfirmed:true,allCapturedBytesVerified:true,allDependencyBytesVerified:true,loaderIdentityReconstructed:true}};
const out=JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
if(process.argv[2]==='--write')fs.writeFileSync(path.join(HERE,'verification.json'),out,{flag:'wx'});
else if(process.argv[2]==='--verify')assert.equal(fs.readFileSync(path.join(HERE,'verification.json'),'utf8'),out);
else throw new Error('Use --write once or --verify for read-only artifact verification.');
console.log(JSON.stringify({verified:true,captureFiles:m.files.length,runtimeFiles:runtime.files.length,loaderFiles:loaderFiles.length,rpcRecords:10,sourceBurnRaw:amount.toString(),reportSha256:sha(out)}));
