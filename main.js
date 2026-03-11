// Global variables for UI
const themeToggle = document.getElementById('theme-toggle');
const bureauSelect = document.getElementById('bureau-select');
const body = document.body;

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

// Elements
const weatherStatus = document.getElementById('weather-status');
const weatherResultContainer = document.getElementById('weather-result-container');
const weatherTableBody = document.getElementById('weather-table-body');
const weatherValueHeader = document.getElementById('weather-value-header');
const weatherTimeElement = document.getElementById('weather-time');

const lowTempStatus = document.getElementById('low-temp-status');
const lowTempResultContainer = document.getElementById('low-temp-result-container');
const lowTempTableBody = document.getElementById('low-temp-table-body');
const lowTempValueHeader = document.getElementById('low-temp-value-header');
const lowTempTimeElement = document.getElementById('low-temp-time');

const precipStatus = document.getElementById('precip-status');
const precipResultContainer = document.getElementById('precip-result-container');
const precipTableBody = document.getElementById('precip-table-body');
const precipValueHeader = document.getElementById('precip-value-header');
const precipTimeElement = document.getElementById('precip-time');

const snowStatus = document.getElementById('snow-status');
const snowResultContainer = document.getElementById('snow-result-container');
const snowTableBody = document.getElementById('snow-table-body');
const snowValueHeader = document.getElementById('snow-value-header');
const snowTimeElement = document.getElementById('snow-time');

const warningList = document.getElementById('warning-list');
const warningTime = document.getElementById('warning-time');
const warningStatus = document.getElementById('warning-status');

const PROXY_URL = "https://api.codetabs.com/v1/proxy/?quest=";
let cachedStationMapping = null;

async function getStationMapping(authKey) {
    if (cachedStationMapping) return cachedStationMapping;
    const mapping = {};
    const decoder = new TextDecoder('euc-kr');
    const parseLines = (text) => {
        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const parts = line.trim().split(/\s+/);
            if (parts.length > 5) {
                const id = parts[0];
                let name = parts[10] || "";
                let adr = parts.slice(15).join(' ');
                if (id && name && isNaN(name)) mapping[id] = { name, adr };
            }
        });
    };
    try {
        const local = await fetch('stations.txt');
        if (local.ok) parseLines(decoder.decode(await local.arrayBuffer()));
        const res = await fetch(PROXY_URL + encodeURIComponent(`https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=SFC&stn=0&authKey=${authKey}`));
        if (res.ok) parseLines(decoder.decode(await res.arrayBuffer()));
    } catch (e) {}
    cachedStationMapping = mapping;
    return mapping;
}

const formatTime = (tm) => `${tm.substring(0,4)}-${tm.substring(4,6)}-${tm.substring(6,8)} ${tm.substring(8,10)}:${tm.substring(10,12)}`;

async function fetchWeatherRanking(type, mode = 'highest') {
    const isHighest = mode === 'highest';
    const statusEl = isHighest ? weatherStatus : lowTempStatus;
    const containerEl = isHighest ? weatherResultContainer : lowTempResultContainer;
    const bodyEl = isHighest ? weatherTableBody : lowTempTableBody;
    statusEl.textContent = '데이터를 불러오는 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const url = type === 'current' ? `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}` : `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=${isHighest?'ta_max':'ta_min'}&stn=0&authKey=${authKey}`;
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [];
        let lastTm = "";
        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            if (type === 'current' && p.length >= 9) {
                const val = parseFloat(p[8]);
                if (!isNaN(val)) {
                    const info = stationData[p[1].trim()] || { name: p[1], adr: "" };
                    stations.push({ name: info.name, val, address: info.adr });
                    lastTm = p[0];
                }
            } else if (type === 'today' && p.length >= 6) {
                const val = parseFloat(p[5]);
                if (!isNaN(val)) {
                    const info = stationData[p[1].trim()] || { name: p[6]||p[1], adr: "" };
                    stations.push({ name: info.name, val, address: info.adr });
                    lastTm = p[0];
                }
            }
        });
        stations = getFilteredStations(stations).sort((a,b) => isHighest ? b.val-a.val : a.val-b.val).slice(0,10);
        bodyEl.innerHTML = stations.map((s,i) => `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:var(--button-bg);font-weight:800;">${s.val.toFixed(1)}</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address}</td></tr>`).join('');
        (isHighest?weatherTimeElement:lowTempTimeElement).textContent = `기준 시간: ${lastTm}`;
        containerEl.style.display = 'block'; statusEl.textContent = '조회 완료';
    } catch(e) { statusEl.textContent = '오류 발생'; }
}

