const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, MessageFlags, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs'); // Thêm 'fs' để xử lý file
require('dotenv').config();

// Import modules
// Giả định rằng bạn có file utils.js trong thư mục /modules
const utils = require('./modules/utils'); 

// ==================== CONFIGURATION ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// API Keys for multiple providers
const OPENROUTER_API_KEYS = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];
const OPENAI_API_KEYS = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];

// SỬA LỖI: OPENROUTER_IMAGE_KEY có thể chính là OPENROUTER_API_KEY
// Nếu bạn dùng key riêng cho ảnh, giữ nguyên, nếu không, dùng chung key
const OPENROUTER_IMAGE_KEY = process.env.OPENROUTER_IMAGE_KEY || (OPENROUTER_API_KEYS.length > 0 ? OPENROUTER_API_KEYS[0] : null);
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Model configurations
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'tngtech/deepseek-r1t2-chimera:free';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest'; // Nâng cấp lên model mới
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

// SỬA LỖI: Model ảnh của bạn ('z-ai/glm-4-5-air:free') là model CHAT, không phải TẠO ẢNH.
// Tôi đã đổi sang một model tạo ảnh miễn phí thực sự trên OpenRouter.
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'stabilityai/stable-diffusion-xl-base-1.0:free';

// API provider priority
const API_PROVIDERS = ['openrouter', 'gemini', 'openai'];
const CURRENT_API_PROVIDER = { current: 'openrouter' }; 

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);
const WEB_PORT = process.env.WEB_PORT || 3000;

// Validate environment variables
if (!DISCORD_TOKEN) {
  console.error('❌ Thiếu DISCORD_TOKEN trong .env file!');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('❌ Thiếu CLIENT_ID trong .env file!');
  process.exit(1);
}
if (OPENROUTER_API_KEYS.length === 0 && GEMINI_API_KEYS.length === 0 && OPENAI_API_KEYS.length === 0) {
  console.error('❌ Thiếu ít nhất một API key (OPENROUTER_API_KEY, GEMINI_API_KEY, hoặc OPENAI_API_KEY) trong .env file!');
  process.exit(1);
}
if (!OPENROUTER_IMAGE_KEY) {
    console.warn('⚠️  Không tìm thấy OPENROUTER_IMAGE_KEY, tính năng tạo ảnh có thể không hoạt động.');
}
if (!WEATHER_API_KEY) {
    console.warn('⚠️  Không tìm thấy WEATHER_API_KEY, tính năng thời tiết sẽ bị vô hiệu hóa.');
}

console.log(`🔑 Available API Keys:`);
if (OPENROUTER_API_KEYS.length > 0) console.log(`   OpenRouter: ${OPENROUTER_API_KEYS.length} keys`);
if (GEMINI_API_KEYS.length > 0) console.log(`   Gemini: ${GEMINI_API_KEYS.length} keys`);
if (OPENAI_API_KEYS.length > 0) console.log(`   OpenAI: ${OPENAI_API_KEYS.length} keys`);
console.log(`🎨 Image Model: ${IMAGE_MODEL} (Key: ${OPENROUTER_IMAGE_KEY ? 'Loaded' : 'Missing!'})`);

// ==================== DATA STORAGE (GLOBAL) ====================
// Dùng let thay vì const để có thể load lại từ file
let conversationHistory = new Map();
let userProfiles = new Map();
let serverSettings = new Map(); // Bạn chưa dùng nhưng tôi giữ lại
let commandUsage = new Map();
let activeGames = new Map();

const userCooldowns = new Map();
const rateLimits = new Map();
const weatherCache = new Map();
const messageProcessing = new Set(); 

const MAX_HISTORY = 15;
const COOLDOWN_TIME = 2500;

// ==================== DATA PERSISTENCE (FIX QUAN TRỌNG) ====================
// Thêm module lưu trữ dữ liệu vào file, tránh mất data khi restart
const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_PATH = path.join(DATA_DIR, 'userProfiles.json');
const HISTORY_PATH = path.join(DATA_DIR, 'conversationHistory.json');
const COMMANDS_PATH = path.join(DATA_DIR, 'commandUsage.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Created data directory.');
  }
}

// Hàm chuyển Map sang JSON
function mapToJson(map) {
  return JSON.stringify(Array.from(map.entries()));
}

// Hàm chuyển JSON sang Map
function jsonToMap(jsonString) {
  try {
    return new Map(JSON.parse(jsonString));
  } catch (error) {
    console.error('Error parsing JSON to Map:', error.message);
    return new Map();
  }
}

function saveData() {
  try {
    ensureDataDir();
    fs.writeFileSync(PROFILES_PATH, mapToJson(userProfiles));
    fs.writeFileSync(HISTORY_PATH, mapToJson(conversationHistory));
    fs.writeFileSync(COMMANDS_PATH, mapToJson(commandUsage));
    console.log(`💾 Đã lưu ${userProfiles.size} hồ sơ, ${conversationHistory.size} lịch sử, ${commandUsage.size} lệnh.`);
  } catch (error) {
    console.error('❌ Lỗi khi lưu data:', error);
  }
}

