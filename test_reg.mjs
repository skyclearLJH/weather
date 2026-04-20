import fs from 'fs';
const authKey = process.env.KMA_AUTH_KEY || process.env.VITE_KMA_AUTH_KEY || '';
const apiPath = `https://apihub.kma.go.kr/api/typ01/url/wrn_reg.php?tmfc=0&authKey=${authKey}`;
fetch(apiPath).then(async res => {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('euc-kr').decode(buf);
  fs.writeFileSync('wrn_reg.txt', text, 'utf8');
});
