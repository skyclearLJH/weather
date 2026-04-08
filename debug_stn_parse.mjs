
import fs from 'fs';

const buffer = fs.readFileSync('d:\\coding\\stn_snow.txt');
const text = new TextDecoder('euc-kr').decode(buffer);
const lines = text.split('\n');
for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length >= 7) {
        console.log(`ID: [${f[0]}], Name: [${f[6]}]`);
    }
}