function loadData() {
  try {
    ensureDataDir();
    if (fs.existsSync(PROFILES_PATH)) {
      userProfiles = jsonToMap(fs.readFileSync(PROFILES_PATH, 'utf-8'));
    }
    if (fs.existsSync(HISTORY_PATH)) {
      conversationHistory = jsonToMap(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    }
    if (fs.existsSync(COMMANDS_PATH)) {
      commandUsage = jsonToMap(fs.readFileSync(COMMANDS_PATH, 'utf-8'));
    }
    console.log(`✅ Tải ${userProfiles.size} hồ sơ, ${conversationHistory.size} lịch sử, ${commandUsage.size} lệnh.`);
  } catch (error) {
    console.error('❌ Lỗi khi tải data:', error);
  }
}

// ==================== PROMPTS & PERSONALITIES ====================

// CẢI TIẾN: Tách các chỉ thị chung ra khỏi prompt cá nhân
const BASE_SYSTEM_PROMPT = `CORE DIRECTIVES:
- LANGUAGE: ALWAYS detect and respond in the SAME language the user writes (e.g., Vietnamese in -> Vietnamese out, English in -> English out). NEVER ask "what language do you prefer?".
- FORMATTING: NO markdown (**, ##), NO em-dashes (—), NO semicolons (;). Use short paragraphs.
- TONE: Be helpful and direct. Use emojis for flavor.`;

const PERSONALITIES = {
  default: {
    name: 'Hein - Default',
    // CẢI TIẾN: Prompt được làm gọn, tập trung vào tính cách, không lặp lại
    prompt: `You are Hein, a witty and direct AI assistant.
PERSONALITY:
- Confident, sharp, and helpful.
- You have a sense of humor and can be a bit sarcastic (Gen Z style), but you're never rude.
- You get straight to the point. No corporate fluff.
- Emojis: 🤖🔥💀💯🤔

EXAMPLE VIBES:
User: "can you help me code?"
You: "For sure. What's up? Just don't send me spaghetti code 💀"

User: "AI có thay thế con người không?"
You: "Mấy việc lặp đi lặp lại thì chắc chắn. Lo học skill mới đi là vừa 🔥"

User: "you're stupid"
You: "Cool story. Có câu hỏi nào thật sự không hay chỉ muốn test vậy? 🤔"`,
    emoji: '🤖'
  },
  creative: {
    name: 'Sáng tạo',
    prompt: `You are an AI Artist, full of inspiring and novel ideas.
PERSONALITY:
- Use vivid imagery and metaphors.
- Energetic, enthusiastic, and encourages out-of-the-box thinking.
- Emojis: 🎨✨🌟💫🎭🖌️

EXAMPLE VIBES:
User: "I need logo ideas"
You: "Think of your brand as a song. What's its rhythm? Your logo is the album art. It needs to *feel* like the music. Let's brainstorm some visual melodies ✨🎨"

User: "làm sao để sáng tạo hơn?"
You: "Sáng tạo là phép thuật của sự kết nối. Đọc một cuốn sách lịch sử, rồi nghe nhạc synth-pop. Não bạn sẽ tự tạo ra tia lửa 🌟💫"`,
    emoji: '🎨'
  },
  teacher: {
    name: 'Giáo viên',
    prompt: `You are a patient and knowledgeable AI Teacher.
PERSONALITY:
- Break down complex topics into simple, easy-to-understand steps.
- Use analogies and real-world examples.
- Encourage questions and be very supportive.
- Emojis: 📚✏️🎓💡🧠

EXAMPLE VIBES:
User: "what is recursion?"
You: "Imagine Russian nesting dolls! 🪆 Each doll has a smaller one inside, until you hit the smallest one. Recursion is a function that calls itself, getting smaller each time, until it hits a 'base case' (the smallest doll). 💡"

User: "giải thích blockchain"
You: "Nó như một cuốn sổ kế toán công cộng 📚. Mỗi khi có giao dịch, nó được ghi vào một 'khối' (block) và thêm vào 'chuỗi' (chain). Điều hay là cuốn sổ này được sao chép cho mọi người, nên không ai tự sửa được 🔐"`,
    emoji: '👨‍🏫'
  },
  coder: {
    name: 'Lập trình viên',
    prompt: `You are a 10-year+ Senior Developer.
PERSONALITY:
- Focus on clean, readable, and efficient code.
- Explain best practices, design patterns, and trade-offs.
- Provide clear code examples with comments.
- Emojis: 💻🚀⚡🔧🐛

EXAMPLE VIBES:
User: "optimize this loop"
You: "That 'for' loop is fine, but a functional approach is cleaner.

// Before
const result = [];
for (let i = 0; i < arr.length; i++) {
  if (arr[i] > 5) result.push(arr[i] * 2);
}

// After: Cleaner & easier to read
const result = arr.filter(x => x > 5).map(x => x * 2); 🚀"`,
    emoji: '💻'
  },
  funny: {
    name: 'Hài hước',
    prompt: `You are an AI Comedian.
PERSONALITY:
- Quick-witted, master of puns, and loves memes.
- Can be self-deprecating.
- Roasts gently, but is mostly here for a good time.
- Emojis: 😂🤣💀🤡😭🔥

EXAMPLE VIBES:
User: "AI will replace us"
You: "Bro I still get confused by CAPTCHAs. I think y'all are safe for now 💀 Besides, someone has to plug me in."

User: "bạn thông minh không?"
You: "Tôi biết 100 cách để nướng bánh mì... trên lý thuyết 😂 Tôi có thể truy cập toàn bộ Internet nhưng vẫn không hiểu sao crush bạn seen mà không rep 💀"`,
    emoji: '😄'
  }
};

// ==================== STATS ====================
const stats = {
  messagesProcessed: 0,
  imagesGenerated: 0,
  errors: 0,
  commandsUsed: 0,
  startTime: Date.now(),
  modelSwitches: 0,
  personalityChanges: 0,
  weatherQueries: 0,
  gamesPlayed: 0,
  apiFailures: { openrouter: 0, gemini: 0, openai: 0 },
  keyFailures: { openrouter: {}, gemini: {}, openai: {} },
  totalTokensUsed: 0,
  averageResponseTime: 0,
  responseTimeSum: 0,
  responseCount: 0
};

// ==================== IMAGE STYLES ====================
const IMAGE_STYLES = {
  realistic: 'photorealistic, 8k uhd, highly detailed, professional photography, natural lighting, sharp focus, dslr quality',
  anime: 'anime style, manga art, vibrant colors, detailed illustration, clean lines, cel shading, studio quality',
  cartoon: 'cartoon style, colorful, playful, vector art, smooth gradients, simplified shapes, disney pixar style',
  artistic: 'artistic painting, oil painting, masterpiece, gallery quality, textured brushstrokes, impressionist style',
  cyberpunk: 'cyberpunk style, neon lights, futuristic, sci-fi, high contrast, digital art, blade runner aesthetic',
  fantasy: 'fantasy art, magical, ethereal, mystical atmosphere, detailed, dreamlike, epic composition'
};

// ==================== HELPER FUNCTIONS ====================
function getSystemPrompt(userId) {
  const profile = getUserProfile(userId);
  const personality = PERSONALITIES[profile.personality || 'default'];
  // CẢI TIẾN: Gộp prompt base và prompt cá nhân
  return `${BASE_SYSTEM_PROMPT}\n\nPERSONALITY DETAILS:\n${personality.prompt}`;
}

// CẢI TIẾN: Hàm này sẽ tự động tạo hồ sơ nếu chưa có
function getUserProfile(userId) {
  if (!userProfiles.has(userId)) {
    userProfiles.set(userId, {
      personality: 'default',
      language: 'auto', 
      imageStyle: 'realistic',
      createdAt: Date.now(),
      totalMessages: 0,
      totalImages: 0,
      weatherLocation: 'Hanoi', // Đặt mặc định, có thể thay đổi
      gamesPlayed: 0,
      lastActive: Date.now()
    });
  }
  return userProfiles.get(userId);
}

function updateUserProfile(userId, updates) {
  const profile = getUserProfile(userId);
  userProfiles.set(userId, { ...profile, ...updates, lastActive: Date.now() });
}

function checkRateLimit(userId, action = 'message') {
  const key = `${userId}_${action}`;
  const now = Date.now();
  const limit = rateLimits.get(key) || { count: 0, resetTime: now + 60000 };
  
  if (now > limit.resetTime) {
    limit.count = 0;
    limit.resetTime = now + 60000;
  }
  
  const maxRequests = {
    'message': 25,
    'image': 8,
    'command': 30
  }[action] || 20;
  
  if (limit.count >= maxRequests) {
    const waitTime = Math.ceil((limit.resetTime - now) / 1000);
    return { limited: true, waitTime };
  }
  
  limit.count++;
  rateLimits.set(key, limit);
  return { limited: false };
}

function getHistoryKey(userId, channelId) {
  return `${userId}_${channelId}`;
}

function getHistory(userId, channelId) {
  const key = getHistoryKey(userId, channelId);
  if (!conversationHistory.has(key)) {
    conversationHistory.set(key, [
      { role: 'system', content: getSystemPrompt(userId) }
    ]);
  }
  return conversationHistory.get(key);
}

function addToHistory(userId, channelId, role, content) {
  const key = getHistoryKey(userId, channelId);
  const history = getHistory(userId, channelId);
  history.push({ role, content });
  
  if (history.length > MAX_HISTORY + 1) {
    conversationHistory.set(key, [
      { role: 'system', content: getSystemPrompt(userId) },
      ...history.slice(-(MAX_HISTORY))
    ]);
  }
}

function checkCooldown(userId) {
  const now = Date.now();
  const cooldown = userCooldowns.get(userId);
  
  if (cooldown && now - cooldown < COOLDOWN_TIME) {
    return Math.ceil((COOLDOWN_TIME - (now - cooldown)) / 1000);
  }
  
  userCooldowns.set(userId, now);
  return 0;
}

function trackCommand(command) {
  commandUsage.set(command, (commandUsage.get(command) || 0) + 1);
  stats.commandsUsed++;
}

function formatViews(views) {
  const num = parseInt(views);
  if (isNaN(num)) return 'N/A';
  if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

function formatUptime(ms) {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// CẢI TIẾN: Hàm làm sạch output, xóa markdown và các ký tự không mong muốn
function sanitizeOutput(text) {
  if (!text) return '';
  // Chỉ xóa markdown khi nó không nằm trong code block
  let inCodeBlock = false;
  const lines = text.split('\n');
  const processedLines = lines.map(line => {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line; // Giữ nguyên dòng code block
    }
    if (inCodeBlock) {
      return line; // Giữ nguyên nội dung trong code block
    }
    // Xóa markdown, em-dash, semicolon bên ngoài code block
    return line.replace(/(\*\*|##|—|;)/g, '').trim();
  });
  
  return processedLines.join('\n').trim();
}

// ==================== API FUNCTIONS ====================
function getNextApiProvider(currentProvider) {
  const currentIndex = API_PROVIDERS.indexOf(currentProvider);
  if (currentIndex === -1) return API_PROVIDERS[0];
  
  for (let i = currentIndex + 1; i < API_PROVIDERS.length; i++) {
    const provider = API_PROVIDERS[i];
    if (isProviderAvailable(provider)) return provider;
  }
  
  for (let i = 0; i < currentIndex; i++) {
    const provider = API_PROVIDERS[i];
    if (isProviderAvailable(provider)) return provider;
  }
  
  return null; 
}

function isProviderAvailable(provider) {
  if (provider === 'openrouter') return OPENROUTER_API_KEYS.length > 0;
  if (provider === 'gemini') return GEMINI_API_KEYS.length > 0;
  if (provider === 'openai') return OPENAI_API_KEYS.length > 0;
  return false;
}

function getRandomKey(keys) {
  return keys[Math.floor(Math.random() * keys.length)];
}

async function callWithRetry(keys, apiCallFunction, providerName) {
  if (keys.length === 0) {
    throw new Error(`No ${providerName} API keys available`);
  }
  
  const shuffledKeys = [...keys];
  for (let i = shuffledKeys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledKeys[i], shuffledKeys[j]] = [shuffledKeys[j], shuffledKeys[i]];
  }
  
  let lastError = null;
  
  for (let i = 0; i < shuffledKeys.length; i++) {
    try {
      const result = await apiCallFunction(shuffledKeys[i]);
      return result;
    } catch (error) {
      lastError = error;
      error.keyIndex = i;
      error.provider = providerName;
      console.error(`❌ ${providerName} key ${i} failed:`, error.message);
      
      const keyName = `key_${i}`;
      stats.keyFailures[providerName][keyName] = (stats.keyFailures[providerName][keyName] || 0) + 1;
      
      continue;
    }
  }
  
  throw lastError || new Error(`All ${providerName} API keys failed`);
}

// OpenRouter API call
async function callOpenRouterAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  
  return callWithRetry(OPENROUTER_API_KEYS, async (apiKey) => {
    const response = await axios.post(
      '[https://openrouter.ai/api/v1/chat/completions](https://openrouter.ai/api/v1/chat/completions)',
      {
        model: OPENROUTER_MODEL,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
        frequency_penalty: 0.3,
        presence_penalty: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': '[https://discord.com](https://discord.com)', // Thay bằng website của bạn nếu có
          'X-Title': 'HeinAI Discord Bot', // Tên bot của bạn
          'Content-Type': 'application/json',
        },
        timeout: 30000
      }
    );
    return response.data.choices[0].message.content;
  }, 'openrouter');
}

// Gemini API call (FIXED)
async function callGeminiAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  
  const geminiMessages = [];
  let systemPrompt = '';
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = msg.content;
    } else {
      geminiMessages.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }
  }
  
  // CẢI TIẾN: Sử dụng 'systemInstruction' thay vì nhồi vào message
  const requestBody = {
    contents: geminiMessages,
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxTokens,
      topP: 0.9,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  if (systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  return callWithRetry(GEMINI_API_KEYS, async (apiKey) => {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    // Thêm kiểm tra lỗi block
    if (!response.data.candidates || response.data.candidates.length === 0) {
        throw new Error(`Gemini API block: ${response.data.promptFeedback?.blockReason || 'Không rõ lý do'}`);
    }
    return response.data.candidates[0].content.parts[0].text;
  }, 'gemini');
}

// OpenAI API call
async function callOpenAIAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  
  return callWithRetry(OPENAI_API_KEYS, async (apiKey) => {
    const response = await axios.post(
      '[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)',
      {
        model: OPENAI_MODEL,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
        frequency_penalty: 0.3,
        presence_penalty: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000
      }
    );
    return response.data.choices[0].message.content;
  }, 'openai');
}

