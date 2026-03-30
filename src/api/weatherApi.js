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
 * 각 총국(regionId)에 맞는 기상청 STN(발표관서) 코드 맵핑 (부산, 창원은 둘다 159)
 */
const getStnByRegion = (regionId) => {
  const stnMap = {
    all: 108, // 전국은 서울(108) 기준
    hq: 109,
    daejeon: 133,
    cheongju: 131,
    jeonju: 146,
    gwangju: 156,
    jeju: 184,
    chuncheon: 105,
    daegu: 143,
    busan: 159,
    changwon: 159
  };
  return stnMap[regionId] ?? 108;
};

/**
 * 기상청 raw 데이터를 파싱하여 본문 내용만 추출하는 함수
 * @param {string} rawData - EUC-KR로 디코딩된 기상청 데이터
 * @param {number} targetStn - 필터링할 발표 관서 코드
 * @returns {string} 파싱된 날씨 해설 내용
 */
const parseKmaReport = (rawData, targetStn) => {
  if (!rawData) return '';
  
  // 기상청 wthr_cmt_rpt 포맷은 '본문 $0#Metadata#' 형태로, 본문이 메타데이터 '앞'에 위치함.
  // 즉, $0 로 split 했을 때 index 0 번이 $0 메타데이터가 설명하는 텍스트임.
  const blocks = rawData.split('$');
  
  let targetBlockIndex = -1;
  // 최신 데이터를 위해 뒤에서부터 검색
  for (let i = blocks.length - 1; i >= 1; i--) {
    const fields = blocks[i].split('#');
    // fields[0]은 인덱스(0, 1...), fields[1]은 STN 지점번호
    if (fields.length > 2 && parseInt(fields[1], 10) === targetStn) {
      targetBlockIndex = i;
      break;
    }
  }

  if (targetBlockIndex === -1) {
    return '현재 지점(STN ' + targetStn + ')의 최신 예보 정보를 기상청에서 찾을 수 없습니다.';
  }

  // targetBlockIndex 레코드가 설명하는 텍스트는 그 '앞' 블록에 있음
  let content = blocks[targetBlockIndex - 1];
  
  // 1. 만약 헤더가 포함된 첫 블록(index 0)인 경우 # 시작 라인들 제거
  if (targetBlockIndex === 1) {
    content = content.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').trim();
  } else {
    // 이전 레코드의 메타데이터(예: 0#108#...#9#)를 건너뛰어야 함
    const fieldsPrev = content.split('#');
    if (fieldsPrev.length >= 9) {
      // 9번째 '#' 이후부터가 본문임
      content = fieldsPrev.slice(9).join('#').trim();
    }
  }

  // 2. 기상청 특유의 '#' 구분자 처리
  // 본문 내에 위치한 '#' 기호는 사실상 섹션 구분자(엔터) 역할을 하므로 줄바꿈으로 치환
  // 이를 통해 <중점 사항>, <하늘상태 및 강수> 등이 올바르게 표출됨
  return content.replace(/#/g, '\n\n').trim();
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    const yesterday = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const tmfc1 = formatToKMATime(yesterday);
    
    const stn = getStnByRegion(regionId);
    const subcd = 12; // 단기 전망 고정

    const url = `/api/kma/api/typ01/url/wthr_cmt_rpt.php?tmfc1=${tmfc1}&tmfc2=${tmfc2}&stn=${stn}&subcd=${subcd}&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP Error Status: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const rawText = decoder.decode(arrayBuffer);
    
    const parsedContent = parseKmaReport(rawText, stn);

    // 내부 카드 포맷으로 변환
    return [
      {
        id: `api-commentary-${regionId}-${now.getTime()}`,
        title: '오늘의 단기 예보 날씨해설 (기상청)',
        time: `${now.getHours()}시 기준 업데이트`,
        content: parsedContent,
        region: regionId === 'all' ? '전국' : '해당 총국'
      }
    ];

  } catch (error) {
    console.error('[API Fetch Error] 날씨해설 데이터를 가져오는 데 실패했습니다.', error);
    throw new Error('기상청 서버 응답 오류');
  }
};
