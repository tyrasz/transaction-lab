import fs from 'node:fs';
import { ethereumjsObservation } from './cases.mjs';
// One exact signed full-VM observation. No Geth input or expected poststate is
// supplied. The parent bounds process time/output and seals this result first.
const input = JSON.parse(fs.readFileSync(process.argv[2]));
console.log(JSON.stringify(await ethereumjsObservation(input)));
