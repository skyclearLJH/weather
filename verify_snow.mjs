const KMA_AUTH_KEY = process.env.KMA_AUTH_KEY || process.env.VITE_KMA_AUTH_KEY || '';

async function fetchSnowData(type = 'tot', customTm = null) {
    const tm = customTm || '20260408100000'.substring(0, 10);
    const stnUrl = `https://apihub.kma.go.kr/api/typ01/url/stn_snow.php?stn=&tm=201601051200&mode=0&help=0&authKey=${KMA_AUTH_KEY}`;
    const stnRes = await fetch(stnUrl);
    const stnBuf = await stnRes.arrayBuffer();
    const stnRaw = new TextDecoder('euc-kr').decode(stnBuf);
    
    const stnMap = new Map();
    const stnLines = stnRaw.split('\n');
    for (const line of stnLines) {
      if (!line || line.trim().startsWith('#')) continue;
      const f = line.trim().split(/\s+/);
      if (f.length >= 7) {
        const id = f[0];
        const name = f[6];
        stnMap.set(id, { name, address: name });
      }
    }

    const dataUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${type}&tm=${tm}&help=0&authKey=${KMA_AUTH_KEY}`;
    console.log(`Fetching from: ${dataUrl}`);
    const dataRes = await fetch(dataUrl);
    const dataBuf = await dataRes.arrayBuffer();
    const dataRaw = new TextDecoder('euc-kr').decode(dataBuf);
    
    console.log("Raw data preview (first 200 chars):", dataRaw.substring(0, 200));
    
    const dataLines = dataRaw.split('\n');
    const result = [];
    let count = 0;
    for (const line of dataLines) {
      if (!line || line.trim().startsWith('#')) continue;
      const f = line.split(',').map(s => s.trim());
      if (f.length >= 3) {
        count++;
        const id = f[1];
        const snow = parseFloat(f[2]);
        if (count < 5) console.log(`Parsed split: ID=${id}, Snow=${snow}`);
        if (snow >= 0) {
          const stnInfo = stnMap.get(id) || { name: `지점 ${id}`, address: '정보 없음' };
          result.push({
            name: stnInfo.name,
            record: `${snow.toFixed(1)} cm`,
            value: snow,
            address: stnInfo.address
          });
        }
      }
    }
    console.log(`Total valid data lines found: ${count}`);
    return result
      .sort((a, b) => b.value - a.value)
      .map((item, idx) => ({
        rank: idx + 1,
        name: item.name,
        record: item.record,
        address: item.address
      }));
}

async function test() {
    console.log("Testing Snow Data Fetch (Total) for 2026.03.02 18:00...");
    try {
        const data = await fetchSnowData('tot', '202603021800');
        console.log("Total Snow Data (Top 5):");
        console.log(data.slice(0, 5));

        console.log("\nTesting Snow Data Fetch (New) for 2026.03.02 18:00...");
        const dayData = await fetchSnowData('day', '202603021800');
        console.log("New Snow Data (Top 5):");
        console.log(dayData.slice(0, 5));

    } catch (e) {
        console.error("Test failed:", e);
    }
}

test();
