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
 * 기상청 raw 데이터를 파싱하여 전체 보고서 내용을 추출하는 함수.
 * 기상청 typ01 wthr_cmt_rpt 포맷은 한 리포트가 여러 레코드($0, $1, $2...)로 분절되어 들어옴.
 * $0는 메타데이터와 제목을 포함하고, $1 이후는 본문 파편들을 포함함.
 * 
 * @param {string} rawData - EUC-KR로 디코딩된 기상청 데이터
 * @param {number} targetStn - 필터링할 발표 관서 코드
 * @returns {string} 파싱된 전체 날씨 해설 내용 (제목 + 본문 조각 전체)
 */
const parseKmaReport = (rawData, targetStn) => {
  if (!rawData) return '';
  
  // 1. 레코드 단위($ 기호)로 분할
  const blocks = rawData.split('$').filter(b => b.trim().length > 0);
  
  // 동일한 시각(TM_FC)에 발표된 레코드들을 그룹화하여 저장
  let reportsByTmfc = {}; 
  let activeStnReport = null;

  for (const block of blocks) {
    // # 기호로 필드 분할
    const fields = block.split('#');
    const recordIndex = fields[0];

    // 만약 $0# 으로 시작하면 새로운 리포트의 메타데이터임
    if (recordIndex === '0') {
      const stn = parseInt(fields[1], 10);
      const tmfc = fields[2]; // 발표 시각

      // 우리가 찾는 지점(targetStn)이거나 전국(0)인 경우 캡처 시작
      if (stn === targetStn || (targetStn === 0 && stn === 108)) {
        // 인덱스 9번부터가 제목임
        const title = fields.slice(9).join('#').trim();
        
        if (!reportsByTmfc[tmfc]) reportsByTmfc[tmfc] = [];
        
        activeStnReport = { contentParts: [title], tmfc };
        reportsByTmfc[tmfc].push(activeStnReport);
      } else {
        // 다른 지점 데이터면 캡처 중단
        activeStnReport = null;
      }
    } else if (activeStnReport && !isNaN(parseInt(recordIndex))) {
      // $0# 이 아닌 $1#, $2# 등의 레코드 조각인 경우
      // 현재 추적 중인 리포트(activeStnReport)가 있다면 그 본문 발췌
      // $1# 이후부터는 인덱스 1번부터가 실제 텍스트 내용임
      const fragment = fields.slice(1).join('#').trim();
      if (fragment.length > 0) {
        activeStnReport.contentParts.push(fragment);
      }
    }
  }

  // 2. 가장 최신 발표 시각(TM_FC)의 리포트 선택
  const sortedTmfcs = Object.keys(reportsByTmfc).sort().reverse();
  if (sortedTmfcs.length === 0) {
    return `선택한 지역(지점번호 ${targetStn})의 예보 통보문이 없습니다.`;
  }

  const latestTmfc = sortedTmfcs[0];
  const latestReportGroup = reportsByTmfc[latestTmfc][0]; // 같은 시간대에 하나만 있다고 가정

  // 3. 수집된 모든 조각(제목 + 본문 파편)을 조인하고 내부의 # 기호를 줄바꿈으로 치환
  let fullContent = latestReportGroup.contentParts.join('\n\n');
  
  // 기상청은 내부 단락 구분에 # 를 사용하므로 이를 줄바꿈으로 변경하여 가독성 확보
  return fullContent.replace(/#/g, '\n\n').replace(/\n\n\n+/g, '\n\n').replace(/[=#]+$/, '').trim();
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async (regionId) => {
  try {
    const now = new Date();
    const tmfc2 = formatToKMATime(now);
    // 충분한 데이터 확보를 위해 48시간 전부터의 데이터를 조회
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
    
    // 조각난 레코드 조각들을 모두 합치는 개선된 파싱 로직 적용
    const parsedContent = parseKmaReport(rawText, stn);

    // 내부 카드 포맷으로 반환
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
