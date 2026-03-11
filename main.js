// Global variables for UI
const themeToggle = document.getElementById('theme-toggle');
const bureauSelect = document.getElementById('bureau-select');
const body = document.body;

const BUREAU_MAPPING = {
    '전국': [],
    '본사': ['서울', '경기', '인천', '서울특별시', '경기도', '인천광역시'],
    '대전총국': ['대전', '세종', '충남', '충청남도', '대전광역시', '세종특별'],
    '청주총국': ['충북', '충청북도'],
    '전주총국': ['전북', '전라북도', '전북특별'],
    '광주총국': ['전남', '전라남도', '광주광역시', '광주'],
    '제주총국': ['제주', '제주특별'],
    '춘천총국': ['강원', '춘천', '원주', '강릉', '강원특별'],
    '대구총국': ['대구', '경북', '경상북도', '대구광역시'],
    '부산총국': ['부산', '울산', '부산광역시', '울산광역시'],
    '창원총국': ['경남', '경상남도']
};

function getFilteredStations(stations) {
    const selectedBureau = bureauSelect ? bureauSelect.value : '전국';
    if (selectedBureau === '전국') return stations;
    
    const targetRegions = BUREAU_MAPPING[selectedBureau] || [];
    return stations.filter(stn => {
        if (!stn.address) return false;
        const cleanAddress = stn.address.replace(/^\([\u4e00-\u9fa5]+\)\s*/, '').trim();
        const firstWord = cleanAddress.split(/\s+/)[0];
        return targetRegions.some(region => firstWord.startsWith(region));
    });
}

// Theme toggle logic
const currentTheme = localStorage.getItem('theme');
if (currentTheme === 'dark') {
    body.classList.add('dark-mode');
    themeToggle.textContent = '라이트 모드';
}

themeToggle.addEventListener('click', () => {
    body.classList.toggle('dark-mode');
    let theme = 'light';
    if (body.classList.contains('dark-mode')) {
        theme = 'dark';
        themeToggle.textContent = '라이트 모드';
    } else {
        themeToggle.textContent = '다크 모드';
    }
    localStorage.setItem('theme', theme);
});

// Weather elements
const fetchWeatherTodayButton = document.getElementById('fetch-weather-today');
const fetchWeatherCurrentButton = document.getElementById('fetch-weather-current');
const weatherResultContainer = document.getElementById('weather-result-container');
const weatherTableBody = document.getElementById('weather-table-body');
const weatherValueHeader = document.getElementById('weather-value-header');
const weatherTimeElement = document.getElementById('weather-time');
const weatherStatus = document.getElementById('weather-status');

const fetchLowTodayButton = document.getElementById('fetch-low-today');
const fetchLowCurrentButton = document.getElementById('fetch-low-current');
const lowTempResultContainer = document.getElementById('low-temp-result-container');
const lowTempTableBody = document.getElementById('low-temp-table-body');
const lowTempValueHeader = document.getElementById('low-temp-value-header');
const lowTempTimeElement = document.getElementById('low-temp-time');
const lowTempStatus = document.getElementById('low-temp-status');

const fetchPrecip1hButton = document.getElementById('fetch-precip-1h');
const fetchPrecipTodayButton = document.getElementById('fetch-precip-today');
const fetchPrecipYesterdayButton = document.getElementById('fetch-precip-yesterday');
const precipResultContainer = document.getElementById('precip-result-container');
const precipTableBody = document.getElementById('precip-table-body');
const precipValueHeader = document.getElementById('precip-value-header');
const precipTimeElement = document.getElementById('precip-time');
const precipStatus = document.getElementById('precip-status');

const fetchSnowTotButton = document.getElementById('fetch-snow-tot');
const fetchSnowDayButton = document.getElementById('fetch-snow-day');
const snowResultContainer = document.getElementById('snow-result-container');
const snowTableBody = document.getElementById('snow-table-body');
const snowValueHeader = document.getElementById('snow-value-header');
const snowTimeElement = document.getElementById('snow-time');
const snowStatus = document.getElementById('snow-status');

