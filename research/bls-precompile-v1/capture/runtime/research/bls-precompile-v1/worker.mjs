import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {executeEthereumCall} from '../../engines/local-evm/ethereum-call.js';
import {createRecordedStateManager} from '../../engines/local-evm/recorded-state.js';
import {loadRows} from './archive.mjs';
import {FILES,FORKS,LIMITS,executionInput} from './cases.mjs';
import assert from 'node:assert/strict';

const [fork,file]=process.argv.slice(2);assert(Object.hasOwn(FORKS,fork)&&FILES.includes(file));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
for(const row of loadRows(root).filter(r=>r.fork===fork&&r.file===file&&r.status==='admitted')){
 const input=executionInput(row),started=performance.now();let record;
 try{const stateManager=await createRecordedStateManager(input.accounts);const output=await executeEthereumCall({request:input.request,header:input.header,stateManager,limits:{wallMs:LIMITS.caseWallMs}});record={id:row.id,input,output,changes:stateManager.snapshotChanges(),reads:stateManager.snapshotReads()};}
 catch(error){record={id:row.id,input,output:null,error:{name:error?.name??null,message:error?.message??null}};}
 process.stdout.write(JSON.stringify({...record,elapsedMs:performance.now()-started})+'\n');
}
