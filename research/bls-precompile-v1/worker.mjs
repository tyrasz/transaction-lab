import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {executeEthereumCall} from '../../engines/local-evm/ethereum-call.js';
import {createRecordedStateManager} from '../../engines/local-evm/recorded-state.js';
import {loadRows} from './archive.mjs';
import {FILES,FORKS,LIMITS,executionInput} from './cases.mjs';
import assert from 'node:assert/strict';

export const stateFor=input=>createRecordedStateManager({accounts:input.accounts});
export async function runBatch(root,fork,file){
 assert(Object.hasOwn(FORKS,fork)&&FILES.includes(file));
 for(const row of loadRows(root).filter(r=>r.fork===fork&&r.file===file&&r.status==='admitted')){
 const input=executionInput(row),started=performance.now();let record;
 try{const stateManager=await stateFor(input);const output=await executeEthereumCall({request:input.request,header:input.header,stateManager,limits:{wallMs:LIMITS.caseWallMs}});record={id:row.id,input,output,changes:stateManager.snapshotChanges(),reads:stateManager.snapshotReads()};}
 catch(error){record={id:row.id,input,output:null,error:{name:error?.name??null,message:error?.message??null}};}
 process.stdout.write(JSON.stringify({...record,elapsedMs:performance.now()-started})+'\n');
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runBatch(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),...process.argv.slice(2));
