// 1. Cấu hình và Khởi tạo Thư viện
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const axios = require('axios');
const http = require('http');

// Hàm tạo độ trễ (Sleep function)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Lấy Token Discord từ .env
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
    console.error("Lỗi: Không tìm thấy DISCORD_BOT_TOKEN. Vui lòng kiểm tra file .env.");
    process.exit(1);
}

// --- STATUS SERVER CONFIGURATION ---
const STATUS_PORT = process.env.STATUS_PORT || 3000;
const startTime = Date.now();

// --- LOGIC LUÂN PHIÊN API KEY ---
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);

if (GEMINI_API_KEYS.length === 0) {
    console.error("Lỗi: Không tìm thấy GEMINI_API_KEYS trong file .env.");
    process.exit(1);
}

console.log(`💡 Đã tải ${GEMINI_API_KEYS.length} API key của Gemini.`);

let currentChatKeyIndex = 0;
let currentAnalysisKeyIndex = 0;

const MODEL_NAME = "gemini-2.0-flash-lite"; 

// --- STATISTICS TRACKING ---
const stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    cacheHits: 0,
    searchQueries: 0,
    apiKeyFailures: {},
    lastError: null,
    lastErrorTime: null
};

// Khởi tạo đếm lỗi cho từng key
GEMINI_API_KEYS.forEach((_, index) => {
    stats.apiKeyFailures[index] = 0;
});

// --- DANH SÁCH TỪ KHÓA BỎ QUA TÌM KIẾM ---
const GREETING_DENYLIST = [
    'chào', 'chaof', 'hello', 'hi', 'hey',
    'chào bạn', 'chào bot', 'bot ơi', 'ơi bot',
    'good morning', 'good afternoon', 'good evening',
    'buổi sáng', 'buổi trưa', 'buổi tối',
    'cảm ơn', 'thank you', 'thanks', 'cảm ơn bot',
    'tạm biệt', 'bye', 'goodbye', 'pp', 'bubye'
];

function isSimpleGreeting(prompt) {
    const lowerPrompt = prompt.toLowerCase().trim();
    if (GREETING_DENYLIST.includes(lowerPrompt)) {
        return true;
    }
    return GREETING_DENYLIST.some(greeting => lowerPrompt.startsWith(greeting + ' '));
}

// --- TÍNH NĂNG TÌM KIẾM WEB ---
const SEARCH_API_KEY = process.env.SERPER_API_KEY || process.env.GOOGLE_SEARCH_API_KEY;

