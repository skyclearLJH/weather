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
const fetchPrecip3hButton = document.getElementById('fetch-precip-3h');
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
    if (cachedStationMapping) return cachedStationMapping;
    
    try {
        const mapping = {};
        const decoder = new TextDecoder('euc-kr');

        const fetchAndParse = async (type) => {
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=${type}&stn=0&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            if (!response.ok) return;
            
            const buffer = await response.arrayBuffer();
            const text = decoder.decode(buffer);
            const lines = text.split('\n');
            
            let stnKoIndex = -1;
            let adrIndex = -1;
            
            for (const line of lines) {
                if (line.includes('STN_KO')) {
                    const headerParts = line.trim().split(/\s+/);
                    stnKoIndex = headerParts.indexOf('STN_KO');
                    // Look for LAW_ADDR first, then ADR
                    adrIndex = headerParts.indexOf('LAW_ADDR');
                    if (adrIndex === -1) adrIndex = headerParts.indexOf('ADR');
                    
                    if (stnKoIndex !== -1) stnKoIndex -= 1;
                    if (adrIndex !== -1) adrIndex -= 1;
                    break;
                }
            }
            
            // Fallbacks for AWS/SFC
            if (stnKoIndex === -1) stnKoIndex = 8; 
            if (adrIndex === -1) adrIndex = 13;

            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
                
                const parts = line.trim().split(/\s+/);
                if (parts.length > stnKoIndex) {
                    const id = parts[0];
                    const name = parts[stnKoIndex];
                    let adr = "";
                    if (adrIndex !== -1 && parts.length > adrIndex) {
                        const rawAdr = parts.slice(adrIndex).join(' ').replace(/^---- /, '').trim();
                        // Clean up: Filter address to start from city name or (산지)/(상지)
                        const adrMatch = rawAdr.match(/(\(산지\)|\(상지\)|강원|경기|서울|인천|대전|대구|부산|울산|광주|세종|충북|충남|전북|전남|경북|경남|제주).*/);
                        adr = adrMatch ? adrMatch[0].trim() : rawAdr;
                    }
                    
                    if (name && name !== '----' && !/^\d+$/.test(name)) {
                        mapping[id] = { name, adr };
                    }
                }
            }
        };

        await fetchAndParse('SFC');
        await fetchAndParse('AWS');

        cachedStationMapping = mapping;
        return mapping;
    } catch (e) {
        console.error('Failed to fetch station mapping:', e);
        return cachedStationMapping || {};
    }
}