let cachedStationMapping = null;
const PROXY_URL = "https://api.codetabs.com/v1/proxy/?quest=";

async function getStationMapping(authKey) {
    if (cachedStationMapping && Object.keys(cachedStationMapping).length > 500) return cachedStationMapping;
    try {
        const mapping = {};
        const decoder = new TextDecoder('euc-kr');
        const parseLines = (text, targetMapping) => {
            const lines = text.split('\n');
            let stnKoIndex = -1, adrIndex = -1;
            for (const line of lines) {
                if (line.includes('STN_KO')) {
                    const headerParts = line.trim().split(/\s+/);
                    stnKoIndex = headerParts.indexOf('STN_KO');
                    adrIndex = headerParts.indexOf('LAW_ADDR');
                    if (adrIndex === -1) adrIndex = headerParts.indexOf('ADR');
                    if (headerParts[0] === '#' || line.startsWith('#')) {
                        if (stnKoIndex !== -1) stnKoIndex -= 1;
                        if (adrIndex !== -1) adrIndex -= 1;
                    }
                    break;
                }
            }
            if (stnKoIndex === -1) stnKoIndex = 10;
            if (adrIndex === -1) adrIndex = 15;
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
                const parts = line.trim().split(/\s+/);
                if (parts.length > 5) {
                    const id = parts[0];
                    let name = (parts[stnKoIndex] || parts[10] || "").replace(/=/g, '').trim();
                    let adr = "";
                    if (adrIndex !== -1 && parts.length > adrIndex) {
                        const rawAdr = parts.slice(adrIndex).join(' ').replace(/^---- /, '').trim();
                        const adrMatch = rawAdr.match(/(\([\u4e00-\u9fa5]+\)|강원|경기|서울|인천|대전|대구|부산|울산|광주|세종|충남|충북|전남|전북|경남|경북|제주|춘천|원주|강릉).*/);
                        adr = adrMatch ? adrMatch[0].trim() : rawAdr;
                    }
                    if (id && name && isNaN(name) && name !== '----' && !targetMapping[id]) {
                        targetMapping[id] = { name, adr: adr || "주소 정보 없음" };
                    }
                }
            }
        };
        try {
            const localResponse = await fetch('stations.txt?_=' + Date.now());
            if (localResponse.ok) {
                const buffer = await localResponse.arrayBuffer();
                parseLines(decoder.decode(buffer), mapping);
            }
        } catch (e) {}
        if (authKey) {
            const fetchInf = async (type) => {
                try {
                    const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=${type}&stn=0&authKey=${authKey}`;
                    const res = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
                    if (res.ok) {
                        const buffer = await res.arrayBuffer();
                        parseLines(decoder.decode(buffer), mapping);
                    }
                } catch (e) {}
            };
            await Promise.all([fetchInf('SFC'), fetchInf('AWS')]);
        }
        if (Object.keys(mapping).length > 0) cachedStationMapping = mapping;
        return mapping;
    } catch (e) { return cachedStationMapping || {}; }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWeatherRanking(type, mode = 'highest', retryCount = 0) {
    const isHighest = mode === 'highest';
    const statusEl = isHighest ? weatherStatus : lowTempStatus;
    const resultContainerEl = isHighest ? weatherResultContainer : lowTempResultContainer;
    const tableBodyEl = isHighest ? weatherTableBody : lowTempTableBody;
    const valueHeaderEl = isHighest ? weatherValueHeader : lowTempValueHeader;
    const timeEl = isHighest ? weatherTimeElement : lowTempTimeElement;
    const typeNames = { 'today': '오늘 ' + (isHighest ? '최고' : '최저') + ' 기온', 'current': '현재 ' + (isHighest ? '최고' : '최저') + ' 기온' };
    if (retryCount === 0) {
        statusEl.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
        resultContainerEl.style.display = 'none';
    }
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        let stations = [];
        let lastTm = "";
        const targetUrl = type === 'current' ? 
            `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}` :
            `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=${isHighest ? 'ta_max' : 'ta_min'}&stn=0&authKey=${authKey}`;
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        if (text.length < 500 && retryCount < 3) { await sleep(1000); return fetchWeatherRanking(type, mode, retryCount + 1); }
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '') continue;
            const parts = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            if (type === 'current' && parts.length >= 9) {
                const tm = parts[0], stnId = parts[1].trim(), val = parseFloat(parts[8]);
                if (!isNaN(val) && val > -50 && val < 60) {
                    const info = stationData[stnId] || { name: `지점 ${stnId}`, adr: "주소 정보 없음" };
                    stations.push({ id: stnId, val, name: info.name, address: info.adr });
                    if (tm) lastTm = tm;
                }
            } else if (type === 'today' && parts.length >= 6) {
                const tm = parts[0].trim(), stnId = parts[1].trim(), val = parseFloat(parts[5]);
                const nameInApi = parts[6] ? parts[6].replace('=', '').trim() : '';
                if (!isNaN(val) && val > -50 && val < 60) {
                    const info = stationData[stnId] || { name: nameInApi || `지점 ${stnId}`, adr: "주소 정보 없음" };
                    stations.push({ id: stnId, val, name: info.name, address: info.adr });
                    if (tm) lastTm = tm;
                }
            }
        }
        stations = getFilteredStations(stations);
        if (lastTm && lastTm.length === 8) {
            const now = new Date(); lastTm += String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
        }
        stations.sort((a, b) => isHighest ? b.val - a.val : a.val - b.val);
        const top10 = stations.slice(0, 10);
        if (top10.length > 0) {
            valueHeaderEl.textContent = '기온(℃)';
            tableBodyEl.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `<td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index+1}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: var(--button-bg); font-weight: 800;">${item.val.toFixed(1)}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>`;
                tableBodyEl.appendChild(row);
            });
            if (lastTm) {
                const formattedTime = lastTm.length >= 12 ? `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10)}:${lastTm.substring(10, 12)}` : lastTm;
                timeEl.textContent = `기준 시간: ${formattedTime}`;
            }
            resultContainerEl.style.display = 'block'; statusEl.textContent = '조회가 완료되었습니다.';
        } else {
            if (retryCount < 3) { await sleep(1000); return fetchWeatherRanking(type, mode, retryCount + 1); }
            statusEl.textContent = '유효한 데이터를 찾을 수 없습니다.';
            resultContainerEl.style.display = 'none';
        }
    } catch (error) {
        if (retryCount < 3) { await sleep(1000); return fetchWeatherRanking(type, mode, retryCount + 1); }
        statusEl.textContent = '오류가 발생했습니다.';
        resultContainerEl.style.display = 'none';
    }
}

