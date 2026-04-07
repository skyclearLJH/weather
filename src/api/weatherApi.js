import { KMA_AUTH_KEY } from '../utils/constants';
import { REGIONS } from '../data/mockData';

/**
 * 10보다 작은 숫자에 0을 붙여 2자리로 만드는 헬퍼 함수
 */
const padZero = (num) => num.toString().padStart(2, '0');

/**
 * 날짜 객체를 YYYYMMDDHH00 포맷 문자열로 변환 (기상청 예측 시간은 보통 정각 단위 요청)
 */
const formatToKMATime = (date) => {
  const yyyy = date.getFullYear();
  const mm = padZero(date.getMonth() + 1);
  const dd = padZero(date.getDate());
  const hh = padZero(date.getHours());
  return `${yyyy}${mm}${dd}${hh}00`; // 분 단위 00으로 고정
};

/**
 * 전국의 각 총국(KBS regional stations)에 대응하는 기상청 발표 관서(STN) 코드 맵핑
 */
const getStnByRegion = (regionId) => {
  const stnMap = {
    all: 108,      // 전국(서울)
    hq: 109,       // 본사(수도권 - 서울/인천/경기)
    daejeon: 133,  // 대전총국(대전/세종/충남)
    cheongju: 131, // 청주총국(충북)
    jeonju: 146,   // 전주총국(전북)
    gwangju: 156,  // 광주총국(광주/전남)
    jeju: 184,     // 제주총국(제주)
    chuncheon: 105, // 춘천총국(강원 - 강릉/춘천)
    daegu: 143,    // 대구총국(대구/경북)
    busan: 159,    // 부산총국(부산/울산/경남동부)
    changwon: 159  // 창원총국(경남서부/남해안) - 부산청 통합 관리
  };
  return stnMap[regionId] ?? 108;
};

/**
 * 기상청 raw 데이터를 파싱하여 전체 보고서 내용을 추출하는 공통 함수.
 */
