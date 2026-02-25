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

// Initialize AI model on page load (optional, can also be lazy loaded)
// window.addEventListener('load', initAI);