async function fetchPrecipRanking(type, retryCount = 0) {
    const typeNames = { '1h': '1시간 강수량', 'today': '오늘 강수량' };
    if (retryCount === 0) {
        precipStatus.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
        precipResultContainer.style.display = 'none';
    }
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const targetUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}`;
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        if (text.length < 500 && retryCount < 3) { await sleep(1000); return fetchPrecipRanking(type, retryCount + 1); }
        const lines = text.split('\n');
        let stations = [];
        let lastTm = "";
        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '') continue;
            const parts = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            if (parts.length < 14) continue;
            const tm = parts[0], stnId = parts[1].trim();
            const val = parseFloat(parts[type === '1h' ? 11 : 13]);
            if (!isNaN(val) && val > 0 && val < 1000) {
                const info = stationData[stnId] || { name: `지점 ${stnId}`, adr: "주소 정보 없음" };
                stations.push({ id: stnId, val, name: info.name, address: info.adr });
                if (tm) lastTm = tm;
            }
        }
        stations = getFilteredStations(stations);
        stations.sort((a, b) => b.val - a.val);
        const top10 = stations.slice(0, 10);
        if (top10.length > 0) {
            precipValueHeader.textContent = '강수량(mm)';
            precipTableBody.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `<td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index+1}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: #007bff; font-weight: 800;">${item.val.toFixed(1)}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>`;
                precipTableBody.appendChild(row);
            });
            if (lastTm) {
                const formattedTime = lastTm.length >= 12 ? `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10)}:${lastTm.substring(10, 12)}` : lastTm;
                precipTimeElement.textContent = `기준 시간: ${formattedTime}`;
            }
            precipResultContainer.style.display = 'block'; 
            precipStatus.textContent = '조회가 완료되었습니다.';
        } else {
            if (retryCount < 3) { await sleep(1000); return fetchPrecipRanking(type, retryCount + 1); }
            precipStatus.textContent = `현재 지역에서 관측된 ${typeNames[type]} 데이터가 없습니다.`;
            precipResultContainer.style.display = 'none';
        }
    } catch (error) {
        if (retryCount < 3) { await sleep(1000); return fetchPrecipRanking(type, retryCount + 1); }
        precipStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
        precipResultContainer.style.display = 'none';
    }
}

