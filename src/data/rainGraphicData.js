const province = (...names) => ({ provinces: names });

const cities = (provinceName, ...names) => ({
  cities: [{ province: provinceName, names }],
});

const mergeSelectors = (...selectors) => ({
  provinces: selectors.flatMap((selector) => selector.provinces ?? []),
  cities: selectors.flatMap((selector) => selector.cities ?? []),
  emdCodes: selectors.flatMap((selector) => selector.emdCodes ?? []),
});

const GYEONGGI_SOUTH = cities(
  '경기도',
  '수원시',
  '성남시',
  '용인시',
  '부천시',
  '광명시',
  '안양시',
  '과천시',
  '시흥시',
  '군포시',
  '의왕시',
  '안산시',
  '오산시',
  '화성시',
  '평택시',
  '안성시',
  '하남시',
  '광주시',
  '이천시',
  '양평군',
  '여주시',
);

const GYEONGGI_SOUTHWEST = cities(
  '경기도',
  '수원시',
  '성남시',
  '용인시',
  '부천시',
  '광명시',
  '안양시',
  '과천시',
  '시흥시',
  '군포시',
  '의왕시',
  '안산시',
  '오산시',
  '화성시',
  '평택시',
  '안성시',
);

const CHUNGNAM_NORTH = cities(
  '충청남도',
  '천안시',
  '아산시',
  '서산시',
  '당진시',
  '예산군',
  '홍성군',
  '태안군',
);

const CHUNGBUK_CENTRAL_NORTH = cities(
  '충청북도',
  '충주시',
  '제천시',
  '음성군',
  '단양군',
  '청주시',
  '증평군',
  '진천군',
  '괴산군',
);

const GANGWON_CENTRAL_SOUTH_INLAND = cities(
  '강원특별자치도',
  '춘천시',
  '홍천군',
  '원주시',
  '횡성군',
  '영월군',
  '평창군',
  '정선군',
);

// KMA official mountain districts: Gangneung, Donghae and Samcheok mountain areas.
const GANGWON_CENTRAL_SOUTH_MOUNTAIN_EMD = {
  emdCodes: [
    '32030370', // 강릉시 연곡면
    '32030310', // 강릉시 성산면
    '32030320', // 강릉시 왕산면
    '32040650', // 동해시 삼화동
    '32070110', // 삼척시 도계읍
    '32070340', // 삼척시 미로면
    '32070320', // 삼척시 하장면
    '32070330', // 삼척시 노곡면
    '32070350', // 삼척시 가곡면
    '32070360', // 삼척시 신기면
  ],
};

const GYEONGBUK_CENTRAL_NORTH = cities(
  '경상북도',
  '영주시',
  '영양군',
  '봉화군',
  '영덕군',
  '울진군',
  '안동시',
  '의성군',
  '청송군',
  '상주시',
  '문경시',
  '예천군',
);

const GYEONGBUK_NORTH = cities(
  '경상북도',
  '영주시',
  '영양군',
  '봉화군',
  '영덕군',
  '울진군',
  '상주시',
  '문경시',
  '예천군',
);

const GYEONGBUK_SOUTH = cities(
  '경상북도',
  '김천시',
  '구미시',
  '칠곡군',
  '고령군',
  '성주군',
  '영천시',
  '경산시',
  '청도군',
  '포항시',
  '경주시',
);

const ULLEUNG_AND_DOKDO = cities('경상북도', '울릉군');

const JEONBUK_WEST = cities(
  '전북특별자치도',
  '전주시',
  '익산시',
  '완주군',
  '군산시',
  '김제시',
  '정읍시',
  '고창군',
  '부안군',
);

const JEONBUK_EAST = cities(
  '전북특별자치도',
  '무주군',
  '진안군',
  '장수군',
  '남원시',
  '임실군',
  '순창군',
);

const JEONBUK_NORTHWEST_COAST = cities(
  '전북특별자치도',
  '군산시',
  '김제시',
);

const WEST_SEA_FIVE_ISLANDS = {
  emdCodes: ['23520320', '23520330', '23520340'],
};

