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
 * 각 총국(regionId)에 맞는 기상청 STN(발표관서) 코드 맵핑
 * 전국: 108 (전국 요약) / 본사: 109 (서울/인천/경기)
 * 춘천: 105 (강원) / 대전: 133 (충남/대전) / 청주: 131 (충북)
 * 전주: 146 (전북) / 광주: 156 (전남/광주) / 제주: 184 (제주)
 * 대구: 143 (경북/대구) / 부산: 159 (경남/부산/울산) / 창원: 159 (경남)
 */
const getStnByRegion = (regionId) => {
  const stnMap = {
    all: 108,
    hq: 109,
    chuncheon: 105,
    daejeon: 133,
    cheongju: 131,
    jeonju: 146,
    gwangju: 156,
    jeju: 184,
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
  
  // 사용자 지침: $X#STN#... 형태의 구분자를 찾고, 해당 구분자부터 다음 구분자가 나오기 전까지의 모든 텍스트를 추출함
  // Metadata fields(9개)를 제외한 나머지 모든 텍스트를 조인
  
  // 1. 모든 레코드 블록 분리 ($ 기호 기준)
  const blocks = rawData.split('$');
  let targetBlocks = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // 레코드 시작 포맷 확인: "번호#지점번호#"
    // 예: "0#105#2026..."
    const fields = block.split('#');
    
    // fields[0]은 레코드 번호, fields[1]은 STN (지점번호)
    if (fields.length > 2 && parseInt(fields[1], 10) === targetStn) {
      // 9번째 필드(인덱스 9)부터가 실제 본문 및 제목 내용임
      // 제목과 여러 본문 섹션이 '#'로 구분되어 들어오므로, 이를 모두 합쳐서 표출
      const content = fields.slice(9).join('\n\n').trim();
      if (content.length > 0) {
        targetBlocks.push(content);
      }
    }
  }

  if (targetBlocks.length === 0) {
    return `지점번호 ${targetStn}에 대한 최신 기상 예보 전문이 없습니다.`;
  }

  // 가장 최신(마지막) 레코드 반환
  // 내부의 잔여 '#' 기호가 있다면 줄바꿈으로 통일하여 <중점 사항> 등이 잘 보이도록 처리
  return targetBlocks[targetBlocks.length - 1].replace(/#/g, '\n\n').trim();
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    // 데이터를 충분히 확보하기 위해 48시간 전부터 조회함
    const yesterday = new Date(now.getTime() - 48 * 60 * 60 * 1000);
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
    
    // 본문 추출 및 파싱
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
