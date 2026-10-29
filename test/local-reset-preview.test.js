import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.js';
import { loadLocalApi } from '../src/local-loader.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { RESET_TARGET, RESET_HELPER, resetPreviewFixture } from '../engines/local-evm/test/reset-preview-fixture.js';

// The production handler/loader/collector/child consume only authenticated
// synthetic initial proofs and code. There is no socket or public RPC here.
test('local HTTP handler serializes neutral reset queries and withholds surviving mutations',async t=>{
  const api=await loadLocalApi();assert(api);const reportDir=await mkdtemp(path.join(os.tmpdir(),'reset-api-'));
  t.after(()=>rm(reportDir,{recursive:true,force:true}));
  for(const helperReverts of [true,false]){
    const f=await resetPreviewFixture({helperReverts}),wires=[],errors=[];
    let finalHeaders=0,factories=0,body,status;
    const input={chainId:1,...f.request,block:f.header.hash,queries:[f.query,{kind:'native_balance',account:RESET_TARGET}]};
    const rpc=new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(url,options)=>{
      try{
        assert.equal(String(url),'https://fixture.invalid/');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
        const request=JSON.parse(options.body);wires.push(request);assert.equal(request.id,wires.length);
        let result;
        if(request.method==='eth_chainId'){assert.equal(wires.length,1);assert.deepEqual(request.params,[]);result='0x1';}
        else if(request.method==='eth_getBlockByHash'){assert.equal(wires.length,2);assert.deepEqual(request.params,[f.header.hash,false]);result=f.header;}
        else if(request.method==='eth_getBlockByNumber'){assert.equal(++finalHeaders,1);assert.deepEqual(request.params,[f.header.number,false]);result=f.header;}
        else{assert(['eth_getProof','eth_getCode'].includes(request.method));assert.deepEqual(request.params.at(-1),{blockHash:f.header.hash,requireCanonical:true});result=await f.rpc.call(request.method,request.params);}
        return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
      }catch(error){errors.push(error.message);throw error;}
    }});
    const server=createAppServer({reportDir,persist:true,localLoader:async()=>api,proofRpcFactory(){assert.equal(++factories,1);return rpc;},standardRpcFactory(){assert.fail('Provider simulation attempted');},rpcFactory(){assert.fail('Legacy simulation attempted');}});
    const req=Readable.from([Buffer.from(JSON.stringify(input))]);Object.assign(req,{method:'POST',url:'/api/evm/local-preview',headers:{host:'127.0.0.1','content-type':'application/json'},aborted:false});
    const res=new EventEmitter();Object.assign(res,{statusCode:200,writableEnded:false,destroyed:false,writeHead(code){this.statusCode=code;return this;},end(value){status=this.statusCode;body=String(value);this.writableEnded=true;return this;}});
    try{await server.listeners('request')[0](req,res);}finally{req.destroy();server.close();}
    assert.deepEqual(errors,[],'Transport assertions must survive swallowed worker errors');assert.equal(status,200,body);assert.equal(finalHeaders,1);
    const report=JSON.parse(body);assert.deepEqual(report.implementation,api.implementation);assert.deepEqual(report.apiRequest,input);
    assert.equal(report.execution.status,'success');assert.equal(report.source.canonicalStatus,'verified');assert.equal(report.status,helperReverts?'complete':'partial');
    assert.equal(report.drain.complete,true);assert.equal(report.attempt.isolation.processSeparated,true);assert.equal(report.attempt.isolation.processClosed,true);assert.equal(report.attempt.broker.pendingAtReturn,0);
    assert.equal(report.transportEvidence.length,wires.length);for(let i=0;i<wires.length;i++)assert.deepEqual(JSON.parse(report.transportEvidence[i].requestText),wires[i]);
    const [query,native]=report.measurements,core=report.attempt.preview,m=core.measurements[0];
    assert.equal(m.before.status,'measured');assert.equal(m.before.values[0].raw,'0');assert.equal(m.after.output.execution.status,'success');assert.equal(BigInt(m.after.output.execution.returnData),43n);
    if(helperReverts){
      assert.equal(query.status,'measured');assert.deepEqual(query.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['0','43','43']]);
      assert.equal(m.after.mutationValidation.status,'verified');assert.equal(m.after.changesAfter.accounts.some(a=>a.address===RESET_HELPER),false);
    }else{
      assert.equal(query.status,'unavailable');assert.equal(query.values,null);assert.equal(m.after.status,'unavailable');assert.equal(m.after.values,null);
      assert.equal(m.after.changesAfter.accounts.find(a=>a.address===RESET_TARGET).reset.basis,'shanghai_selfdestruct_deletion');
      assert.equal(m.after.changesAfter.accounts.find(a=>a.address===RESET_HELPER).nonce.after,'0x2');
    }
    assert.equal(native.status,'measured');assert.equal(native.query,null);assert.equal(native.returnBytes,0);
    assert.deepEqual(native.values,[{name:'balance',beforeRaw:'17',afterRaw:'0',deltaRaw:'-17',unit:{kind:'native_wei',scale:'1000000000000000000'}}]);
    assert.deepEqual(core.measurements[1].after.changesBefore,core.original.changes);assert.equal(core.usage.executions,3);
    assert.deepEqual(JSON.parse(await readFile(path.join(reportDir,'simulations',report.id+'.json'),'utf8')),report,'Persisted JSON retains unavailable values, reset audit and exact native units');
  }
});
