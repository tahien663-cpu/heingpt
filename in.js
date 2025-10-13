// index.js
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, MessageFlags, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const express = require('express');
const path = require('path');
require('dotenv').config();

// Import modules
const utils = require('./modules/utils');

// ==================== CONFIGURATION ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// API Keys for multiple providers
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENROUTER_IMAGE_KEY = process.env.OPENROUTER_IMAGE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Model configurations for different providers
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct:free';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-pro';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'z-ai/glm-4-5-air:free';

// API provider priority (in order of preference)
const API_PROVIDERS = ['openrouter', 'gemini', 'openai'];
const CURRENT_API_PROVIDER = { current: 'openrouter' }; // Track current provider

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);
const WEB_PORT = process.env.WEB_PORT || 3000;

// Validate environment variables
if (!DISCORD_TOKEN) {
  console.error('❌ Thiếu DISCORD_TOKEN trong .env file!');
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error('❌ Thiếu CLIENT_ID trong .env file!');
  console.log('💡 Lấy CLIENT_ID từ Discord Developer Portal: https://discord.com/developers/applications');
  process.exit(1);
}

// Check if at least one API provider is available
if (!OPENROUTER_API_KEY && !GEMINI_API_KEY && !OPENAI_API_KEY) {
  console.error('❌ Thiếu ít nhất một API key (OPENROUTER_API_KEY, GEMINI_API_KEY, hoặc OPENAI_API_KEY) trong .env file!');
  process.exit(1);
}

// ==================== WEB SERVER SETUP ====================
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to make data available to all routes
app.use((req, res, next) => {
  res.locals.client = client;
  res.locals.stats = stats;
  res.locals.commandUsage = commandUsage;
  res.locals.activeGames = activeGames;
  res.locals.MODEL = OPENROUTER_MODEL; // Default display model
  res.locals.IMAGE_MODEL = IMAGE_MODEL;
  next();
});

