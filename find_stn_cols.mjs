
import fs from 'fs';

const buffer = fs.readFileSync('d:\\coding\\stn_snow.txt');
const text = new TextDecoder('euc-kr').decode(buffer);
const lines = text.split('\n');
for (const line of lines) {
    if (line.includes('# STN')) {
        console.log("Column line: " + line);
    }
    if (line.startsWith('   90')) { // Test data line
        console.log("Data line example: " + line);
    }
}