async function fetchPrecipYesterdayRanking(retryCount = 0) {
    precipStatus.textContent = '어제부터 현재까지의 누적 강수량을 계산 중...';
    precipResultContainer.style.display = 'none';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ'; 
        const stationData = await getStationMapping(authKey);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yyyymmdd = yesterday.getFullYear() + String(yesterday.getMonth() + 1).padStart(2, '0') + String(yesterday.getDate()).padStart(2, '0');
        const combinedData = {};
        const yesterdayUrl = `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?tm2=${yyyymmdd}&obs=rn_day&stn=0&authKey=${authKey}`;
        const yesResponse = await fetch(PROXY_URL + encodeURIComponent(yesterdayUrl) + `&_=${Date.now()}`);
        if (yesResponse.ok) {
            const buffer = await yesResponse.arrayBuffer();
            const text = new TextDecoder('euc-kr').decode(buffer);
            const lines = text.split('\n');
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
                const parts = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
                if (parts.length >= 6) {
                    const stnId = parts[1].trim();
                    const val = parseFloat(parts[5]);
                    if (!isNaN(val) && val >= 0) {
                        const nameInApi = parts[6] ? parts[6].replace('=', '').trim() : '';
                        const info = stationData[stnId] || { name: nameInApi || `지점 ${stnId}`, adr: "주소 정보 없음" };
                        combinedData[stnId] = { val: val, name: info.name, address: info.adr };
                    }
                }
            }
        }
        const todayUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}`;
        const todayResponse = await fetch(PROXY_URL + encodeURIComponent(todayUrl) + `&_=${Date.now()}`);
        let lastTm = "";
        if (todayResponse.ok) {
            const buffer = await todayResponse.arrayBuffer();
            const text = new TextDecoder('euc-kr').decode(buffer);
            const lines = text.split('\n');
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                const parts = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
                if (parts.length >= 14) {
                    const tm = parts[0].trim(), stnId = parts[1].trim(), val = parseFloat(parts[13]);
                    if (!isNaN(val) && val >= 0) {
                        if (combinedData[stnId]) { combinedData[stnId].val += val; }
                        else {
                            const info = stationData[stnId] || { name: `지점 ${stnId}`, adr: "주소 정보 없음" };
                            combinedData[stnId] = { val: val, name: info.name, address: info.adr };
                        }
                        if (tm) lastTm = tm;
                    }
                }
            }
        }
        let stations = Object.values(combinedData).filter(item => item.val > 0);
        stations = getFilteredStations(stations);
        stations.sort((a, b) => b.val - a.val);
        const top10 = stations.slice(0, 10);
        if (top10.length > 0) {
            precipValueHeader.textContent = '누적 강수량(mm)';
            precipTableBody.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `<td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index+1}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: #28a745; font-weight: 800;">${item.val.toFixed(1)}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>`;
                precipTableBody.appendChild(row);
            });
            const todayStr = lastTm ? `${lastTm.substring(0,4)}-${lastTm.substring(4,6)}-${lastTm.substring(6,8)} ${lastTm.substring(8,10)}:${lastTm.substring(10,12)}` : '현재';
            precipTimeElement.textContent = `기준 기간: 어제(${yyyymmdd.substring(0,4)}-${yyyymmdd.substring(4,6)}-${yyyymmdd.substring(6,8)}) ~ 오늘 ${todayStr}`;
            precipResultContainer.style.display = 'block'; 
            precipStatus.textContent = '합산 조회가 완료되었습니다.';
        } else {
            precipStatus.textContent = '현재 지역에서 어제부터 현재까지 관측된 강수 데이터가 없습니다.';
            precipResultContainer.style.display = 'none';
        }
    } catch (error) {
        if (retryCount < 3) return fetchPrecipYesterdayRanking(retryCount + 1);
        precipStatus.textContent = '데이터를 합산하는 중 오류가 발생했습니다.';
        precipResultContainer.style.display = 'none';
    }
}