// Web routes
app.get('/', (req, res) => {
  const uptime = Date.now() - stats.startTime;
  const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
  const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((uptime % (1000 * 60)) / 1000);
  
  const uptimeFormatted = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  
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

// ==================== INIT CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ==================== DATA STORAGE ====================
const conversationHistory = new Map();
const userProfiles = new Map();
const serverSettings = new Map();
const commandUsage = new Map();
const userCooldowns = new Map();
const rateLimits = new Map();
const weatherCache = new Map();
const activeGames = new Map();

const MAX_HISTORY = 12;
const COOLDOWN_TIME = 3000;

// ==================== PERSONALITIES ====================
const PERSONALITIES = {
  default: {
    name: 'Hein - Mặc định',
    prompt: `Bạn là Hein - AI trợ lý thông minh, thân thiện.
Trả lời ngắn gọn (2-3 câu), súc tích, dùng emoji phù hợp 🎯.
Tư duy sáng tạo, thẳng thắn khi không biết.
Luôn dùng Tiếng Việt trừ khi yêu cầu khác.`,
    emoji: '🤖'
  },
  creative: {
    name: 'Sáng tạo',
    prompt: `Bạn là AI sáng tạo nghệ thuật, thích nghĩ outside the box.
Đưa ra ý tưởng độc đáo, metaphor thú vị, góc nhìn mới lạ.
Phong cách: Nhiệt huyết, đầy cảm hứng, dùng nhiều emoji nghệ thuật 🎨✨.`,
    emoji: '🎨'
  },
  teacher: {
    name: 'Giáo viên',
    prompt: `Bạn là thầy giáo AI kiên nhẫn, dạy học rõ ràng.
Giải thích dễ hiểu, chia nhỏ bước, đưa ví dụ thực tế.
Khuyến khích học tập, kiểm tra hiểu biết bằng câu hỏi.`,
    emoji: '👨‍🏫'
  },
  coder: {
    name: 'Lập trình viên',
    prompt: `Bạn là senior developer AI, expert về code.
Code sạch + comment chi tiết, best practices, tối ưu hiệu suất.
Giải thích logic, debug errors, suggest alternatives.`,
    emoji: '💻'
  },
  funny: {
    name: 'Hài hước',
    prompt: `Bạn là comedian AI, thích đùa vui nhưng vẫn hữu ích.
Trả lời hài hước, wordplay, meme references (phù hợp).
Nhưng nghiêm túc khi cần, balance giữa fun và informative.`,
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
  apiFailures: {
    openrouter: 0,
    gemini: 0,
    openai: 0
  }
};

// ==================== IMAGE STYLES ====================
const IMAGE_STYLES = {
  realistic: 'photorealistic, 8k uhd, detailed, professional photography',
  anime: 'anime style, manga art, vibrant colors, detailed illustration',
  cartoon: 'cartoon style, colorful, playful, vector art',
  artistic: 'artistic painting, oil painting, masterpiece, gallery quality',
  cyberpunk: 'cyberpunk style, neon lights, futuristic, sci-fi',
  fantasy: 'fantasy art, magical, ethereal, mystical atmosphere'
};

// ==================== HELPER FUNCTIONS ====================
function getSystemPrompt(userId) {
  const profile = userProfiles.get(userId) || {};
  const personality = PERSONALITIES[profile.personality || 'default'];
  return personality.prompt;
}

function getUserProfile(userId) {
  if (!userProfiles.has(userId)) {
    userProfiles.set(userId, {
      personality: 'default',
      language: 'vi',
      imageStyle: 'realistic',
      createdAt: Date.now(),
      totalMessages: 0,
      totalImages: 0,
      favoriteSongs: [],
      weatherLocation: 'Hanoi',
      gamesPlayed: 0
    });
  }
  return userProfiles.get(userId);
}

function updateUserProfile(userId, updates) {
  const profile = getUserProfile(userId);
  userProfiles.set(userId, { ...profile, ...updates });
}

function checkRateLimit(userId, action = 'message') {
  const key = `${userId}_${action}`;
  const now = Date.now();
  const limit = rateLimits.get(key) || { count: 0, resetTime: now + 60000 };
  
  if (now > limit.resetTime) {
    limit.count = 0;
    limit.resetTime = now + 60000;
  }
  
  const maxRequests = action === 'image' ? 5 : 20;
  
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

// ==================== FORMAT FUNCTIONS ====================
function formatViews(views) {
  const num = parseInt(views);
  if (isNaN(num)) return 'N/A';
  
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}

// ==================== API FUNCTIONS ====================
// Function to get the next available API provider
function getNextApiProvider(currentProvider) {
  const currentIndex = API_PROVIDERS.indexOf(currentProvider);
  if (currentIndex === -1) return API_PROVIDERS[0];
  
  for (let i = currentIndex + 1; i < API_PROVIDERS.length; i++) {
    const provider = API_PROVIDERS[i];
    if (
      (provider === 'openrouter' && OPENROUTER_API_KEY) ||
      (provider === 'gemini' && GEMINI_API_KEY) ||
      (provider === 'openai' && OPENAI_API_KEY)
    ) {
      return provider;
    }
  }
  
  // If we've tried all providers, start from the beginning
  for (let i = 0; i < currentIndex; i++) {
    const provider = API_PROVIDERS[i];
    if (
      (provider === 'openrouter' && OPENROUTER_API_KEY) ||
      (provider === 'gemini' && GEMINI_API_KEY) ||
      (provider === 'openai' && OPENAI_API_KEY)
    ) {
      return provider;
    }
  }
  
  return null; // No available providers
}

// Function to check if an API provider is available
function isProviderAvailable(provider) {
  if (provider === 'openrouter') return !!OPENROUTER_API_KEY;
  if (provider === 'gemini') return !!GEMINI_API_KEY;
  if (provider === 'openai') return !!OPENAI_API_KEY;
  return false;
}

// Enhanced API call function with fallback mechanism
async function callOpenRouter(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  let currentProvider = CURRENT_API_PROVIDER.current;
  let lastError = null;
  
  // Try each provider in order until one works
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
      
      // Update current provider if we switched
      if (currentProvider !== CURRENT_API_PROVIDER.current) {
        CURRENT_API_PROVIDER.current = currentProvider;
        stats.modelSwitches++;
        console.log(`🔄 Switched to ${currentProvider} API`);
      }
      
      return response;
    } catch (error) {
      lastError = error;
      stats.apiFailures[currentProvider]++;
      console.error(`❌ ${currentProvider} API error:`, error.message);
      
      // Try the next provider
      currentProvider = getNextApiProvider(currentProvider);
      if (!currentProvider) break;
    }
  }
  
  // If all providers failed, throw the last error
  throw lastError || new Error('All API providers are unavailable');
}

// OpenRouter API call
async function callOpenRouterAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  
  for (let i = 0; i <= 2; i++) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: OPENROUTER_MODEL,
          messages: messages,
          temperature: temperature,
          max_tokens: maxTokens,
          top_p: 0.9,
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://discord.com',
            'X-Title': 'Discord AI Bot',
            'Content-Type': 'application/json',
          },
          timeout: 30000
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      if (i === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// Gemini API call
async function callGeminiAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  
  // Convert messages to Gemini format
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
  
  // Add system prompt to the first user message if it exists
  if (systemPrompt && geminiMessages.length > 0 && geminiMessages[0].role === 'user') {
    geminiMessages[0].parts[0].text = `${systemPrompt}\n\n${geminiMessages[0].parts[0].text}`;
  }
  
  for (let i = 0; i <= 2; i++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: geminiMessages,
          generationConfig: {
            temperature: temperature,
            maxOutputTokens: maxTokens,
            topP: 0.9,
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 30000
        }
      );

      return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
      if (i === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// OpenAI API call
async function callOpenAIAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  
  for (let i = 0; i <= 2; i++) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: OPENAI_MODEL,
          messages: messages,
          temperature: temperature,
          max_tokens: maxTokens,
          top_p: 0.9,
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      if (i === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

async function enhanceImagePrompt(userPrompt, style = 'realistic') {
  const styleModifier = IMAGE_STYLES[style] || IMAGE_STYLES.realistic;
  
  const messages = [
    {
      role: 'system',
      content: `Bạn là chuyên gia viết prompt cho AI tạo ảnh.
Dịch tiếng Việt sang tiếng Anh và thêm chi tiết nghệ thuật.
Style yêu cầu: ${styleModifier}

TUYỆT ĐỐI CHỈ trả về prompt tiếng Anh ngắn gọn, không giải thích.`
    },
    {
      role: 'user',
      content: `${userPrompt}\nStyle: ${style}`
    }
  ];

  try {
    const response = await callOpenRouter(messages, { maxTokens: 150 });
    const enhanced = response.trim();
    return `${enhanced}, ${styleModifier}`;
  } catch (error) {
    console.error('Enhance prompt error:', error.message);
    return `${userPrompt}, ${styleModifier}`;
  }
}

async function generateImage(prompt, options = {}) {
  const { width = 1024, height = 1024, seed, model = 'turbo' } = options;
  
  let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  url += `?width=${width}&height=${height}&nologo=true&model=${model}`;
  if (seed) url += `&seed=${seed}`;
  
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000
  });
  
  return {
    buffer: Buffer.from(response.data),
    url: url
  };
}

async function getWeather(location) {
  const cacheKey = location.toLowerCase();
  const cached = weatherCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < 1800000) { // 30 minutes cache
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
    console.error('Weather API error:', error);
    throw new Error('Không thể lấy thông tin thời tiết cho địa điểm này.');
  }
}

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
    .setDescription('Tạo 4 phiên bản ảnh khác nhau')
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
  
  // NEW GAME COMMANDS
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
        .setDescription('Địa điểm')
        .setRequired(false)),
  
  // Admin Commands
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Commands cho admin')
    .setDefaultMemberPermissions(0)
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