async function fetchPrecipRanking(type) {
    precipStatus.textContent = '데이터를 불러오는 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}`;
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [], lastTm = "";
        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            if (p.length >= 14) {
                const val = parseFloat(p[type==='1h'?11:13]);
                if (val > 0) {
                    const info = stationData[p[1].trim()] || { name: p[1], adr: "" };
                    stations.push({ name: info.name, val, address: info.adr });
                    lastTm = p[0];
                }
            }
        });
        stations = getFilteredStations(stations).sort((a,b) => b.val-a.val).slice(0,10);
        precipTableBody.innerHTML = stations.map((s,i) => `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:#007bff;font-weight:800;">${s.val.toFixed(1)}</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address}</td></tr>`).join('');
        precipTimeElement.textContent = `기준 시간: ${lastTm}`;
        precipResultContainer.style.display = 'block'; precipStatus.textContent = '조회가 완료되었습니다.';
    } catch(e) { precipStatus.textContent = '오류 발생'; }
}

async function fetchSnowRanking(type) {
    snowStatus.textContent = '데이터를 불러오는 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stationData = await getStationMapping(authKey);
        const url = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${type==='day'?'day':'tot'}&authKey=${authKey}`;
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [], lastTm = "";
        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.trim().split(/\s+/);
            if (p.length >= 7) {
                const val = parseFloat(p[6]);
                if (val > 0) {
                    const info = stationData[p[1].trim()] || { name: p[2], adr: "" };
                    stations.push({ name: info.name, val, address: info.adr });
                    lastTm = p[0];
                }
            }
        });
        stations = getFilteredStations(stations).sort((a,b) => b.val-a.val).slice(0,10);
        snowTableBody.innerHTML = stations.map((s,i) => `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:var(--accent-color);font-weight:800;">${s.val.toFixed(1)}</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address}</td></tr>`).join('');
        snowTimeElement.textContent = `기준 시간: ${lastTm}`;
        snowResultContainer.style.display = 'block'; snowStatus.textContent = '조회가 완료되었습니다.';
    } catch(e) { snowStatus.textContent = '오류 발생'; }
}

// --- Weather Warnings Logic ---
const WIDE_MAP = {
    '강원도': '강원', '경기도': '경기', '경상남도': '경남', '경상북도': '경북', 
    '전라남도': '전남', '전라북도': '전북', '충청남도': '충남', '충청북도': '충북',
    '제주도': '제주도', '제주도전해상': '제주도', '제주전해상': '제주도',
    '서울특별시': '서울', '인천광역시': '인천', '대전광역시': '대전', 
    '광주광역시': '광주', '대구광역시': '대구', '울산광역시': '울산', '부산광역시': '부산',
    '세종특별자치시': '세종'
};

