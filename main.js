// Global variables for UI
const themeToggle = document.getElementById('theme-toggle');
const bureauSelect = document.getElementById('bureau-select');
const body = document.body;

// 총국별 관할 광역지자체 매핑
const BUREAU_MAPPING = {
    '전국': [],
    '본사': ['서울', '경기', '인천'],
    '대전총국': ['대전', '세종', '충남'],
    '청주총국': ['충북'],
    '전주총국': ['전북'],
    '광주총국': ['전남', '광주'],
    '제주총국': ['제주'],
    '춘천총국': ['강원'],
    '대구총국': ['대구', '경북'],
    '부산총국': ['부산', '울산'],
    '창원총국': ['경남']
};

// 지점 정보 캐시
let cachedStationMapping = null;
const PROXY_URL = "https://api.codetabs.com/v1/proxy/?quest=";

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

// Theme toggle
const currentTheme = localStorage.getItem('theme');
if (currentTheme === 'dark') { body.classList.add('dark-mode'); themeToggle.textContent = '라이트 모드'; }
themeToggle.addEventListener('click', () => {
    body.classList.toggle('dark-mode');
    let theme = body.classList.contains('dark-mode') ? 'dark' : 'light';
    themeToggle.textContent = theme === 'dark' ? '라이트 모드' : '다크 모드';
    localStorage.setItem('theme', theme);
});

// UI Elements Helper
const getEl = (id) => document.getElementById(id);

// 지점 정보 로드 및 파싱 (지점명 및 주소 매핑 강화)
async function getStationMapping(authKey) {
    if (cachedStationMapping) return cachedStationMapping;
    const mapping = {};
    const decoder = new TextDecoder('euc-kr');

    const parseLines = (text) => {
        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.trim().split(/\s+/);
            if (p.length < 5) return;
            
            // stations.txt: 0=ID, 10=Name, 14~=Addr
            const id = p[0];
            let name = "";
            let adr = "";

            // Find name: Skip numeric/coordinate-like values
            for (let i = 1; i < p.length; i++) {
                if (isNaN(p[i]) && !p[i].includes('.') && p[i].length >= 2 && p[i] !== '----') {
                    // Possible name found. Usually Korean name comes before English.
                    if (!name) name = p[i]; 
                }
            }
            if (!name && p[10]) name = p[10]; // Fallback for stations.txt standard format

            // Find address: Start from known province names
            const adrStartIdx = p.findIndex(item => 
                ['서울','경기','인천','강원','충북','충남','대전','세종','전북','전남','광주','경북','경남','대구','부산','울산','제주'].some(r => item.startsWith(r))
            );
            if (adrStartIdx !== -1) {
                // Remove legal codes (long digits) and join
                adr = p.slice(adrStartIdx).join(' ').replace(/\d{4,}/g, '').trim();
            }
            
            if (id && name) {
                mapping[id] = { name: name.replace(/,$/, ''), adr };
            }
        });
    };

    try {
        // Load local first
        const local = await fetch('stations.txt');
        if (local.ok) parseLines(decoder.decode(await local.arrayBuffer()));
        
        // Load API if needed (commented out to save requests if local is enough, but user wants robustness)
        // We will try one API source to be sure
        const url = `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=SFC&stn=0&authKey=${authKey}`;
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        if (res.ok) parseLines(decoder.decode(await res.arrayBuffer()));
        
    } catch (e) { console.error(e); }
    cachedStationMapping = mapping;
    return mapping;
}

const formatTime = (tm) => {
    if (!tm || tm.length < 12) return tm;
    return `${tm.substring(0,4)}-${tm.substring(4,6)}-${tm.substring(6,8)} ${tm.substring(8,10)}:${tm.substring(10,12)}`;
};

// Generic Fetch Function to reduce code duplication and errors
async function fetchAndDisplay(type, mode, uiGroup, processLine) {
    uiGroup.status.textContent = '데이터 분석 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stnMap = await getStationMapping(authKey);
        
        let url = '';
        if (type === 'precip') url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}`;
        else if (type === 'snow') url = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${mode}&authKey=${authKey}`;
        else if (mode === 'current') url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}`;
        else url = `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=${type==='high'?'ta_max':'ta_min'}&stn=0&authKey=${authKey}`;

        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [], lastTm = "";

        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            
            const result = processLine(p, stnMap);
            if (result) {
                stations.push(result);
                lastTm = p[0];
            }
        });

        // Filter and Sort
        stations = getFilteredStations(stations);
        if (type === 'precip' || type === 'snow') stations.sort((a,b) => b.val - a.val);
        else if (type === 'high') stations.sort((a,b) => b.val - a.val);
        else stations.sort((a,b) => a.val - b.val);
        
        stations = stations.slice(0, 10);

        // Render
        uiGroup.body.innerHTML = stations.map((s,i) => {
            const valColor = type === 'precip' ? '#007bff' : (type === 'snow' ? '#e83e8c' : 'var(--button-bg)');
            const unit = type === 'precip' ? 'mm' : (type === 'snow' ? 'cm' : '°C');
            return `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:${valColor};font-weight:800;">${s.val.toFixed(1)}${unit}</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address || '정보 없음'}</td></tr>`;
        }).join('');
        
        uiGroup.time.textContent = `기준 시간: ${formatTime(lastTm)}`;
        uiGroup.container.style.display = 'block';
        uiGroup.status.textContent = '조회 완료';

    } catch(e) {
        console.error(e);
        uiGroup.status.textContent = '오류 발생: 다시 시도해주세요.';
    }
}

