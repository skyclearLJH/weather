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
 * 각 총국(regionId)에 맞는 기상청 STN(발표관서) 코드 맵팅 (부산, 창원은 둘다 159)
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
  
  // 1. '#'으로 시작하는 상단 주석 라인들 제거
  const lines = rawData.split('\n');
  const contentLines = lines.filter(line => !line.trim().startsWith('#'));
  const cleanedData = contentLines.join('\n');
  
  // 2. '$'로 레코드 구분
  const records = cleanedData.split('$').filter(r => r.trim().length > 0);
  
  if (records.length === 0) return '현재 시간대에 해당하는 날씨 해설 정보가 없습니다.';

  // 가장 최신 데이터를 가져오기 위해 뒤에서부터 검색 (기상청 API는 보통 시간순 정렬)
  // targetStn이 매칭되는 가장 마지막 레코드를 선택
  let latestRecord = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const fields = record.split('#');
    if (fields.length < 5) continue;
    
    const recordStn = parseInt(fields[1], 10);
    // STN 0인 경우는 전체 검색용이지만, 우리는 특정 지점 데이터를 가져옴
    if (recordStn === targetStn || targetStn === 0) {
      latestRecord = record;
      break;
    }
  }
  
  if (!latestRecord) return '해당 지점의 날씨 해설 정보를 찾을 수 없습니다.';

  const fields = latestRecord.split('#');
  
  // 기상청 wthr_cmt_rpt 포맷상 보통 9번째 필드 이후가 본문 시작입니다.
  // 단기 전망(subcd=12) 등의 경우 필드 구성이 조금씩 다를 수 있으나, 
  // 보통 마지막 메타데이터 필드 이후가 본문입니다.
  // 사용자 피드백에 따르면 제목만 나왔다고 하므로, 뒤의 모든 필드를 합쳐서 보여줍니다.
  
  const content = fields.slice(9).join('#').trim();
  
  // 만약 마지막에 '#'가 남았다면 제거 (기상청 데이터 끝자락 특성)
  return content.replace(/#$/, '').trim();
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    // 단기 전망을 위해 검색 범위를 조금 넉넉히 (24시간 전부터)
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tmfc1 = formatToKMATime(yesterday);
    
    const stn = getStnByRegion(regionId);
    
    // subcd=12 (단기 전망) 고정
    const subcd = 12;

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
