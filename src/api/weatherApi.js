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
 * 기상청 raw 데이터를 파싱하여 본문 내용만 추출하는 함수 (기상청 typ01 wthr_cmt_rpt 포맷 특화)
 * @param {string} rawData - EUC-KR로 디코딩된 기상청 데이터
 * @param {number} targetStn - 필터링할 발표 관서 코드
 * @returns {string} 파싱된 날씨 해설 내용
 */
const parseKmaReport = (rawData, targetStn) => {
  if (!rawData) return '';
  
  // 기상청 wthr_cmt_rpt 포맷은 '본문 $0#Metadata# 본문 $1#Metadata#' 형태인 경우와
  // '#Header $0#Metadata# 본문' 형태인 경우가 있으나, 사용자 피드백에 따르면
  // 본문이 $0# 앞에 위치하는 구조임.
  const records = rawData.split('$');
  
  let targetRecordIndex = -1;
  // 최신 데이터를 위해 뒤에서부터 매칭되는 STN 레코드 탐색
  for (let i = records.length - 1; i >= 1; i--) {
    const meta = records[i];
    // 레코드 메타데이터 예: "0#108#202603301610#...#12#"
    if (meta.includes(`#${targetStn}#`)) {
      targetRecordIndex = i;
      break;
    }
  }

  // 매칭되는 레코드를 찾지 못한 경우
  if (targetRecordIndex === -1) {
    return '현재 선택된 지역(STN ' + targetStn + ')의 최신 날씨 해설 정보를 찾을 수 없습니다.';
  }

  // targetRecordIndex 가 가리키는 실제 텍스트는 그 '앞' 블록에 있음
  let rawContent = records[targetRecordIndex - 1];
  
  // 1. '#'으로 시작하는 상단 주석/헤더 라인들 제거
  let lines = rawContent.split('\n').filter(line => !line.trim().startsWith('#'));
  let content = lines.join('\n').trim();
  
  // 2. 만약 이전 레코드의 메타데이터가 섞여있다면 (targetRecordIndex > 1) 
  // 해당 블록은 "X#STN#...#9# CONTENT" 형태이므로 마지막 '#' 이후만 추출
  if (targetRecordIndex > 1) {
    const lastHashIndex = content.lastIndexOf('#');
    if (lastHashIndex !== -1) {
      content = content.substring(lastHashIndex + 1).trim();
    }
  }

  return content || '날씨 해설 본문 내용이 존재하지 않습니다.';
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    // 단기 전망 데이터 확보를 위해 넉넉히 24시간 전부터 조회
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tmfc1 = formatToKMATime(yesterday);
    
    const stn = getStnByRegion(regionId);
    
    // subcd=12 (단기 전망) 요청
    const subcd = 12;

    const url = `/api/kma/api/typ01/url/wthr_cmt_rpt.php?tmfc1=${tmfc1}&tmfc2=${tmfc2}&stn=${stn}&subcd=${subcd}&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP Error Status: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const rawText = decoder.decode(arrayBuffer);
    
    // 수정된 파싱 로직 적용
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
