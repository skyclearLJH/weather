
import fs from 'fs';

async function testParsing() {
    const KMA_AUTH_KEY = 'KkmPfomzTJyJj36Js9ycNQ';
    const tm = '202603021800';
    
    // Simulate stnRaw parsing
    const stnBuf = fs.readFileSync('stn_snow.txt');
    const decoder = new TextDecoder('euc-kr');
    const stnRaw = decoder.decode(stnBuf);

    const stnMetadata = new Map();
    const SIDO_NAMES = {
      '11': '서울특별시', '26': '부산광역시', '27': '대구광역시', '28': '인천광역시',
      '29': '광주광역시', '30': '대전광역시', '31': '울산광역시', '36': '세종특별자치시',
      '41': '경기도', '42': '강원특별자치도', '43': '충청북도', '44': '충청남도',
      '45': '전북특별자치도', '46': '전라남도', '47': '경상북도', '48': '경상남도',
      '50': '제주특별자치도'
    };

    stnRaw.split('\n').forEach(line => {
      if (!line || line.trim().startsWith('#')) return;
      const f = line.trim().split(/\s+/);
      if (f.length >= 9) {
        const id = f[0];
        const name = f[6];
        const legalCode = f[8]; // 10자리 법정동 코드
        
        const sidoCode = legalCode.substring(0, 2);
        const sido = SIDO_NAMES[sidoCode] || '';
        const address = sido ? `${sido} ${name}` : name;
        
        stnMetadata.set(id, { name, address });
      }
    });

    // Simulate dataRaw parsing
    const dataBuf = fs.readFileSync('snow_2026.txt');
    const dataRaw = decoder.decode(dataBuf);
    const dataLines = dataRaw.split('\n');
    const result = [];
    
    for (const line of dataLines) {
      if (!line || line.trim().startsWith('#')) continue;
      const f = line.split(',').map(s => s.trim());
      
      if (f.length >= 7) {
        const id = f[1];
        const snowStr = f[6].replace(/[^0-9.-]/g, '');
        const snow = parseFloat(snowStr);
        
        if (!isNaN(snow) && snow > 0) {
          const meta = stnMetadata.get(id) || { name: f[2], address: f[2] };
          result.push({
            name: meta.name,
            record: `${snow.toFixed(1)} cm`,
            value: snow,
            address: meta.address
          });
        }
      }
    }

    console.log('--- Top 5 Addresses ---');
    result.sort((a,b) => b.value - a.value).slice(0, 5).forEach(r => {
        console.log(`${r.name}: ${r.address} (${r.record})`);
    });
}

testParsing();
