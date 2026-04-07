export const INITIAL_TABS = [
  { id: 'forecast', label: '예보' },
  { id: 'warning', label: '특보' },
  { id: 'precipitation', label: '강수량' },
  { id: 'minTemp', label: '최저기온' },
  { id: 'maxTemp', label: '최고기온' },
  { id: 'snow', label: '적설량' },
];

export const REGIONS = [
  { id: 'all', label: '전국', keywords: [] },
  { id: 'hq', label: '본사', keywords: ['서울', '인천', '경기', '서해5도'] },
  { id: 'daejeon', label: '대전총국', keywords: ['대전', '세종', '충청남도', '충남'] },
  { id: 'cheongju', label: '청주총국', keywords: ['충청북도', '충북'] },
  { id: 'jeonju', label: '전주총국', keywords: ['전라북도', '전북'] },
  { id: 'gwangju', label: '광주총국', keywords: ['광주', '전라남도', '전남', '흑산도.홍도'] },
  { id: 'jeju', label: '제주총국', keywords: ['제주'] },
  { id: 'chuncheon', label: '춘천총국', keywords: ['강원'] },
  { id: 'daegu', label: '대구총국', keywords: ['대구', '경상북도', '경북', '울릉도.독도'] },
  { id: 'busan', label: '부산총국', keywords: ['부산', '울산'] },
  { id: 'changwon', label: '창원총국', keywords: ['경상남도', '경남'] },
];

export const SUB_MENUS = {
  forecast: [
    { id: 'doc', label: '통보문' },
    { id: 'commentary', label: '날씨해설' },
  ],
  warning: [
    { id: 'current', label: '특보' },
    { id: 'preliminary', label: '예비특보' },
  ],
  precipitation: [
    { id: '1h', label: '1시간 강수량' },
    { id: 'today', label: '오늘 강수량' },
    { id: 'since_yesterday', label: '어제부터 강수량' },
  ],
  minTemp: [
    { id: 'current', label: '현재 최저기온' },
    { id: 'today', label: '오늘 최저기온' },
  ],
  maxTemp: [
    { id: 'current', label: '현재 최고기온' },
    { id: 'today', label: '오늘 최고기온' },
  ],
  snow: [
    { id: 'current', label: '적설(현재)' },
    { id: 'new_today', label: '신적설(오늘)' },
  ]
};

// --- DATA SETS ---
const generateData = (base) => {
  return [...base, 
    { name: '서울', record: '-2.0°C', address: '서울특별시 종로구 송월길 52' },
    { name: '인천', record: '-1.5°C', address: '인천광역시 중구 자유공원서로' },
    { name: '수원', record: '-1.8°C', address: '경기도 수원시 권선구 권선로' },
    { name: '대전', record: '-3.0°C', address: '대전광역시 유성구 대학로' },
    { name: '천안', record: '-2.5°C', address: '충청남도 천안시 서북구 쌍용대로' },
    { name: '전주', record: '-1.0°C', address: '전북특별자치도 전주시 완산구 기린대로' },
    { name: '광주', record: '0.0°C', address: '광주광역시 북구 서하로' },
    { name: '대구', record: '-0.5°C', address: '대구광역시 동구 효동로' },
    { name: '부산', record: '2.5°C', address: '부산광역시 중구 대청로' },
    { name: '창원', record: '1.5°C', address: '경상남도 창원시 마산합포구 가포로' },
    { name: '제주', record: '5.5°C', address: '제주특별자치도 제주시 만덕로' },
  ].sort((a,b) => parseFloat(a.record) - parseFloat(b.record)).map((item, index) => ({...item, rank: index + 1}));
};

export const MOCK_MIN_TEMP_CURRENT = generateData([
  { name: '대관령', record: '-5.2°C', address: '강원특별자치도 평창군 대관령면 경강로' },
  { name: '철원', record: '-3.1°C', address: '강원특별자치도 철원군 갈말읍 명성로' },
]);

export const MOCK_MIN_TEMP_TODAY = generateData([
  { name: '태백', record: '-6.0°C', address: '강원특별자치도 태백시 천제단길' },
  { name: '대관령', record: '-5.8°C', address: '강원특별자치도 평창군 대관령면 경강로' },
]);

export const MOCK_MAX_TEMP_CURRENT = MOCK_MIN_TEMP_CURRENT.map(i => ({...i, record: (parseFloat(i.record) + 15).toFixed(1) + '°C'})).reverse().map((item, index) => ({...item, rank: index + 1}));
export const MOCK_MAX_TEMP_TODAY = MOCK_MIN_TEMP_TODAY.map(i => ({...i, record: (parseFloat(i.record) + 15).toFixed(1) + '°C'})).reverse().map((item, index) => ({...item, rank: index + 1}));

export const MOCK_PRECIPITATION_1H = generateData([{ name: '서귀포', record: '45.5mm', address: '제주특별자치도 서귀포시 신중로' }]).map(i=>({...i, record: Math.abs(parseFloat(i.record)*3).toFixed(1) + 'mm'})).reverse().map((i, idx) => ({...i, rank: idx+1}));
export const MOCK_PRECIPITATION_TODAY = MOCK_PRECIPITATION_1H.map(i=>({...i, record: (parseFloat(i.record)*4).toFixed(1) + 'mm'}));
export const MOCK_PRECIPITATION_YESTERDAY = MOCK_PRECIPITATION_1H.map(i=>({...i, record: (parseFloat(i.record)*8).toFixed(1) + 'mm'}));

export const MOCK_SNOW_CURRENT = generateData([{ name: '울릉도', record: '15.2cm', address: '경상북도 울릉군 울릉읍 도동길' }]).map(i=>({...i, record: Math.max(0, parseFloat(i.record) + 5).toFixed(1) + 'cm'})).reverse().map((i, idx) => ({...i, rank: idx+1}));
export const MOCK_SNOW_TODAY = MOCK_SNOW_CURRENT.map(i=>({...i, record: (parseFloat(i.record)*0.5).toFixed(1) + 'cm'}));


export const MOCK_FORECAST_DOC = [
  { id: 1, title: '전국 대체로 맑으나 동해안 눈/비', time: '10:00 발표', content: '오늘(30일) 전국이 대체로 맑겠으나, 동풍의 영향으로 강원 영동과 경북 동해안에는 오후까지 비나 눈이 오는 곳이 있겠습니다.', region: '전국' },
];

export const MOCK_FORECAST_COMMENTARY = [
  { id: 2, title: '찬 대륙고기압 영향, 내일 더 춥다', time: '05:00 발표', content: '북서쪽에서 찬 공기가 남하하면서 내일 아침 기온은 오늘보다 5~10도 가량 큰 폭으로 떨어지겠습니다.', region: '전국' }
];

export const MOCK_WARNING_CURRENT = [
  { id: 1, type: '대설주의보', region: '강원도', time: '09:00 발효' },
  { id: 2, type: '풍랑주의보', region: '제주도전해상', time: '08:00 발효' },
];

export const MOCK_WARNING_PRELIMINARY = [
  { id: 3, type: '한파주의보', region: '경기도, 충청북도, 춘천 등 지역 내일', time: '21:00 발효 예정' }
];
