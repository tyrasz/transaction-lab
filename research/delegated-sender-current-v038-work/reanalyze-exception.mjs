// Saved-only amendment. The frozen first adjudication and target packet stay intact.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {entry,read,json,sha,nodeIdentity,checkRows,verifyPacket} from '../lending-local-sequence-current-v037/archive.mjs';

const SELF=fileURLToPath(import.meta.url),ROOT=path.resolve(path.dirname(SELF),'../..');
const WORK='research/delegated-sender-current-v038-work';
const CAPTURE=path.join(ROOT,'research/delegated-sender-current-v038/capture-001');
const COMPARATOR='research/ordinary-local-coverage-v1/outcomes.mjs';
export const PINS=Object.freeze({
 intent:'f89ace8fabaea373b0226cb7cefb68ea6c4b59531cf317eae1da24a5ac8fdb54',
 manifest:'3c845b025d9a722e5afa00406d87763656cd38fb6c4ca2bede6ba1918d9115e9',
 firstComparison:'17e888ea19e0d158986b5728a12e49ef4c11113257cc2e033a1505f90226edf6',
 oldComparator:'53fe6a9a11f5144fe582ba721f99d2e91531cced0f96261d4ab24429cafe0e7c',
 newComparator:'45d233829aab40b4371da7aff5d4c6ed0a7378c703e4c99d423d66f6afe54903',
});

export function assertComparatorAmendment(oldText,newText){
 assert.equal(sha(oldText),PINS.oldComparator);assert.equal(sha(newText),PINS.newComparator);
 const comment='  // Geth formats ErrInvalidOpCode as "invalid opcode: %s" and names 0xfe "INVALID":\n'+
  '  // https://raw.githubusercontent.com/ethereum/go-ethereum/v1.16.5/core/vm/errors.go\n'+
  '  // https://raw.githubusercontent.com/ethereum/go-ethereum/v1.16.5/core/vm/opcodes.go\n'+
  '  // Admit only that exact additional spelling; unknown suffixes remain unavailable.\n';
 const expected=oldText.replace('function errorClass(error,local=false) {','export function errorClass(error,local=false) {')
  .replace('  const aliases=',comment+'  const aliases=')
  .replace('/^invalid opcode(?:: opcode 0x[0-9a-f]{2} not defined)?$/','/^invalid opcode(?:: INVALID(?![\\s\\S])|: opcode 0x[0-9a-f]{2} not defined)?$/');
 assert.equal(newText,expected,'Only the reviewed exact exception alias may change');
}

export function assertOnlyExceptionChannelChanged(before,after){
 assert.deepEqual(before.counts,{matched:9,mismatched:0,unavailable:1});
 assert.equal(before.rows[0].channels.executionStatus.status,'unavailable');
 assert.equal(before.rows[0].evidence.local.rawExecutionError,'invalid opcode');
 assert.equal(before.rows[0].evidence.oracle.rawExecutionError,'invalid opcode: INVALID');
 const expected=structuredClone(before.rows);
 expected[0].channels.executionStatus={status:'match',product:{status:'failed',exception:'invalid_opcode'},oracle:{status:'failed',exception:'invalid_opcode'}};
 expected[0].outcome.comparison='match';expected[0].allChannelsComplete=true;expected[0].reasons=[];
 assert.deepEqual(after.rows,expected,'An amendment must not alter another channel, raw value, delegation or case');
 assert.deepEqual(after.counts,{matched:10,mismatched:0,unavailable:0});
 assert.deepEqual(after.metrics,after.counts);
}

export async function reanalyze(){
 const firstPath=path.join(ROOT,WORK,'comparison-first.json');assert.equal(sha(read(firstPath)),PINS.firstComparison);
 const first=json(firstPath),runtime=path.join(CAPTURE,'runtime');
 const original=await(await import(pathToFileURL(path.join(runtime,'research/delegated-sender-current-v038/adjudicate.mjs')))).adjudicateSavedCapture(CAPTURE,PINS.intent,PINS.manifest);
 // Compare at the original CLI JSON boundary, where undefined object fields
 // are intentionally omitted from the saved response.
 assert.equal(JSON.stringify(original,null,2)+'\n',read(firstPath).toString());assert.equal(original.evidenceUsable,true);
 const intent=json(path.join(CAPTURE,'intent.json')),oldText=read(path.join(runtime,COMPARATOR)).toString(),newText=read(path.join(ROOT,COMPARATOR)).toString();
 assertComparatorAmendment(oldText,newText);
 const unchanged=intent.files.filter(r=>r.path!==COMPARATOR);checkRows(ROOT,unchanged);assert.deepEqual(nodeIdentity(),intent.node);
 const amendmentFiles=[WORK+'/reanalyze-exception.mjs',WORK+'/reanalysis.test.mjs',COMPARATOR,'research/ordinary-local-coverage-v1/exception.test.mjs','research/ordinary-local-coverage-v1/case.test.mjs'].map(p=>entry(ROOT,p));
 const declarations=json(path.join(CAPTURE,'declarations.json'));
 const records=[0,1].map(i=>Object.fromEntries(['local','oracle'].map(kind=>[kind,json(path.join(CAPTURE,kind,String(i+1).padStart(3,'0'),'report.json'))])));
 const {compareFixedCases}=await import(pathToFileURL(path.join(ROOT,'research/delegated-sender-current-v038/adjudicate.mjs')));
 const amended=await compareFixedCases({cases:declarations.cases,records,usable:true,expectedImplementation:records[0].local.report.implementation});
 assertOnlyExceptionChannelChanged(original,amended);
 checkRows(ROOT,unchanged);checkRows(ROOT,amendmentFiles);checkRows(runtime,intent.files);assert.deepEqual(nodeIdentity(),intent.node);
 // Rebind all reread inputs/reports, not only the immutable execution sources.
 verifyPacket(CAPTURE,PINS.manifest);
 assert.equal(sha(read(firstPath)),PINS.firstComparison);
 return{kind:'saved_exception_classification_amendment',capturePins:PINS,originalCounts:original.counts,denominator:original.denominator,
  ...amended,amendmentFiles,unchangedSourceFilesVerified:unchanged.length,originalPacketRevalidated:true,
  change:'Recognize only the additional exact provider exception spelling invalid opcode: INVALID. No original execution, input or other comparison channel changed.',
  evidenceBasis:['https://raw.githubusercontent.com/ethereum/go-ethereum/v1.16.5/core/vm/errors.go','https://raw.githubusercontent.com/ethereum/go-ethereum/v1.16.5/core/vm/opcodes.go'],
  providerBuildAttested:false,retrospective:true,targetsExecuted:0,networkCalls:0,
  limitations:original.limitations};
}
if(process.argv[1]===SELF){assert.equal(process.argv.length,2);console.log(JSON.stringify(await reanalyze(),null,2));}
