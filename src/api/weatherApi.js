import { KMA_AUTH_KEY } from '../utils/constants';

/**
 * 10보다 작은 숫자에 0을 붙여 2자리로 만드는 헬퍼 함수
 */
const padZero = (num) => num.toString().padStart(2, '0');

/**
 * 날짜 객체를 YYYYMMDDHHMM 포맷 문자열로 변환
 */
const formatDateForApi = (date) => {
  const yyyy = date.getFullYear();
  const mm = padZero(date.getMonth() + 1);
  const dd = padZero(date.getDate());
  const hh = padZero(date.getHours());
  const mins = padZero(date.getMinutes());
  return `${yyyy}${mm}${dd}${hh}${mins}`;
};

/**
 * 기상청 날씨해설 전문(Text) 데이터를 가져오는 함수
 */
export const fetchWeatherCommentary = async () => {
  try {
    const now = new Date();
    const tmfc2 = formatDateForApi(now);

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tmfc1 = formatDateForApi(yesterday);

    const url = `https://apihub.kma.go.kr/api/typ01/url/wthr_cmt_rpt.php?tmfc1=${tmfc1}&tmfc2=${tmfc2}&stn=0&subcd=0&disp=0&help=1&authKey=${KMA_AUTH_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP Error Status: ${response.status}`);
    }

    const textData = await response.text();
    
    // Convert text to our internal card format
    // Real data usually comes with headers or just plain text block lines.
    // For weather commentary, we treat the entire payload as one big text block if needed.
    return [
      {
        id: 'api-commentary-1',
        title: '오늘의 날씨해설 (기상청)',
        time: `${now.getHours()}시 ${padZero(now.getMinutes())}분 기준`,
        content: textData.trim(),
        region: '전국'
      }
    ];

  } catch (error) {
    console.error('[API Fetch Error] 날씨해설 데이터를 가져오는 데 실패했습니다 (인증키 또는 네트워크 오류).', error);
    throw new Error('기상청 서버 응답 오류');
  }
};