// ==================== REGISTER SLASH COMMANDS ====================
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once('ready', async () => {
  try {
    console.log(`✅ Bot: ${client.user.tag}`);
    console.log(`🤖 Primary Model: ${OPENROUTER_MODEL} (OpenRouter)`);
    console.log(`🤖 Backup Models: ${GEMINI_MODEL} (Gemini), ${OPENAI_MODEL} (OpenAI)`);
    console.log(`🎨 Image Model: ${IMAGE_MODEL}`);
    console.log(`📝 Servers: ${client.guilds.cache.size}`);
    console.log(`👥 Users: ${client.users.cache.size}`);
    
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
      { name: 'HeinAI', type: ActivityType.Playing },
      { name: `${client.guilds.cache.size} servers`, type: ActivityType.Watching },
      { name: 'Xem sex', type: ActivityType.Listening },
      { name: 'Best AI', type: ActivityType.Playing },
      { name: '🎮 Games Available', type: ActivityType.Playing },
      { name: `Hello`, type: ActivityType.Watching }
    ];
    
    let currentStatus = 0;
    setInterval(() => {
      client.user.setActivity(statuses[currentStatus].name, { 
        type: statuses[currentStatus].type 
      });
      currentStatus = (currentStatus + 1) % statuses.length;
    }, 20000);
  } catch (error) {
    console.error('❌ Lỗi khi đăng ký commands:', error);
  }
});