async function searchWeb(query) {
    if (!SEARCH_API_KEY) {
        return null; 
    }
    try {
        const response = await axios.post(
            'https://google.serper.dev/search',
            { q: query, num: 5, gl: 'vn', hl: 'vi' }, 
            {
                headers: {
                    'X-API-KEY': SEARCH_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );
        if (response.data && response.data.organic) {
            stats.searchQueries++;
            return response.data.organic.slice(0, 5).map(item => ({
                title: item.title,
                snippet: item.snippet,
                link: item.link
            }));
        }
        return null;
    } catch (error) {
        console.error("Lỗi tìm kiếm web:", error.message);
        return null;
    }
}

// Từ khóa kích hoạt tìm kiếm
const SEARCH_TRIGGERS = [
    'search', 'tìm', 'tìm kiếm', 'tìm thông tin', 'tra', 'tra cứu', 
    'tra google', 'google', 'gg', 'hỏi google', 'kiểm tra', 
    'tìm hiểu', 'tìm xem', 'xem thử', 'cho biết', 'cho tôi biết',
    'thông tin về', 'thông tin mới nhất', 'tin tức', 'tin tức về',
    'cập nhật', 'cập nhật về', 'có gì mới', 'mới nhất', 'là ai', 
    'find', 'lookup', 'look up', 'check', 'what is', 'who is',
    'where is', 'when is', 'how to', 'latest', 'news about',
    'information about', 'tell me about', 'show me'
];

function shouldSearchByKeyword(prompt) {
    const lowerPrompt = prompt.toLowerCase();
    return SEARCH_TRIGGERS.some(trigger => 
        lowerPrompt.startsWith(trigger + ' ') || 
        lowerPrompt.startsWith(trigger + ':') ||
        lowerPrompt.includes(' ' + trigger + ' ') ||
        lowerPrompt.includes(trigger + ' về') ||
        lowerPrompt.includes(trigger + ' xem') ||
        lowerPrompt.endsWith(' ' + trigger) 
    );
}

// Cache cho kết quả phân tích AI
const searchDecisionCache = new Map();

// --- TÍNH NĂNG CẢI THIỆN CÂU HỎI ---
const queryRefinementCache = new Map();

async function refineQueryWithAI(originalPrompt, conversationContext = "") {
    const cacheKey = originalPrompt.toLowerCase().trim().substring(0, 60);
    if (queryRefinementCache.has(cacheKey)) {
        const cached = queryRefinementCache.get(cacheKey);
        if (Date.now() - cached.timestamp < 1800000) {
            console.log(`🔄 Sử dụng query đã cải thiện từ cache`);
            return cached.refinedQuery;
        }
    }

    const refinementPrompt = `Bạn là chuyên gia tối ưu hóa câu truy vấn tìm kiếm. Nhiệm vụ của bạn là biến đổi câu hỏi thành câu truy vấn tìm kiếm tối ưu cho Google.

${conversationContext ? `--- Ngữ cảnh hội thoại ---\n${conversationContext}\n` : ''}
--- Câu hỏi gốc ---
"${originalPrompt}"

--- Nguyên tắc cải thiện ---
1. **Loại bỏ**: Từ thừa, lời chào, từ cảm thán
2. **Thêm**: Từ khóa quan trọng, năm (nếu cần thông tin mới nhất)
3. **Rút gọn**: Giữ 3-8 từ khóa chính
4. **Cụ thể hóa**: Thêm địa điểm, thời gian nếu cần
5. **Sử dụng ngữ cảnh**: Nếu câu hỏi liên quan đến cuộc trò chuyện trước, hãy kết hợp thông tin đó

--- Ví dụ ---
Gốc: "Bạn có thể tìm giúp tôi xem giá iPhone mới nhất không?"
Cải thiện: "giá iPhone 16 2025 Việt Nam"

Gốc: "Cho tôi biết thông tin về trận đấu hôm qua"
Cải thiện: "kết quả bóng đá hôm qua"

Gốc: "Anh ấy là ai vậy?" (Ngữ cảnh: đang nói về Elon Musk)
Cải thiện: "Elon Musk tiểu sử 2025"

--- Yêu cầu ---
Chỉ trả về câu truy vấn đã cải thiện, KHÔNG giải thích. Độ dài 3-10 từ.`;

    try {
        for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
            const keyIndexToTry = (currentAnalysisKeyIndex + i) % GEMINI_API_KEYS.length;
            const key = GEMINI_API_KEYS[keyIndexToTry];
            
            try {
                console.log(`🔄 Cải thiện query: Thử Key #${keyIndexToTry + 1}...`);
                const genAI = new GoogleGenerativeAI(key);
                const model = genAI.getGenerativeModel({ model: MODEL_NAME });
                const result = await model.generateContent(refinementPrompt);
                
                currentAnalysisKeyIndex = (keyIndexToTry + 1) % GEMINI_API_KEYS.length;
                
                const refinedQuery = result.response.text().trim()
                    .replace(/^["']|["']$/g, '')
                    .substring(0, 100);
                
                if (queryRefinementCache.size >= 50) {
                    const firstKey = queryRefinementCache.keys().next().value;
                    queryRefinementCache.delete(firstKey);
                }
                queryRefinementCache.set(cacheKey, {
                    refinedQuery: refinedQuery,
                    timestamp: Date.now()
                });

                console.log(`🔄 Query cải thiện: "${originalPrompt}" → "${refinedQuery}"`);
                return refinedQuery;

            } catch (error) {
                console.warn(`⚠️ Lỗi Key #${keyIndexToTry + 1} khi cải thiện query: ${error.message}`);
            }
        }
        
        console.warn("⚠️ Không thể cải thiện query, sử dụng bản gốc");
        return cleanSearchKeywords(originalPrompt);
        
    } catch (error) {
        console.error("Lỗi cải thiện query:", error.message);
        return cleanSearchKeywords(originalPrompt);
    }
}

async function callAnalysisAIWithFailover(prompt) {
    const analysisPrompt = `Phân tích câu hỏi sau và quyết định có cần tìm kiếm web không.

CÂU HỎI: "${prompt}"

TIÊU CHÍ CẦN SEARCH:
- Thông tin thời sự, tin tức mới nhất
- Giá cả, tỷ giá, chứng khoán hiện tại
- Thời tiết, lịch trình sự kiện
- Thông tin về người nổi tiếng, sự kiện gần đây
- Dữ liệu thống kê, số liệu cụ thể
- Thông tin sản phẩm, địa điểm cụ thể
- Câu hỏi "how to", hướng dẫn cụ thể

KHÔNG CẦN SEARCH:
- Kiến thức phổ thông, lý thuyết cơ bản
- Toán học, khoa học cơ bản
- Lập trình, giải thuật chung
- Câu hỏi triết học, ý kiến cá nhân
- Sáng tạo nội dung (viết văn, thơ, code)
- Trò chuyện thông thường (chào hỏi, cảm ơn, tạm biệt)

Trả lời ĐÚNG 1 TỪ: "YES" hoặc "NO"`;

    for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
        const keyIndexToTry = (currentAnalysisKeyIndex + i) % GEMINI_API_KEYS.length;
        const key = GEMINI_API_KEYS[keyIndexToTry];
        
        try {
            console.log(`🧠 Phân tích search: Đang thử với Key #${keyIndexToTry + 1}...`);
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: MODEL_NAME });
            const result = await model.generateContent(analysisPrompt);
            
            currentAnalysisKeyIndex = (keyIndexToTry + 1) % GEMINI_API_KEYS.length;
            return result; 

        } catch (error) {
            console.warn(`⚠️ Lỗi Key #${keyIndexToTry + 1} khi phân tích: ${error.message}`);
        }
    }
    
    throw new Error("Tất cả API keys của Gemini đều thất bại khi phân tích.");
}

