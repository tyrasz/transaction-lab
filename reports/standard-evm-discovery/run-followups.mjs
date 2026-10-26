import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const requests=JSON.parse(await readFile(new URL('followup-requests.json',import.meta.url)));
for(const request of requests){const result=spawnSync(process.execPath,[new URL('fetch.mjs',import.meta.url).pathname,JSON.stringify(request)],{encoding:'utf8',timeout:35000});process.stdout.write(result.stdout??'');if(result.status!==0)throw new Error(result.stderr||result.error?.message||'Recorder failed');}
