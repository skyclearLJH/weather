
import fs from 'fs';

async function testParsing() {
    // Recent sample including 311
    const stnRaw = `
  311  128.40695000   38.33153000   1269.00  311 향로봉                            11D20405 4282033035 
  119  126.98530000   37.27230000 000          34.06 119 수원                 11B20601 4111313100
`;

    const SIDO_NAMES = {
      '11': '서울특별시', '41': '경기도', '42': '강원특별자치도'
    };

    const stnMetadata = new Map();
    stnRaw.split('\n').forEach(line => {
      if (!line || line.trim().startsWith('#')) return;
      const f = line.trim().split(/\s+/);
      if (f.length >= 7) {
        const id = f[0];
        const name = f.find(field => /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(field)) || f[6] || f[5];
        const legalCode = f.find(field => /^\d{10}$/.test(field));
        
        if (legalCode) {
          const sidoCode = legalCode.substring(0, 2);
          const sido = SIDO_NAMES[sidoCode] || '';
          const address = sido ? `${sido} ${name}` : name;
          stnMetadata.set(id, { name, address });
        }
      }
    });

    console.log('--- Metadata Check ---');
    console.log('311:', stnMetadata.get('311'));
    console.log('119:', stnMetadata.get('119'));
}

testParsing();
