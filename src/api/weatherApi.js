import { REGIONS } from '../data/mockData';
import { KMA_SNOW_LAW_ADDRESS_MAP } from '../data/kmaSnowLawAddressMap';
import { KMA_PROXY_BASE } from '../utils/constants';

const padZero = (value) => value.toString().padStart(2, '0');

const formatKmaMinuteTime = (date) => {
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  const hour = padZero(date.getHours());
  const minute = padZero(date.getMinutes());
  return `${year}${month}${day}${hour}${minute}`;
};

const formatKmaHourTime = (date) => formatKmaMinuteTime(date).slice(0, 10);

const subtractHours = (date, hours) => new Date(date.getTime() - hours * 60 * 60 * 1000);

const getStnByRegion = (regionId) => {
  const stnMap = {
    all: 108,
    hq: 109,
    daejeon: 133,
    cheongju: 131,
    jeonju: 146,
    gwangju: 156,
    jeju: 184,
    chuncheon: 105,
    daegu: 143,
    busan: 159,
    changwon: 159,
  };

  return stnMap[regionId] ?? 108;
};

const getIssuingOfficeName = (stn) => {
  const officeMap = {
    108: '기상청',
    109: '수도권기상청',
    133: '대전지방기상청',
    131: '청주기상지청',
    146: '전주기상지청',
    156: '광주지방기상청',
    184: '제주지방기상청',
    105: '강원지방기상청',
    143: '대구지방기상청',
    159: '부산지방기상청',
  };

  return officeMap[stn] ?? '기상청';
};

const buildKmaUrl = (path, params = {}) => {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `${KMA_PROXY_BASE}/${path}${query ? `?${query}` : ''}`;
};

const fetchKmaArrayBuffer = async (path, params = {}) => {
  const response = await fetch(buildKmaUrl(path, params));

  if (!response.ok) {
    throw new Error(`HTTP Error Status: ${response.status}`);
  }

  return response.arrayBuffer();
};

const fetchKmaText = async (path, params = {}) => {
  const buffer = await fetchKmaArrayBuffer(path, params);
  return new TextDecoder('euc-kr').decode(buffer);
};