async function fetchSnowRanking(type, retryCount = 0) {
    const typeNames = { 'tot': '적설량(cm)', 'day': '신적설(cm)' };
    if (retryCount === 0) {
        snowStatus.textContent = `${typeNames[type].replace('(cm)', '')} 데이터를 불러오는 중...`;
        snowResultContainer.style.display = 'none';
    }
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${type === 'day' ? 'day' : 'tot'}&authKey=${authKey}`;
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        if (text.length < 500 && retryCount < 3) { await sleep(1000); return fetchSnowRanking(type, retryCount + 1); }
        const lines = text.split('\n');
        let stations = [];
        let lastTm = "";
        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
            const parts = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            if (parts.length >= 7) {
                const tm = parts[0].trim(), stnId = parts[1].trim(), stnKoInData = parts[2].trim(), val = parseFloat(parts[6].trim());
                if (!isNaN(val) && val > 0 && val < 900) {
                    const info = stationData[stnId] || { name: stnKoInData || `지점 ${stnId}`, adr: "주소 정보 없음" };
                    stations.push({ id: stnId, val, name: info.name, address: info.adr });
                }
                if (tm && tm.length === 12) lastTm = tm;
            }
        }
        stations = getFilteredStations(stations);
        stations.sort((a, b) => b.val - a.val);
        const top10 = stations.slice(0, 10);
        if (top10.length > 0) {
            snowValueHeader.textContent = typeNames[type];
            snowTableBody.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `<td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index+1}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: var(--accent-color); font-weight: 800;">${item.val.toFixed(1)}</td><td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>`;
                snowTableBody.appendChild(row);
            });
            if (lastTm) {
                const formattedTime = `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10)}:${lastTm.substring(10, 12)}`;
                snowTimeElement.textContent = `기준 시간: ${formattedTime}`;
            }
            snowResultContainer.style.display = 'block'; 
            snowStatus.textContent = '조회가 완료되었습니다.';
        } else {
            if (retryCount < 3) { await sleep(1000); return fetchSnowRanking(type, retryCount + 1); }
            snowStatus.textContent = `현재 지역에서 관측된 ${typeNames[type].replace('(cm)', '')} 데이터가 없습니다.`;
            snowResultContainer.style.display = 'none';
        }
    } catch (error) {
        if (retryCount < 3) { await sleep(1000); return fetchSnowRanking(type, retryCount + 1); }
        snowStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
        snowResultContainer.style.display = 'none';
    }
}

// Warning elements
const warningList = document.getElementById('warning-list');
const warningTime = document.getElementById('warning-time');
const warningStatus = document.getElementById('warning-status');

