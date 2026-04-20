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
  { id: 'jeonju', label: '전주총국', keywords: ['전북특별자치도', '전북', '전라북도'] },
  { id: 'gwangju', label: '광주총국', keywords: ['광주', '전라남도', '전남', '흑산도', '홍도'] },
  { id: 'jeju', label: '제주총국', keywords: ['제주'] },
  { id: 'chuncheon', label: '춘천총국', keywords: ['강원'] },
  { id: 'daegu', label: '대구총국', keywords: ['대구', '경상북도', '경북', '울릉도', '독도'] },
  { id: 'busan', label: '부산총국', keywords: ['부산', '울산'] },
  { id: 'changwon', label: '창원총국', keywords: ['경상남도', '경남'] },
];

export const SUB_MENUS = {
  forecast: [
    { id: 'doc', label: '통보문' },
    { id: 'commentary', label: '날씨해설' },
  ],
  warning: [
    { id: 'current', label: '현재 특보' },
    { id: 'preliminary', label: '예비특보' },
  ],
  precipitation: [
    { id: '1h', label: '1시간' },
    { id: 'today', label: '오늘 누적' },
    { id: 'since_yesterday', label: '어제부터 누적' },
  ],
  minTemp: [
    { id: 'current', label: '현재' },
    { id: 'today', label: '오늘' },
  ],
  maxTemp: [
    { id: 'current', label: '현재' },
    { id: 'today', label: '오늘' },
  ],
  snow: [
    { id: 'current', label: '현재 적설' },
    { id: 'new_today', label: '오늘 신적설' },
  ],
};

const withRanks = (items, compareFn) =>
  [...items]
    .sort(compareFn)
    .map((item, index) => ({ ...item, rank: index + 1 }));

const sortNumericAsc = (a, b) => parseFloat(a.record) - parseFloat(b.record);
const sortNumericDesc = (a, b) => parseFloat(b.record) - parseFloat(a.record);

const minCurrentBase = [
  { name: '대관령', record: '-5.2°C', address: '강원도 평창군 대관령면 경강로 5721' },
  { name: '철원', record: '-4.8°C', address: '강원도 철원군 갈말읍 명성로 179' },
  { name: '봉화', record: '-4.3°C', address: '경상북도 봉화군 봉화읍 내성로 134' },
  { name: '제천', record: '-3.8°C', address: '충청북도 제천시 의림대로 242' },
  { name: '서울', record: '-2.0°C', address: '서울시 종로구 송월길 52' },
  { name: '수원', record: '-1.8°C', address: '경기도 수원시 권선구 권선로 276' },
  { name: '전주', record: '-1.0°C', address: '전북특별자치도 전주시 완산구 기린대로 213' },
  { name: '광주', record: '0.0°C', address: '광주시 북구 서하로 172' },
  { name: '대구', record: '0.6°C', address: '대구시 동구 효동로 2길 10' },
  { name: '부산', record: '2.4°C', address: '부산시 중구 대청로 116' },
  { name: '제주', record: '5.5°C', address: '제주시 남성로 2길 18' },
];

const minTodayBase = [
  { name: '임실', record: '-6.2°C', address: '전북특별자치도 임실군 임실읍 봉황로 124' },
  { name: '대관령', record: '-5.8°C', address: '강원도 평창군 대관령면 경강로 5721' },
  { name: '철원', record: '-5.4°C', address: '강원도 철원군 갈말읍 명성로 179' },
  { name: '봉화', record: '-4.9°C', address: '경상북도 봉화군 봉화읍 내성로 134' },
  { name: '제천', record: '-4.2°C', address: '충청북도 제천시 의림대로 242' },
  { name: '서울', record: '-2.9°C', address: '서울시 종로구 송월길 52' },
  { name: '수원', record: '-2.6°C', address: '경기도 수원시 권선구 권선로 276' },
  { name: '전주', record: '-1.8°C', address: '전북특별자치도 전주시 완산구 기린대로 213' },
  { name: '광주', record: '-0.7°C', address: '광주시 북구 서하로 172' },
  { name: '대구', record: '0.2°C', address: '대구시 동구 효동로 2길 10' },
  { name: '부산', record: '1.8°C', address: '부산시 중구 대청로 116' },
];

