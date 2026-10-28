import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { executeStateTest } from './state-test.js';
const [file,id,index,sha]=process.argv.slice(2);
try{
 const raw=fs.readFileSync(file);if(raw.length>8388608||createHash('sha256').update(raw).digest('hex')!==sha)throw Error('Fixture source hash mismatch');
 const fixture=JSON.parse(raw)[id];if(!fixture)throw Error('Unknown frozen fixture ID');
 const result=await executeStateTest(fixture,Number(index));process.stdout.write(JSON.stringify({status:'completed',result})+'\n');
}catch(error){process.stdout.write(JSON.stringify({status:'unavailable',error:{name:error.name,message:error.message}})+'\n');process.exitCode=1;}