async function shouldSearchByAI(prompt) { 
    const cacheKey = prompt.toLowerCase().trim().substring(0, 50);
    if (searchDecisionCache.has(cacheKey)) {
        const cached = searchDecisionCache.get(cacheKey);
        if (Date.now() - cached.timestamp < 1800000) {
            console.log(`🧠 Sử dụng quyết định search từ cache: ${cached.decision}`);
            return cached.decision;
        }
    }

    try {
        const result = await callAnalysisAIWithFailover(prompt); 
        const response = result.response;
        const decision = response.text().trim().toUpperCase();
        
        const shouldSearch = decision.includes('YES');

        if (searchDecisionCache.size >= 50) {
            const firstKey = searchDecisionCache.keys().next().value;
            searchDecisionCache.delete(firstKey);
        }
        searchDecisionCache.set(cacheKey, {
            decision: shouldSearch,
            timestamp: Date.now()
        });

        console.log(`🧠 AI quyết định search: ${shouldSearch ? 'CÓ' : 'KHÔNG'}`);
        return shouldSearch;
    } catch (error) {
        console.error("Lỗi khi phân tích AI (tất cả các key):", error.message);
        return shouldSearchByKeyword(prompt);
    }
}

function cleanSearchKeywords(prompt) {
    let cleaned = prompt;
    for (const trigger of SEARCH_TRIGGERS) {
        const regex = new RegExp(`(^${trigger}\\s*:?\\s*)|(\\s*${trigger}$)`, 'i');
        cleaned = cleaned.replace(regex, '');
    }
    return cleaned.trim();
}

// --- RATE LIMITING ---
const RATE_LIMIT = {
    maxPerMinute: 15,
    maxPerHour: 100,
    cooldownTime: 4000,
};
const requestTracker = {
    perMinute: [],
    perHour: [],
    lastRequestTime: 0
};

function checkRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;
    requestTracker.perMinute = requestTracker.perMinute.filter(t => t > oneMinuteAgo);
    requestTracker.perHour = requestTracker.perHour.filter(t => t > oneHourAgo);
    if (requestTracker.perMinute.length >= RATE_LIMIT.maxPerMinute) {
        return { allowed: false, reason: `phút (${RATE_LIMIT.maxPerMinute}/phút)` };
    }
    if (requestTracker.perHour.length >= RATE_LIMIT.maxPerHour) {
        return { allowed: false, reason: `giờ (${RATE_LIMIT.maxPerHour}/giờ)` };
    }
    const timeSinceLastRequest = now - requestTracker.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT.cooldownTime) {
        const waitTime = Math.ceil((RATE_LIMIT.cooldownTime - timeSinceLastRequest) / 1000);
        return { allowed: false, reason: `cooldown (đợi ${waitTime}s)` };
    }
    return { allowed: true };
}

function recordRequest() {
    const now = Date.now();
    requestTracker.perMinute.push(now);
    requestTracker.perHour.push(now);
    requestTracker.lastRequestTime = now;
}

// --- REQUEST QUEUE ---
const requestQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;
    while (requestQueue.length > 0) {
        const { message, prompt, sessionData } = requestQueue.shift();
        const rateLimitCheck = checkRateLimit();
        if (!rateLimitCheck.allowed) {
            requestQueue.unshift({ message, prompt, sessionData });
            await sleep(RATE_LIMIT.cooldownTime);
            continue;
        }
        try {
            await handleGeminiRequest(message, prompt, sessionData);
            recordRequest();
            await sleep(RATE_LIMIT.cooldownTime);
        } catch (error) {
            console.error("Lỗi khi xử lý queue:", error);
        }
    }
    isProcessingQueue = false;
}

// --- RESPONSE CACHING ---
const responseCache = new Map();
const CACHE_DURATION = 3600000;

function getCacheKey(prompt) {
    return prompt.toLowerCase().trim().substring(0, 100);
}

function getFromCache(prompt) {
    const key = getCacheKey(prompt);
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        stats.cacheHits++;
        return cached.response;
    }
    if (cached) responseCache.delete(key);
    return null;
}

function saveToCache(prompt, response) {
    const key = getCacheKey(prompt);
    if (responseCache.size >= 100) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
    }
    responseCache.set(key, {
        response,
        timestamp: Date.now()
    });
}

// --- RETRY LOGIC ---
const MAX_RETRIES = 5;
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 40000];

async function retryWithBackoff(fn, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const errorMsg = error.message || '';
            const isRetryableError = errorMsg.includes('503');
            const isLastAttempt = attempt === retries - 1;
            
            if (!isRetryableError || isLastAttempt) {
                throw error;
            }
            
            const delay = RETRY_DELAYS[attempt] || 40000;
            console.log(`⚠️ Thử lại (lỗi 503) lần ${attempt + 1}/${retries} sau ${delay / 1000}s...`);
            await sleep(delay);
        }
    }
}

// --- MESSAGE HISTORY ---
const MESSAGE_HISTORY_LIMIT = 10;
const messageHistory = new Map(); 

function addToHistory(channelId, role, content) {
    if (!messageHistory.has(channelId)) {
        messageHistory.set(channelId, []);
    }
    const history = messageHistory.get(channelId);
    history.push({
        role: role,
        parts: [{ text: content }],
        timestamp: Date.now()
    });
    if (history.length > MESSAGE_HISTORY_LIMIT) {
        history.shift();
    }
}

function getHistory(channelId) {
    const history = messageHistory.get(channelId) || [];
    return history.map(msg => ({ role: msg.role, parts: msg.parts }));
}

function getHistoryContextText(channelId) {
    const history = messageHistory.get(channelId);
    if (!history || history.length === 0) return "";
    let context = "\n\n--- Lịch sử hội thoại gần đây ---\n";
    history.forEach((msg) => {
        const speaker = msg.role === 'user' ? '👤 User' : '🤖 Bot';
        context += `${speaker}: ${msg.parts[0].text}\n`;
    });
    context += "--- Kết thúc lịch sử ---\n\n";
    return context;
}

setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    for (const [channelId, history] of messageHistory.entries()) {
        const filtered = history.filter(msg => msg.timestamp > oneHourAgo); 
        if (filtered.length === 0) {
            messageHistory.delete(channelId);
        } else {
            messageHistory.set(channelId, filtered);
        }
    }
    console.log(`🧹 Dọn dẹp lịch sử: ${messageHistory.size} kênh còn lại`);
}, 3600000); 

// --- CHAT SESSIONS ---
const chatSessions = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

const systemInstruction = {
    role: "system",
    parts: [{ text: "Bạn là một trợ lý AI (Gemini 2.0 Flash) trên Discord. Hãy trả lời một cách chuyên nghiệp, chính xác, và duy trì ngữ cảnh trò chuyện. Tuyệt đối không sử dụng tiếng lóng hoặc các từ ngữ không phù hợp."}]
};

function getOrCreateChatSession(channelId) {
    if (chatSessions.has(channelId)) {
        return chatSessions.get(channelId);
    }

    const keyToUse = GEMINI_API_KEYS[currentChatKeyIndex];
    const keyIndexUsed = currentChatKeyIndex;
    
    console.log(`Tạo phiên chat mới cho kênh ${channelId} dùng API Key #${keyIndexUsed + 1}`);

    currentChatKeyIndex = (currentChatKeyIndex + 1) % GEMINI_API_KEYS.length;

    const genAI = new GoogleGenerativeAI(keyToUse);
    const model = genAI.getGenerativeModel({ 
        model: MODEL_NAME, 
        safetySettings,
        systemInstruction 
    });

    const history = getHistory(channelId);
    const chat = model.startChat({
        history: history,
        generationConfig: { maxOutputTokens: 4096 }
    });

    const sessionData = {
        chat: chat,
        keyIndex: keyIndexUsed
    };
    chatSessions.set(channelId, sessionData);
    
    return sessionData;
}

