// Global variables for UI
const themeToggle = document.getElementById('theme-toggle');
const body = document.body;

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

// Weather elements (Highest)
const fetchWeatherTodayButton = document.getElementById('fetch-weather-today');
const fetchWeatherCurrentButton = document.getElementById('fetch-weather-current');
const weatherResultContainer = document.getElementById('weather-result-container');
const weatherTableBody = document.getElementById('weather-table-body');
const weatherValueHeader = document.getElementById('weather-value-header');
const weatherTimeElement = document.getElementById('weather-time');
const weatherStatus = document.getElementById('weather-status');

// Weather elements (Lowest)
const fetchLowTodayButton = document.getElementById('fetch-low-today');
const fetchLowCurrentButton = document.getElementById('fetch-low-current');
const lowTempResultContainer = document.getElementById('low-temp-result-container');
const lowTempTableBody = document.getElementById('low-temp-table-body');
const lowTempValueHeader = document.getElementById('low-temp-value-header');
const lowTempTimeElement = document.getElementById('low-temp-time');
const lowTempStatus = document.getElementById('low-temp-status');

// Precipitation elements
const fetchPrecip1hButton = document.getElementById('fetch-precip-1h');
const fetchPrecipTodayButton = document.getElementById('fetch-precip-today');
const precipResultContainer = document.getElementById('precip-result-container');
const precipTableBody = document.getElementById('precip-table-body');
const precipValueHeader = document.getElementById('precip-value-header');
const precipTimeElement = document.getElementById('precip-time');
const precipStatus = document.getElementById('precip-status');

// Snowfall elements
const fetchSnowTotButton = document.getElementById('fetch-snow-tot');
const fetchSnowDayButton = document.getElementById('fetch-snow-day');
const snowResultContainer = document.getElementById('snow-result-container');
const snowTableBody = document.getElementById('snow-table-body');
const snowValueHeader = document.getElementById('snow-value-header');
const snowTimeElement = document.getElementById('snow-time');
const snowStatus = document.getElementById('snow-status');

let cachedStationMapping = null;

// New faster CORS Proxy URL
const PROXY_URL = "https://api.codetabs.com/v1/proxy/?quest=";

async function getStationMapping(authKey) {
    if (cachedStationMapping && Object.keys(cachedStationMapping).length > 300) return cachedStationMapping;
    
    try {
        const mapping = {};
        const decoder = new TextDecoder('euc-kr');

        // 1. 로컬 stations.txt 읽기
        try {
            const localResponse = await fetch('stations.txt?_=' + Date.now());
            if (localResponse.ok) {
                const buffer = await localResponse.arrayBuffer();
                const text = decoder.decode(buffer);
                const lines = text.split('\n');
                
                let stnKoIndex = -1;
                let adrIndex = -1;
                
                for (const line of lines) {
                    if (line.includes('STN_KO')) {
                        const headerParts = line.trim().split(/\s+/);
                        stnKoIndex = headerParts.indexOf('STN_KO');
                        adrIndex = headerParts.indexOf('LAW_ADDR');
                        if (adrIndex === -1) adrIndex = headerParts.indexOf('ADR');
                        if (stnKoIndex !== -1) stnKoIndex -= 1; 
                        if (adrIndex !== -1) adrIndex -= 1;
                        break;
                    }
                }

                for (const line of lines) {
                    if (line.startsWith('#') || line.trim() === '') continue;
                    const parts = line.trim().split(/\s+/);
                    if (parts.length > 5) {
                        const id = parts[0];
                        const name = parts[stnKoIndex] || parts[10];
                        let adr = "";
                        if (adrIndex !== -1 && parts.length > adrIndex) {
                            const rawAdr = parts.slice(adrIndex).join(' ').replace(/^---- /, '').trim();
                            const adrMatch = rawAdr.match(/(\(산지\)|\(상지\)|강원|경기|서울|인천|대전|대구|부산|울산|광주|세종|충북|충남|전북|전남|경북|경남|제주).*/);
                            adr = adrMatch ? adrMatch[0].trim() : rawAdr;
                        }
                        if (id && name && isNaN(name) && name !== '----') {
                            mapping[id] = { name, adr };
                        }
                    }
                }
            }
        } catch (e) { console.error('Local stations.txt load failed:', e); }

        // 2. 추가 지점 정보 API 보충 (AWS 및 적설 관측소 포함)
        if (authKey) {
            const fetchInf = async (type) => {
                try {
                    const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=${type}&stn=0&authKey=${authKey}`;
                    const res = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
                    if (res.ok) {
                        const buffer = await res.arrayBuffer();
                        const text = decoder.decode(buffer);
                        const lines = text.split('\n');
                        for (const line of lines) {
                            if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
                            const parts = line.trim().split(/\s+/);
                            const id = parts[0];
                            const name = parts[8];
                            if (id && name && !mapping[id]) {
                                const rawAdr = parts.slice(13).join(' ').replace(/^---- /, '').trim();
                                const adrMatch = rawAdr.match(/(\(산지\)|\(상지\)|강원|경기|서울|인천|대전|대구|부산|울산|광주|세종|충북|충남|전북|전남|경북|경남|제주).*/);
                                mapping[id] = { name, adr: adrMatch ? adrMatch[0].trim() : rawAdr };
                            }
                        }
                    }
                } catch (e) {}
            };
            await Promise.all([fetchInf('AWS'), fetchInf('SFC')]);
        }

        if (Object.keys(mapping).length > 0) cachedStationMapping = mapping;
        return mapping;
    } catch (e) {
        console.error('Final mapping merge failed:', e);
        return cachedStationMapping || {};
    }
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
    if (retryCount === 0) statusEl.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
    
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const stations = [];
        let lastTm = "";

        const targetUrl = type === 'current' ? 
            `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&disp=1&authKey=${authKey}` :
            `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=${isHighest ? 'ta_max' : 'ta_min'}&stn=0&authKey=${authKey}`;
        
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        
        if (text.length < 500 && retryCount < 3) {
            await sleep(1000);
            return fetchWeatherRanking(type, mode, retryCount + 1);
        }

        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '') continue;
            const parts = line.split(',');
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
        }
    } catch (error) {
        if (retryCount < 3) { await sleep(1000); return fetchWeatherRanking(type, mode, retryCount + 1); }
        statusEl.textContent = '오류가 발생했습니다.';
    }
}

if (fetchWeatherTodayButton) fetchWeatherTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'highest'));
if (fetchWeatherCurrentButton) fetchWeatherCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'highest'));
if (fetchLowTodayButton) fetchLowTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'lowest'));
if (fetchLowCurrentButton) fetchLowCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'lowest'));

async function fetchPrecipRanking(type, retryCount = 0) {
    const typeNames = { '1h': '1시간 강수량', 'today': '오늘 강수량' };
    if (retryCount === 0) precipStatus.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
    
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const targetUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&disp=1&authKey=${authKey}`;
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        
        if (text.length < 500 && retryCount < 3) {
            await sleep(1000); return fetchPrecipRanking(type, retryCount + 1);
        }

        const lines = text.split('\n');
        const stations = [];
        let lastTm = "";

        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '') continue;
            const parts = line.split(',');
            if (parts.length < 14) continue;
            const tm = parts[0], stnId = parts[1].trim(), val = parseFloat(type === '1h' ? parts[11] : parts[13]); 
            if (!isNaN(val) && val > 0 && val < 1000) {
                const info = stationData[stnId] || { name: `지점 ${stnId}`, adr: "주소 정보 없음" };
                stations.push({ id: stnId, val, name: info.name, address: info.adr });
                if (tm) lastTm = tm;
            }
        }
        
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
            precipResultContainer.style.display = 'block'; precipStatus.textContent = '조회가 완료되었습니다.';
        } else {
            if (retryCount < 3) { await sleep(1000); return fetchPrecipRanking(type, retryCount + 1); }
            precipStatus.textContent = `현재 관측된 ${typeNames[type]} 데이터가 없습니다.`;
            precipResultContainer.style.display = 'none';
        }
    } catch (error) {
        if (retryCount < 3) { await sleep(1000); return fetchPrecipRanking(type, retryCount + 1); }
        precipStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
    }
}