const normalizeReportText = (content) =>
  content
    .replace(/#/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/7777END/g, '')
    .replace(/[=\s]+$/g, '')
    .trim();

const parseKmaReport = (rawData, targetStn, titleFieldIndex) => {
  if (!rawData) {
    return { content: '', tmfc: '' };
  }

  const blocks = rawData
    .split('$')
    .map((block) => block.trim())
    .filter(Boolean);

  const reportsByTmfc = new Map();
  let activeReport = null;

  for (const block of blocks) {
    const fields = block.split('#');
    const recordIndex = fields[0];

    if (recordIndex === '0') {
      const stn = Number.parseInt(fields[1], 10);
      const tmfc = fields[2];

      if (stn === targetStn || (targetStn === 0 && stn === 108)) {
        const title = fields.slice(titleFieldIndex).join('#').trim();
        const payload = { tmfc, contentParts: [title] };

        if (!reportsByTmfc.has(tmfc)) {
          reportsByTmfc.set(tmfc, []);
        }

        reportsByTmfc.get(tmfc).push(payload);
        activeReport = payload;
      } else {
        activeReport = null;
      }
    } else if (activeReport && !Number.isNaN(Number.parseInt(recordIndex, 10))) {
      const fragment = fields.slice(1).join('#').trim();
      if (fragment) {
        activeReport.contentParts.push(fragment);
      }
    }
  }

  const latestTmfc = [...reportsByTmfc.keys()].sort().reverse()[0];
  if (!latestTmfc) {
    return { content: '', tmfc: '' };
  }

  const latestReport = reportsByTmfc.get(latestTmfc)?.[0];
  return {
    content: normalizeReportText(latestReport?.contentParts.join('\n\n') ?? ''),
    tmfc: latestTmfc,
  };
};

const formatDisplayTime = (tmfc) => {
  if (!tmfc || tmfc.length < 10) {
    return '';
  }

  const year = tmfc.slice(0, 4);
  const month = tmfc.slice(4, 6);
  const day = tmfc.slice(6, 8);
  const hour = tmfc.slice(8, 10);
  const minute = tmfc.length >= 12 ? tmfc.slice(10, 12) : '00';
  return `${year}.${month}.${day} ${hour}:${minute} 발표`;
};

const getBroadRegion = (upperRegion, detailRegion) => {
  const combined = `${upperRegion} ${detailRegion}`;

  if (combined.includes('서해') && combined.includes('앞바다')) return '서해 앞바다';
  if (combined.includes('서해') && combined.includes('먼바다')) return '서해 먼바다';
  if (combined.includes('남해') && combined.includes('앞바다')) return '남해 앞바다';
  if (combined.includes('남해') && combined.includes('먼바다')) return '남해 먼바다';
  if (combined.includes('동해') && combined.includes('앞바다')) return '동해 앞바다';
  if (combined.includes('동해') && combined.includes('먼바다')) return '동해 먼바다';
  if (combined.includes('제주도') && combined.includes('앞바다')) return '제주도 앞바다';
  if (combined.includes('제주도') && combined.includes('먼바다')) return '제주도 먼바다';
  if (combined.includes('울릉도') || combined.includes('독도')) return '경북';
  if (combined.includes('흑산도') || combined.includes('홍도')) return '전남';
  if (combined.includes('서해5도')) return '인천';

  return upperRegion
    .replace('경상북도', '경북')
    .replace('경상남도', '경남')
    .replace('전북특별자치도', '전북')
    .replace('전라북도', '전북')
    .replace('전라남도', '전남')
    .replace('충청북도', '충북')
    .replace('충청남도', '충남')
    .replace('제주도', '제주')
    .replace('특별자치도', '')
    .replace('특별시', '')
    .replace('광역시', '')
    .trim();
};

const formatDetailOcean = (value) =>
  value
    .replace(/^(서해|남해|동해|제주도)/, '')
    .replace(/\s+/g, ' ')
    .replace(/먼바다/g, '먼바다')
    .replace(/앞바다/g, '앞바다')
    .trim();

const formatDetailLand = (value) =>
  value
    .replace(
      /^(강원도|경기도|충청북도|충청남도|전라북도|전북특별자치도|전라남도|경상북도|경상남도|제주도|서울특별시|인천광역시|대전광역시|대구광역시|부산광역시|울산광역시|광주광역시|세종특별자치시)/,
      '',
    )
    .trim();

export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const stn = getStnByRegion(regionId);

    const rawText = await fetchKmaText('api/typ01/url/wthr_cmt_rpt.php', {
      tmfc1: formatKmaMinuteTime(subtractHours(now, 72)),
      tmfc2: formatKmaMinuteTime(now),
      stn,
      subcd: 12,
      disp: 0,
      help: 1,
    });

    const { content, tmfc } = parseKmaReport(rawText, stn, 9);

    return [
      {
        id: `commentary-${regionId}-${tmfc || Date.now()}`,
        title: `날씨해설 (${getIssuingOfficeName(stn)})`,
        time: formatDisplayTime(tmfc),
        content: content || '표출 가능한 날씨해설이 아직 없습니다.',
        region: regionId === 'all' ? '전국' : REGIONS.find((item) => item.id === regionId)?.label ?? '',
      },
    ];
  } catch (error) {
    console.error('[API Fetch Error] 날씨해설 실패', error);
    throw new Error('기상청 날씨해설 데이터를 불러오지 못했습니다.');
  }
};

export const fetchWeatherDoc = async (regionId) => {
  try {
    const now = new Date();
    const stn = getStnByRegion(regionId);

    const rawText = await fetchKmaText('api/typ01/url/fct_afs_ds.php', {
      tmfc1: formatKmaHourTime(subtractHours(now, 72)),
      tmfc2: formatKmaHourTime(now),
      stn,
      disp: 0,
      help: 1,
    });

    const { content, tmfc } = parseKmaReport(rawText, stn, 7);

    return [
      {
        id: `forecast-doc-${regionId}-${tmfc || Date.now()}`,
        title: `통보문 (${getIssuingOfficeName(stn)})`,
        time: formatDisplayTime(tmfc),
        content: content || '표출 가능한 통보문이 아직 없습니다.',
        region: regionId === 'all' ? '전국' : REGIONS.find((item) => item.id === regionId)?.label ?? '',
      },
    ];
  } catch (error) {
    console.error('[API Fetch Error] 통보문 실패', error);
    throw new Error('기상청 통보문 데이터를 불러오지 못했습니다.');
  }
};

