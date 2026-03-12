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

// UI Elements
const getEl = (id) => document.getElementById(id);
const ui = {
    weather: { status: getEl('weather-status'), container: getEl('weather-result-container'), body: getEl('weather-table-body'), time: getEl('weather-time') },
    low: { status: getEl('low-temp-status'), container: getEl('low-temp-result-container'), body: getEl('low-temp-table-body'), time: getEl('low-temp-time') },
    precip: { status: getEl('precip-status'), container: getEl('precip-result-container'), body: getEl('precip-table-body'), time: getEl('precip-time') },
    snow: { status: getEl('snow-status'), container: getEl('snow-result-container'), body: getEl('snow-table-body'), time: getEl('snow-time') },
    warning: { list: getEl('warning-list'), time: getEl('warning-time'), status: getEl('warning-status') }
};

// 지점 정보 로드 및 파싱 (지점명 및 주소 매핑 강화)
async function getStationMapping() {
    if (cachedStationMapping) return cachedStationMapping;
    const mapping = {};
    const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
    const decoder = new TextDecoder('euc-kr');

    const parseLines = (text) => {
        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.trim().split(/\s+/);
            if (p.length < 5) return;
            
            const id = p[0];
            let name = "";
            
            // 지점명 찾기 (숫자가 아닌 첫 번째 문구)
            for (let i = 1; i < p.length; i++) {
                if (isNaN(p[i]) && p[i].length > 1) {
                    name = p[i].replace(/,$/, '');
                    break;
                }
            }

            // 주소 찾기 (광역 지명으로 시작하는 부분)
            let adr = "";
            const adrStartIdx = p.findIndex(item => 
                ['서울','경기','인천','강원','충북','충남','대전','세종','전북','전남','광주','경북','경남','대구','부산','울산','제주'].some(r => item.startsWith(r))
            );
            if (adrStartIdx !== -1) {
                adr = p.slice(adrStartIdx).join(' ').replace(/\d{8,}$/g, '').trim(); // 법정동 코드 등 긴 숫자 제거
            }
            
            if (id && name) {
                mapping[id] = { name, adr };
            }
        });
    };

    try {
        const urls = [
            'stations.txt',
            `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=SFC&stn=0&authKey=${authKey}`,
            `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=AWS&stn=0&authKey=${authKey}`
        ];
        for (const url of urls) {
            try {
                const fullUrl = url.startsWith('http') ? PROXY_URL + encodeURIComponent(url) : url;
                const res = await fetch(fullUrl);
                if (res.ok) parseLines(decoder.decode(await res.arrayBuffer()));
            } catch(e) {}
        }
    } catch (e) {}
    cachedStationMapping = mapping;
    return mapping;
}

const formatTime = (tm) => {
    if (!tm || tm.length < 12) return tm;
    return `${tm.substring(0,4)}-${tm.substring(4,6)}-${tm.substring(6,8)} ${tm.substring(8,10)}:${tm.substring(10,12)}`;
};

// 기온 랭킹 (최고/최저)
async function fetchWeatherRanking(type, mode = 'highest') {
    const isHighest = mode === 'highest';
    const target = isHighest ? ui.weather : ui.low;
    target.status.textContent = '데이터 분석 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stnMap = await getStationMapping();
        const url = type === 'current' 
            ? `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}` 
            : `https://apihub.kma.go.kr/api/typ01/url/sfc_aws_day.php?obs=${isHighest?'ta_max':'ta_min'}&stn=0&authKey=${authKey}`;
        
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [], lastTm = "";

        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            const stnId = p[1]?.trim();
            if (!stnId) return;

            let val = NaN;
            if (type === 'current' && p.length >= 9) val = parseFloat(p[8]);
            else if (type === 'today' && p.length >= 6) val = parseFloat(p[5]);

            if (!isNaN(val) && val > -90) {
                const info = stnMap[stnId] || { name: stnId, adr: "" };
                stations.push({ name: info.name, val, address: info.adr });
                lastTm = p[0];
            }
        });

        stations = getFilteredStations(stations).sort((a,b) => isHighest ? b.val-a.val : a.val-b.val).slice(0,10);
        target.body.innerHTML = stations.map((s,i) => `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:var(--button-bg);font-weight:800;">${s.val.toFixed(1)}°</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address || '정보 없음'}</td></tr>`).join('');
        target.time.textContent = `기준 시간: ${formatTime(lastTm)}`;
        target.container.style.display = 'block'; target.status.textContent = '조회 완료';
    } catch(e) { target.status.textContent = '오류 발생'; }
}