// Handler Wrappers
const handlers = {
    weather: (mode) => {
        const uiGroup = { status: getEl('weather-status'), container: getEl('weather-result-container'), body: getEl('weather-table-body'), time: getEl('weather-time') };
        fetchAndDisplay('high', mode, uiGroup, (p, stnMap) => {
            const stnId = p[1]?.trim();
            if (!stnId) return null;
            let val = NaN;
            if (mode === 'current' && p.length >= 9) val = parseFloat(p[8]);
            else if (mode === 'today' && p.length >= 6) val = parseFloat(p[5]);
            
            if (!isNaN(val) && val > -50 && val < 50) { // Valid temp range
                const info = stnMap[stnId] || { name: stnId, adr: "" };
                return { name: info.name, val, address: info.adr };
            }
            return null;
        });
    },
    low: (mode) => {
        const uiGroup = { status: getEl('low-temp-status'), container: getEl('low-temp-result-container'), body: getEl('low-temp-table-body'), time: getEl('low-temp-time') };
        fetchAndDisplay('low', mode, uiGroup, (p, stnMap) => {
            const stnId = p[1]?.trim();
            if (!stnId) return null;
            let val = NaN;
            if (mode === 'current' && p.length >= 9) val = parseFloat(p[8]);
            else if (mode === 'today' && p.length >= 6) val = parseFloat(p[5]);
            
            if (!isNaN(val) && val > -50 && val < 50) {
                const info = stnMap[stnId] || { name: stnId, adr: "" };
                return { name: info.name, val, address: info.adr };
            }
            return null;
        });
    },
    precip: (mode) => {
        const uiGroup = { status: getEl('precip-status'), container: getEl('precip-result-container'), body: getEl('precip-table-body'), time: getEl('precip-time') };
        fetchAndDisplay('precip', mode, uiGroup, (p, stnMap) => {
            const stnId = p[1]?.trim();
            if (p.length >= 14) {
                const val = parseFloat(p[mode==='1h'?11:13]);
                if (val > 0) {
                    const info = stnMap[stnId] || { name: stnId, adr: "" };
                    return { name: info.name, val, address: info.adr };
                }
            }
            return null;
        });
    },
    snow: (mode) => {
        const uiGroup = { status: getEl('snow-status'), container: getEl('snow-result-container'), body: getEl('snow-table-body'), time: getEl('snow-time') };
        fetchAndDisplay('snow', mode, uiGroup, (p, stnMap) => {
            if (p.length >= 7) {
                const stnId = p[1].trim();
                const val = parseFloat(p[6]);
                if (val > 0) {
                    // Try to get name from map (more accurate), fallback to p[2]
                    const info = stnMap[stnId];
                    const name = info ? info.name : p[2].replace(/,$/, '');
                    const adr = info ? info.adr : "";
                    return { name, val, address: adr };
                }
            }
            return null;
        });
    }
};

// --- Weather Warnings Logic ---
const WARNING_WIDE_MAP = {
    '강원도': '강원', '경기도': '경기', '경상남도': '경남', '경상북도': '경북', 
    '전라남도': '전남', '전라북도': '전북', '충청남도': '충남', '충청북도': '충북',
    '제주도': '제주', '서울특별시': '서울', '인천광역시': '인천', '대전광역시': '대전', 
    '광주광역시': '광주', '대구광역시': '대구', '울산광역시': '울산', '부산광역시': '부산',
    '세종특별자치시': '세종'
};

