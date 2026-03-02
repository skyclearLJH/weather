// Global variables for UI
const lottoNumbersContainer = document.querySelector('.lotto-numbers');
const drawButton = document.getElementById('draw-button');
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

// Lotto drawing logic
drawButton.addEventListener('click', () => {
    lottoNumbersContainer.innerHTML = '';
    const numbers = new Set();
    while (numbers.size < 6) {
        const randomNumber = Math.floor(Math.random() * 45) + 1;
        numbers.add(randomNumber);
    }

    const sortedNumbers = Array.from(numbers).sort((a, b) => a - b);

    for (const number of sortedNumbers) {
        const numberElement = document.createElement('div');
        numberElement.classList.add('lotto-number');
        numberElement.textContent = number;
        lottoNumbersContainer.appendChild(numberElement);
    }
});

// Teachable Machine AI Logic
const URL = "https://teachablemachine.withgoogle.com/models/1iolGa32d/";
let model, labelContainer, maxPredictions;

async function initAI() {
    const modelURL = URL + "model.json";
    const metadataURL = URL + "metadata.json";

    model = await tmImage.load(modelURL, metadataURL);
    maxPredictions = model.getTotalClasses();
    labelContainer = document.getElementById("label-container");
    for (let i = 0; i < maxPredictions; i++) {
        labelContainer.appendChild(document.createElement("div"));
    }
}

async function predict(imageElement) {
    const prediction = await model.predict(imageElement);
    const resultContainer = document.getElementById("result-container");
    
    // Sort predictions to find the most likely one
    prediction.sort((a, b) => b.probability - a.probability);
    
    const topResult = prediction[0];
    let resultMessage = "";
    
    if (topResult.className === "baby" || topResult.className === "아기") {
        resultMessage = "귀여운 아기입니다! 👶";
    } else if (topResult.className === "elementary" || topResult.className === "초등학생") {
        resultMessage = "씩씩한 초등학생입니다! 🎒";
    } else {
        resultMessage = `${topResult.className} 입니다!`;
    }
    
    resultContainer.innerHTML = `결과: ${resultMessage} (${(topResult.probability * 100).toFixed(1)}%)`;

    for (let i = 0; i < maxPredictions; i++) {
        const classPrediction =
            prediction[i].className + ": " + prediction[i].probability.toFixed(2);
        labelContainer.childNodes[i].innerHTML = classPrediction;
    }
}

// Image Upload Handling
const imageInput = document.getElementById('image-input');
const uploadButton = document.getElementById('upload-button');
const imagePreview = document.getElementById('image-preview');
const imagePreviewContainer = document.getElementById('image-preview-container');

uploadButton.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = async (event) => {
            imagePreview.src = event.target.result;
            imagePreviewContainer.style.display = 'block';
            
            if (!model) {
                document.getElementById('result-container').innerHTML = "모델 로딩 중...";
                await initAI();
            }
            
            // Wait for image to load before predicting
            imagePreview.onload = async () => {
                await predict(imagePreview);
            };
        };
        reader.readAsDataURL(file);
    }
});

// Weather logic
const fetchWeatherButton = document.getElementById('fetch-weather-button');
const weatherResultContainer = document.getElementById('weather-result-container');
const highestStationElement = document.getElementById('highest-station');
const highestTempElement = document.getElementById('highest-temp');
const observationTimeElement = document.getElementById('observation-time');
const weatherStatus = document.getElementById('weather-status');

// Snowfall elements
const fetchSnowButton = document.getElementById('fetch-snow-button');
const snowResultContainer = document.getElementById('snow-result-container');
const snowTableBody = document.getElementById('snow-table-body');
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