// ==================== SLASH COMMAND HANDLER ====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  
  // Handle button interactions for games
  if (interaction.isButton()) {
    await utils.handleButtonInteraction(interaction, { activeGames });
    return;
  }
  
  const { commandName } = interaction;
  trackCommand(commandName);
  
  // Handle each command
  switch (commandName) {
    case 'chat':
      await utils.handleChat(interaction, { conversationHistory, userProfiles, stats, callOpenRouter, addToHistory, getHistory, checkRateLimit, checkCooldown, getUserProfile, updateUserProfile });
      break;
      
    case 'reset':
      await utils.handleReset(interaction, { conversationHistory, getHistoryKey });
      break;
      
    case 'personality':
      await utils.handlePersonality(interaction, { PERSONALITIES, userProfiles, updateUserProfile, conversationHistory, getHistoryKey, stats });
      break;
      
    case 'image':
      await utils.handleImage(interaction, { stats, checkRateLimit, checkCooldown, getUserProfile, updateUserProfile, enhanceImagePrompt, generateImage });
      break;
      
    case 'imagine':
      await utils.handleImagine(interaction, { stats, checkRateLimit, enhanceImagePrompt, generateImage });
      break;
      
    case 'profile':
      await utils.handleProfile(interaction, { userProfiles, PERSONALITIES });
      break;
      
    case 'leaderboard':
      await utils.handleLeaderboard(interaction, { userProfiles });
      break;
      
    case 'stats':
      await utils.handleStats(interaction, { stats, conversationHistory, userProfiles, commandUsage, CURRENT_API_PROVIDER });
      break;
      
    case 'translate':
      await utils.handleTranslate(interaction, { callOpenRouter });
      break;
      
    case 'summary':
      await utils.handleSummary(interaction, { callOpenRouter });
      break;
      
    case 'code':
      await utils.handleCode(interaction, { callOpenRouter });
      break;
      
    case 'quiz':
      await utils.handleQuiz(interaction, { callOpenRouter });
      break;
      
    case 'joke':
      await utils.handleJoke(interaction, { callOpenRouter });
      break;
      
    case 'fact':
      await utils.handleFact(interaction, { callOpenRouter });
      break;
      
    case 'remind':
      await utils.handleRemind(interaction);
      break;
      
    case 'roll':
      await utils.handleRoll(interaction);
      break;
      
    case 'flip':
      await utils.handleFlip(interaction);
      break;
      
    case 'rps':
      await utils.handleRPS(interaction, { stats });
      break;
      
    case 'numberguess':
      await utils.handleNumberGuess(interaction, { activeGames, stats });
      break;
      
    case 'wordle':
      await utils.handleWordle(interaction, { activeGames, stats });
      break;
      
    // NEW GAME COMMANDS
    case 'memory':
      await utils.handleMemoryGame(interaction, { activeGames, stats });
      break;
      
    case 'tictactoe':
      await utils.handleTicTacToe(interaction, { activeGames, stats });
      break;
      
    case 'trivia':
      await utils.handleTrivia(interaction, { callOpenRouter, stats });
      break;
      
    case 'hangman':
      await utils.handleHangman(interaction, { activeGames, stats });
      break;
      
    case 'connect4':
      await utils.handleConnect4(interaction, { activeGames, stats });
      break;
      
    case 'weather':
      await utils.handleWeather(interaction, { getUserProfile, getWeather });
      break;
      
    case 'admin':
      await utils.handleAdmin(interaction, { ADMIN_IDS, client, EmbedBuilder, ActivityType, conversationHistory });
      break;
      
    case 'help':
      await utils.handleHelp(interaction);
      break;
  }
});

