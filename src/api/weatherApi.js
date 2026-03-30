import { KMA_AUTH_KEY } from '../utils/constants';

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