async function fetchWeatherWarnings() {
    const listEl = getEl('warning-list');
    if (!listEl) return;
    
    getEl('warning-status').textContent = '특보 데이터 분석 중...';
    const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
    const selectedBureau = bureauSelect.value;
    const targetRegions = BUREAU_MAPPING[selectedBureau] || [];

    const getTimeName = (tm) => {
        if (!tm || tm.length < 12) return "";
        const hh = parseInt(tm.substring(8, 10));
        let name = hh < 6 ? "새벽" : (hh < 12 ? "오전" : (hh < 18 ? "오후" : "밤"));
        const today = new Date();
        const tmDay = parseInt(tm.substring(6, 8));
        const day = (tmDay !== today.getDate()) ? "내일" : "오늘";
        return `(${day} ${name})`;
    };

    try {
        const fetchData = async (fe) => {
            const url = `https://apihub.kma.go.kr/api/typ01/url/wrn_now_data_new.php?fe=${fe}&authKey=${authKey}`;
            const res = await fetch(PROXY_URL + encodeURIComponent(url));
            return new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        };

        const [fData, pData] = await Promise.all([fetchData('f'), fetchData('p')]);
        const allLines = [...fData.split('\n'), ...pData.split('\n')];
        
        let warnings = { '경보': {}, '주의보': {}, '예비특보': {} }; 
        const now = new Date();
        const lastTm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        let hasData = false;

        allLines.forEach(line => {
            if (line.startsWith('#') || !line.trim() || line.includes('START')) return;
            const p = line.split(',').map(s => s.trim());
            if (p.length < 9) return;

            const upRegion = p[1]; 
            const regionRaw = p[3];    
            const type = p[6];      
            const levelRaw = p[7];     
            const tmEf = p[5];      

            let wideName = WARNING_WIDE_MAP[upRegion] || upRegion.replace(/특별시|광역시|특별자치시|특별자치도|도$/g, '');
            if (wideName === '제주') wideName = '제주'; // Ensure simple name

            if (type.includes('풍랑') && selectedBureau !== '전국') return;

            // Strict Level Logic
            let levelKey = '예비특보';
            if (levelRaw.includes('경보') || levelRaw === '2') levelKey = '경보';
            else if (levelRaw.includes('주의보') || levelRaw === '1') levelKey = '주의보';

            let title = `${type} ${levelKey}`;
            if (levelKey === '예비특보') title = `${type} 예비특보${getTimeName(tmEf)}`;

            let subName = regionRaw.replace(/[()]/g, '').trim();
            // Remove parent region name if prefixed
            if (subName.startsWith(upRegion)) subName = subName.replace(upRegion, '').trim();
            else if (subName.startsWith(wideName)) subName = subName.replace(wideName, '').trim();
            
            // Clean suffix but preserve specific islands
            if (subName.length > 2 && !['울릉도', '독도', '제주도', '흑산도', '홍도'].some(i => subName.includes(i))) {
                subName = subName.replace(/시$|군$|구$/g, '');
            }
            if (!subName || subName === wideName) subName = wideName;

            if (!warnings[levelKey][title]) warnings[levelKey][title] = {};
            if (!warnings[levelKey][title][wideName]) warnings[levelKey][title][wideName] = new Set();
            
            if (subName === wideName) warnings[levelKey][title][wideName].add("__WHOLE__");
            else warnings[levelKey][title][wideName].add(subName);
        });

        let html = '';
        ['경보', '주의보', '예비특보'].forEach(level => {
            const group = warnings[level];
            const titles = Object.keys(group).sort();
            let levelHtml = '';
            
            titles.forEach(t => {
                const wideRegions = group[t];
                const texts = [];
                Object.keys(wideRegions).forEach(wide => {
                    if (selectedBureau !== '전국' && !targetRegions.includes(wide)) return;
                    const subs = Array.from(wideRegions[wide]);
                    if (subs.includes("__WHOLE__") && subs.length === 1) texts.push(wide);
                    else texts.push(`${wide}(${subs.filter(s => s !== "__WHOLE__").sort().join('·')})`);
                });
                if (texts.length > 0) levelHtml += `<div class="warning-item"><span class="warning-title">○ ${t}</span> : ${texts.join(', ')}</div>`;
            });

            if (levelHtml) {
                hasData = true;
                const badge = level === '경보' ? 'badge-danger' : (level === '주의보' ? 'badge-warning' : 'badge-info');
                html += `<div class="warning-group ${level}"><div class="warning-group-header"><span class="warning-badge ${badge}">${level}</span></div><div class="warning-group-body">${levelHtml}</div></div>`;
            }
        });

        listEl.innerHTML = hasData ? html : '<div style="text-align:center;padding:40px;color:var(--text-muted);">현재 발효 중인 특보가 없습니다.</div>';
        getEl('warning-status').textContent = hasData ? '조회 완료' : '특보 없음';
        if (lastTm) getEl('warning-time').textContent = `기준 시간: ${formatTime(lastTm)}`;
    } catch(e) { console.error(e); getEl('warning-status').textContent = '오류 발생'; }
}

// Initialize
bureauSelect.addEventListener('change', fetchWeatherWarnings);
window.addEventListener('DOMContentLoaded', fetchWeatherWarnings);

// Button Event Listeners
getEl('fetch-weather-today')?.addEventListener('click', () => handlers.weather('today'));
getEl('fetch-weather-current')?.addEventListener('click', () => handlers.weather('current'));
getEl('fetch-low-today')?.addEventListener('click', () => handlers.low('today'));
getEl('fetch-low-current')?.addEventListener('click', () => handlers.low('current'));
getEl('fetch-precip-1h')?.addEventListener('click', () => handlers.precip('1h'));
getEl('fetch-precip-today')?.addEventListener('click', () => handlers.precip('today'));
getEl('fetch-snow-tot')?.addEventListener('click', () => handlers.snow('tot'));
getEl('fetch-snow-day')?.addEventListener('click', () => handlers.snow('day'));
