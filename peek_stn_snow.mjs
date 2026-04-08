
import fs from 'fs';

const buffer = fs.readFileSync('d:\\coding\\stn_snow.txt');
const text = new TextDecoder('euc-kr').decode(buffer);
console.log(text.substring(0, 1000));
