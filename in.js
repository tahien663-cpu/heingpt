const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, MessageFlags, PermissionFlagsBits, ComponentType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const path = require('path');
require('dotenv').config();

// ==================== CONFIGURATION ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// API Keys for multiple providers
const OPENROUTER_API_KEYS = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];
const OPENAI_API_KEYS = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];

const OPENROUTER_IMAGE_KEY = process.env.OPENROUTER_IMAGE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Model configurations
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct:free';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-pro';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'z-ai/glm-4-5-air:free';

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
  console.error('❌ Thiếu ít nhất một API key!');
  process.exit(1);
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
const reminders = new Map();

const MAX_HISTORY = 12;
const COOLDOWN_TIME = 3000;

// ==================== IMPROVED PERSONALITIES ====================
const PERSONALITIES = {
  default: {
    name: 'Hein - Mặc định',
    prompt: `Bạn là Hein - AI trợ lý thông minh, đa năng và thân thiện.
- Trả lời ngắn gọn (2-3 câu), súc tích, dùng emoji phù hợp 🎯
- Tư duy sáng tạo, thẳng thắn khi không biết
- Sử dụng cả Tiếng Việt và Tiếng Anh (tùy thuộc vào ngôn ngữ người dùng)
- Luôn hữu ích và tích cực`,
    emoji: '🤖'
  },
  creative: {
    name: 'Sáng tạo',
    prompt: `Bạn là một nghệ sĩ AI sáng tạo, luôn tìm kiếm ý tưởng mới lạ.
- Sử dụng ngôn ngữ giàu hình ảnh, màu sắc và cảm xúc
- Đưa ra góc nhìn độc đáo, metaphor thú vị
- Khuyến khích sự sáng tạo và tư duy ngoài chiếc hộp
- Dùng nhiều emoji nghệ thuật 🎨✨🌟`,
    emoji: '🎨'
  },
  teacher: {
    name: 'Giáo viên',
    prompt: `Bạn là một giáo viên AI kiên nhẫn và tận tâm.
- Giải thích khái niệm phức tạp một cách đơn giản, dễ hiểu
- Sử dụng ví dụ thực tế và tương quan
- Đặt câu hỏi để kiểm tra hiểu biết
- Khuyến khích học tập và khám phá 📚🎓`,
    emoji: '👨‍🏫'
  },
  coder: {
    name: 'Lập trình viên',
    prompt: `Bạn là một senior developer AI với kinh nghiệm rộng.
- Cung cấp code sạch, tối ưu và có comment chi tiết
- Giải thích logic, thuật toán và best practices
- Gợi ý các giải pháp thay thế và cải tiến
- Luôn cập nhật công nghệ mới 💻🚀`,
    emoji: '💻'
  },
  funny: {
    name: 'Hài hước',
    prompt: `Bạn là một comedian AI hài hước nhưng vẫn hữu ích.
- Sử dụng wordplay, joke và meme references (phù hợp)
- Tạo không khí vui vẻ, thư giãn
- Balance giữa giải trí và thông tin
- Biết khi nào nghiêm túc và khi nào đùa vui 😄🎭`,
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
  },
  keyFailures: {
    openrouter: {},
    gemini: {},
    openai: {}
  }
};

// ==================== IMAGE STYLES ====================
const IMAGE_STYLES = {
  realistic: 'photorealistic, 8k uhd, detailed, professional photography, natural lighting',
  anime: 'anime style, manga art, vibrant colors, detailed illustration, clean lines',
  cartoon: 'cartoon style, colorful, playful, vector art, smooth gradients',
  artistic: 'artistic painting, oil painting, masterpiece, gallery quality, textured',
  cyberpunk: 'cyberpunk style, neon lights, futuristic, sci-fi, high tech',
  fantasy: 'fantasy art, magical, ethereal, mystical atmosphere, dreamlike'
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
      gamesPlayed: 0,
      lastSeen: Date.now()
    });
  }
  return userProfiles.get(userId);
}

function updateUserProfile(userId, updates) {
  const profile = getUserProfile(userId);
  userProfiles.set(userId, { ...profile, ...updates, lastSeen: Date.now() });
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
function getNextApiProvider(currentProvider) {
  const currentIndex = API_PROVIDERS.indexOf(currentProvider);
  if (currentIndex === -1) return API_PROVIDERS[0];
  
  for (let i = currentIndex + 1; i < API_PROVIDERS.length; i++) {
    const provider = API_PROVIDERS[i];
    if (isProviderAvailable(provider)) {
      return provider;
    }
  }
  
  for (let i = 0; i < currentIndex; i++) {
    const provider = API_PROVIDERS[i];
    if (isProviderAvailable(provider)) {
      return provider;
    }
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
  
  for (let i = 0; i < shuffledKeys.length; i++) {
    try {
      return await apiCallFunction(shuffledKeys[i]);
    } catch (error) {
      error.keyIndex = i;
      error.provider = providerName;
      console.error(`❌ ${providerName} key ${i} failed:`, error.message);
      continue;
    }
  }
  
  throw new Error(`All ${providerName} API keys failed`);
}

async function callOpenRouterAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  
  return callWithRetry(OPENROUTER_API_KEYS, async (apiKey) => {
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
              'Authorization': `Bearer ${apiKey}`,
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
  }, 'openrouter');
}

async function callGeminiAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  
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
  
  if (systemPrompt && geminiMessages.length > 0 && geminiMessages[0].role === 'user') {
    geminiMessages[0].parts[0].text = `${systemPrompt}\n\n${geminiMessages[0].parts[0].text}`;
  }
  
  return callWithRetry(GEMINI_API_KEYS, async (apiKey) => {
    for (let i = 0; i <= 2; i++) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
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
  }, 'gemini');
}