async function fetchWeatherRanking(type, mode = 'highest') {
    const isHighest = mode === 'highest';
    const statusEl = isHighest ? weatherStatus : lowTempStatus;
    const resultContainerEl = isHighest ? weatherResultContainer : lowTempResultContainer;
    const tableBodyEl = isHighest ? weatherTableBody : lowTempTableBody;
    const valueHeaderEl = isHighest ? weatherValueHeader : lowTempValueHeader;
    const timeEl = isHighest ? weatherTimeElement : lowTempTimeElement;

    const typeNames = {
        'today': '오늘 ' + (isHighest ? '최고' : '최저') + ' 기온',
        'current': '현재 ' + (isHighest ? '최고' : '최저') + ' 기온'
    };
    
    statusEl.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
    
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        
        const stations = [];
        let lastTm = "";

        if (type === 'current') {
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&disp=1&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            if (!response.ok) throw new Error('HTTP ' + response.status);
            
            const buffer = await response.arrayBuffer();
            const text = new TextDecoder('euc-kr').decode(buffer);
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                const parts = line.split(',');
                if (parts.length < 9) continue;
                const tm = parts[0];
                const stnId = parts[1].trim();
                const val = parseFloat(parts[8]); // TA
                
                if (!isNaN(val) && val > -50 && val < 60) {
                    const name = stationData[stnId]?.name || `지점 ${stnId}`;
                    const address = stationData[stnId]?.adr || "주소 정보 없음";
                    stations.push({ id: stnId, val, name, address });
                    if (tm) lastTm = tm;
                }
            }
        } else {
            // Today's Max/Min Temp using sfc_aws_day.php
            const obs = isHighest ? 'ta_max' : 'ta_min';
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=${obs}&stn=0&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            if (!response.ok) throw new Error('HTTP ' + response.status);

            const buffer = await response.arrayBuffer();
            const text = new TextDecoder('euc-kr').decode(buffer);
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                const parts = line.split(',');
                if (parts.length < 6) continue;
                
                const tm = parts[0].trim();
                const stnId = parts[1].trim();
                const val = parseFloat(parts[5].trim());
                const nameInApi = parts[6] ? parts[6].replace('=', '').trim() : '';
                
                if (!isNaN(val) && val > -50 && val < 60) {
                    const name = stationData[stnId]?.name || nameInApi || `지점 ${stnId}`;
                    const address = stationData[stnId]?.adr || "주소 정보 없음";
                    stations.push({ id: stnId, val, name, address });
                    if (tm) lastTm = tm;
                }
            }
        }
        
        // Sort: Descending for highest, Ascending for lowest
        if (isHighest) {
            stations.sort((a, b) => b.val - a.val);
        } else {
            stations.sort((a, b) => a.val - b.val);
        }
        
        const top10 = stations.slice(0, 10);
        
        if (top10.length > 0) {
            valueHeaderEl.textContent = '기온';
            tableBodyEl.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index + 1}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: var(--button-bg); font-weight: 800;">
                        ${item.val.toFixed(1)} °C
                    </td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>
                `;
                tableBodyEl.appendChild(row);
            });
            
            if (lastTm) {
                const formattedTime = lastTm.length >= 8 ? `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10) || '00'}:${lastTm.substring(10, 12) || '00'}` : lastTm;
                timeEl.textContent = `기준 시간: ${formattedTime}`;
            }
            
            resultContainerEl.style.display = 'block';
            statusEl.textContent = '조회가 완료되었습니다.';
        } else {
            statusEl.textContent = '유효한 데이터를 찾을 수 없습니다.';
        }
    } catch (error) {
        console.error(error);
        statusEl.textContent = '오류가 발생했습니다.';
    }
}

if (fetchWeatherTodayButton) fetchWeatherTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'highest'));
if (fetchWeatherCurrentButton) fetchWeatherCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'highest'));
if (fetchLowTodayButton) fetchLowTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'lowest'));
if (fetchLowCurrentButton) fetchLowCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'lowest'));

async function fetchPrecipRanking(type) {
    const typeNames = {
        '1h': '1시간 강수량',
        '3h': '3시간 강수량',
        'today': '오늘 강수량'
    };
    
    precipStatus.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
    
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        
        const stations = [];
        let lastTm = "";

        if (type === '1h' || type === 'today') {
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&disp=1&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            if (!response.ok) throw new Error('HTTP ' + response.status);
            
            const buffer = await response.arrayBuffer();
            const text = new TextDecoder('euc-kr').decode(buffer);
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                const parts = line.split(',');
                if (parts.length < 14) continue;
                
                const tm = parts[0];
                const stnId = parts[1].trim();
                const val = parseFloat(type === '1h' ? parts[11] : parts[13]); // index 11: RN-60m, index 13: RN-DAY
                
                if (!isNaN(val) && val > 0 && val < 1000) {
                    const name = stationData[stnId]?.name || `지점 ${stnId}`;
                    const address = stationData[stnId]?.adr || "주소 정보 없음";
                    stations.push({ id: stnId, val, name, address });
                    if (tm) lastTm = tm;
                }
            }
        } else {
            // 3-hour precipitation using kma_sfctm2.php (AWS hourly)
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php?stn=0&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            if (!response.ok) throw new Error('HTTP ' + response.status);
            
            const buffer = await response.arrayBuffer();
            const text = new TextDecoder('euc-kr').decode(buffer);
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                const parts = line.trim().split(/\s+/);
                if (parts.length < 20) continue;
                
                const tm = parts[0];
                const stnId = parts[1];
                const val = parseFloat(parts[19]); // index 19: RN_HR3
                
                if (!isNaN(val) && val > 0 && val < 1000) {
                    const name = stationData[stnId]?.name || `지점 ${stnId}`;
                    const address = stationData[stnId]?.adr || "주소 정보 없음";
                    stations.push({ id: stnId, val, name, address });
                    if (tm) lastTm = tm;
                }
            }
        }
        
        stations.sort((a, b) => b.val - a.val);
        const top10 = stations.slice(0, 10);
        
        if (top10.length > 0) {
            precipValueHeader.textContent = '강수량';
            precipTableBody.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index + 1}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: #007bff; font-weight: 800;">
                        ${item.val.toFixed(1)} mm
                    </td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>
                `;
                precipTableBody.appendChild(row);
            });
            
            if (lastTm) {
                const formattedTime = lastTm.length >= 8 ? `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10) || '00'}:${lastTm.substring(10, 12) || '00'}` : lastTm;
                precipTimeElement.textContent = `기준 시간: ${formattedTime}`;
            }
            
            precipResultContainer.style.display = 'block';
            precipStatus.textContent = '조회가 완료되었습니다.';
        } else {
            precipStatus.textContent = `현재 관측된 ${typeNames[type]} 데이터가 없습니다.`;
            precipResultContainer.style.display = 'none';
        }
    } catch (error) {
        console.error(error);
        precipStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
    }
}

