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
    all: 0,
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
  return stnMap[regionId] ?? 0;
};

/**
 * 기상청 raw 데이터를 파싱하여 본문 내용만 추출하는 함수
 * @param {string} rawData - EUC-KR로 디코딩된 기상청 데이터
 * @param {number} targetStn - 필터링할 발표 관서 코드
 * @returns {string} 파싱된 날씨 해설 내용
 */
const parseKmaReport = (rawData, targetStn) => {
  if (!rawData) return '';
  
  // 1. '#'으로 시작하는 상단 주석 라인들 제거
  const lines = rawData.split('\n');
  const contentLines = lines.filter(line => !line.trim().startsWith('#'));
  const cleanedData = contentLines.join('\n');
  
  // 2. '$'로 레코드 구분
  const records = cleanedData.split('$').filter(r => r.trim().length > 0);
  
  let finalContent = '';
  
  for (const record of records) {
    // 레코드 형태: X#STN#TM_FC#...#CONTENT#
    // '#'으로 필드 구분
    const fields = record.split('#');
    
    // 만약 데이터가 너무 짧으면 무시
    if (fields.length < 5) continue;
    
    const recordStn = parseInt(fields[1], 10);
    
    // 타겟 지점번호(STN)가 일치하는지 확인 (targetStn이 0이면 전국용으로 첫번째 레코드 사용)
    if (targetStn === 0 || recordStn === targetStn) {
      // 9번째 '#' 이후부터가 실제 본문 내용 (사용자 스니펫 및 기상청 문서 참고)
      // 레코드 헤더가 'X#STN#TM_FC#TM_EF#...#9#' 형태인 경우 index 9번 이후를 모두 합침
      // 기상청 wthr_cmt_rpt 포맷상 보통 9번째 필드 이후가 본문 시작입니다.
      // 또는 마지막 '#'를 찾아서 그 이후를 가져오는 방식이 더 안전할 수도 있습니다.
      
      const content = fields.slice(9).join('#').trim();
      
      // 만약 내용이 있으면 반환 (내용이 비어있는 경우 여러 레코드 중 있는 것을 찾음)
      if (content.length > 10) {
        finalContent = content;
        break; 
      }
    }
  }
  
  return finalContent || '해당하는 날씨 해설 정보가 없습니다.';
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tmfc1 = formatToKMATime(yesterday);
    
    // 발표관서 코드 가져오기
    const stn = getStnByRegion(regionId);

    // CORS 이슈 방지를 위해 vite.config.js에 설정한 /api/kma 프록시 경로 사용
    const url = `/api/kma/api/typ01/url/wthr_cmt_rpt.php?tmfc1=${tmfc1}&tmfc2=${tmfc2}&stn=${stn}&subcd=0&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP Error Status: ${response.status}`);
    }

    // EUC-KR 디코딩을 위해 ArrayBuffer로 받음
    const arrayBuffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const rawText = decoder.decode(arrayBuffer);
    
    // 본문 내용만 추출
    const parsedContent = parseKmaReport(rawText, stn);

    // 내부 카드 포맷으로 변환
    return [
      {
        id: `api-commentary-${regionId}-${now.getTime()}`,
        title: '오늘의 날씨해설 (기상청)',
        time: `${now.getHours()}시 기준`,
        content: parsedContent,
        region: regionId === 'all' ? '전국' : '해당 총국'
      }
    ];

  } catch (error) {
    console.error('[API Fetch Error] 날씨해설 데이터를 가져오는 데 실패했습니다.', error);
    throw new Error('기상청 서버 응답 오류');
  }
};
