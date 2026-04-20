import fs from 'fs';
const authKey = process.env.KMA_AUTH_KEY || process.env.VITE_KMA_AUTH_KEY || '';
const url = `https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php?fe=f&tm=&disp=0&help=1&authKey=${authKey}`;
fetch(url).then(async res => {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('euc-kr').decode(buf);
  fs.writeFileSync('wrn_data.txt', text, 'utf8');
});