export const RAIN_GRAPHICS = {
  '20260716-16-17': {
    title: '예상 강수량',
    period: '(~내일, mm)',
    issuedAt: '2026-07-16 17:00',
    layers: [
      {
        id: '5-around',
        color: '#a7def2',
        selector: GYEONGGI_SOUTHWEST,
      },
      {
        id: '5-10',
        color: '#78c9ee',
        selector: province('제주특별자치도'),
      },
      {
        id: '20-60',
        color: '#1976d2',
        selector: province(
          '대전광역시',
          '세종특별자치시',
          '충청남도',
          '충청북도',
          '대구광역시',
          '경상북도',
        ),
      },
      {
        id: '30-80',
        color: '#064ca8',
        selector: province(
          '전북특별자치도',
          '전남광주통합특별시',
          '부산광역시',
          '울산광역시',
          '경상남도',
        ),
      },
    ],
    labels: [
      { text: '5안팎', note: '(오늘)', lon: 126.28, lat: 37.22, color: '#a7def2', darkText: true },
      { text: '20~60', lon: 128.05, lat: 36.2, color: '#1976d2' },
      { text: '30~80', lon: 127.78, lat: 35.25, color: '#064ca8' },
      { text: '5~10', note: '(내일)', lon: 127.16, lat: 33.4, color: '#78c9ee' },
    ],
  },
  '20260716-18': {
    title: '예상 강수량',
    period: '(모레, mm)',
    issuedAt: '2026-07-16 17:00',
    layers: [
      {
        id: '5-10',
        color: '#91d7f1',
        selector: province('제주특별자치도'),
      },
      {
        id: '5-40',
        color: '#4ba9e7',
        selector: province(
          '전남광주통합특별시',
          '부산광역시',
          '울산광역시',
          '경상남도',
        ),
      },
      {
        id: '20-60',
        color: '#1976d2',
        selector: mergeSelectors(
          province('대구광역시'),
          GYEONGBUK_SOUTH,
          WEST_SEA_FIVE_ISLANDS,
        ),
      },
      {
        id: '30-80',
        color: '#0756b5',
        selector: mergeSelectors(
          province('강원특별자치도', '전북특별자치도'),
          GYEONGBUK_CENTRAL_NORTH,
          ULLEUNG_AND_DOKDO,
        ),
      },
      {
        id: '50-100',
        color: '#123b8d',
        selector: province('충청북도'),
      },
      {
        id: '50-150',
        color: '#51318e',
        selector: province(
          '서울특별시',
          '인천광역시',
          '경기도',
          '대전광역시',
          '세종특별자치시',
          '충청남도',
        ),
      },
      {
        id: '150-plus',
        color: '#8a2f8f',
        selector: mergeSelectors(
          GANGWON_CENTRAL_SOUTH_INLAND,
          GANGWON_CENTRAL_SOUTH_MOUNTAIN_EMD,
          CHUNGBUK_CENTRAL_NORTH,
        ),
        emphasis: true,
      },
      {
        id: '200-plus',
        color: '#54116e',
        selector: mergeSelectors(GYEONGGI_SOUTH, CHUNGNAM_NORTH),
        emphasis: true,
      },
    ],
    labels: [
      { text: '50~150', note: '(내일부터)', lon: 126.78, lat: 37.68, color: '#51318e' },
      { text: '30~80', lon: 128.85, lat: 37.78, color: '#0756b5' },
      { text: '200↑', lon: 126.12, lat: 36.98, color: '#54116e' },
      { text: '150↑', lon: 128.05, lat: 37.03, color: '#8a2f8f' },
      { text: '50~100', lon: 127.78, lat: 36.45, color: '#123b8d' },
      { text: '20~60', lon: 128.62, lat: 35.8, color: '#1976d2' },
      { text: '5~40', lon: 128.18, lat: 35.05, color: '#4ba9e7' },
      { text: '5~10', lon: 127.16, lat: 33.4, color: '#91d7f1', darkText: true },
    ],
  },
  '20260717-18-19': {
    title: '예상 강수량',
    period: '(내일~모레, mm)',
    issuedAt: '2026-07-17',
    layers: [
      {
        id: '5-30',
        color: '#9adcf1',
        selector: province('제주특별자치도'),
      },
      {
        id: '20-60',
        color: '#58ade8',
        selector: province(
          '전남광주통합특별시',
          '부산광역시',
          '울산광역시',
          '경상남도',
        ),
      },
      {
        id: '30-80',
        color: '#2f87d1',
        selector: mergeSelectors(JEONBUK_EAST, WEST_SEA_FIVE_ISLANDS),
      },
      {
        id: '30-100',
        color: '#1768b8',
        selector: mergeSelectors(
          JEONBUK_WEST,
          province('대구광역시'),
          GYEONGBUK_SOUTH,
          ULLEUNG_AND_DOKDO,
        ),
      },
      {
        id: '50-100',
        color: '#1768b8',
        selector: GYEONGBUK_CENTRAL_NORTH,
      },
      {
        id: '80-150',
        color: '#343b94',
        selector: province(
          '대전광역시',
          '세종특별자치시',
          '충청남도',
          '충청북도',
        ),
      },
      {
        id: '100-200',
        color: '#63348e',
        selector: province(
          '서울특별시',
          '인천광역시',
          '경기도',
          '강원특별자치도',
        ),
      },
      {
        id: '120-plus',
        color: '#214c9d',
        selector: JEONBUK_NORTHWEST_COAST,
        emphasis: true,
      },
      {
        id: '150-plus',
        color: '#4b348f',
        selector: GYEONGBUK_NORTH,
        emphasis: true,
      },
      {
        id: '250-plus',
        color: '#85257f',
        selector: mergeSelectors(
          province('세종특별자치시'),
          CHUNGNAM_NORTH,
          CHUNGBUK_CENTRAL_NORTH,
        ),
        emphasis: true,
      },
      {
        id: '300-plus',
        color: '#54116e',
        selector: mergeSelectors(
          GANGWON_CENTRAL_SOUTH_INLAND,
          GANGWON_CENTRAL_SOUTH_MOUNTAIN_EMD,
        ),
        emphasis: true,
      },
    ],
    labels: [
      { text: '100~200', lon: 126.55, lat: 38.05, color: '#63348e' },
      { text: '300↑', lon: 128.05, lat: 37.55, color: '#54116e' },
      { text: '80~150', lon: 126.12, lat: 36.78, color: '#343b94' },
      { text: '250↑', lon: 127.65, lat: 36.58, color: '#85257f' },
      { text: '30~80', lon: 126.22, lat: 35.28, color: '#2f87d1' },
      { text: '120↑', lon: 125.88, lat: 35.9, color: '#214c9d' },
      { text: '30~100', lon: 127.72, lat: 35.72, color: '#1768b8' },
      { text: '50~100', lon: 128.95, lat: 36.72, color: '#1768b8' },
      { text: '150↑', lon: 129.28, lat: 37.28, color: '#4b348f' },
      { text: '20~60', lon: 128.22, lat: 34.72, color: '#58ade8' },
      { text: '5~30', lon: 127.16, lat: 33.4, color: '#9adcf1', darkText: true },
    ],
  },
};

export const DEFAULT_RAIN_GRAPHIC_ID = '20260717-18-19';