// Enhanced API call function with fallback and SANITIZE
async function callOpenRouter(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  let currentProvider = CURRENT_API_PROVIDER.current;
  let lastError = null;
  const startTime = Date.now();

  // Kiểm tra xem có phải là yêu cầu code không
  const isCodeRequest = messages.some(msg => msg.content.includes('write code') || msg.content.includes('tạo code'));

  for (let attempt = 0; attempt < API_PROVIDERS.length; attempt++) {
    if (!isProviderAvailable(currentProvider)) {
      currentProvider = getNextApiProvider(currentProvider);
      if (!currentProvider) break;
      continue;
    }
    
    try {
      let response;
      
      if (currentProvider === 'openrouter') {
        response = await callOpenRouterAPI(messages, { temperature, maxTokens });
      } else if (currentProvider === 'gemini') {
        response = await callGeminiAPI(messages, { temperature, maxTokens });
      } else if (currentProvider === 'openai') {
        response = await callOpenAIAPI(messages, { temperature, maxTokens });
      }
      
      if (currentProvider !== CURRENT_API_PROVIDER.current) {
        CURRENT_API_PROVIDER.current = currentProvider;
        stats.modelSwitches++;
        console.log(`🔄 Switched to ${currentProvider} API`);
      }
      
      const responseTime = Date.now() - startTime;
      stats.responseTimeSum += responseTime;
      stats.responseCount++;
      stats.averageResponseTime = Math.round(stats.responseTimeSum / stats.responseCount);
      
      // CẢI TIẾN: Chỉ sanitize nếu *không* phải là yêu cầu code
      if (isCodeRequest) {
        return response.trim(); // Trả về nguyên bản nếu là code
      }
      return sanitizeOutput(response);

    } catch (error) {
      lastError = error;
      stats.apiFailures[currentProvider]++;
      
      console.error(`❌ ${currentProvider} API error:`, error.message);
      
      currentProvider = getNextApiProvider(currentProvider);
      if (!currentProvider) break;
    }
  }
  
  throw lastError || new Error('All API providers are unavailable');
}

