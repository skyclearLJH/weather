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

let cachedStationMapping = null;

// New faster CORS Proxy URL
const PROXY_URL = "https://api.codetabs.com/v1/proxy/?quest=";

async function getStationMapping(authKey) {
    if (cachedStationMapping) return cachedStationMapping;
    
    try {
        const mapping = {
            '793': '고산',
            '108': '서울',
            '159': '부산',
            '143': '대구',
            '156': '광주',
            '133': '대전',
            '112': '인천',
            '131': '청주',
            '138': '포항',
            '184': '제주'
        };
        
        const decoder = new TextDecoder('euc-kr');

        const fetchAndParse = async (type) => {
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=${type}&stn=0&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            if (!response.ok) return;
            
            const buffer = await response.arrayBuffer();
            const text = decoder.decode(buffer);
            const lines = text.split('\n');
            
            let stnKoIndex = -1;
            for (const line of lines) {
                if (line.includes('STN_KO')) {
                    const headerParts = line.trim().split(/\s+/);
                    stnKoIndex = headerParts.indexOf('STN_KO');
                    // Header has '#' at index 0, but data lines don't.
                    // So we subtract 1 to align with data line indices.
                    if (stnKoIndex !== -1) stnKoIndex -= 1;
                    break;
                }
            }
            
            if (stnKoIndex === -1) stnKoIndex = 8; // Fallback to common index

            for (const line of lines) {
                if (line.startsWith('#') || line.trim() === '' || line.startsWith(' {')) continue;
                
                const parts = line.trim().split(/\s+/);
                if (parts.length > stnKoIndex) {
                    const id = parts[0];
                    const name = parts[stnKoIndex];
                    if (name && name !== '----' && !/^\d+$/.test(name)) {
                        mapping[id] = name;
                    }
                }
            }
        };

        // Fetch SFC first, then AWS (AWS will only fill in missing ones)
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
            
            // 1. Fetch station names first
            const stationNames = await getStationMapping(authKey);
            
            // 2. Fetch AWS Every Minute Data
            const targetUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?stn=0&disp=1&authKey=${authKey}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(targetUrl));
            
            if (!response.ok) {
                throw new Error('데이터를 불러오는데 실패했습니다 (HTTP ' + response.status + ')');
            }
            
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
                const stationName = stationNames[highestStationId] || `지점 ${highestStationId}`;
                const formattedTime = `${obsTime.substring(0, 4)}-${obsTime.substring(4, 6)}-${obsTime.substring(6, 8)} ${obsTime.substring(8, 10)}:${obsTime.substring(10, 12)}`;
                
                highestStationElement.textContent = stationName;
                highestTempElement.textContent = `${highestTemp.toFixed(1)} °C`;
                observationTimeElement.textContent = formattedTime;
                
                weatherResultContainer.style.display = 'block';
                weatherStatus.textContent = '조회가 완료되었습니다.';
            } else {
                weatherStatus.textContent = '유효한 기상 데이터를 찾을 수 없습니다.';
            }
            
        } catch (error) {
            console.error('Weather fetch error:', error);
            weatherStatus.innerHTML = '오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
        } finally {
            fetchWeatherButton.disabled = false;
        }
    });
}