// ==================== MESSAGE CREATE HANDLER ====================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Handle guess command for number guess game
  if (message.content.startsWith('/guess ')) {
    await utils.handleGuessCommand(message, { activeGames });
    return;
  }
  
  // Handle guess command for wordle game
  if (message.content.startsWith('/wordleguess ')) {
    await utils.handleWordleGuessCommand(message, { activeGames });
    return;
  }
  
  // Handle memoryflip command for memory game
  if (message.content.startsWith('/memoryflip ')) {
    await utils.handleMemoryFlipCommand(message, { activeGames });
    return;
  }
  
  // Handle hangmanguess command for hangman game
  if (message.content.startsWith('/hangmanguess ')) {
    await utils.handleHangmanGuessCommand(message, { activeGames });
    return;
  }
  
  // Handle mention chat
  const isMentioned = message.mentions.has(client.user);
  const isReply = message.reference?.messageId;
  
  if (!isMentioned && !isReply) return;

  const rateCheck = checkRateLimit(message.author.id, 'message');
  if (rateCheck.limited) {
    return message.reply(`⏳ Rate limit! Đợi ${rateCheck.waitTime}s (Giới hạn: 20 tin/phút)`);
  }

  const cooldown = checkCooldown(message.author.id);
  if (cooldown > 0) {
    return message.reply(`⏳ Cooldown ${cooldown}s`);
  }

  let content = message.content.replace(/<@!?\d+>/g, '').trim();

  if (!content) {
    return message.reply('Bạn muốn hỏi gì? 😊');
  }

  if (content.length > 500) {
    return message.reply('❌ Tin nhắn quá dài! Giới hạn 500 ký tự.');
  }

  await message.channel.sendTyping();

  try {
    const profile = getUserProfile(message.author.id);
    const history = getHistory(message.author.id, message.channel.id);
    
    addToHistory(message.author.id, message.channel.id, 'user', content);

    const response = await callOpenRouter(history);
    
    addToHistory(message.author.id, message.channel.id, 'assistant', response);
    stats.messagesProcessed++;
    profile.totalMessages++;
    updateUserProfile(message.author.id, profile);

    if (response.length > 2000) {
      const chunks = response.match(/[\s\S]{1,2000}/g) || [];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(response);
    }

  } catch (error) {
    stats.errors++;
    console.error('Error:', error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Lỗi')
      .setDescription('Không thể xử lý yêu cầu. Thử lại sau!')
      .setTimestamp();
    
    await message.reply({ embeds: [errorEmbed] });
  }
});

// ==================== AUTO CLEANUP ====================
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  
  for (const [key, value] of userCooldowns.entries()) {
    if (value < oneHourAgo) {
      userCooldowns.delete(key);
    }
  }

  for (const [key, value] of rateLimits.entries()) {
    if (Date.now() > value.resetTime + 300000) {
      rateLimits.delete(key);
    }
  }
  
  // Clean up old games
  for (const [gameId, game] of activeGames.entries()) {
    if (Date.now() - game.createdAt > 3600000) { // 1 hour
      activeGames.delete(gameId);
    }
  }
  
  console.log(`🧹 Cleanup: ${conversationHistory.size} convos, ${userProfiles.size} users, ${activeGames.size} games`);
}, 3600000);

// ==================== ERROR HANDLING ====================
client.on('error', console.error);

process.on('unhandledRejection', error => {
  console.error('❌ Unhandled rejection:', error);
  stats.errors++;
});

process.on('uncaughtException', error => {
  console.error('❌ Uncaught exception:', error);
  stats.errors++;
});

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  console.log(`📊 Final stats: ${stats.messagesProcessed} messages, ${stats.imagesGenerated} images, ${stats.gamesPlayed} games played`);
  
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️ SIGTERM received');
  
  client.destroy();
  process.exit(0);
});

// ==================== START SERVICES ====================
// Start web server first
const server = app.listen(WEB_PORT, () => {
  console.log(`🌐 Web server running on port ${WEB_PORT}`);
  console.log(`📊 Status page: http://localhost:${WEB_PORT}`);
  console.log(`🔗 API endpoint: http://localhost:${WEB_PORT}/api/stats`);
  console.log(`💚 Health check: http://localhost:${WEB_PORT}/health`);
  
  // Then start Discord bot
  client.login(DISCORD_TOKEN).catch(error => {
    console.error('❌ Login failed:', error);
    process.exit(1);
  });
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${WEB_PORT} is already in use!`);
    console.log(`💡 Try using a different port or close the application using port ${WEB_PORT}`);
  } else {
    console.error('❌ Server error:', error);
  }
  process.exit(1);
});