export const fetchWeatherWarnings = async (regionId) => {
  try {
    const rawText = await fetchKmaText('api/typ01/url/wrn_now_data.php', {
      fe: 'f',
      tm: '',
      disp: 0,
      help: 1,
    });

    const records = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const fields = line.split(',').map((item) => item.trim());
        return {
          regUpKo: fields[1],
          regKo: fields[3],
          tmFc: fields[4],
          tmEf: fields[5],
          wrn: fields[6],
          lvl: fields[7],
          cmd: fields[8],
          edTm: fields[9],
        };
      });

    const currentMap = new Map();
    const preliminaryMap = new Map();
    const targetRegion = REGIONS.find((item) => item.id === regionId);

    records.forEach((record) => {
      const isMarine =
        /(해상|바다|앞바다|먼바다)/.test(record.regUpKo) || /(해상|바다|앞바다|먼바다)/.test(record.regKo);
      const regionMatches =
        regionId === 'all' ||
        isMarine ||
        targetRegion?.keywords?.some(
          (keyword) => record.regUpKo.includes(keyword) || record.regKo.includes(keyword),
        );

      if (!regionMatches) {
        return;
      }

      if (isMarine && regionId !== 'all') {
        return;
      }

      const isPreliminary = record.tmEf?.endsWith('58') || record.tmEf?.endsWith('59');
      const targetMap = isPreliminary ? preliminaryMap : currentMap;
      const levelLabel = record.lvl === '주의' ? '주의보' : record.lvl === '경보' ? '경보' : record.lvl;
      const typeName = `${record.wrn} ${levelLabel}`;
      const broadRegion = getBroadRegion(record.regUpKo, record.regKo || record.regUpKo);
      const detailRegion = isMarine
        ? formatDetailOcean(record.regKo || record.regUpKo)
        : formatDetailLand(record.regKo || record.regUpKo);

      if (!targetMap.has(typeName)) {
        targetMap.set(typeName, new Map());
      }

      if (!targetMap.get(typeName).has(broadRegion)) {
        targetMap.get(typeName).set(broadRegion, new Set());
      }

      if (detailRegion && detailRegion !== broadRegion) {
        targetMap.get(typeName).get(broadRegion).add(detailRegion);
      }
    });

    const formatOutput = (map) =>
      [...map.entries()].map(([typeName, broadMap], index) => ({
        id: `${typeName}-${index}-${Date.now()}`,
        type: typeName,
        time: '',
        content: [...broadMap.entries()]
          .map(([broadRegion, detailRegions]) => {
            const details = [...detailRegions];
            return details.length > 0
              ? `• ${broadRegion} (${details.join(', ')})`
              : `• ${broadRegion}`;
          })
          .join('\n'),
      }));

    return {
      current: formatOutput(currentMap),
      preliminary: formatOutput(preliminaryMap),
    };
  } catch (error) {
    console.error('[API Fetch Error] 특보 실패', error);
    throw new Error('기상청 특보 데이터를 불러오지 못했습니다.');
  }
};

export const getWarningImageUrl = (trigger = 0) => {
  const now = new Date();

  return buildKmaUrl('api/typ03/cgi/wrn/nph-wrn7', {
    out: 0,
    tmef: 1,
    city: 1,
    name: 0,
    tm: formatKmaMinuteTime(now),
    lon: 127.7,
    lat: 36.1,
    range: 300,
    size: 685,
    wrn: 'W,R,C,D,O,V,T,S,Y,H,',
    _ts: trigger,
  });
};

export const fetchSnowData = async (type = 'tot', customTm = null) => {
  try {
    const tm = customTm || formatKmaMinuteTime(new Date());

    const [dataRaw, stnRaw] = await Promise.all([
      fetchKmaText('api/typ01/url/kma_snow1.php', { sd: type, tm, help: 0 }),
      fetchKmaText('api/typ01/url/stn_snow.php', { stn: '', tm, mode: 0, help: 1 }),
    ]);

    const stationMetadata = new Map();

    stnRaw.split('\n').forEach((line) => {
      if (!line || line.trim().startsWith('#')) {
        return;
      }

      const fields = line.trim().split(/\s+/);
      if (fields.length < 9) {
        return;
      }

      const stationId = fields[0];
      const stationName = fields[6];
      const legalCode = fields[8];
      const address = KMA_SNOW_LAW_ADDRESS_MAP[legalCode] ?? stationName;

      stationMetadata.set(stationId, { name: stationName, address });
    });

    return dataRaw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').map((field) => field.trim()))
      .filter((fields) => fields.length >= 7)
      .map((fields) => {
        const stationId = fields[1];
        const snowValue = Number.parseFloat(fields[6].replace(/[^0-9.-]/g, ''));
        const metadata = stationMetadata.get(stationId) ?? { name: fields[2], address: fields[2] };

        return {
          name: metadata.name,
          address: metadata.address,
          value: snowValue,
        };
      })
      .filter((item) => Number.isFinite(item.value) && item.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((item, index) => ({
        rank: index + 1,
        name: item.name,
        record: `${item.value.toFixed(1)}cm`,
        address: item.address,
      }));
  } catch (error) {
    console.error('[API Fetch Error] 적설 실패', error);
    throw new Error('기상청 적설 데이터를 불러오지 못했습니다.');
  }
};
