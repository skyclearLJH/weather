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
  
  // 기상청 wthr_cmt_rpt 포맷은 필드 수 제한으로 인해 하나의 긴 보고서가 
  // 여러 개의 레코드($0#, $1#, $2#...)로 쪼개져 있는 경우가 많음.
  // 동일한 STN(지점)을 가진 모든 레코드의 텍스트를 하나로 합쳐야 함.
  
  const blocks = rawData.split('$');
  let resultParts = [];
  let latestTmfc = "";

  // 1. 모든 레코드 블록을 순회하며 대상 지점(targetStn)과 매칭되는 데이터 수집
  for (let i = 0; i < blocks.length; i++) {
     const fields = blocks[i].split('#');
     // fields[0]: 레코드 인덱스, fields[1]: STN, fields[2]: TM_FC (발표시각)
     if (fields.length > 3 && parseInt(fields[1], 10) === targetStn) {
        const tmfc = fields[2];
        
        // 새로운 타임스탬프가 발견되면 (더 최신일 경우) 기존 데이터를 비우고 갱신 전략
        // 기상청 API는 보통 정렬되어 오므로, 가장 최근 시각의 뭉치를 가져옴
        if (tmfc > latestTmfc) {
          latestTmfc = tmfc;
          resultParts = [];
        }

        // 현재 블록의 시각이 최신 시각과 같다면 본문을 추가
        if (tmfc === latestTmfc) {
           // 9번째 '#' 이후부터가 실제 본문 및 제목 내용임
           const content = fields.slice(9).join('#').trim();
           if (content.length > 0) {
             resultParts.push(content);
           }
        }
     }
  }

  if (resultParts.length === 0) return '해당 지점의 최신 날씨 해설 정보를 기상청에서 찾을 수 없습니다.';

  // 2. 조각난 본문들을 하나로 합치고 기상청 구분자(#)를 가독성을 위해 줄바꿈으로 변환
  // 사용자가 제공한 <중점 사항> 등의 태그 앞뒤에 줄바꿈이 생겨 가독성이 살아남.
  let fullText = resultParts.join('\n\n');
  
  // 내부 기호 및 잔여 # 처리
  // 본문 중간의 # 도 줄바꿈으로 변환하여 제목#본문 구조를 보기 좋게 만듦
  return fullText.replace(/#/g, '\n\n').trim();
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