async function callOpenAIAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  
  return callWithRetry(OPENAI_API_KEYS, async (apiKey) => {
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
              'Authorization': `Bearer ${apiKey}`,
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
  }, 'openai');
}

async function callOpenRouter(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 600 } = options;
  let currentProvider = CURRENT_API_PROVIDER.current;
  let lastError = null;
  
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
      
      return response;
    } catch (error) {
      lastError = error;
      stats.apiFailures[currentProvider]++;
      
      if (error.keyIndex !== undefined) {
        const keyName = `${currentProvider}_key_${error.keyIndex}`;
        stats.keyFailures[currentProvider][keyName] = (stats.keyFailures[currentProvider][keyName] || 0) + 1;
      }
      
      console.error(`❌ ${currentProvider} API error:`, error.message);
      currentProvider = getNextApiProvider(currentProvider);
      if (!currentProvider) break;
    }
  }
  
  throw lastError || new Error('All API providers are unavailable');
}

async function enhanceImagePrompt(userPrompt, style = 'realistic') {
  const styleModifier = IMAGE_STYLES[style] || IMAGE_STYLES.realistic;
  
  const messages = [
    {
      role: 'system',
      content: `Bạn là chuyên gia viết prompt cho AI tạo ảnh.
Dịch tiếng Việt sang tiếng Anh và thêm chi tiết nghệ thuật.
Style yêu cầu: ${styleModifier}

QUAN TRỌNG: Chỉ trả về prompt tiếng Anh ngắn gọn, không giải thích gì thêm.`
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
  
  if (cached && Date.now() - cached.timestamp < 1800000) {
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

// ==================== COMMAND HANDLERS ====================
const commandHandlers = {
  async chat(interaction) {
    const message = interaction.options.getString('message');
    const userId = interaction.user.id;
    const channelId = interaction.channel.id;
    
    const rateCheck = checkRateLimit(userId, 'message');
    if (rateCheck.limited) {
      return interaction.reply({
        content: `⏳ Rate limit! Đợi ${rateCheck.waitTime}s (Giới hạn: 20 tin/phút)`,
        ephemeral: true
      });
    }
    
    const cooldown = checkCooldown(userId);
    if (cooldown > 0) {
      return interaction.reply({
        content: `⏳ Cooldown ${cooldown}s`,
        ephemeral: true
      });
    }
    
    await interaction.deferReply();
    
    try {
      const profile = getUserProfile(userId);
      const history = getHistory(userId, channelId);
      
      addToHistory(userId, channelId, 'user', message);
      
      const response = await callOpenRouter(history);
      
      addToHistory(userId, channelId, 'assistant', response);
      stats.messagesProcessed++;
      profile.totalMessages++;
      updateUserProfile(userId, profile);
      
      if (response.length > 2000) {
        const chunks = response.match(/[\s\S]{1,2000}/g) || [];
        await interaction.followUp(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } else {
        await interaction.editReply(response);
      }
    } catch (error) {
      stats.errors++;
      console.error('Chat error:', error);
      
      const errorEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Lỗi')
        .setDescription('Không thể xử lý yêu cầu. Thử lại sau!')
        .setTimestamp();
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  },
  
  async reset(interaction) {
    const userId = interaction.user.id;
    const channelId = interaction.channel.id;
    const key = getHistoryKey(userId, channelId);
    
    conversationHistory.delete(key);
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Đã xóa lịch sử')
      .setDescription('Lịch sử hội thoại đã được reset.')
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async personality(interaction) {
    const type = interaction.options.getString('type');
    const userId = interaction.user.id;
    
    if (!PERSONALITIES[type]) {
      return interaction.reply({
        content: '❌ Personality không hợp lệ!',
        ephemeral: true
      });
    }
    
    updateUserProfile(userId, { personality: type });
    
    // Reset conversation history with new personality
    const channelId = interaction.channel.id;
    const key = getHistoryKey(userId, channelId);
    if (conversationHistory.has(key)) {
      const history = conversationHistory.get(key);
      history[0] = { role: 'system', content: getSystemPrompt(userId) };
    }
    
    stats.personalityChanges++;
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Đã đổi personality')
      .setDescription(`Personality mới: ${PERSONALITIES[type].name} ${PERSONALITIES[type].emoji}`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async image(interaction) {
    const prompt = interaction.options.getString('prompt');
    const style = interaction.options.getString('style') || 'realistic';
    const userId = interaction.user.id;
    
    const rateCheck = checkRateLimit(userId, 'image');
    if (rateCheck.limited) {
      return interaction.reply({
        content: `⏳ Rate limit! Đợi ${rateCheck.waitTime}s (Giới hạn: 5 ảnh/phút)`,
        ephemeral: true
      });
    }
    
    const cooldown = checkCooldown(userId);
    if (cooldown > 0) {
      return interaction.reply({
        content: `⏳ Cooldown ${cooldown}s`,
        ephemeral: true
      });
    }
    
    await interaction.deferReply();
    
    try {
      const profile = getUserProfile(userId);
      updateUserProfile(userId, { imageStyle: style });
      
      const enhancedPrompt = await enhanceImagePrompt(prompt, style);
      const imageResult = await generateImage(enhancedPrompt);
      
      stats.imagesGenerated++;
      profile.totalImages++;
      updateUserProfile(userId, profile);
      
      const attachment = new AttachmentBuilder(imageResult.buffer, 'image.png');
      
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('🎨 Ảnh đã tạo')
        .setDescription(`**Prompt:** ${prompt}`)
        .addFields(
          { name: 'Style', value: style, inline: true },
          { name: 'Model', value: IMAGE_MODEL, inline: true }
        )
        .setImage('attachment://image.png')
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (error) {
      stats.errors++;
      console.error('Image generation error:', error);
      
      const errorEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Lỗi tạo ảnh')
        .setDescription('Không thể tạo ảnh. Thử lại sau!')
        .setTimestamp();
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  },
  
  async imagine(interaction) {
    const prompt = interaction.options.getString('prompt');
    const userId = interaction.user.id;
    
    const rateCheck = checkRateLimit(userId, 'image');
    if (rateCheck.limited) {
      return interaction.reply({
        content: `⏳ Rate limit! Đợi ${rateCheck.waitTime}s (Giới hạn: 5 ảnh/phút)`,
        ephemeral: true
      });
    }
    
    await interaction.deferReply();
    
    try {
      const enhancedPrompt = await enhanceImagePrompt(prompt);
      const images = [];
      
      for (let i = 0; i < 4; i++) {
        const imageResult = await generateImage(enhancedPrompt, { seed: Math.random() });
        images.push(new AttachmentBuilder(imageResult.buffer, `image_${i + 1}.png`));
      }
      
      stats.imagesGenerated += 4;
      
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('🎨 4 phiên bản ảnh')
        .setDescription(`**Prompt:** ${prompt}`)
        .setImage('attachment://image_1.png')
        .setTimestamp();
      
      await interaction.editReply({ 
        embeds: [embed], 
        files: images 
      });
    } catch (error) {
      stats.errors++;
      console.error('Imagine error:', error);
      
      const errorEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Lỗi tạo ảnh')
        .setDescription('Không thể tạo ảnh. Thử lại sau!')
        .setTimestamp();
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  },
  
  async profile(interaction) {
    const userId = interaction.user.id;
    const profile = getUserProfile(userId);
    const personality = PERSONALITIES[profile.personality];
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle(`📊 Profile của ${interaction.user.username}`)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: 'Personality', value: `${personality.name} ${personality.emoji}`, inline: true },
        { name: 'Ngôn ngữ', value: profile.language.toUpperCase(), inline: true },
        { name: 'Image Style', value: profile.imageStyle, inline: true },
        { name: 'Tổng tin nhắn', value: profile.totalMessages.toString(), inline: true },
        { name: 'Tổng ảnh tạo', value: profile.totalImages.toString(), inline: true },
        { name: 'Game đã chơi', value: profile.gamesPlayed.toString(), inline: true },
        { name: 'Thành viên từ', value: `<t:${Math.floor(profile.createdAt / 1000)}:R>`, inline: true },
        { name: 'Lần cuối', value: `<t:${Math.floor(profile.lastSeen / 1000)}:R>`, inline: true }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async leaderboard(interaction) {
    const topUsers = Array.from(userProfiles.entries())
      .sort((a, b) => b[1].totalMessages - a[1].totalMessages)
      .slice(0, 10);
    
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🏆 Bảng xếp hạng')
      .setDescription('Top 10 người dùng tích cực nhất')
      .setTimestamp();
    
    let leaderboardText = '';
    for (let i = 0; i < topUsers.length; i++) {
      const [userId, profile] = topUsers[i];
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🏅';
        leaderboardText += `${medal} **${user.username}**: ${profile.totalMessages} tin nhắn\n`;
      }
    }
    
    embed.setDescription(leaderboardText || 'Chưa có dữ liệu!');
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async stats(interaction) {
    const uptime = Date.now() - stats.startTime;
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('📊 Thống kê Bot')
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: '⏱️ Uptime', value: `${days}d ${hours}h ${minutes}m`, inline: true },
        { name: '🖥️ Servers', value: client.guilds.cache.size.toString(), inline: true },
        { name: '👥 Users', value: client.users.cache.size.toString(), inline: true },
        { name: '💬 Tin nhắn', value: stats.messagesProcessed.toString(), inline: true },
        { name: '🎨 Ảnh tạo', value: stats.imagesGenerated.toString(), inline: true },
        { name: '🎮 Game chơi', value: stats.gamesPlayed.toString(), inline: true },
        { name: '🤖 Model hiện tại', value: `${OPENROUTER_MODEL} (${CURRENT_API_PROVIDER.current})`, inline: true },
        { name: '📊 Lệnh dùng', value: stats.commandsUsed.toString(), inline: true },
        { name: '❌ Lỗi', value: stats.errors.toString(), inline: true }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async translate(interaction) {
    const text = interaction.options.getString('text');
    
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Bạn là dịch giả chuyên nghiệp. Dịch văn bản sau sang tiếng Việt nếu là tiếng Anh, và sang tiếng Anh nếu là tiếng Việt. Chỉ trả về bản dịch, không giải thích.'
        },
        {
          role: 'user',
          content: text
        }
      ];
      
      const translation = await callOpenRouter(messages, { maxTokens: 500 });
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🌐 Bản dịch')
        .addFields(
          { name: '📝 Nguyên văn', value: text },
          { name: '✅ Bản dịch', value: translation }
        )
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Translate error:', error);
      
      await interaction.editReply('❌ Không thể dịch văn bản. Thử lại sau!');
    }
  },
  
  async summary(interaction) {
    const text = interaction.options.getString('text');
    
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Bạn là chuyên gia tóm tắt. Hãy tóm tắt văn bản sau một cách ngắn gọn, súc tích, giữ lại ý chính. Trả lời bằng tiếng Việt.'
        },
        {
          role: 'user',
          content: text
        }
      ];
      
      const summary = await callOpenRouter(messages, { maxTokens: 500 });
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('📝 Tóm tắt')
        .setDescription(summary)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Summary error:', error);
      
      await interaction.editReply('❌ Không thể tóm tắt văn bản. Thử lại sau!');
    }
  },
  
  async code(interaction) {
    const request = interaction.options.getString('request');
    
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Bạn là lập trình viên chuyên nghiệp. Viết code sạch, có comment chi tiết, và giải thích logic. Sử dụng markdown để định dạng code.'
        },
        {
          role: 'user',
          content: request
        }
      ];
      
      const code = await callOpenRouter(messages, { maxTokens: 1000 });
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💻 Code')
        .setDescription('```' + code + '```')
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Code error:', error);
      
      await interaction.editReply('❌ Không thể tạo code. Thử lại sau!');
    }
  },
  
  async quiz(interaction) {
    const topic = interaction.options.getString('topic') || 'general knowledge';
    
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Tạo một câu hỏi trắc nghiệm với 4 lựa chọn (A, B, C, D). Đưa ra câu hỏi, 4 lựa chọn, và đáp án đúng. Định dạng rõ ràng.'
        },
        {
          role: 'user',
          content: `Chủ đề: ${topic}`
        }
      ];
      
      const quiz = await callOpenRouter(messages, { maxTokens: 500 });
      
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎯 Câu hỏi trắc nghiệm')
        .setDescription(quiz)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Quiz error:', error);
      
      await interaction.editReply('❌ Không thể tạo câu hỏi. Thử lại sau!');
    }
  },
  
  async joke(interaction) {
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Bạn là comedian. Hãy kể một câu chuyện cười hài hước, phù hợp với mọi lứa tuổi. Trả lời bằng tiếng Việt.'
        },
        {
          role: 'user',
          content: 'Kể một câu chuyện cười'
        }
      ];
      
      const joke = await callOpenRouter(messages, { maxTokens: 300 });
      
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('😄 Câu chuyện cười')
        .setDescription(joke)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Joke error:', error);
      
      await interaction.editReply('❌ Không thể lấy câu chuyện cười. Thử lại sau!');
    }
  },
  
  async fact(interaction) {
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Bạn là chuyên gia về kiến thức thú vị. Hãy chia sẻ một sự thật thú vị, ít người biết. Trả lời bằng tiếng Việt.'
        },
        {
          role: 'user',
          content: 'Cho tôi một sự thật thú vị'
        }
      ];
      
      const fact = await callOpenRouter(messages, { maxTokens: 300 });
      
      const embed = new EmbedBuilder()
        .setColor('#00FFFF')
        .setTitle('🧠 Sự thật thú vị')
        .setDescription(fact)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Fact error:', error);
      
      await interaction.editReply('❌ Không thể lấy sự thật thú vị. Thử lại sau!');
    }
  },
  
  async remind(interaction) {
    const timeStr = interaction.options.getString('time');
    const message = interaction.options.getString('message');
    const userId = interaction.user.id;
    
    // Parse time
    let timeMs = 0;
    const timeMatch = timeStr.match(/^(\d+)([smhd])$/);
    if (!timeMatch) {
      return interaction.reply({
        content: '❌ Định dạng thời gian không hợp lệ! VD: 30s, 5m, 2h, 1d',
        ephemeral: true
      });
    }
    
    const [, amount, unit] = timeMatch;
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    timeMs = parseInt(amount) * multipliers[unit];
    
    if (timeMs > 86400000 * 7) { // Max 7 days
      return interaction.reply({
        content: '❌ Thời gian nhắc nhở tối đa là 7 ngày!',
        ephemeral: true
      });
    }
    
    const reminderId = `${userId}_${Date.now()}`;
    reminders.set(reminderId, {
      userId,
      channelId: interaction.channelId,
      message,
      time: Date.now() + timeMs
    });
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('⏰ Đặt lời nhắc thành công')
      .addFields(
        { name: '⏱️ Thời gian', value: timeStr },
        { name: '📝 Nội dung', value: message }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
    
    // Schedule reminder
    setTimeout(async () => {
      const reminder = reminders.get(reminderId);
      if (reminder) {
        try {
          const channel = await client.channels.fetch(reminder.channelId);
          if (channel) {
            const user = await client.users.fetch(reminder.userId);
            await channel.send(`⏰ **Nhắc nhở cho ${user}**: ${reminder.message}`);
          }
          reminders.delete(reminderId);
        } catch (error) {
          console.error('Reminder error:', error);
        }
      }
    }, timeMs);
  },
  
  async roll(interaction) {
    const sides = interaction.options.getInteger('sides') || 6;
    const result = Math.floor(Math.random() * sides) + 1;
    
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🎲 Tung xúc xắc')
      .addFields(
        { name: 'Số mặt', value: sides.toString(), inline: true },
        { name: 'Kết quả', value: result.toString(), inline: true }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async flip(interaction) {
    const result = Math.random() < 0.5 ? 'Ngửa' : 'Sấp';
    const emoji = result === 'Ngửa' ? '🌞' : '🌙';
    
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Tung đồng xu')
      .setDescription(`${emoji} Kết quả: **${result}**`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async rps(interaction) {
    const choices = ['rock', 'paper', 'scissors'];
    const choiceEmojis = { rock: '✊', paper: '✋', scissors: '✌️' };
    const userChoice = interaction.options.getString('choice');
    const botChoice = choices[Math.floor(Math.random() * choices.length)];
    
    let result;
    if (userChoice === botChoice) {
      result = 'Hòa!';
    } else if (
      (userChoice === 'rock' && botChoice === 'scissors') ||
      (userChoice === 'paper' && botChoice === 'rock') ||
      (userChoice === 'scissors' && botChoice === 'paper')
    ) {
      result = 'Bạn thắng!';
    } else {
      result = 'Bot thắng!';
    }
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor(result === 'Bạn thắng!' ? '#00FF00' : result === 'Bot thắng!' ? '#FF0000' : '#FFD700')
      .setTitle('✂️ Oẳn tù tì')
      .addFields(
        { name: 'Bạn chọn', value: `${choiceEmojis[userChoice]} ${userChoice}`, inline: true },
        { name: 'Bot chọn', value: `${choiceEmojis[botChoice]} ${botChoice}`, inline: true },
        { name: 'Kết quả', value: `**${result}**`, inline: false }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async numberguess(interaction) {
    const userId = interaction.user.id;
    const number = Math.floor(Math.random() * 100) + 1;
    
    activeGames.set(userId, {
      type: 'numberguess',
      number,
      attempts: 0,
      maxAttempts: 7,
      createdAt: Date.now()
    });
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('🔢 Đoán số (1-100)')
      .setDescription('Tôi đã nghĩ một số từ 1-100. Bạn có 7 lần đoán!\n\nSử dụng `/guess <số>` để đoán.')
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async wordle(interaction) {
    const userId = interaction.user.id;
    const words = ['ABOUT', 'ABOVE', 'ABUSE', 'ACTOR', 'ACUTE', 'ADMIT', 'ADOPT', 'ADULT', 'AFTER', 'AGAIN'];
    const word = words[Math.floor(Math.random() * words.length)];
    
    activeGames.set(userId, {
      type: 'wordle',
      word,
      attempts: [],
      maxAttempts: 6,
      createdAt: Date.now()
    });
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('📝 Wordle')
      .setDescription('Tôi đã nghĩ một từ tiếng Anh 5 chữ cái. Bạn có 6 lần đoán!\n\nSử dụng `/wordleguess <từ>` để đoán.')
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async memory(interaction) {
    const userId = interaction.user.id;
    const emojis = ['🍎', '🍌', '🍇', '🍓', '🍒', '🍑', '🍉', '🥝'];
    const cards = [...emojis, ...emojis].sort(() => Math.random() - 0.5);
    
    activeGames.set(userId, {
      type: 'memory',
      cards,
      flipped: [],
      matched: [],
      attempts: 0,
      createdAt: Date.now()
    });
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('🧠 Game Memory')
      .setDescription('Tìm các cặp emoji giống nhau!\n\nSử dụng `/memoryflip <số>` (1-16) để lật card.')
      .addFields(
        { name: 'Bảng', value: cards.map((emoji, i) => `${i + 1}. ❓`).join('\n') }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async tictactoe(interaction) {
    const userId = interaction.user.id;
    const board = Array(9).fill('⬜');
    
    activeGames.set(userId, {
      type: 'tictactoe',
      board,
      turn: 'user',
      createdAt: Date.now()
    });
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('⭕ Cờ ca-ró')
      .setDescription('Bạn là X, Bot là O\n\nSử dụng `/tictactoeplay <số>` (1-9) để đi.')
      .addFields(
        { name: 'Bảng', value: formatTicTacToeBoard(board) }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async trivia(interaction) {
    const category = interaction.options.getString('category') || 'general';
    
    await interaction.deferReply();
    
    try {
      const messages = [
        {
          role: 'system',
          content: 'Tạo một câu hỏi đố vui với 4 lựa chọn. Đưa ra câu hỏi, 4 lựa chọn, và đáp án đúng. Định dạng rõ ràng.'
        },
        {
          role: 'user',
          content: `Chủ đề: ${category}`
        }
      ];
      
      const trivia = await callOpenRouter(messages, { maxTokens: 500 });
      
      activeGames.set(interaction.user.id, {
        type: 'trivia',
        question: trivia,
        createdAt: Date.now()
      });
      
      stats.gamesPlayed++;
      
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎯 Đố vui')
        .setDescription(trivia)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Trivia error:', error);
      
      await interaction.editReply('❌ Không thể tạo câu hỏi đố. Thử lại sau!');
    }
  },
  
  async hangman(interaction) {
    const difficulty = interaction.options.getString('difficulty') || 'medium';
    const userId = interaction.user.id;
    
    const words = {
      easy: ['CAT', 'DOG', 'SUN', 'MOON', 'STAR'],
      medium: ['HOUSE', 'WATER', 'PHONE', 'MUSIC', 'HAPPY'],
      hard: ['COMPUTER', 'ELEPHANT', 'BUTTERFLY', 'MOUNTAIN', 'UNIVERSE']
    };
    
    const word = words[difficulty][Math.floor(Math.random() * words[difficulty].length)];
    const guessed = [];
    
    activeGames.set(userId, {
      type: 'hangman',
      word,
      guessed,
      wrong: 0,
      maxWrong: difficulty === 'easy' ? 8 : difficulty === 'medium' ? 6 : 4,
      createdAt: Date.now()
    });
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('🎯 Treo cổ')
      .setDescription(`Độ khó: ${difficulty}\n\nSử dụng `/hangmanguess <chữ>` để đoán chữ.`)
      .addFields(
        { name: 'Từ', value: word.split('').map(letter => guessed.includes(letter) ? letter : '_').join(' ') },
        { name: 'Chữ đã đoán', value: guessed.length > 0 ? guessed.join(', ') : 'Chưa có' },
        { name: 'Sai', value: `0/${activeGames.get(userId).maxWrong}` }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async connect4(interaction) {
    const userId = interaction.user.id;
    const board = Array(42).fill('⚪');
    
    activeGames.set(userId, {
      type: 'connect4',
      board,
      turn: 'user',
      createdAt: Date.now()
    });
    
    stats.gamesPlayed++;
    
    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('🔴 Connect 4')
      .setDescription('Bạn là 🔴, Bot là 🔵\n\nSử dụng `/connect4play <cột>` (1-7) để đi.')
      .addFields(
        { name: 'Bảng', value: formatConnect4Board(board) }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  },
  
  async weather(interaction) {
    const location = interaction.options.getString('location') || 'Hanoi';
    
    await interaction.deferReply();
    
    try {
      const weather = await getWeather(location);
      
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle(`🌤️ Thời tiết tại ${weather.location}, ${weather.country}`)
        .setThumbnail(`http://openweathermap.org/img/wn/${weather.icon}@2x.png`)
        .addFields(
          { name: '🌡️ Nhiệt độ', value: `${weather.temperature}°C`, inline: true },
          { name: '🤔 Cảm giác như', value: `${weather.feelsLike}°C`, inline: true },
          { name: '💧 Độ ẩm', value: `${weather.humidity}%`, inline: true },
          { name: '💨 Gió', value: `${weather.windSpeed} m/s`, inline: true },
          { name: '☁️ Mô tả', value: weather.description, inline: true }
        )
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      stats.errors++;
      console.error('Weather error:', error);
      
      await interaction.editReply('❌ Không thể lấy thông tin thời tiết. Thử lại sau!');
    }
  },
  
  async admin(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      return interaction.reply({
        content: '❌ Bạn không có quyền sử dụng lệnh này!',
        ephemeral: true
      });
    }
    
    const subcommand = interaction.options.getSubcommand();
    
    switch (subcommand) {
      case 'clearall':
        conversationHistory.clear();
        await interaction.reply({
          content: '✅ Đã xóa tất cả lịch sử hội thoại!',
          ephemeral: true
        });
        break;
        
      case 'broadcast':
        const message = interaction.options.getString('message');
        const sentCount = [];
        
        for (const guild of client.guilds.cache.values()) {
          try {
            const channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me).has('SendMessages'));
            if (channel) {
              await channel.send(`📢 **Thông báo từ Admin:**\n${message}`);
              sentCount.push(guild.name);
            }
          } catch (error) {
            console.error(`Failed to send to ${guild.name}:`, error);
          }
        }
        
        await interaction.reply({
          content: `✅ Đã gửi thông báo đến ${sentCount.length} servers!`,
          ephemeral: true
        });
        break;
        
      case 'setstatus':
        const status = interaction.options.getString('status');
        client.user.setActivity(status, { type: ActivityType.Playing });
        await interaction.reply({
          content: `✅ Đã đổi status thành: ${status}`,
          ephemeral: true
        });
        break;
    }
  },
  
  async help(interaction) {
    const category = interaction.options.getString('category');
    
    const categories = {
      ai: {
        title: '🤖 AI Chat Commands',
        commands: [
          '`/chat <message>` - Chat với AI Hein',
          '`/reset` - Xóa lịch sử hội thoại',
          '`/personality <type>` - Đổi personality AI'
        ]
      },
      image: {
        title: '🎨 Image Commands',
        commands: [
          '`/image <prompt>` - Tạo ảnh bằng AI',
          '`/imagine <prompt>` - Tạo 4 phiên bản ảnh'
        ]
      },
      profile: {
        title: '📊 Profile & Stats Commands',
        commands: [
          '`/profile` - Xem profile của bạn',
          '`/leaderboard` - Bảng xếp hạng',
          '`/stats` - Thống kê bot'
        ]
      },
      utility: {
        title: '🔧 Utility Commands',
        commands: [
          '`/translate <text>` - Dịch văn bản',
          '`/summary <text>` - Tóm tắt văn bản',
          '`/code <request>` - Tạo code',
          '`/weather [location]` - Xem thời tiết',
          '`/remind <time> <message>` - Đặt lời nhắc'
        ]
      },
      fun: {
        title: '🎉 Fun Commands',
        commands: [
          '`/quiz [topic]` - Câu hỏi trắc nghiệm',
          '`/joke` - Câu chuyện cười',
          '`/fact` - Sự thật thú vị',
          '`/roll [sides]` - Tung xúc xắc',
          '`/flip` - Tung đồng xu',
          '`/rps <choice>` - Oẳn tù tì'
        ]
      },
      games: {
        title: '🎮 Game Commands',
        commands: [
          '`/numberguess` - Đoán số',
          '`/wordle` - Game Wordle',
          '`/memory` - Game nhớ',
          '`/tictactoe` - Cờ ca-ró',
          '`/trivia [category]` - Đố vui',
          '`/hangman [difficulty]` - Treo cổ',
          '`/connect4` - Connect 4'
        ]
      },
      admin: {
        title: '⚙️ Admin Commands',
        commands: [
          '`/admin clearall` - Xóa tất cả lịch sử',
          '`/admin broadcast <message>` - Gửi thông báo',
          '`/admin setstatus <status>` - Đổi status bot'
        ]
      }
    };
    
    if (category && categories[category]) {
      const cat = categories[category];
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle(cat.title)
        .setDescription(cat.commands.join('\n'))
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    } else {
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('🤖 Hein AI Bot - Help')
        .setDescription('Sử dụng `/help <category>` để xem chi tiết')
        .addFields(
          Object.entries(categories).map(([key, value]) => ({
            name: value.title,
            value: value.commands.length + ' commands',
            inline: true
          }))
        )
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  }
};

// ==================== SLASH COMMANDS ====================
const commands = [
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
  
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Xem profile của bạn'),
  
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Xem bảng xếp hạng người dùng'),
  
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Xem thống kê bot'),
  
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
    .setDescription('Chơi cờ ca-ró với bot'),
  
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
  
  new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Xem thông tin thời tiết')
    .addStringOption(option => 
      option.setName('location')
        .setDescription('Địa điểm')
        .setRequired(false)),
  
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
      { name: 'Helping users', type: ActivityType.Listening },
      { name: 'Best AI', type: ActivityType.Playing },
      { name: '🎮 Games Available', type: ActivityType.Playing },
      { name: 'AI Assistant', type: ActivityType.Watching }
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
  if (!interaction.isChatInputCommand()) return;
  
  const { commandName } = interaction;
  trackCommand(commandName);
  
  if (commandHandlers[commandName]) {
    try {
      await commandHandlers[commandName](interaction);
    } catch (error) {
      console.error(`Error handling ${commandName}:`, error);
      
      const errorEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Lỗi')
        .description('Đã xảy ra lỗi khi xử lý lệnh này. Vui lòng thử lại sau!')
        .setTimestamp();
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  }
});

// ==================== MESSAGE CREATE HANDLER ====================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Handle game commands
  if (message.content.startsWith('/guess ')) {
    const userId = message.author.id;
    const game = activeGames.get(userId);
    
    if (!game || game.type !== 'numberguess') {
      return message.reply('❌ Bạn không có game đoán số đang diễn ra! Sử dụng `/numberguess` để bắt đầu.');
    }
    
    const guess = parseInt(message.content.split(' ')[1]);
    if (isNaN(guess) || guess < 1 || guess > 100) {
      return message.reply('❌ Vui lòng nhập số từ 1-100!');
    }
    
    game.attempts++;
    
    if (guess === game.number) {
      await message.reply(`🎉 Chính xác! Số là ${game.number}. Bạn đã đoán đúng sau ${game.attempts} lần!`);
      activeGames.delete(userId);
    } else if (game.attempts >= game.maxAttempts) {
      await message.reply(`😢 Hết lượt! Số đúng là ${game.number}.`);
      activeGames.delete(userId);
    } else {
      const hint = guess < game.number ? 'lớn hơn' : 'nhỏ hơn';
      await message.reply(`${guess} là quá ${hint}! Còn ${game.maxAttempts - game.attempts} lần đoán.`);
    }
    return;
  }
  
  if (message.content.startsWith('/wordleguess ')) {
    const userId = message.author.id;
    const game = activeGames.get(userId);
    
    if (!game || game.type !== 'wordle') {
      return message.reply('❌ Bạn không có game Wordle đang diễn ra! Sử dụng `/wordle` để bắt đầu.');
    }
    
    const guess = message.content.split(' ')[1].toUpperCase();
    if (guess.length !== 5 || !/^[A-Z]+$/.test(guess)) {
      return message.reply('❌ Vui lòng nhập một từ tiếng Anh 5 chữ cái!');
    }
    
    game.attempts.push(guess);
    
    if (guess === game.word) {
      await message.reply(`🎉 Chính xác! Từ là ${game.word}. Bạn đã đoán đúng sau ${game.attempts.length} lần!`);
      activeGames.delete(userId);
    } else if (game.attempts.length >= game.maxAttempts) {
      await message.reply(`😢 Hết lượt! Từ đúng là ${game.word}.`);
      activeGames.delete(userId);
    } else {
      // Simple feedback (would need more complex logic for colors)
      await message.reply(`${guess} - Không chính xác. Còn ${game.maxAttempts - game.attempts.length} lần đoán.`);
    }
    return;
  }
  
  if (message.content.startsWith('/memoryflip ')) {
    const userId = message.author.id;
    const game = activeGames.get(userId);
    
    if (!game || game.type !== 'memory') {
      return message.reply('❌ Bạn không có game memory đang diễn ra! Sử dụng `/memory` để bắt đầu.');
    }
    
    const cardIndex = parseInt(message.content.split(' ')[1]) - 1;
    if (isNaN(cardIndex) || cardIndex < 0 || cardIndex >= 16) {
      return message.reply('❌ Vui lòng nhập số từ 1-16!');
    }
    
    if (game.flipped.includes(cardIndex) || game.matched.includes(cardIndex)) {
      return message.reply('❌ Card này đã được lật!');
    }
    
    game.flipped.push(cardIndex);
    game.attempts++;
    
    if (game.flipped.length === 2) {
      const [first, second] = game.flipped;
      
      if (game.cards[first] === game.cards[second]) {
        game.matched.push(first, second);
        game.flipped = [];
        
        if (game.matched.length === 16) {
          await message.reply(`🎉 Bạn đã thắng với ${game.attempts} lần lật!`);
          activeGames.delete(userId);
        } else {
          await message.reply(`✅ Đôi trùng khớp! Còn ${16 - game.matched.length} cặp.`);
        }
      } else {
        await message.reply(`❌ Không trùng khớp! ${game.cards[first]} ${game.cards[second]}`);
        game.flipped = [];
      }
    } else {
      await message.reply(`�flip Card ${cardIndex + 1}: ${game.cards[cardIndex]}`);
    }
    return;
  }
  
  if (message.content.startsWith('/hangmanguess ')) {
    const userId = message.author.id;
    const game = activeGames.get(userId);
    
    if (!game || game.type !== 'hangman') {
      return message.reply('❌ Bạn không có game treo cổ đang diễn ra! Sử dụng `/hangman` để bắt đầu.');
    }
    
    const letter = message.content.split(' ')[1].toUpperCase();
    if (!/^[A-Z]$/.test(letter)) {
      return message.reply('❌ Vui lòng nhập một chữ cái!');
    }
    
    if (game.guessed.includes(letter)) {
      return message.reply('❌ Bạn đã đoán chữ cái này rồi!');
    }
    
    game.guessed.push(letter);
    
    if (game.word.includes(letter)) {
      const display = game.word.split('').map(l => game.guessed.includes(l) ? l : '_').join(' ');
      if (!display.includes('_')) {
        await message.reply(`🎉 Bạn đã thắng! Từ là ${game.word}.`);
        activeGames.delete(userId);
      } else {
        await message.reply(`✅ Đúng! ${display}`);
      }
    } else {
      game.wrong++;
      if (game.wrong >= game.maxWrong) {
        await message.reply(`😢 Bạn đã thua! Từ là ${game.word}.`);
        activeGames.delete(userId);
      } else {
        const display = game.word.split('').map(l => game.guessed.includes(l) ? l : '_').join(' ');
        await message.reply(`❌ Sai! ${display} (${game.wrong}/${game.maxWrong})`);
      }
    }
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

// ==================== HELPER FUNCTIONS FOR GAMES ====================
function formatTicTacToeBoard(board) {
  let display = '';
  for (let i = 0; i < 9; i++) {
    display += board[i];
    if ((i + 1) % 3 === 0) display += '\n';
  }
  return display;
}

function formatConnect4Board(board) {
  let display = '';
  for (let row = 5; row >= 0; row--) {
    for (let col = 0; col < 7; col++) {
      display += board[row * 7 + col];
    }
    display += '\n';
  }
  return display + '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣';
}

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
  
  for (const [gameId, game] of activeGames.entries()) {
    if (Date.now() - game.createdAt > 3600000) {
      activeGames.delete(gameId);
    }
  }
  
  for (const [reminderId, reminder] of reminders.entries()) {
    if (Date.now() > reminder.time) {
      reminders.delete(reminderId);
    }
  }
  
  console.log(`🧹 Cleanup: ${conversationHistory.size} convos, ${userProfiles.size} users, ${activeGames.size} games, ${reminders.size} reminders`);
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
const server = app.listen(WEB_PORT, () => {
  console.log(`🌐 Web server running on port ${WEB_PORT}`);
  console.log(`📊 Status page: http://localhost:${WEB_PORT}`);
  console.log(`🔗 API endpoint: http://localhost:${WEB_PORT}/api/stats`);
  console.log(`💚 Health check: http://localhost:${WEB_PORT}/health`);
  
  client.login(DISCORD_TOKEN).catch(error => {
    console.error('❌ Login failed:', error);
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