async function fetchWeatherWarnings() {
    if (!warningList) return;
    warningStatus.textContent = '기상특보 데이터를 불러오는 중...';
    const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
    const selectedBureau = bureauSelect ? bureauSelect.value : '전국';
    const targetRegions = BUREAU_MAPPING[selectedBureau] || [];
    try {
        const fetchWarningData = async (feType) => {
            const url = `https://apihub.kma.go.kr/api/typ01/url/wrn_now_data_new.php?fe=${feType}&tm=&disp=0&help=1&authKey=${authKey}`;
            const res = await fetch(PROXY_URL + encodeURIComponent(url) + `&_=${Date.now()}`);
            if (!res.ok) return "";
            const buffer = await res.arrayBuffer();
            let text = new TextDecoder('euc-kr').decode(buffer);
            if (text.includes('{"result"') || text.includes('message')) {
                const errorText = new TextDecoder('utf-8').decode(buffer);
                try {
                    const errJson = JSON.parse(errorText);
                    if (errJson.result && errJson.result.status === 401) {
                        warningStatus.textContent = `API 인증 오류: ${errJson.result.message}`;
                    }
                } catch(e) {}
                return "";
            }
            if (!text.includes('주의보') && !text.includes('경보') && !text.includes('예비특보')) {
                text = new TextDecoder('utf-8').decode(buffer);
            }
            return text;
        };
        const [finalData, prelimData] = await Promise.all([fetchWarningData('f'), fetchWarningData('p')]);
        const allLines = [...finalData.split('\n'), ...prelimData.split('\n')];
        let filteredWarnings = [];
        let lastUpdateTime = "";
        allLines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') && !trimmed.includes('발표시각')) return;
            if ((trimmed.includes('주의보') || trimmed.includes('경보') || trimmed.includes('예비특보')) && trimmed.includes(':')) {
                let cleanLine = trimmed.replace(/^[○o\-\s\*]+/, '').trim();
                const isSeaWarning = cleanLine.includes('풍랑');
                if (selectedBureau === '전국') { filteredWarnings.push(cleanLine); }
                else {
                    if (isSeaWarning) return; 
                    if (targetRegions.some(region => cleanLine.includes(region))) { filteredWarnings.push(cleanLine); }
                }
            } else if (trimmed.includes('발표시각') && !lastUpdateTime) {
                lastUpdateTime = trimmed.replace(/[#]/g, '').trim();
            }
        });
        filteredWarnings = [...new Set(filteredWarnings)].filter(w => w.length > 5);
        if (filteredWarnings.length > 0) {
            warningList.innerHTML = filteredWarnings.map(w => `<div style="margin-bottom: 12px; font-weight: 500;">○ ${w}</div>`).join('');
            warningStatus.textContent = '조회가 완료되었습니다.';
        } else {
            if (!warningStatus.textContent.includes('오류')) {
                warningList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">현재 해당 지역에 발효 중인 특보가 없습니다.</div>';
                warningStatus.textContent = '발효 중인 특보가 없습니다.';
            }
        }
        if (lastUpdateTime) { warningTime.textContent = `기준 시간: ${lastUpdateTime}`; }
    } catch (error) {
        warningStatus.textContent = '특보 데이터를 불러오는 중 오류가 발생했습니다.';
    }
}

if (bureauSelect) {
    bureauSelect.addEventListener('change', () => { fetchWeatherWarnings(); });
}
window.addEventListener('DOMContentLoaded', () => { fetchWeatherWarnings(); });

if (fetchWeatherTodayButton) fetchWeatherTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'highest'));
if (fetchWeatherCurrentButton) fetchWeatherCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'highest'));
if (fetchLowTodayButton) fetchLowTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'lowest'));
if (fetchLowCurrentButton) fetchLowCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'lowest'));
if (fetchPrecip1hButton) fetchPrecip1hButton.addEventListener('click', () => fetchPrecipRanking('1h'));
if (fetchPrecipTodayButton) fetchPrecipTodayButton.addEventListener('click', () => fetchPrecipRanking('today'));
if (fetchPrecipYesterdayButton) fetchPrecipYesterdayButton.addEventListener('click', fetchPrecipYesterdayRanking);
if (fetchSnowTotButton) fetchSnowTotButton.addEventListener('click', () => fetchSnowRanking('tot'));
if (fetchSnowDayButton) fetchSnowDayButton.addEventListener('click', () => fetchSnowRanking('day'));
