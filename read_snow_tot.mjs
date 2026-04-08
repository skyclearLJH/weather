
import fs from 'fs';

const buffer = fs.readFileSync('d:\\coding\\snow_tot.txt');
const text = new TextDecoder('euc-kr').decode(buffer);
const lines = text.split('\n');
console.log("Headers or first 10 lines:");
for (let i = 0; i < 20; i++) {
    if (lines[i]) console.log(lines[i]);
}