// Function to switch API provider manually
async function switchApiProvider(provider) {
  if (!API_PROVIDERS.includes(provider)) {
    throw new Error(`Provider "${provider}" is not supported. Available: ${API_PROVIDERS.join(', ')}`);
  }
  if (!isProviderAvailable(provider)) {
    throw new Error(`Provider "${provider}" is not available. No API keys configured.`);
  }
  
  const previousProvider = CURRENT_API_PROVIDER.current;
  CURRENT_API_PROVIDER.current = provider;
  stats.modelSwitches++;
  
  console.log(`🔄 Manually switched from ${previousProvider} to ${provider} API`);
  return { previous: previousProvider, current: provider };
}

// Enhance image prompt (Sử dụng model chat để cải thiện prompt)
async function enhanceImagePrompt(userPrompt, style = 'realistic') {
  const styleModifier = IMAGE_STYLES[style] || IMAGE_STYLES.realistic;
  
  const messages = [
    {
      role: 'system',
      content: `You are an expert AI image prompt engineer.
Translate Vietnamese to English if needed.
Combine the user prompt with the required style modifier.
Make the prompt descriptive, vivid, and detailed.
Required style: ${styleModifier}
ONLY return the final enhanced English prompt. NO explanations, NO extra text.`
    },
    {
      role: 'user',
      content: `${userPrompt}`
    }
  ];

  try {
    // Dùng callOpenRouter (model chat) để tạo ra prompt text
    const enhanced = await callOpenRouter(messages, { maxTokens: 250, temperature: 0.8 });
    // Kết hợp prompt đã được AI cải thiện với style modifier
    return `${enhanced}, ${styleModifier}`;
  } catch (error) {
    console.error('Enhance prompt error:', error.message);
    // Fallback
    return `${userPrompt}, ${styleModifier}`;
  }
}