const maxCurrentBase = [
  { name: '구미', record: '26.4°C', address: '경상북도 구미시 송원서로 7' },
  { name: '밀양', record: '26.0°C', address: '경상남도 밀양시 중앙로 265' },
  { name: '대구', record: '25.8°C', address: '대구시 동구 효동로 2길 10' },
  { name: '합천', record: '25.2°C', address: '경상남도 합천군 합천읍 동서로 95' },
  { name: '전주', record: '24.9°C', address: '전북특별자치도 전주시 완산구 기린대로 213' },
  { name: '서울', record: '24.1°C', address: '서울시 종로구 송월길 52' },
  { name: '광주', record: '23.7°C', address: '광주시 북구 서하로 172' },
  { name: '수원', record: '23.4°C', address: '경기도 수원시 권선구 권선로 276' },
  { name: '부산', record: '22.8°C', address: '부산시 중구 대청로 116' },
  { name: '강릉', record: '22.4°C', address: '강원도 강릉시 솔올로 57' },
  { name: '제주', record: '21.9°C', address: '제주시 남성로 2길 18' },
];

const maxTodayBase = [
  { name: '밀양', record: '28.6°C', address: '경상남도 밀양시 중앙로 265' },
  { name: '구미', record: '28.3°C', address: '경상북도 구미시 송원서로 7' },
  { name: '대구', record: '27.8°C', address: '대구시 동구 효동로 2길 10' },
  { name: '합천', record: '27.5°C', address: '경상남도 합천군 합천읍 동서로 95' },
  { name: '전주', record: '26.9°C', address: '전북특별자치도 전주시 완산구 기린대로 213' },
  { name: '광주', record: '26.4°C', address: '광주시 북구 서하로 172' },
  { name: '서울', record: '25.6°C', address: '서울시 종로구 송월길 52' },
  { name: '수원', record: '25.1°C', address: '경기도 수원시 권선구 권선로 276' },
  { name: '부산', record: '24.6°C', address: '부산시 중구 대청로 116' },
  { name: '강릉', record: '24.2°C', address: '강원도 강릉시 솔올로 57' },
  { name: '제주', record: '23.8°C', address: '제주시 남성로 2길 18' },
];

const precipitation1hBase = [
  { name: '관악', record: '13.0mm', address: '서울시 관악구 신림동' },
  { name: '서귀포', record: '11.8mm', address: '제주도 서귀포시 토평동' },
  { name: '해남', record: '10.6mm', address: '전라남도 해남군 해남읍' },
  { name: '부산', record: '9.7mm', address: '부산시 중구 대청동' },
  { name: '강릉', record: '8.9mm', address: '강원도 강릉시 교동' },
  { name: '광주', record: '7.8mm', address: '광주시 북구 운암동' },
  { name: '대전', record: '6.2mm', address: '대전시 유성구 구성동' },
  { name: '청주', record: '5.6mm', address: '충청북도 청주시 상당구' },
  { name: '전주', record: '4.8mm', address: '전북특별자치도 전주시 덕진구' },
  { name: '수원', record: '3.9mm', address: '경기도 수원시 권선구' },
];

export const MOCK_MIN_TEMP_CURRENT = withRanks(minCurrentBase, sortNumericAsc);
export const MOCK_MIN_TEMP_TODAY = withRanks(minTodayBase, sortNumericAsc);
export const MOCK_MAX_TEMP_CURRENT = withRanks(maxCurrentBase, sortNumericDesc);
export const MOCK_MAX_TEMP_TODAY = withRanks(maxTodayBase, sortNumericDesc);
export const MOCK_PRECIPITATION_1H = withRanks(precipitation1hBase, sortNumericDesc);
export const MOCK_PRECIPITATION_TODAY = withRanks(
  precipitation1hBase.map((item) => ({
    ...item,
    record: `${(parseFloat(item.record) * 2.8).toFixed(1)}mm`,
  })),
  sortNumericDesc,
);
export const MOCK_PRECIPITATION_YESTERDAY = withRanks(
  precipitation1hBase.map((item) => ({
    ...item,
    record: `${(parseFloat(item.record) * 5.2).toFixed(1)}mm`,
  })),
  sortNumericDesc,
);

export const MOCK_SNOW_CURRENT = withRanks(
  [
    { name: '대관령', record: '14.2cm', address: '강원도 평창군 대관령면 경강로 5721' },
    { name: '진부령', record: '11.5cm', address: '강원도 고성군 간성읍 진부령로 663' },
    { name: '미시령', record: '9.7cm', address: '강원도 속초시 설악산로 833' },
  ],
  sortNumericDesc,
);

export const MOCK_SNOW_TODAY = withRanks(
  [
    { name: '대관령', record: '6.8cm', address: '강원도 평창군 대관령면 경강로 5721' },
    { name: '진부령', record: '5.4cm', address: '강원도 고성군 간성읍 진부령로 663' },
    { name: '미시령', record: '4.1cm', address: '강원도 속초시 설악산로 833' },
  ],
  sortNumericDesc,
);