if (fetchPrecip1hButton) fetchPrecip1hButton.addEventListener('click', () => fetchPrecipRanking('1h'));
if (fetchPrecip3hButton) fetchPrecip3hButton.addEventListener('click', () => fetchPrecipRanking('3h'));
if (fetchPrecipTodayButton) fetchPrecipTodayButton.addEventListener('click', () => fetchPrecipRanking('today'));

async function fetchSnowRanking(type) {
    const typeNames = {
        'tot': '적설량',
        'day': '신적설(일)'
    };
    
    snowStatus.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
    
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        
        const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${type}&authKey=${authKey}`;
        const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
        
        if (!response.ok) throw new Error('HTTP ' + response.status);
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('euc-kr');
        const text = decoder.decode(buffer);
        const lines = text.split('\n');
        
        const stations = [];
        let lastTm = "";

        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
            
            const parts = line.split(',');
            if (parts.length >= 7) {
                const tm = parts[0].trim();
                const stnId = parts[1].trim();
                const stnKoInData = parts[2].trim();
                const val = parseFloat(parts[6].trim());
                
                if (!isNaN(val) && val >= 0 && val < 900) {
                    const name = stationData[stnId]?.name || stnKoInData || `지점 ${stnId}`;
                    const address = stationData[stnId]?.adr || "주소 정보 없음";
                    
                    stations.push({ id: stnId, val, name, address });
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
                row.innerHTML = `
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index + 1}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: var(--accent-color); font-weight: 800;">${item.val.toFixed(1)} cm</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>
                `;
                snowTableBody.appendChild(row);
            });
            
            if (lastTm) {
                const formattedTime = `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10)}:${lastTm.substring(10, 12)}`;
                snowTimeElement.textContent = `기준 시간: ${formattedTime}`;
            }
            
            snowResultContainer.style.display = 'block';
            snowStatus.textContent = '조회가 완료되었습니다.';
        } else {
            snowStatus.textContent = `현재 관측된 ${typeNames[type]} 데이터가 없습니다.`;
            snowResultContainer.style.display = 'none';
        }
    } catch (error) {
        console.error(error);
        snowStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
    }
}

if (fetchSnowTotButton) fetchSnowTotButton.addEventListener('click', () => fetchSnowRanking('tot'));
if (fetchSnowDayButton) fetchSnowDayButton.addEventListener('click', () => fetchSnowRanking('day'));
