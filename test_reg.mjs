import fs from 'fs';
const apiPath = 'https://apihub.kma.go.kr/api/typ01/url/wrn_reg.php?tmfc=0&authKey=KkmPfomzTJyJj36Js9ycNQ';
fetch(apiPath).then(async res => {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('euc-kr').decode(buf);
  fs.writeFileSync('wrn_reg.txt', text, 'utf8');
});