const parseKmaReport = (rawData, targetStn, subTitleIndex = 9) => {
  if (!rawData) return { content: '', tmfc: '' };
  
  const blocks = rawData.split('$').filter(b => b.trim().length > 0);
  let reportsByTmfc = {}; 
  let activeStnReport = null;

  for (const block of blocks) {
    const fields = block.split('#');
    const recordIndex = fields[0];

    if (recordIndex === '0') {
      const stn = parseInt(fields[1], 10);
      const tmfc = fields[2]; 

      if (stn === targetStn || (targetStn === 0 && stn === 108)) {
        // subTitleIndex 이후부터가 본문 혹은 제목임
        const title = fields.slice(subTitleIndex).join('#').trim();
        
        if (!reportsByTmfc[tmfc]) reportsByTmfc[tmfc] = [];
        
        activeStnReport = { contentParts: [title], tmfc };
        reportsByTmfc[tmfc].push(activeStnReport);
      } else {
        activeStnReport = null;
      }
    } else if (activeStnReport && !isNaN(parseInt(recordIndex))) {
      const fragment = fields.slice(1).join('#').trim();
      if (fragment.length > 0) {
        activeStnReport.contentParts.push(fragment);
      }
    }
  }

  const sortedTmfcs = Object.keys(reportsByTmfc).sort().reverse();
  if (sortedTmfcs.length === 0) {
    return { content: `지점번호 ${targetStn}의 최신 통보문이 없습니다.`, tmfc: '' };
  }

  const latestTmfc = sortedTmfcs[0];
  const latestReportGroup = reportsByTmfc[latestTmfc][0];
  let fullContent = latestReportGroup.contentParts.join('\n\n');
  
  // 가독성 확보 및 불필요한 기호(7777END, =, # 등) 제거
  const finalContent = fullContent
    .replace(/#/g, '\n\n')
    .replace(/\n\n\n+/g, '\n\n')
    .replace(/7777END/g, '')
    .replace(/[=#\s]+$/, '')
    .trim();

  return {
    content: finalContent,
    tmfc: latestTmfc
  };
};

/**
 * 날짜 포맷팅 (YYYYMMDDHHMM -> YYYY.MM.DD HH:mm 발표)
 */
const formatDisplayTime = (tmfc, fallbackDate) => {
    if (tmfc && tmfc.length >= 10) {
        const year = tmfc.substring(0, 4);
        const month = tmfc.substring(4, 6);
        const day = tmfc.substring(6, 8);
        const hour = tmfc.substring(8, 10);
        const min = tmfc.length >= 12 ? tmfc.substring(10, 12) : '00';
        return `${year}.${month}.${day} ${hour}:${min} 발표`;
    }
    return `${fallbackDate.getHours()}시 기준 업데이트`;
};

/**
 * 예보 > 날씨해설 전문(Text) 데이터를 가져오는 함수 (wthr_cmt_rpt.php)
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    const yesterday = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const tmfc1 = formatToKMATime(yesterday);
    const stn = getStnByRegion(regionId);

    const url = `/api/kma/api/typ01/url/wthr_cmt_rpt.php?tmfc1=${tmfc1}&tmfc2=${tmfc2}&stn=${stn}&subcd=12&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP Error Status: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const rawText = new TextDecoder('euc-kr').decode(arrayBuffer);
    
    const { content, tmfc } = parseKmaReport(rawText, stn, 9);

    return [{
        id: `api-commentary-${regionId}-${tmfc || now.getTime()}`,
        title: '오늘의 단기 예보 날씨해설 (기상청)',
        time: formatDisplayTime(tmfc, now),
        content: content,
        region: regionId === 'all' ? '전국' : '해당 총국'
    }];
  } catch (error) {
    console.error('[API Fetch Error] 날씨해설 실패', error);
    throw new Error('기상청 날씨해설 서버 응답 오류');
  }
};

/**
 * 예보 > 통보문 전문(Text) 데이터를 가져오는 함수 (fct_afs_ds.php)
 */
export const fetchWeatherDoc = async (regionId) => {
  try {
    const now = new Date();
    // 통보문 API는 보통 시각 형식이 YYYYMMDDHH로 짧을 수 있음
    const tmfc2 = formatToKMATime(now).substring(0, 10);
    const yesterday = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const tmfc1 = formatToKMATime(yesterday).substring(0, 10);
    
    const stn = getStnByRegion(regionId);

    const url = `/api/kma/api/typ01/url/fct_afs_ds.php?tmfc1=${tmfc1}&tmfc2=${tmfc2}&stn=${stn}&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP Error Status: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const rawText = new TextDecoder('euc-kr').decode(arrayBuffer);
    
    // 통보문은 메타데이터 필드가 7개임 (fields[6]까지가 메타데이터, 7부터 본문)
    const { content, tmfc } = parseKmaReport(rawText, stn, 7);

    return [{
        id: `api-doc-${regionId}-${tmfc || now.getTime()}`,
        title: '기상청 공식 기상 통보문',
        time: formatDisplayTime(tmfc, now),
        content: content,
        region: regionId === 'all' ? '전국' : '해당 총국'
    }];
  } catch (error) {
    console.error('[API Fetch Error] 통보문 실패', error);
    throw new Error('기상청 통보문 서버 응답 오류');
  }
};

const getBroadRegion = (regUpKo, regKo) => {
  const fullStr = `${regUpKo} ${regKo}`;
  if (fullStr.includes('서해') && fullStr.includes('앞바다')) return '서해 앞바다';
  if (fullStr.includes('서해') && fullStr.includes('먼바다')) return '서해 먼바다';
  if (fullStr.includes('남해') && fullStr.includes('앞바다')) return '남해 앞바다';
  if (fullStr.includes('남해') && fullStr.includes('먼바다')) return '남해 먼바다';
  if (fullStr.includes('동해') && fullStr.includes('앞바다')) return '동해 앞바다';
  if (fullStr.includes('동해') && fullStr.includes('먼바다')) return '동해 먼바다';
  if (fullStr.includes('제주') && fullStr.includes('앞바다')) return '제주 앞바다';
  if (fullStr.includes('제주') && fullStr.includes('먼바다')) return '제주 먼바다';
  
  if (fullStr.includes('울릉도') || fullStr.includes('독도')) return '경북';
  if (fullStr.includes('흑산도') || fullStr.includes('홍도')) return '전남';
  if (fullStr.includes('서해5도')) return '인천';
  
  let broad = regUpKo;
  broad = broad.replace('경상북도', '경북').replace('경상남도', '경남')
               .replace('전북자치도', '전북').replace('전라북도', '전북')
               .replace('전라남도', '전남')
               .replace('충청북도', '충북').replace('충청남도', '충남')
               .replace('제주도', '제주도');
  if (broad.endsWith('도') && broad.length > 2) broad = broad.substring(0, broad.length - 1);
  if (broad.endsWith('특별시') || broad.endsWith('광역시')) broad = broad.substring(0, 2); 
  return broad;
};

const formatDetailOcean = (str) => {
  let res = str.replace(/^(서해|남해|동해|제주도|제주)/, '');
  res = res.replace(/(남동쪽|남서쪽|북동쪽|북서쪽|남쪽|북쪽|동쪽|서쪽|남동|남서|북동|북서|남부|북부|중부|동부|서부)/g, '$1 ')
           .replace(/(안쪽|바깥|앞|먼)/g, '$1 ')
           .replace(/\s+/g, ' ').trim();
  res = res.replace(/먼 바다/g, '먼바다').replace(/앞 바다/g, '앞바다').trim();
  return res;
};

const formatDetailLand = (str) => {
  let res = str;
  res = res.replace(/^(강원도|강원|경기도|경기|충청남도|충남|충청북도|충북|전라남도|전남|전북자치도|전라북도|전북|경상남도|경남|경상북도|경북|제주도|제주|서울특별시|서울|인천광역시|인천|대전광역시|대전|대구광역시|대구|부산광역시|부산|울산광역시|울산|광주광역시|광주|세종특별자치시|세종)/, '');
  res = res.replace(/\./g, '·');
  if (!res.trim()) return str.replace(/\./g, '·');
  return res.trim();
};

/**
 * 기상청 특보 및 예비특보 실황(wrn_now_data.php) 페칭 함수
 */
export const fetchWeatherWarnings = async (regionId) => {
  try {
    const url = `/api/kma/api/typ01/url/wrn_now_data.php?fe=f&tm=&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP Error Status: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const rawText = new TextDecoder('euc-kr').decode(arrayBuffer);
    
    const lines = rawText.split('\n');
    const records = [];
    
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const fields = line.split(',').map(s => s.trim());
      if (fields.length >= 10) {
        records.push({
          regUpKo: fields[1],
          regKo: fields[3],
          tmFc: fields[4],
          tmEf: fields[5],
          wrn: fields[6],
          lvl: fields[7],
          cmd: fields[8],
          edTm: fields[9]
        });
      }
    }
    
    const currentMap = new Map();
    const prelimMap = new Map();
    
    const targetRegionObj = REGIONS.find(r => r.id === regionId);
    
    records.forEach(rec => {
      // 해상 특보 필터링 규칙 (전국 'all' 일 때만 표시)
      const isMarine = /해상|바다|앞바다|먼바다/.test(rec.regUpKo) || /해상|바다|앞바다|먼바다/.test(rec.regKo);
      if (isMarine && regionId !== 'all') return;
      
      // 내륙 특보 필터링 규칙 (all이 아닐 경우 키워드 매칭)
      if (!isMarine && regionId !== 'all') {
        if (targetRegionObj && targetRegionObj.keywords.length > 0) {
          const match = targetRegionObj.keywords.some(kw => 
            rec.regUpKo.includes(kw) || rec.regKo.includes(kw)
          );
          if (!match) return; // 포함 안 되면 건너뜀
        }
      }
      
      // 예비특보 분리 규칙 (TM_EF 끝자리가 59 또는 58)
      const isPreliminary = rec.tmEf.endsWith('59') || rec.tmEf.endsWith('58');
      const targetMap = isPreliminary ? prelimMap : currentMap;
      
      const levelText = rec.lvl === '주의' ? '주의보' : (rec.lvl === '경보' ? '경보' : rec.lvl);
      const typeName = `${rec.wrn} ${levelText}`;
      
      const detailFull = rec.regKo || rec.regUpKo;
      const broadReg = getBroadRegion(rec.regUpKo, detailFull);
      let detailReg = detailFull;

      if (isMarine) {
        detailReg = formatDetailOcean(detailReg);
      } else {
        detailReg = formatDetailLand(detailReg);
      }

      if (!targetMap.has(typeName)) {
        targetMap.set(typeName, new Map());
      }
      
      const broadMap = targetMap.get(typeName);
      if (!broadMap.has(broadReg)) {
        broadMap.set(broadReg, new Set());
      }
      
      broadMap.get(broadReg).add(detailReg);
    });
    
    // 이중 Map(Type -> Broad)을 가공
    const formatOutput = (map) => {
      const result = [];
      let idx = 0;
      for (const [typeName, broadMap] of map.entries()) {
        const broadGroups = [];
        for (const [broadReg, detailSet] of broadMap.entries()) {
           const details = Array.from(detailSet).filter(d => d && d !== broadReg);
           if (details.length === 0) {
             broadGroups.push(`${broadReg}`);
           } else {
             broadGroups.push(`${broadReg}(${details.join('·')})`);
           }
        }
        
        result.push({
          id: `warn-${Date.now()}-${idx++}-${Math.random().toString(36).substr(2, 5)}`,
          type: typeName,
          time: '',
          content: broadGroups.map(bg => '▶ ' + bg).join('\n')
        });
      }
      return result;
    };
    
    return {
      current: formatOutput(currentMap),
      preliminary: formatOutput(prelimMap)
    };
  } catch (error) {
    console.error('[API Fetch Error] 특보/예비특보 실패', error);
    throw new Error('기상청 특보 서버 응답 오류');
  }
};

/**
 * 기상특보 종합 상황도 이미지 URL 반환
 */
export const getWarningImageUrl = (trigger = 0) => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = padZero(now.getMonth() + 1);
  const dd = padZero(now.getDate());
  const hh = padZero(now.getHours());
  const mi = padZero(now.getMinutes());
  const tmStr = `${yyyy}${mm}${dd}${hh}${mi}`;

  return `/api/kma/api/typ03/cgi/wrn/nph-wrn7?out=0&tmef=1&city=1&name=0&tm=${tmStr}&lon=127.7&lat=36.1&range=300&size=685&wrn=W,R,C,D,O,V,T,S,Y,H,&authKey=${KMA_AUTH_KEY}&_ts=${trigger}`;
};