// --- STATUS SERVER ---
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function getStatusHTML() {
    const uptime = Date.now() - startTime;
    const successRate = stats.totalRequests > 0 
        ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2)
        : '0.00';
    
    const apiKeyStatus = GEMINI_API_KEYS.map((_, index) => {
        const failures = stats.apiKeyFailures[index] || 0;
        const statusColor = failures === 0 ? '#00ff00' : failures < 5 ? '#ffaa00' : '#ff0000';
        return `
            <div style="padding: 8px; margin: 5px; background: #2a2a2a; border-radius: 5px; border-left: 4px solid ${statusColor};">
                <strong>Key #${index + 1}</strong>: ${failures} lỗi
            </div>
        `;
    }).join('');

    return `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot Status - ${client.user?.tag || 'Loading...'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: #fff;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 2px solid rgba(255,255,255,0.1);
            margin-bottom: 30px;
        }
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .status-badge {
            display: inline-block;
            padding: 8px 20px;
            background: ${client.user ? '#00ff00' : '#ff0000'};
            color: #000;
            border-radius: 20px;
            font-weight: bold;
            margin-top: 10px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
            border: 1px solid rgba(255,255,255,0.1);
        }
        .card h2 {
            font-size: 1.3em;
            margin-bottom: 15px;
            color: #ffdd57;
        }
        .stat {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .stat:last-child { border-bottom: none; }
        .stat-label { color: #ddd; }
        .stat-value { 
            font-weight: bold;
            font-size: 1.1em;
        }
        .progress-bar {
            height: 20px;
            background: rgba(255,255,255,0.1);
            border-radius: 10px;
            overflow: hidden;
            margin-top: 10px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ff00, #00aa00);
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8em;
            font-weight: bold;
        }
        .api-keys {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .refresh-info {
            text-align: center;
            padding: 20px;
            color: #aaa;
            font-size: 0.9em;
        }
        .error-box {
            background: rgba(255,0,0,0.2);
            border: 1px solid #ff0000;
            border-radius: 10px;
            padding: 15px;
            margin-top: 15px;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .loading {
            animation: pulse 2s infinite;
        }
    </style>
    <script>
        setInterval(() => location.reload(), 30000);
    </script>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Discord Bot Status</h1>
            <div class="status-badge ${client.user ? '' : 'loading'}">
                ${client.user ? '✅ ONLINE' : '⏳ STARTING...'}
            </div>
            <p style="margin-top: 15px; font-size: 1.2em;">
                ${client.user ? client.user.tag : 'Đang kết nối...'}
            </p>
        </div>

        <div class="grid">
            <!-- Bot Info -->
            <div class="card">
                <h2>📊 Thông Tin Bot</h2>
                <div class="stat">
                    <span class="stat-label">Uptime</span>
                    <span class="stat-value">${formatUptime(uptime)}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Model</span>
                    <span class="stat-value">${MODEL_NAME}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Servers</span>
                    <span class="stat-value">${client.guilds?.cache.size || 0}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Channels</span>
                    <span class="stat-value">${chatSessions.size}</span>
                </div>
            </div>

            <!-- Request Stats -->
            <div class="card">
                <h2>📈 Thống Kê Request</h2>
                <div class="stat">
                    <span class="stat-label">Tổng Request</span>
                    <span class="stat-value">${stats.totalRequests}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Thành Công</span>
                    <span class="stat-value" style="color: #00ff00;">${stats.successfulRequests}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Thất Bại</span>
                    <span class="stat-value" style="color: #ff6b6b;">${stats.failedRequests}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Tỉ Lệ Thành Công</span>
                    <span class="stat-value">${successRate}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${successRate}%;">
                        ${successRate}%
                    </div>
                </div>
            </div>

            <!-- Cache & Search -->
            <div class="card">
                <h2>💾 Cache & Tìm Kiếm</h2>
                <div class="stat">
                    <span class="stat-label">Cache Hits</span>
                    <span class="stat-value" style="color: #00ff00;">${stats.cacheHits}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Cache Size</span>
                    <span class="stat-value">${responseCache.size}/100</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Search Queries</span>
                    <span class="stat-value">${stats.searchQueries}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Search API</span>
                    <span class="stat-value">${SEARCH_API_KEY ? '✅ Active' : '❌ Inactive'}</span>
                </div>
            </div>

            <!-- Rate Limiting -->
            <div class="card">
                <h2>⏱️ Rate Limiting</h2>
                <div class="stat">
                    <span class="stat-label">Queue Size</span>
                    <span class="stat-value">${requestQueue.length}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Requests/Minute</span>
                    <span class="stat-value">${requestTracker.perMinute.length}/${RATE_LIMIT.maxPerMinute}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Requests/Hour</span>
                    <span class="stat-value">${requestTracker.perHour.length}/${RATE_LIMIT.maxPerHour}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Cooldown</span>
                    <span class="stat-value">${RATE_LIMIT.cooldownTime / 1000}s</span>
                </div>
            </div>
        </div>

        <!-- API Keys Status -->
        <div class="card">
            <h2>🔑 API Keys Status (${GEMINI_API_KEYS.length} keys)</h2>
            <div class="api-keys">
                ${apiKeyStatus}
            </div>
        </div>

        <!-- Last Error -->
        ${stats.lastError ? `
        <div class="card">
            <h2>⚠️ Lỗi Gần Nhất</h2>
            <div class="error-box">
                <strong>Thời gian:</strong> ${new Date(stats.lastErrorTime).toLocaleString('vi-VN')}<br>
                <strong>Lỗi:</strong> ${stats.lastError}
            </div>
        </div>
        ` : ''}

        <div class="refresh-info">
            🔄 Trang tự động làm mới mỗi 30 giây | 
            Thời gian: ${new Date().toLocaleString('vi-VN')}
        </div>
    </div>
</body>
</html>`;
}