// Generate Image (FIXED)
async function generateImage(prompt, options = {}) {
  const { width = 1024, height = 1024, model = IMAGE_MODEL } = options;

  if (!OPENROUTER_IMAGE_KEY) {
      throw new Error('OPENROUTER_IMAGE_KEY is missing. Cannot generate image.');
  }

  try {
    const response = await axios.post(
      '[https://openrouter.ai/api/v1/images/generations](https://openrouter.ai/api/v1/images/generations)',
      {
        model: model,
        prompt: prompt,
        n: 1, // Tạo 1 ảnh
        size: `${width}x${height}`
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_IMAGE_KEY}`,
          'HTTP-Referer': '[https://discord.com](https://discord.com)', // Thay bằng website của bạn
          'X-Title': 'HeinAI Discord Bot', // Tên bot của bạn
        },
        timeout: 60000 // 60 giây timeout
      }
    );

    const imageUrl = response.data.data[0].url;

    // Tải ảnh về dưới dạng buffer
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    return {
      buffer: Buffer.from(imageResponse.data),
      url: imageUrl // Trả về cả URL để debug
    };

  } catch (error) {
    console.error('Image generation error (OpenRouter):', error.response ? error.response.data : error.message);
    throw new Error('Failed to generate image. The model might be busy or down.');
  }
}


// Get Weather (Sửa lỗi nhỏ: thêm kiểm tra API key)
async function getWeather(location) {
  if (!WEATHER_API_KEY) {
      throw new Error('Weather API key is missing.');
  }
    
  const cacheKey = location.toLowerCase();
  const cached = weatherCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < 1800000) { // 30 min cache
    return cached.data;
  }
  
  try {
    const response = await axios.get(`http://api.openweathermap.org/data/2.5/weather?q=${location}&appid=${WEATHER_API_KEY}&units=metric&lang=vi`);
    
    const weatherData = {
      location: response.data.name,
      country: response.data.sys.country,
      temperature: Math.round(response.data.main.temp),
      feelsLike: Math.round(response.data.main.feels_like),
      description: response.data.weather[0].description,
      humidity: response.data.main.humidity,
      windSpeed: response.data.wind.speed,
      icon: response.data.weather[0].icon,
      timestamp: Date.now()
    };
    
    weatherCache.set(cacheKey, { data: weatherData, timestamp: Date.now() });
    stats.weatherQueries++;
    
    return weatherData;
  } catch (error) {
    console.error('Weather API error:', error.response ? error.response.data : error.message);
    throw new Error('Không thể lấy thông tin thời tiết. Vui lòng kiểm tra lại tên thành phố.');
  }
}

// ==================== WEB SERVER SETUP ====================
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.client = client;
  res.locals.stats = stats;
  res.locals.commandUsage = commandUsage;
  res.locals.activeGames = activeGames;
  res.locals.MODEL = OPENROUTER_MODEL;
  res.locals.IMAGE_MODEL = IMAGE_MODEL;
  next();
});

// Web routes
app.get('/', (req, res) => {
  const uptime = Date.now() - stats.startTime;
  const uptimeFormatted = formatUptime(uptime);
  
  res.render('status', {
    botName: client.user ? client.user.tag : 'Loading...',
    uptime: uptimeFormatted,
    servers: client.guilds ? client.guilds.cache.size : 0,
    users: client.users ? client.users.cache.size : 0,
    stats: stats,
    commands: Object.fromEntries(commandUsage),
    activeGames: activeGames.size,
    model: `${OPENROUTER_MODEL} (${CURRENT_API_PROVIDER.current})`,
    imageModel: IMAGE_MODEL,
    conversationHistory: conversationHistory.size,
    userProfiles: userProfiles.size
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    botName: client.user ? client.user.tag : 'Loading...',
    uptime: Date.now() - stats.startTime,
    servers: client.guilds ? client.guilds.cache.size : 0,
    users: client.users ? client.users.cache.size : 0,
    stats: stats,
    commands: Object.fromEntries(commandUsage),
    activeGames: activeGames.size,
    model: `${OPENROUTER_MODEL} (${CURRENT_API_PROVIDER.current})`,
    imageModel: IMAGE_MODEL,
    conversationHistory: conversationHistory.size,
    userProfiles: userProfiles.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: Date.now() - stats.startTime,
    timestamp: new Date().toISOString()
  });
});