// 강수량 랭킹
async function fetchPrecipRanking(type) {
    ui.precip.status.textContent = '데이터 분석 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stnMap = await getStationMapping();
        const url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&authKey=${authKey}`;
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [], lastTm = "";

        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.includes(',') ? line.split(',') : line.trim().split(/\s+/);
            const stnId = p[1]?.trim();
            if (p.length >= 14) {
                const val = parseFloat(p[type==='1h'?11:13]);
                if (val > 0) {
                    const info = stnMap[stnId] || { name: stnId, adr: "" };
                    stations.push({ name: info.name, val, address: info.adr });
                    lastTm = p[0];
                }
            }
        });

        stations = getFilteredStations(stations).sort((a,b) => b.val-a.val).slice(0,10);
        ui.precip.body.innerHTML = stations.map((s,i) => `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:#007bff;font-weight:800;">${s.val.toFixed(1)}mm</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address || '정보 없음'}</td></tr>`).join('');
        ui.precip.time.textContent = `기준 시간: ${formatTime(lastTm)}`;
        ui.precip.container.style.display = 'block'; ui.precip.status.textContent = '조회 완료';
    } catch(e) { ui.precip.status.textContent = '오류 발생'; }
}

// 적설량 랭킹
async function fetchSnowRanking(type) {
    ui.snow.status.textContent = '데이터 분석 중...';
    try {
        const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
        const stnMap = await getStationMapping();
        const url = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=${type==='day'?'day':'tot'}&authKey=${authKey}`;
        const res = await fetch(PROXY_URL + encodeURIComponent(url));
        const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
        let stations = [], lastTm = "";

        text.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) return;
            const p = line.trim().split(/\s+/);
            if (p.length >= 7) {
                const stnId = p[1].trim();
                const val = parseFloat(p[6]);
                if (val > 0) {
                    const info = stnMap[stnId] || { name: p[2].replace(/,$/, ''), adr: "" };
                    stations.push({ name: info.name, val, address: info.adr });
                    lastTm = p[0];
                }
            }
        });

        stations = getFilteredStations(stations).sort((a,b) => b.val-a.val).slice(0,10);
        ui.snow.body.innerHTML = stations.map((s,i) => `<tr><td style="padding:12px;font-weight:700;">${i+1}</td><td style="padding:12px;">${s.name}</td><td style="padding:12px;color:var(--accent-color);font-weight:800;">${s.val.toFixed(1)}cm</td><td style="padding:12px;font-size:0.85rem;color:var(--text-muted);">${s.address || '정보 없음'}</td></tr>`).join('');
        ui.snow.time.textContent = `기준 시간: ${formatTime(lastTm)}`;
        ui.snow.container.style.display = 'block'; ui.snow.status.textContent = '조회 완료';
    } catch(e) { ui.snow.status.textContent = '오류 발생'; }
}

// --- 기상특보 (Weather Warnings) ---
const WIDE_MAP = {
    '강원도': '강원', '경기도': '경기', '경상남도': '경남', '경상북도': '경북', 
    '전라남도': '전남', '전라북도': '전북', '충청남도': '충남', '충청북도': '충북',
    '제주도': '제주', '서울특별시': '서울', '인천광역시': '인천', '대전광역시': '대전', 
    '광주광역시': '광주', '대구광역시': '대구', '울산광역시': '울산', '부산광역시': '부산',
    '세종특별자치시': '세종'
};

async function fetchWeatherWarnings() {
    if (!ui.warning.list) return;
    ui.warning.status.textContent = '특보 데이터 분석 중...';
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

        allLines.forEach(line => {
            if (line.startsWith('#') || !line.trim() || line.includes('START')) return;
            const p = line.split(',').map(s => s.trim());
            if (p.length < 9) return;

            const upRegion = p[1]; 
            const regionRaw = p[3];    
            const type = p[6];      
            const levelRaw = p[7];     
            const tmEf = p[5];      

            let wideName = WIDE_MAP[upRegion] || upRegion.replace(/특별시|광역시|특별자치시|특별자치도|도$/g, '');
            if (type.includes('풍랑') && selectedBureau !== '전국') return;

            let levelKey = '예비특보';
            if (levelRaw === '2' || levelRaw.includes('경보')) levelKey = '경보';
            else if (levelRaw === '1' || levelRaw.includes('주의보')) levelKey = '주의보';

            let title = `${type} ${levelKey}`;
            if (levelRaw === '예비' || levelKey === '예비특보') title = `${type} 예비특보${getTimeName(tmEf)}`;

            let subName = regionRaw.replace(/[()]/g, '').trim();
            if (subName.startsWith(upRegion)) subName = subName.replace(upRegion, '').trim();
            else if (subName.startsWith(wideName)) subName = subName.replace(wideName, '').trim();
            
            // 섬 이름(울릉도, 독도, 제주도 등) 보존
            if (subName.length > 2 && !['울릉도', '독도', '제주도', '흑산도', '홍도'].some(island => subName.includes(island))) {
                subName = subName.replace(/시$|군$|구$/g, '');
            }
            if (!subName || subName === wideName) subName = wideName;

            if (!warnings[levelKey][title]) warnings[levelKey][title] = {};
            if (!warnings[levelKey][title][wideName]) warnings[levelKey][title][wideName] = new Set();
            
            if (subName === wideName) warnings[levelKey][title][wideName].add("__WHOLE__");
            else warnings[levelKey][title][wideName].add(subName);
        });

        let html = '';
        let hasData = false;
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

        ui.warning.list.innerHTML = hasData ? html : '<div style="text-align:center;padding:40px;color:var(--text-muted);">현재 발효 중인 특보가 없습니다.</div>';
        ui.warning.status.textContent = hasData ? '조회 완료' : '특보 없음';
        if (lastTm) ui.warning.time.textContent = `기준 시간: ${formatTime(lastTm)}`;
    } catch(e) { ui.warning.status.textContent = '오류 발생'; }
}

bureauSelect.addEventListener('change', fetchWeatherWarnings);
window.addEventListener('DOMContentLoaded', fetchWeatherWarnings);

// Event Listeners for all menus
document.getElementById('fetch-weather-today')?.addEventListener('click', () => fetchWeatherRanking('today', 'highest'));
document.getElementById('fetch-weather-current')?.addEventListener('click', () => fetchWeatherRanking('current', 'highest'));
document.getElementById('fetch-low-today')?.addEventListener('click', () => fetchWeatherRanking('today', 'lowest'));
document.getElementById('fetch-low-current')?.addEventListener('click', () => fetchWeatherRanking('current', 'lowest'));
document.getElementById('fetch-precip-1h')?.addEventListener('click', () => fetchPrecipRanking('1h'));
document.getElementById('fetch-precip-today')?.addEventListener('click', () => fetchPrecipRanking('today'));
document.getElementById('fetch-snow-tot')?.addEventListener('click', () => fetchSnowRanking('tot'));
document.getElementById('fetch-snow-day')?.addEventListener('click', () => fetchSnowRanking('day'));
