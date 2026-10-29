// One real-browser HTTP check; only synthetic authenticated initial RPC facts.
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../../src/server.js';
import { ProofRpcClient } from '../../src/proof-rpc.js';
import { feeFixture, TX_SENDER, TARGET } from '../../engines/local-evm/test/fee-fixture.js';

const dir=fileURLToPath(new URL('./',import.meta.url));
const save=(name,value)=>writeFile(dir+name,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
await mkdir(dir,{recursive:true});
const f=await feeFixture({value:'123',target:{nonce:1n,balance:9n,code:'0x'}});
const intended={chainId:1,from:TX_SENDER,to:TARGET,data:'0x',value:'123',block:f.header.hash,
  executionProfile:'unsigned_eip1559_block_end',fees:{maxFeePerGas:'13',maxPriorityFeePerGas:'3'},
  queries:[TX_SENDER,TARGET].map(account=>({kind:'native_balance',account}))};
await save('intended-request.json',intended);
await save('fixture.json',{scope:'Synthetic initial MPT/header; no public-chain data or provider execution.',header:f.header,allocation:f.allocation});
const sourceFiles=['public/app.js','public/index.html','public/style.css','src/server.js','src/local-simulation.js','src/local-loader.js','src/config.js','engines/local-evm/test/fee-fixture.js','engines/local-evm/test/native-balance-fixture.js'];
await save('declaration.json',{scope:'One synthetic browser-form run through production HTTP route, adapter, proof collector and isolated child; no public RPC or accuracy claim.',createdAt:new Date().toISOString(),node:process.version,request:intended,
  limits:{browserRuns:1,wallMs:600000,proofCalls:260},sources:await Promise.all(sourceFiles.map(async path=>{const bytes=await readFile(new URL('../../'+path,import.meta.url));return{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}))});
let runs=0,clients=0;const proofRequests=[],errors=[];
const server=createAppServer({reportDir:dir+'persisted',persist:false,standardLoader:async()=>null,arbitrumLoader:async()=>null,
  rpcFactory(){throw Error('Legacy RPC forbidden');},standardRpcFactory(){throw Error('Provider RPC forbidden');},
  proofRpcFactory(){assert.equal(++clients,1);return new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(url,options)=>{
    try{assert.equal(String(url),'https://fixture.invalid/');const request=JSON.parse(options.body);proofRequests.push(request);assert(proofRequests.length<=260);
      let result;
      if(request.method==='eth_chainId'){assert.deepEqual(request.params,[]);result='0x1';}
      else if(request.method==='eth_getBlockByHash'){assert.deepEqual(request.params,[f.header.hash,false]);result=f.header;}
      else if(request.method==='eth_getBlockByNumber'){assert.deepEqual(request.params,[f.header.number,false]);result=f.header;}
      else{assert(['eth_getProof','eth_getCode'].includes(request.method));assert.deepEqual(request.params.at(-1),{blockHash:f.header.hash,requireCanonical:true});result=await f.rpc.call(request.method,request.params);}
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
    }catch(error){errors.push(error.message);throw error;}
  }});}});
server.prependListener('request',(req,res)=>{
  if(req.method!=='POST')return;
  assert.equal(req.url,'/api/evm/local-preview');assert.equal(++runs,1);
  const startedAt=new Date().toISOString(),chunks=[];
  req.on('data',chunk=>chunks.push(chunk));
  const end=res.end.bind(res);
  res.end=function(value,...args){
    const requestText=Buffer.concat(chunks).toString('utf8'),responseText=Buffer.isBuffer(value)?value.toString('utf8'):String(value);
    Promise.all([save('request.json',requestText),save('response.json',responseText),save('http.json',{startedAt,finishedAt:new Date().toISOString(),method:req.method,path:req.url,status:res.statusCode,requestHeaders:req.headers,responseHeaders:res.getHeaders(),proofRequests:proofRequests.length,errors})])
      .then(()=>save('HTTP_CAPTURE_COMPLETE.json',{status:res.statusCode,runs,clients,errors})).catch(error=>{console.error(error);process.exitCode=1;});
    return end(value,...args);
  };
});
const timer=setTimeout(()=>server.close(()=>process.exit(1)),600000);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const url=`http://127.0.0.1:${server.address().port}`;await save('server.json',{url,pid:process.pid,startedAt:new Date().toISOString()});console.log(JSON.stringify({url,from:TX_SENDER,to:TARGET,block:f.header.hash}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearTimeout(timer);server.close(async()=>{await save('server-closed.json',{closedAt:new Date().toISOString(),runs,clients,proofRequests:proofRequests.length,errors});process.exit(0);});});