async function fetchWeatherWarnings() {
    if (!warningList) return;
    warningStatus.textContent = '기상특보 데이터를 분석 중...';
    const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
    const selectedBureau = bureauSelect ? bureauSelect.value : '전국';
    const targetRegions = BUREAU_MAPPING[selectedBureau] || [];

    const getTimeName = (tm) => {
        if (!tm || tm.length < 12) return "";
        const hh = parseInt(tm.substring(8, 10));
        const mm = tm.substring(10, 12);
        let name = "";
        if (hh < 6) name = "새벽"; else if (hh < 12) name = "오전"; else if (hh < 18) name = "오후"; else name = "밤";
        const today = new Date();
        const tmDay = parseInt(tm.substring(6, 8));
        const day = (tmDay !== today.getDate()) ? "내일" : "오늘";
        return `(${day} ${name})`;
    };

    try {
        const fetchData = async (fe) => {
            const url = `https://apihub.kma.go.kr/api/typ01/url/wrn_now_data_new.php?fe=${fe}&tm=&disp=0&help=1&authKey=${authKey}`;
            const res = await fetch(PROXY_URL + encodeURIComponent(url));
            return new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        };

        const [fData, pData] = await Promise.all([fetchData('f'), fetchData('p')]);
        const allLines = [...fData.split('\n'), ...pData.split('\n')];
        
        let warnings = {}; 
        let lastTm = "";

        allLines.forEach(line => {
            if (line.startsWith('#기준시각:')) lastTm = line.split(':')[1].trim();
            if (line.startsWith('#') || !line.trim() || line.includes('START')) return;

            const p = line.split(',').map(s => s.trim());
            if (p.length < 9) return;

            const upRegionRaw = p[1]; 
            const regionRaw = p[3];    
            const type = p[6];      
            const level = p[7];     
            const tmEf = p[5];      

            if (type.includes('풍랑') && selectedBureau !== '전국') return;
            if (selectedBureau !== '전국') {
                if (!targetRegions.some(r => upRegionRaw.includes(r) || regionRaw.includes(r))) return;
            }

            let title = `${type} ${level}${level === '예비' ? '특보' : '보'}`;
            if (level === '예비') title += getTimeName(tmEf);

            const wideName = WIDE_MAP[upRegionRaw] || upRegionRaw.replace(/특별시|광역시|도|특별자치시|특별자치도/g, '');
            
            // 상세 지역명에서 광역명 및 시/군/구 제거 로직
            let subName = regionRaw;
            // 1. 광역명 제거 (강원도, 강원 모두 제거)
            subName = subName.replace(upRegionRaw, '').replace(wideName, '');
            // 2. '시', '군' 제거 (단, 단독 지명인 경우 보존을 위해 정교하게 처리)
            if (subName.length > 2) subName = subName.replace(/시$|군$|구$/g, '');
            subName = subName.trim();

            if (!warnings[title]) warnings[title] = {};
            if (!warnings[title][wideName]) warnings[title][wideName] = new Set();
            if (!subName || subName === wideName) warnings[title][wideName].add("__WHOLE__");
            else warnings[title][wideName].add(subName);
        });

        const sortedTitles = Object.keys(warnings).sort((a, b) => {
            const getRank = (t) => t.includes('경보') ? 1 : (t.includes('주의보') ? 2 : 3);
            return getRank(a) - getRank(b) || a.localeCompare(b);
        });

        const results = sortedTitles.map(title => {
            const wideRegions = warnings[title];
            const regionTexts = Object.keys(wideRegions).map(wide => {
                const subs = Array.from(wideRegions[wide]);
                if (subs.includes("__WHOLE__") && subs.length === 1) return wide;
                const cleanSubs = subs.filter(s => s !== "__WHOLE__").join('·');
                return cleanSubs ? `${wide}(${cleanSubs})` : wide;
            }).join(', ');
            return `○ ${title} : ${regionTexts}`;
        });

        if (results.length > 0) {
            warningList.innerHTML = results.map(r => `<div style="margin-bottom:10px; font-weight: 500;">${r}</div>`).join('');
            warningStatus.textContent = '조회 완료';
        } else {
            warningList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">현재 발효 중인 특보가 없습니다.</div>';
            warningStatus.textContent = '특보 없음';
        }
        if (lastTm) warningTime.textContent = `기준 시간: ${formatTime(lastTm)}`;
    } catch(e) { warningStatus.textContent = '오류 발생'; }
}

bureauSelect.addEventListener('change', () => fetchWeatherWarnings());
window.addEventListener('DOMContentLoaded', () => fetchWeatherWarnings());

if (fetchWeatherTodayButton) fetchWeatherTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'highest'));
if (fetchWeatherCurrentButton) fetchWeatherCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'highest'));
if (fetchLowTodayButton) fetchLowTodayButton.addEventListener('click', () => fetchWeatherRanking('today', 'lowest'));
if (fetchLowCurrentButton) fetchLowCurrentButton.addEventListener('click', () => fetchWeatherRanking('current', 'lowest'));
if (fetchPrecip1hButton) fetchPrecip1hButton.addEventListener('click', () => fetchPrecipRanking('1h'));
if (fetchPrecipTodayButton) fetchPrecipTodayButton.addEventListener('click', () => fetchPrecipRanking('today'));
if (fetchSnowTotButton) fetchSnowTotButton.addEventListener('click', () => fetchSnowRanking('tot'));
if (fetchSnowDayButton) fetchSnowDayButton.addEventListener('click', () => fetchSnowRanking('day'));