if (fetchWeatherButton) {
    fetchWeatherButton.addEventListener('click', async () => {
        weatherStatus.textContent = '기상청 데이터를 불러오는 중...';
        fetchWeatherButton.disabled = true;
        
        try {
            const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
            const stationData = await getStationMapping(authKey);
            
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&disp=1&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            
            if (!response.ok) throw new Error('HTTP ' + response.status);
            
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('euc-kr');
            const text = decoder.decode(buffer);
            const lines = text.split('\n');
            
            let highestTemp = -999;
            let highestStationId = '';
            let obsTime = '';
            
            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                const parts = line.split(',');
                if (parts.length < 9) continue;
                
                const time = parts[0];
                const stnId = parts[1].trim();
                const temp = parseFloat(parts[8]);
                
                if (!isNaN(temp) && temp > highestTemp && temp < 60 && temp > -50) {
                    highestTemp = temp;
                    highestStationId = stnId;
                    obsTime = time;
                }
            }
            
            if (highestStationId) {
                const name = stationData[highestStationId]?.name || `지점 ${highestStationId}`;
                const formattedTime = `${obsTime.substring(0, 4)}-${obsTime.substring(4, 6)}-${obsTime.substring(6, 8)} ${obsTime.substring(8, 10)}:${obsTime.substring(10, 12)}`;
                
                highestStationElement.textContent = name;
                highestTempElement.textContent = `${highestTemp.toFixed(1)} °C`;
                observationTimeElement.textContent = formattedTime;
                
                weatherResultContainer.style.display = 'block';
                weatherStatus.textContent = '조회가 완료되었습니다.';
            } else {
                weatherStatus.textContent = '유효한 데이터를 찾을 수 없습니다.';
            }
        } catch (error) {
            console.error(error);
            weatherStatus.textContent = '오류가 발생했습니다.';
        } finally {
            fetchWeatherButton.disabled = false;
        }
    });
}

// Snowfall Top 10 logic (Updated to use kma_snow1.php with comma parsing)
if (fetchSnowButton) {
    fetchSnowButton.addEventListener('click', async () => {
        snowStatus.textContent = '적설관측 데이터를 불러오는 중...';
        fetchSnowButton.disabled = true;
        
        try {
            const authKey = 'KkmPfomzTJyJj36Js9ycNQ';
            const stationData = await getStationMapping(authKey);
            
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=day&authKey=${authKey}`;
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
                
                // kma_snow1.php is comma-separated
                const parts = line.split(',');
                if (parts.length >= 7) {
                    const tm = parts[0].trim();
                    const stnId = parts[1].trim();
                    const stnKoInData = parts[2].trim();
                    const sdDay = parseFloat(parts[6].trim());
                    
                    if (!isNaN(sdDay) && sdDay > 0) {
                        const name = stationData[stnId]?.name || stnKoInData || `지점 ${stnId}`;
                        const address = stationData[stnId]?.adr || "주소 정보 없음";
                        
                        stations.push({
                            id: stnId,
                            sdDay: sdDay,
                            name: name,
                            address: address
                        });
                    }
                    if (tm && tm.length === 12) lastTm = tm;
                }
            }
            
            stations.sort((a, b) => b.sdDay - a.sdDay);
            const top10 = stations.slice(0, 10);
            
            if (top10.length > 0) {
                snowTableBody.innerHTML = '';
                top10.forEach((item, index) => {
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 700;">${index + 1}</td>
                        <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-weight: 600;">${item.name}</td>
                        <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); color: var(--accent-color); font-weight: 800;">${item.sdDay.toFixed(1)} cm</td>
                        <td style="padding: 12px; border-bottom: 1px solid var(--shadow-color); font-size: 0.85rem; color: var(--text-muted);">${item.address}</td>
                    `;
                    snowTableBody.appendChild(row);
                });
                
                if (lastTm) {
                    const formattedTime = `${lastTm.substring(0, 4)}-${lastTm.substring(4, 6)}-${lastTm.substring(6, 8)} ${lastTm.substring(8, 10)}:${lastTm.substring(10, 12)}`;
                    snowTimeElement.textContent = `기준 시간: ${formattedTime}`;
                } else {
                    snowTimeElement.textContent = `기준 시간: 실시간`;
                }
                
                snowResultContainer.style.display = 'block';
                snowStatus.textContent = '조회가 완료되었습니다.';
            } else {
                snowStatus.textContent = '현재 적설관측 지점에서 신적설(새로 쌓인 눈)이 관측되지 않았습니다.';
                snowResultContainer.style.display = 'none';
            }
            
        } catch (error) {
            console.error(error);
            snowStatus.textContent = '데이터를 가져오는 중 오류가 발생했습니다.';
        } finally {
            fetchSnowButton.disabled = false;
        }
    });
}