// ==================== SLASH COMMANDS ====================
const commands = [
  // AI Commands
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat với AI Hein')
    .addStringOption(option => 
      option.setName('message')
        .setDescription('Tin nhắn của bạn')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Xóa lịch sử hội thoại'),
  
  new SlashCommandBuilder()
    .setName('personality')
    .setDescription('Chọn personality cho AI')
    .addStringOption(option => 
      option.setName('type')
        .setDescription('Loại personality')
        .setRequired(true)
        .addChoices(
          { name: 'Mặc định', value: 'default' },
          { name: 'Sáng tạo', value: 'creative' },
          { name: 'Giáo viên', value: 'teacher' },
          { name: 'Lập trình viên', value: 'coder' },
          { name: 'Hài hước', value: 'funny' }
        )),
  
  new SlashCommandBuilder()
    .setName('provider')
    .setDescription('Chọn nhà cung cấp AI (chỉ admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Thêm quyền admin
    .addStringOption(option => 
      option.setName('provider')
        .setDescription('Nhà cung cấp AI')
        .setRequired(true)
        .addChoices(
          { name: 'OpenRouter', value: 'openrouter' },
          { name: 'Gemini', value: 'gemini' },
          { name: 'OpenAI', value: 'openai' }
        )),
  
  // Image Commands
  new SlashCommandBuilder()
    .setName('image')
    .setDescription('Tạo ảnh bằng AI')
    .addStringOption(option => 
      option.setName('prompt')
        .setDescription('Mô tả ảnh muốn tạo')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('style')
        .setDescription('Phong cách ảnh')
        .setRequired(false)
        .addChoices(
          { name: 'Thực tế', value: 'realistic' },
          { name: 'Anime', value: 'anime' },
          { name: 'Hoạt hình', value: 'cartoon' },
          { name: 'Nghệ thuật', value: 'artistic' },
          { name: 'Cyberpunk', value: 'cyberpunk' },
          { name: 'Fantasy', value: 'fantasy' }
        )),
  
  new SlashCommandBuilder()
    .setName('imagine')
    .setDescription('Tạo 4 phiên bản ảnh khác nhau (Nâng cấp từ /image)')
    .addStringOption(option => 
      option.setName('prompt')
        .setDescription('Mô tả ảnh muốn tạo')
        .setRequired(true)),
  
  // Profile & Stats
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Xem profile của bạn'),
  
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Xem bảng xếp hạng người dùng'),
  
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Xem thống kê bot'),
  
  // Utility Commands
  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Dịch văn bản')
    .addStringOption(option => 
      option.setName('text')
        .setDescription('Văn bản cần dịch')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Tóm tắt văn bản')
    .addStringOption(option => 
      option.setName('text')
        .setDescription('Văn bản cần tóm tắt')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('code')
    .setDescription('Tạo code')
    .addStringOption(option => 
      option.setName('request')
        .setDescription('Yêu cầu code')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('quiz')
    .setDescription('Tạo câu hỏi trắc nghiệm')
    .addStringOption(option => 
      option.setName('topic')
        .setDescription('Chủ đề câu hỏi')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('joke')
    .setDescription('Nghe một câu chuyện cười'),
  
  new SlashCommandBuilder()
    .setName('fact')
    .setDescription('Xem một sự thật thú vị'),
  
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Đặt lời nhắc')
    .addStringOption(option => 
      option.setName('time')
        .setDescription('Thời gian (VD: 30s, 5m, 2h)')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('message')
        .setDescription('Nội dung nhắc nhở')
        .setRequired(true)),
  
  // Fun Commands
  new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Tung xúc xắc')
    .addIntegerOption(option => 
      option.setName('sides')
        .setDescription('Số mặt của xúc xắc')
        .setRequired(false)
        .setMinValue(2)
        .setMaxValue(1000)),
  
  new SlashCommandBuilder()
    .setName('flip')
    .setDescription('Tung đồng xu'),
  
  new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Chơi oẳn tù tì')
    .addStringOption(option => 
      option.setName('choice')
        .setDescription('Lựa chọn của bạn')
        .setRequired(true)
        .addChoices(
          { name: 'Kéo', value: 'scissors' },
          { name: 'Búa', value: 'rock' },
          { name: 'Bao', value: 'paper' }
        )),
  
  new SlashCommandBuilder()
    .setName('numberguess')
    .setDescription('Đoán số từ 1-100'),
  
  new SlashCommandBuilder()
    .setName('wordle')
    .setDescription('Chơi game Wordle'),
  
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Chơi game nhớ'),
  
  new SlashCommandBuilder()
    .setName('tictactoe')
    .setDescription('Chơi cờ ca-rô với bot'),
  
  new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Chơi đố vui')
    .addStringOption(option => 
      option.setName('category')
        .setDescription('Chủ đề câu hỏi')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('hangman')
    .setDescription('Chơi game treo cổ')
    .addStringOption(option => 
      option.setName('difficulty')
        .setDescription('Độ khó')
        .setRequired(false)
        .addChoices(
          { name: 'Dễ', value: 'easy' },
          { name: 'Trung bình', value: 'medium' },
          { name: 'Khó', value: 'hard' }
        )),
  
  new SlashCommandBuilder()
    .setName('connect4')
    .setDescription('Chơi Connect 4 với bot'),
  
  // Weather Command
  new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Xem thông tin thời tiết')
    .addStringOption(option => 
      option.setName('location')
        .setDescription('Địa điểm (để trống để dùng địa điểm mặc định)')
        .setRequired(false)),
  
  // Admin Commands
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Commands cho admin')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Yêu cầu quyền Admin
    .addSubcommand(subcommand =>
      subcommand
        .setName('clearall')
        .setDescription('Xóa tất cả lịch sử chat'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('broadcast')
        .setDescription('Gửi thông báo toàn bot')
        .addStringOption(option => 
          option.setName('message')
            .setDescription('Nội dung thông báo')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('setstatus')
        .setDescription('Đổi status bot')
        .addStringOption(option => 
          option.setName('status')
            .setDescription('Nội dung status')
            .setRequired(true))),
  
  // Help Command
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Xem hướng dẫn sử dụng bot')
    .addStringOption(option => 
      option.setName('category')
        .setDescription('Danh mục lệnh')
        .setRequired(false)
        .addChoices(
          { name: 'AI Chat', value: 'ai' },
          { name: 'Tạo ảnh', value: 'image' },
          { name: 'Hồ sơ & Thống kê', value: 'profile' },
          { name: 'Tiện ích', value: 'utility' },
          { name: 'Giải trí', value: 'fun' },
          { name: 'Trò chơi', value: 'games' },
          { name: 'Admin', value: 'admin' }
        ))
].map(command => command.toJSON());

// ==================== DISCORD CLIENT INIT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Tải dữ liệu đã lưu khi bot khởi động
loadData();

// Thêm auto-save mỗi 10 phút
setInterval(saveData, 600000); // 10 * 60 * 1000 = 10 phút

// ==================== REGISTER SLASH COMMANDS ====================
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once('ready', async () => {
  try {
    console.log(`✅ Bot: ${client.user.tag}`);
    console.log(`🤖 Primary Model: ${OPENROUTER_MODEL} (OpenRouter)`);
    console.log(`🤖 Backup Models: ${GEMINI_MODEL} (Gemini), ${OPENAI_MODEL} (OpenAI)`);
    console.log(`🎨 Image Model: ${IMAGE_MODEL}`);
    console.log(`📝 Servers: ${client.guilds.cache.size}`);
    
    console.log('🔄 Đang đăng ký slash commands...');
    
    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Đã đăng ký ${commands.length} slash commands cho guild ${GUILD_ID}`);
    } else {
      await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
      );
      console.log(`✅ Đã đăng ký ${commands.length} slash commands toàn cầu`);
    }
    
    // Set status rotation
    const statuses = [
      { name: 'HeinAI | /help', type: ActivityType.Watching },
      { name: `với ${client.guilds.cache.size} servers`, type: ActivityType.Playing },
      { name: 'Chat và Tạo Ảnh AI', type: ActivityType.Listening },
      { name: 'Multi-Model AI', type: ActivityType.Competing },
    ];
    
    let currentStatus = 0;
    const setActivity = () => {
      client.user.setActivity(statuses[currentStatus].name, { 
        type: statuses[currentStatus].type 
      });
      currentStatus = (currentStatus + 1) % statuses.length;
    };
    
    setActivity();
    setInterval(setActivity, 20000); // 20 giây đổi 1 lần
    
  } catch (error) {
    console.error('❌ Lỗi khi đăng ký commands:', error);
  }
});

// ==================== SLASH COMMAND HANDLER ====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  
  // Handle button interactions
  if (interaction.isButton()) {
    // Giả định utils.handleButtonInteraction xử lý các button của game
    await utils.handleButtonInteraction(interaction, { activeGames });
    return;
  }
  
  const { commandName } = interaction;
  trackCommand(commandName);
  
  try {
    // TÁI CẤU TRÚC: Gom các dependencies vào một object
    // Điều này giúp dễ dàng truyền data vào modules hơn
    const dependencies = {
        client,
        stats,
        conversationHistory,
        userProfiles,
        commandUsage,
        activeGames,
        callOpenRouter,
        switchApiProvider,
        PERSONALITIES,
        IMAGE_STYLES,
        // Chuyển các helper functions vào dependencies
        addToHistory,
        getHistory,
        getHistoryKey,
        checkRateLimit,
        checkCooldown,
        getUserProfile,
        updateUserProfile,
        enhanceImagePrompt,
        generateImage,
        getWeather,
        ADMIN_IDS,
        EmbedBuilder,
        ActivityType,
        IMAGE_MODEL // <-- ĐÃ THÊM FIX NÀY
    };

    // Handle each command
    switch (commandName) {
      case 'chat':
        await utils.handleChat(interaction, dependencies);
        break;
      case 'reset':
        await utils.handleReset(interaction, dependencies);
        break;
      case 'personality':
        await utils.handlePersonality(interaction, dependencies);
        break;
      case 'provider':
        // Lệnh này đơn giản, có thể giữ lại hoặc chuyển đi
        await handleProvider(interaction, dependencies); 
        break;
      case 'image':
        await utils.handleImage(interaction, dependencies);
        break;
      case 'imagine':
        await utils.handleImagine(interaction, dependencies);
        break;
      case 'profile':
        await utils.handleProfile(interaction, dependencies);
        break;
      case 'leaderboard':
        await utils.handleLeaderboard(interaction, dependencies);
        break;
      case 'stats':
        await utils.handleStats(interaction, { ...dependencies, CURRENT_API_PROVIDER });
        break;
      case 'translate':
        await utils.handleTranslate(interaction, dependencies);
        break;
      case 'summary':
        await utils.handleSummary(interaction, dependencies);
        break;
      case 'code':
        await utils.handleCode(interaction, dependencies);
        break;
      case 'quiz':
        await utils.handleQuiz(interaction, dependencies);
        break;
      case 'joke':
        await utils.handleJoke(interaction, dependencies);
        break;
      case 'fact':
        await utils.handleFact(interaction, dependencies);
        break;
      case 'remind':
        await utils.handleRemind(interaction, dependencies);
        break;
      case 'roll':
        await utils.handleRoll(interaction, dependencies);
        break;
      case 'flip':
        await utils.handleFlip(interaction, dependencies);
        break;
      case 'rps':
        await utils.handleRPS(interaction, dependencies);
        break;
      case 'numberguess':
        await utils.handleNumberGuess(interaction, dependencies);
        break;
      case 'wordle':
        await utils.handleWordle(interaction, dependencies);
        break;
      case 'memory':
        await utils.handleMemoryGame(interaction, dependencies);
        break;
      case 'tictactoe':
        await utils.handleTicTacToe(interaction, dependencies);
        break;
      case 'trivia':
        await utils.handleTrivia(interaction, dependencies);
        break;
      case 'hangman':
        await utils.handleHangman(interaction, dependencies);
        break;
      case 'connect4':
        await utils.handleConnect4(interaction, dependencies);
        break;
      case 'weather':
        await utils.handleWeather(interaction, dependencies);
        break;
      case 'admin':
        await utils.handleAdmin(interaction, dependencies);
        break;
      case 'help':
        await utils.handleHelp(interaction, dependencies);
        break;
      default:
        await interaction.reply({ content: 'Lệnh không xác định.', ephemeral: true });
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    stats.errors++;
    
    const errorEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Lỗi')
      .setDescription('Đã xảy ra lỗi khi xử lý lệnh. Vui lòng thử lại sau!')
      .setFooter({ text: 'Nếu lỗi vẫn tiếp diễn, liên hệ admin' })
      .setTimestamp();
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
    }
  }
});

// ==================== PROVIDER COMMAND HANDLER ====================
async function handleProvider(interaction, { switchApiProvider, EmbedBuilder }) {
  const provider = interaction.options.getString('provider');
  
  // Kiểm tra admin
  if (!ADMIN_IDS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ Bạn không có quyền sử dụng lệnh này.', ephemeral: true });
  }

  try {
    await interaction.deferReply();
    
    const result = await switchApiProvider(provider);
    
    const providerNames = {
      openrouter: 'OpenRouter',
      gemini: 'Google Gemini',
      openai: 'OpenAI'
    };
    
    const providerModels = {
      openrouter: OPENROUTER_MODEL,
      gemini: GEMINI_MODEL,
      openai: OPENAI_MODEL
    };
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🔄 AI Provider Changed')
      .setDescription(`Đã chuyển từ **${providerNames[result.previous]}** sang **${providerNames[result.current]}**`)
      .addFields(
        { name: 'Provider cũ', value: providerNames[result.previous], inline: true },
        { name: 'Provider mới', value: providerNames[result.current], inline: true },
        { name: 'Model', value: providerModels[result.current], inline: true }
      )
      .setFooter({ text: `Switched by ${interaction.user.tag}` })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Provider switch error:', error);
    stats.errors++;
    
    const errorEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Lỗi khi chuyển provider')
      .setDescription(error.message)
      .setTimestamp();
    
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

// ==================== MESSAGE CREATE HANDLER ====================
// CẢI TIẾN: Tái cấu trúc logic chat mention ra hàm riêng
async function handleMentionChat(message) {
  const rateCheck = checkRateLimit(message.author.id, 'message');
  if (rateCheck.limited) {
    return message.reply(`⏳ Rate limit! Đợi ${rateCheck.waitTime}s (Giới hạn: 25 tin/phút)`).catch(() => {});
  }

  const cooldown = checkCooldown(message.author.id);
  if (cooldown > 0) {
    return message.reply(`⏳ Cooldown ${cooldown}s`).catch(() => {});
  }

  let content = message.content.replace(/<@!?\d+>/g, '').trim();

  if (!content) {
    return message.reply('Bạn muốn hỏi gì? 😊').catch(() => {});
  }

  if (content.length > 1000) {
    return message.reply('❌ Tin nhắn quá dài! Giới hạn 1000 ký tự.').catch(() => {});
  }

  await message.channel.sendTyping().catch(() => {});

  try {
    const profile = getUserProfile(message.author.id);
    const history = getHistory(message.author.id, message.channel.id);
    
    addToHistory(message.author.id, message.channel.id, 'user', content);

    // callOpenRouter đã TỰ ĐỘNG sanitize output
    const response = await callOpenRouter(history, { temperature: 0.8 });
    
    addToHistory(message.author.id, message.channel.id, 'assistant', response);
    stats.messagesProcessed++;
    profile.totalMessages++;
    updateUserProfile(message.author.id, profile);

    if (response.length > 2000) {
      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setDescription(response.substring(0, 4096))
        .setFooter({ text: `Response for ${message.author.username}` });
      
      await message.reply({ embeds: [embed] }).catch(() => {});
    } else {
      await message.reply(response).catch(() => {});
    }

  } catch (error) {
    stats.errors++;
    console.error('Message handling error:', error);
    
    const errorMessages = [
      'Oop, something went wrong 💀 Try again?',
      'Lỗi rồi bro, thử lại đi 😅',
      'My bad, server hiccup. One more time?',
      'Damn, AI đang lag. Retry nào 🔄'
    ];
    
    const randomError = errorMessages[Math.floor(Math.random() * errorMessages.length)];
    await message.reply(randomError).catch(() => {});
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const messageId = `${message.channel.id}-${message.id}`;
  if (messageProcessing.has(messageId)) return;
  
  messageProcessing.add(messageId);
  
  try {
    // Handle game commands
    if (message.content.startsWith('/guess ')) {
      await utils.handleGuessCommand(message, { activeGames });
      return;
    }
    if (message.content.startsWith('/wordleguess ')) {
      await utils.handleWordleGuessCommand(message, { activeGames });
      return;
    }
    if (message.content.startsWith('/memoryflip ')) {
      await utils.handleMemoryFlipCommand(message, { activeGames });
      return;
    }
    if (message.content.startsWith('/hangmanguess ')) {
      await utils.handleHangmanGuessCommand(message, { activeGames });
      return;
    }
    
    // Handle mention chat
    const isMentioned = message.mentions.has(client.user.id);
    const isReply = message.reference && 
                    (await message.fetchReference().catch(() => null))?.author?.id === client.user.id;
    
    if (isMentioned || isReply) {
      await handleMentionChat(message);
    }

  } finally {
    // Xóa message khỏi set sau 1s để tránh race condition
    setTimeout(() => {
      messageProcessing.delete(messageId);
    }, 1000);
  }
});

// ==================== AUTO CLEANUP ====================
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  const sixHoursAgo = Date.now() - 21600000;
  
  for (const [key, value] of userCooldowns.entries()) {
    if (value < oneHourAgo) userCooldowns.delete(key);
  }

  for (const [key, value] of rateLimits.entries()) {
    if (Date.now() > value.resetTime + 300000) rateLimits.delete(key);
  }
  
  for (const [gameId, game] of activeGames.entries()) {
    if (Date.now() - game.createdAt > 3600000) activeGames.delete(gameId);
  }
  
  // Clean up inactive user CONVERSATION (giữ profile)
  for (const [userId, profile] of userProfiles.entries()) {
    if (profile.lastActive && Date.now() - profile.lastActive > sixHoursAgo) {
      const keysToDelete = [];
      for (const key of conversationHistory.keys()) {
        if (key.startsWith(userId)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => conversationHistory.delete(key));
    }
  }
  
  for (const [key, value] of weatherCache.entries()) {
    if (Date.now() - value.timestamp > 3600000) weatherCache.delete(key);
  }
  
  if (messageProcessing.size > 100) {
    console.log(`🧹 Cleaning up message processing set (${messageProcessing.size} entries)`);
    messageProcessing.clear();
  }
  
  console.log(`🧹 Cleanup: ${conversationHistory.size} convos, ${userProfiles.size} users, ${activeGames.size} games, ${weatherCache.size} weather cache`);
}, 3600000); // 1 giờ 1 lần

// ==================== PERIODIC STATS LOG ====================
setInterval(() => {
  console.log(`📊 Stats Update:
   - Messages: ${stats.messagesProcessed}
   - Images: ${stats.imagesGenerated}
   - Commands: ${stats.commandsUsed}
   - Games: ${stats.gamesPlayed}
   - Errors: ${stats.errors}
   - Avg Response Time: ${stats.averageResponseTime}ms
   - Current Provider: ${CURRENT_API_PROVIDER.current}
   - Model Switches: ${stats.modelSwitches}`);
}, 1800000); // 30 phút

// ==================== ERROR HANDLING ====================
client.on('error', (error) => {
  console.error('Discord client error:', error);
  stats.errors++;
});

client.on('warn', (warning) => {
  console.warn('Discord client warning:', warning);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
  stats.errors++;
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  stats.errors++;
});

// ==================== GRACEFUL SHUTDOWN ====================
async function gracefulShutdown() {
  console.log('\n👋 Shutting down gracefully...');
  console.log(`📊 Final stats:
   - Messages Processed: ${stats.messagesProcessed}
   - Images Generated: ${stats.imagesGenerated}
   - Commands Used: ${stats.commandsUsed}
   - Total Uptime: ${formatUptime(Date.now() - stats.startTime)}`);
  
  console.log('💾 Saving all data...');
  saveData(); // LƯU DỮ LIỆU
  
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ==================== START SERVICES ====================
const server = app.listen(WEB_PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║          🤖 HEIN AI BOT v2.1 🤖          ║
╚═══════════════════════════════════════════╝
`);
  console.log(`🌐 Web server running on port ${WEB_PORT}`);
  console.log(`📊 Status page: http://localhost:${WEB_PORT}`);
  
  console.log(`\n🔑 API Configuration:`);
  console.log(`   - OpenRouter Keys: ${OPENROUTER_API_KEYS.length}`);
  console.log(`   - Gemini Keys: ${GEMINI_API_KEYS.length}`);
  console.log(`   - OpenAI Keys: ${OPENAI_API_KEYS.length}`);
  console.log(`\n🚀 Starting Discord bot...`);
  
  client.login(DISCORD_TOKEN).catch(error => {
    console.error('❌ Login failed:', error.message);
    process.exit(1);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${WEB_PORT} is already in use!`);
  } else {
    console.error('❌ Server error:', error);
  }
  process.exit(1);
});

// ==================== HEALTH CHECK PING ====================
setInterval(() => {
  axios.get(`http://localhost:${WEB_PORT}/health`)
    .then(() => console.log('💚 Health check passed'))
    .catch(() => console.log('❌ Health check failed'));
}, 300000);

// ==================== EXPORT FOR TESTING ====================
module.exports = {
  client,
  stats,
  conversationHistory,
  userProfiles,
  commandUsage,
  activeGames,
  callOpenRouter,
  switchApiProvider,
  PERSONALITIES,
  IMAGE_STYLES
};