const statusServer = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getStatusHTML());
    } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: Date.now() - startTime,
            botConnected: !!client.user,
            totalRequests: stats.totalRequests,
            successRate: stats.totalRequests > 0 
                ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2)
                : '0.00'
        }));
    } else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            stats,
            uptime: Date.now() - startTime,
            bot: {
                username: client.user?.tag || 'Not connected',
                servers: client.guilds?.cache.size || 0,
                activeSessions: chatSessions.size
            },
            rateLimit: {
                queueSize: requestQueue.length,
                perMinute: requestTracker.perMinute.length,
                perHour: requestTracker.perHour.length
            },
            cache: {
                size: responseCache.size,
                hits: stats.cacheHits
            }
        }, null, 2));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
});

statusServer.listen(STATUS_PORT, () => {
    console.log(`📊 Status server đang chạy tại: http://localhost:${STATUS_PORT}`);
    console.log(`📊 Health check: http://localhost:${STATUS_PORT}/health`);
    console.log(`📊 JSON stats: http://localhost:${STATUS_PORT}/stats`);
});

client.once('clientReady', () => {
    console.log(`🤖 Bot Discord đã sẵn sàng! Đăng nhập với tên: ${client.user.tag}`);
    console.log(`💡 Model: ${MODEL_NAME}`);
    console.log(`💡 Giới hạn Rate Limit: ${RATE_LIMIT.maxPerMinute}/phút, ${RATE_LIMIT.maxPerHour}/giờ`);
    console.log(`💡 Thời gian chờ (Cooldown): ${RATE_LIMIT.cooldownTime / 1000}s giữa các request`);
    console.log(`💡 Lịch sử tin nhắn: Lưu ${MESSAGE_HISTORY_LIMIT} tin nhắn gần nhất mỗi kênh`);
    console.log(`🔍 Tìm kiếm Web: ${SEARCH_API_KEY ? 'Đã kích hoạt (có cải thiện query)' : 'Chưa cấu hình'}`);
});

