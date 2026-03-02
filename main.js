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

// Weather elements
const fetchWeatherTodayButton = document.getElementById('fetch-weather-today');
const fetchWeatherCurrentButton = document.getElementById('fetch-weather-current');
const weatherResultContainer = document.getElementById('weather-result-container');
const weatherTableBody = document.getElementById('weather-table-body');
const weatherValueHeader = document.getElementById('weather-value-header');
const weatherTimeElement = document.getElementById('weather-time');
const weatherStatus = document.getElementById('weather-status');

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

async function fetchWeatherRanking(type) {
    const typeNames = {
        'today': '오늘 최고 기온',
        'current': '현재 최고 기온'
    };
    
    weatherStatus.textContent = `${typeNames[type]} 데이터를 불러오는 중...`;
    
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
            // Today's Max Temp using sfc_aws_day.php
            // We fetch both ta_max and ta_max_tm
            const [respMax, respTime] = await Promise.all([
                fetch(PROXY_URL + encodeURIComponent(`https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=ta_max&stn=0&authKey=${authKey}`)),
                fetch(PROXY_URL + encodeURIComponent(`https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=ta_max_tm&stn=0&authKey=${authKey}`))
            ]);

            const decoder = new TextDecoder('euc-kr');
            const textMax = decoder.decode(await respMax.arrayBuffer());
            const textTime = decoder.decode(await respTime.arrayBuffer());
            
            const timeMap = {};
            textTime.split('\n').forEach(line => {
                if (line.startsWith('#') || line.trim() === '') return;
                const parts = line.split(',');
                if (parts.length >= 6) {
                    const stnId = parts[1].trim();
                    const timeVal = parts[5].trim();
                    if (timeVal && timeVal !== '-9.0') {
                        timeMap[stnId] = timeVal;
                    }
                }
            });

            const linesMax = textMax.split('\n');
            for (const line of linesMax) {
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
                    
                    const timeVal = timeMap[stnId] || "";
                    let timeStr = "";
                    if (timeVal.length === 4) {
                        timeStr = `${timeVal.substring(0, 2)}:${timeVal.substring(2, 4)}`;
                    } else if (timeVal) {
                        timeStr = timeVal;
                    }
                    
                    stations.push({ 
                        id: stnId, 
                        val, 
                        name, 
                        address, 
                        timeStr: timeStr ? `(${timeStr})` : "" 
                    });
                    if (tm) lastTm = tm;
                }
            }
        }
        
        stations.sort((a, b) => b.val - a.val);
        const top10 = stations.slice(0, 10);
        
        if (top10.length > 0) {
            weatherValueHeader.textContent = '기온';
            weatherTableBody.innerHTML = '';
            top10.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index + 1}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: var(--button-bg); font-weight: 800;">
                        ${item.val.toFixed(1)} °C <span style="font-size: 0.85rem; font-weight: 400; color: var(--text-muted);">${item.timeStr || ''}</span>
                    </td>
                    <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>
                `;
                weatherTableBody.appendChild(row);
            });
            
            if (lastTm) {
                const formattedTime = lastTm.length >= 8 ? `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10) || '00'}:${lastTm.substring(10, 12) || '00'}` : lastTm;
                weatherTimeElement.textContent = `기준 시간: ${formattedTime}`;
            }
            
            weatherResultContainer.style.display = 'block';
            weatherStatus.textContent = '조회가 완료되었습니다.';
        } else {
            weatherStatus.textContent = '유효한 데이터를 찾을 수 없습니다.';
        }
    } catch (error) {
        console.error(error);
        weatherStatus.textContent = '오류가 발생했습니다.';
    }
}

if (fetchWeatherTodayButton) fetchWeatherTodayButton.addEventListener('click', () => fetchWeatherRanking('today'));
if (fetchWeatherCurrentButton) fetchWeatherCurrentButton.addEventListener('click', () => fetchWeatherRanking('current'));

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