if (fetchPrecip1hButton) fetchPrecip1hButton.addEventListener('click', () => fetchPrecipRanking('1h'));
if (fetchPrecipTodayButton) fetchPrecipTodayButton.addEventListener('click', () => fetchPrecipRanking('today'));

async function fetchSnowRanking(type, retryCount = 0) {
    const typeNames = { 'tot': '적설량(cm)', 'day': '신적설(cm)' };
    if (retryCount === 0) snowStatus.textContent = `${typeNames[type].replace('(cm)', '')} 데이터를 불러오는 중...`;
    
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${type === 'day' ? 'day' : 'tot'}&authKey=${authKey}`;
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl) + `&_=${Date.now()}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        
        if (text.length < 500 && retryCount < 3) {
            await sleep(1000); return fetchSnowRanking(type, retryCount + 1);
        }

        const lines = text.split('\n');
        const stations = [];
        let lastTm = "";

        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
            const parts = line.split(',');
            if (parts.length >= 7) {
                const tm = parts[0].trim(), stnId = parts[1].trim(), stnKoInData = parts[2].trim(), val = parseFloat(parts[6].trim());
                if (!isNaN(val) && val >= 0 && val < 900) {
                    const info = stationData[stnId] || { name: stnKoInData || `지점 ${stnId}`, adr: "주소 정보 없음" };
                    stations.push({ id: stnId, val, name: info.name, address: info.adr });
                }
                if (tm && tm.length === 12) lastTm = tm;
            }
        }
        
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
            snowResultContainer.style.display = 'block'; snowStatus.textContent = '조회가 완료되었습니다.';
        } else {
            if (retryCount < 3) { await sleep(1000); return fetchSnowRanking(type, retryCount + 1); }
            snowStatus.textContent = `현재 관측된 ${typeNames[type].replace('(cm)', '')} 데이터가 없습니다.`;
            snowResultContainer.style.display = 'none';
        }
    } catch (error) {
        if (retryCount < 3) { await sleep(1000); return fetchSnowRanking(type, retryCount + 1); }
        snowStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
    }
}

if (fetchSnowTotButton) fetchSnowTotButton.addEventListener('click', () => fetchSnowRanking('tot'));
if (fetchSnowDayButton) fetchSnowDayButton.addEventListener('click', () => fetchSnowRanking('day'));