async function handleGeminiRequest(message, prompt, sessionData) {
    const channelId = message.channel.id;
    const { chat, keyIndex } = sessionData;
    
    stats.totalRequests++;
    
    try {
        message.channel.sendTyping();

        let needsSearch = false; 
        let cleanPrompt = prompt;

        if (isSimpleGreeting(prompt)) {
            needsSearch = false;
        } else {
            needsSearch = shouldSearchByKeyword(prompt);
            if (!needsSearch) {
                needsSearch = await shouldSearchByAI(prompt);
            } 
            if (needsSearch) {
                cleanPrompt = cleanSearchKeywords(prompt);
            }
        }

        let searchResults = null;
        let searchContext = ""; 
        let refinedQuery = cleanPrompt;
        
        if (needsSearch && SEARCH_API_KEY) {
            await message.channel.send("🔍 Đang phân tích và tìm kiếm thông tin...");
            
            const historyContext = getHistoryContextText(channelId);
            refinedQuery = await refineQueryWithAI(cleanPrompt, historyContext);
            
            if (refinedQuery !== cleanPrompt && refinedQuery.length > 0) {
                await message.channel.send(`🔄 Query tối ưu: *"${refinedQuery}"*`);
            }
            
            searchResults = await searchWeb(refinedQuery);
            
            if (searchResults && searchResults.length > 0) {
                searchContext = searchResults.map((r, i) => 
                    `[Nguồn ${i+1}] ${r.title}: ${r.snippet}`
                ).join('\n\n');
            } else {
                await message.channel.send("⚠️ Không tìm thấy kết quả, sẽ trả lời từ kiến thức có sẵn.");
            }
        }

        if (!searchResults) {
            const cachedResponse = getFromCache(cleanPrompt);
            if (cachedResponse) {
                console.log("📦 Sử dụng response từ cache");
                await message.reply(`${cachedResponse}\n\n_💾 (Từ cache)_`);
                addToHistory(channelId, 'user', prompt);
                addToHistory(channelId, 'model', cachedResponse);
                stats.successfulRequests++;
                return;
            }
        }

        let fullPrompt = "";
        const historyContextText = getHistoryContextText(channelId);

        if (searchResults && searchContext) {
            const searchInstruction = `Dựa vào thông tin web dưới đây và lịch sử hội thoại (nếu liên quan), hãy trả lời một cách chi tiết cho câu hỏi sau: ${cleanPrompt}`;
            fullPrompt = historyContextText 
                ? `${historyContextText}--- THÔNG TIN WEB ---\n${searchContext}\n\n--- YÊU CẦU ---\n${searchInstruction}`
                : `--- THÔNG TIN WEB ---\n${searchContext}\n\n--- YÊU CẦU ---\n${searchInstruction}`;
        } else {
            fullPrompt = cleanPrompt; 
        }

        const apiResponse = await retryWithBackoff(async () => {
            return await chat.sendMessage(fullPrompt);
        });

        const responseText = apiResponse.response.text();

        if (!responseText) {
            throw new Error("API không trả về response hợp lệ.");
        }

        addToHistory(channelId, 'user', prompt);
        addToHistory(channelId, 'model', responseText);

        if (!searchResults) {
            saveToCache(cleanPrompt, responseText);
        }

        await message.reply(responseText);
        
        stats.successfulRequests++;
        
        const searchStatus = searchResults 
            ? `🔍 search (query: "${refinedQuery}")` 
            : needsSearch ? '⚠️ search lỗi' : '💬 không search';
        const logStats = `✅ ${searchStatus} | Key: #${keyIndex + 1} | Queue: ${requestQueue.length} | Cache: ${responseCache.size} | History: ${messageHistory.get(channelId)?.length || 0}/10`;
        console.log(logStats);

    } catch (error) {
        stats.failedRequests++;
        stats.lastError = error.message;
        stats.lastErrorTime = Date.now();
        stats.apiKeyFailures[keyIndex] = (stats.apiKeyFailures[keyIndex] || 0) + 1;
        
        console.error(`Lỗi Gemini API (Key #${keyIndex + 1}):`, error.message);
        
        const errorMsg = error.message || '';
        const isQuotaError = errorMsg.includes('429') || errorMsg.includes('resourceExhausted');
        const isPermissionError = errorMsg.includes('403') || errorMsg.includes('permissionDenied');

        if (isQuotaError || isPermissionError) {
            console.warn(`🛑 Key #${keyIndex + 1} đã chết. Xóa phiên chat.`);
            chatSessions.delete(channelId);
            
            await message.reply(`⚠️ Xin lỗi, API key cho phiên trò chuyện này (Key #${keyIndex + 1}) đã hết hạn hoặc gặp lỗi. 
    
**Vui lòng gửi lại tin nhắn của bạn.**
Tôi sẽ tự động thử một API key khác cho bạn.`);

        } else {
            let userErrorMsg = "⚠️ Xin lỗi, tôi gặp lỗi khi xử lý yêu cầu của bạn.";
            if (errorMsg.includes('503')) {
                userErrorMsg = "🔄 Dịch vụ tạm thời quá tải. Đang thử lại...";
            }
            await message.reply(userErrorMsg);
        }
    }
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    
    if (!message.mentions.users.has(client.user.id)) return;

    const prompt = message.content.replace(`<@${client.user.id}>`, '').trim();

    if (!prompt) {
        return message.reply("Hãy hỏi tôi điều gì đó!");
    }

    if (prompt.toLowerCase() === 'clear history' || prompt.toLowerCase() === 'xóa lịch sử') {
        const chatId = message.channel.id;
        messageHistory.delete(chatId);
        chatSessions.delete(chatId);
        return message.reply("🗑️ Đã xóa lịch sử hội thoại của kênh này!");
    }

    const rateLimitCheck = checkRateLimit();
    if (!rateLimitCheck.allowed) {
        return message.reply(`⏳ Đang bị giới hạn tốc độ (${rateLimitCheck.reason}). Yêu cầu của bạn đã được đưa vào hàng đợi.`);
    }
    
    const chatId = message.channel.id;
    const sessionData = getOrCreateChatSession(chatId);

    requestQueue.push({ message, prompt, sessionData });
    processQueue();
});

client.login(DISCORD_BOT_TOKEN);
