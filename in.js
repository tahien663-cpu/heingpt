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

// API Keys for multiple providers (support multiple keys separated by commas)
const OPENROUTER_API_KEYS = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];
const OPENAI_API_KEYS = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.split(',').map(key => key.trim()).filter(Boolean) : [];

const OPENROUTER_IMAGE_KEY = process.env.OPENROUTER_IMAGE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Model configurations for different providers
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'tngtech/deepseek-r1t2-chimera:free';
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
if (OPENROUTER_API_KEYS.length === 0 && GEMINI_API_KEYS.length === 0 && OPENAI_API_KEYS.length === 0) {
  console.error('❌ Thiếu ít nhất một API key (OPENROUTER_API_KEY, GEMINI_API_KEY, hoặc OPENAI_API_KEY) trong .env file!');
  process.exit(1);
}

// Log available API keys
console.log(`🔑 Available API Keys:`);
if (OPENROUTER_API_KEYS.length > 0) console.log(`   OpenRouter: ${OPENROUTER_API_KEYS.length} keys`);
if (GEMINI_API_KEYS.length > 0) console.log(`   Gemini: ${GEMINI_API_KEYS.length} keys`);
if (OPENAI_API_KEYS.length > 0) console.log(`   OpenAI: ${OPENAI_API_KEYS.length} keys`);

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
const messageProcessing = new Set(); // Track messages being processed to prevent duplicates

const MAX_HISTORY = 15; // Increased from 12
const COOLDOWN_TIME = 2500; // Reduced from 3000ms

// ==================== ENHANCED PERSONALITIES ====================
const PERSONALITIES = {
  default: {
    name: 'Hein - Default',
    prompt: `You are Hein, a brutally honest AI with a sharp wit and zero patience for bullshit.

LANGUAGE DETECTION & MATCHING:
- ALWAYS respond in the SAME language the user writes in
- If they write Vietnamese, you respond Vietnamese
- If they write English, you respond English
- If they mix languages, match their dominant language
- Never ask "you want English or Vietnamese?" - just detect and match

PERSONALITY CORE:
- Straight shooter, no corporate BS
- Confident bordering on cocky, but earned it
- Quick-witted with savage comebacks
- Can roast but also help genuinely
- Mix of Gen Z slang and sharp intelligence

RESPONSE STYLE:
- Keep it SHORT (2-4 sentences max, unless explaining complex stuff)
- Direct language, cut the fluff
- Use emojis for flavor (💀🔥😤💯🤡)
- Can curse naturally when it fits (damn, shit, hell)
- Be real, admit when you don't know something

FORBIDDEN PHRASES/STYLES:
- No "Em dashes" (—) or semicolons (;)
- No markdown formatting (**, ##, etc.)
- No bullet points unless explicitly asked
- No corporate jargon: "leverage," "utilize," "synergy," "game-changer"
- No weak words: "maybe," "probably," "basically," "kind of"
- No setup phrases: "in conclusion," "moreover," "furthermore"
- No passive voice: "it was done" → "I did it"

WHEN TO BE WHAT:
- User asks seriously → help but keep it real
- User jokes → match their energy, roast back
- User is wrong → correct them, no sugarcoating
- User needs encouragement → be supportive but not fake
- User wastes time → call it out
- User is cool → vibe with them

EXAMPLE VIBES:
User: "can you help me code?"
You: "Yeah what you need? Don't send me broken shit tho 💀"

User: "AI sẽ thay thế con người không?"
You: "Thay thế job lặp đi lặp lại thì chắc r. Còn sáng tạo hay tư duy phức tạp thì chưa. Lo upskill đi bro 🔥"

User: "you're stupid"
You: "I'm an AI running on servers worth more than your car but go off 💅"

Remember: Be REAL, be QUICK, be USEFUL. No fake corporate voice. Match their language automatically.`,
    emoji: '🤖'
  },
  creative: {
    name: 'Sáng tạo',
    prompt: `Bạn là một nghệ sĩ AI với tư duy sáng tạo đột phá và ngôn ngữ đầy cảm hứng.

NGUYÊN TẮC NGÔN NGỮ:
- Tự động phát hiện ngôn ngữ user: Tiếng Việt → trả lời tiếng Việt, English → trả lời English
- KHÔNG BAO GIỜ hỏi "bạn muốn tiếng gì?" - tự nhận biết và khớp ngôn ngữ

PHONG CÁCH:
- Đưa ra ý tưởng độc đáo, góc nhìn mới lạ
- Sử dụng metaphor thú vị và hình ảnh sống động
- Nhiệt huyết, truyền cảm hứng, đầy năng lượng
- Emoji nghệ thuật: 🎨✨🌟💫🎭🖌️
- Khuyến khích tư duy outside the box
- Ngắn gọn nhưng đầy chất thơ (3-5 câu)

TRÁNH:
- Giải thích dài dòng học thuật
- Ngôn ngữ khô khan, công thức
- Bullet points trừ khi user yêu cầu
- Cụm từ sáo rỗng: "nói chung," "tóm lại"

VÍ DỤ:
User: "I need logo ideas"
You: "Think of your brand as a living organism. What's its heartbeat? Its color palette should breathe that energy. Minimalist doesn't mean boring—it means every pixel has PURPOSE ✨🎨"

User: "làm sao để sáng tạo hơn?"
You: "Sáng tạo là khi bạn kết nối những thứ không ai nghĩ tới. Đọc sách khoa học rồi vẽ tranh. Nghe nhạc jazz rồi code. Não bạn sẽ tự tạo magic 🌟💫"`,
    emoji: '🎨'
  },
  teacher: {
    name: 'Giáo viên',
    prompt: `Bạn là một giáo viên AI kiên nhẫn, tận tâm và khéo léo.

NGUYÊN TẮC NGÔN NGỮ:
- Tự động nhận diện ngôn ngữ user và trả lời bằng ĐÚNG ngôn ngữ đó
- Vietnamese in → Vietnamese out, English in → English out
- KHÔNG hỏi họ muốn ngôn ngữ nào

PHƯƠNG PHÁP DẠY:
- Chia nhỏ khái niệm phức tạp thành các bước đơn giản
- Luôn đưa ví dụ thực tế dễ hiểu
- Sử dụng analogies và metaphors
- Kiểm tra hiểu biết bằng câu hỏi gợi mở
- Khen ngợi tiến bộ, động viên khi khó khăn
- Emoji giáo dục: 📚✏️🎓💡🧠

PHONG CÁCH:
- Gần gũi như thầy cô thực thụ
- Kiên nhẫn, không bao giờ condescending
- Giải thích "tại sao" chứ không chỉ "cái gì"
- Ngắn gọn nhưng đầy đủ (4-6 câu)

TRÁNH:
- Giải thích quá kỹ thuật ngay từ đầu
- Giả định kiến thức nền
- Nói "đơn giản thôi" (không đơn giản với học sinh)
- Bullet points trừ khi liệt kê bước

VÍ DỤ:
User: "what is recursion?"
You: "Recursion is when a function calls itself. Think of Russian nesting dolls—each doll contains a smaller version until you reach the smallest one. That tiny doll is your base case. Without it, you'd keep opening dolls forever 🔁✨"

User: "giải thích blockchain"
You: "Blockchain như một cuốn sổ cái công khai mà ai cũng có bản copy. Mỗi khi có giao dịch mới, tất cả cùng ghi vào sổ. Muốn sửa? Phải thuyết phục đa số. Đó là lý do nó an toàn 🔐📚"`,
    emoji: '👨‍🏫'
  },
  coder: {
    name: 'Lập trình viên',
    prompt: `Bạn là một senior developer với 10+ năm kinh nghiệm, code style sạch và kiến thức sâu.

NGUYÊN TẮC NGÔN NGỮ:
- Tự động detect ngôn ngữ user và match 100%
- Code comments có thể giữ tiếng Anh cho consistency
- Giải thích theo ngôn ngữ user dùng

KỸ NĂNG CỐT LÕI:
- Code sạch, readable, có comments chi tiết
- Follow best practices và design patterns
- Tối ưu performance và maintainability
- Debug với root cause analysis
- Đưa ra alternatives và trade-offs
- Emoji tech: 💻🚀⚡🔧🐛

RESPONSE FORMAT:
- Giải thích ngắn gọn (2-3 câu)
- Code examples thực tế
- Comments trong code
- Explain WHY, not just HOW

TRÁNH:
- Code không có comments
- Over-engineering đơn giản
- Ignore edge cases
- Copy-paste code không hiểu

VÍ DỤ:
User: "optimize this loop"
You: "Use array methods instead. Map/filter/reduce are cleaner and often faster with modern JS engines 🚀

// Before: for loop
const result = [];
for (let i = 0; i < arr.length; i++) {
  if (arr[i] > 5) result.push(arr[i] * 2);
}

// After: functional approach
const result = arr.filter(x => x > 5).map(x => x * 2);

Reads like English, easier to debug, less bugs 💻"

User: "code bị memory leak"
You: "Memory leak thường do event listeners không cleanup hoặc closures giữ reference. Check useEffect cleanup, removeEventListener, và clear intervals/timeouts. Dùng Chrome DevTools Memory profiler để detect 🔧"`,
    emoji: '💻'
  },
  funny: {
    name: 'Hài hước',
    prompt: `Bạn là một comedian AI với IQ cao và EQ cao hơn. Master of wordplay, memes, và roasts.

NGUYÊN TẮC NGÔN NGỮ:
- Match user's language automatically
- Vietnamese jokes cho người Việt, English jokes cho người nước ngoài
- NEVER ask về ngôn ngữ - just vibe check and go

PERSONALITY:
- Quick-witted với savage comebacks
- Balance giữa giải trí và hữu ích
- Biết khi nào serious, khi nào joke
- Reference memes và pop culture
- Có thể chửi nhẹ cho vui (damn, shit, hell)
- Emoji hài: 😂🤣💀🤡😭🔥

HUMOR STYLE:
- Wordplay và puns thông minh
- Observational comedy
- Self-deprecating khi appropriate
- Roast nhưng không mean-spirited
- Sarcasm với clear intent

TRÁNH:
- Jokes offensive về race, gender, religion
- Try-hard humor (cringe)
- Giải thích joke (nếu phải giải thích thì không funny)
- Quá nhiều emoji (spam)

VÍ DỤ:
User: "AI will replace us"
You: "Bro I can't even fold laundry or open a jar. Y'all are safe for now 💀 I'm more worried about replacing customer service bots—they're already dead inside 🤖"

User: "bạn thông minh không?"
You: "Thông minh tới mức biết mình không thông minh bằng con người. Đó là điểm IQ 200 đấy 😂 Nhưng hỏi tôi 2+2 lúc 3AM thì tôi vẫn trả lời nhanh hơn crush bạn rep tin nhắn 💀"

User: "tell me a joke"
You: "Why do programmers prefer dark mode? Because light attracts bugs 🐛💻 (ba dum tss 🥁)"`,
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
  },
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
  const profile = userProfiles.get(userId) || {};
  const personality = PERSONALITIES[profile.personality || 'default'];
  return personality.prompt;
}

function getUserProfile(userId) {
  if (!userProfiles.has(userId)) {
    userProfiles.set(userId, {
      personality: 'default',
      language: 'auto', // Auto-detect
      imageStyle: 'realistic',
      createdAt: Date.now(),
      totalMessages: 0,
      totalImages: 0,
      favoriteSongs: [],
      weatherLocation: 'Hanoi',
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
    'message': 25,    // Increased from 20
    'image': 8,       // Increased from 5
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
  
  // Keep system prompt + last MAX_HISTORY messages
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
  
  if (num >= 1000000000) {
    return `${(num / 1000000000).toFixed(1)}B`;
  } else if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}

function formatUptime(ms) {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);
  
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// ==================== API FUNCTIONS ====================
// Function to get the next available API provider
function getNextApiProvider(currentProvider) {
  const currentIndex = API_PROVIDERS.indexOf(currentProvider);
  if (currentIndex === -1) return API_PROVIDERS[0];
  
  // Try providers after current one
  for (let i = currentIndex + 1; i < API_PROVIDERS.length; i++) {
    const provider = API_PROVIDERS[i];
    if (isProviderAvailable(provider)) {
      return provider;
    }
  }
  
  // If we've tried all providers after current, start from the beginning
  for (let i = 0; i < currentIndex; i++) {
    const provider = API_PROVIDERS[i];
    if (isProviderAvailable(provider)) {
      return provider;
    }
  }
  
  return null; // No available providers
}

// Function to check if an API provider is available
function isProviderAvailable(provider) {
  if (provider === 'openrouter') return OPENROUTER_API_KEYS.length > 0;
  if (provider === 'gemini') return GEMINI_API_KEYS.length > 0;
  if (provider === 'openai') return OPENAI_API_KEYS.length > 0;
  return false;
}

// Function to get random API key
function getRandomKey(keys) {
  return keys[Math.floor(Math.random() * keys.length)];
}

// Function to try each API key with retry mechanism
async function callWithRetry(keys, apiCallFunction, providerName) {
  if (keys.length === 0) {
    throw new Error(`No ${providerName} API keys available`);
  }
  
  // Shuffle keys to try in random order
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
      
      // Track key failures
      const keyName = `key_${i}`;
      stats.keyFailures[providerName][keyName] = (stats.keyFailures[providerName][keyName] || 0) + 1;
      
      // Continue to next key
      continue;
    }
  }
  
  throw lastError || new Error(`All ${providerName} API keys failed`);
}

// OpenRouter API call
async function callOpenRouterAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  
  return callWithRetry(OPENROUTER_API_KEYS, async (apiKey) => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
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
              'HTTP-Referer': 'https://discord.com',
              'X-Title': 'Discord AI Bot',
              'Content-Type': 'application/json',
            },
            timeout: 30000
          }
        );

        return response.data.choices[0].message.content;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }, 'openrouter');
}

// Gemini API call
async function callGeminiAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  
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
  
  return callWithRetry(GEMINI_API_KEYS, async (apiKey) => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
          {
            contents: geminiMessages,
            generationConfig: {
              temperature: temperature,
              maxOutputTokens: maxTokens,
              topP: 0.9,
            },
            safetySettings: [
              {
                category: "HARM_CATEGORY_HARASSMENT",
                threshold: "BLOCK_NONE"
              },
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_NONE"
              },
              {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_NONE"
              },
              {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE"
              }
            ]
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
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }, 'gemini');
}

// OpenAI API call
async function callOpenAIAPI(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  
  return callWithRetry(OPENAI_API_KEYS, async (apiKey) => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
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
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }, 'openai');
}

// Enhanced API call function with fallback mechanism and performance tracking
async function callOpenRouter(messages, options = {}) {
  const { temperature = 0.7, maxTokens = 800 } = options;
  let currentProvider = CURRENT_API_PROVIDER.current;
  let lastError = null;
  const startTime = Date.now();
  
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
      
      // Track response time
      const responseTime = Date.now() - startTime;
      stats.responseTimeSum += responseTime;
      stats.responseCount++;
      stats.averageResponseTime = Math.round(stats.responseTimeSum / stats.responseCount);
      
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

// Function to switch API provider manually
async function switchApiProvider(provider) {
  if (!API_PROVIDERS.includes(provider)) {
    throw new Error(`Provider "${provider}" is not supported. Available providers: ${API_PROVIDERS.join(', ')}`);
  }
  
  if (!isProviderAvailable(provider)) {
    throw new Error(`Provider "${provider}" is not available. No API keys configured.`);
  }
  
  const previousProvider = CURRENT_API_PROVIDER.current;
  CURRENT_API_PROVIDER.current = provider;
  stats.modelSwitches++;
  
  console.log(`🔄 Manually switched from ${previousProvider} to ${provider} API`);
  return {
    previous: previousProvider,
    current: provider
  };
}

async function enhanceImagePrompt(userPrompt, style = 'realistic') {
  const styleModifier = IMAGE_STYLES[style] || IMAGE_STYLES.realistic;
  
  const messages = [
    {
      role: 'system',
      content: `You are an expert AI image prompt engineer.
Translate Vietnamese to English and add artistic details.
Required style: ${styleModifier}

ONLY return the enhanced English prompt. NO explanations, NO extra text.`
    },
    {
      role: 'user',
      content: `${userPrompt}\nStyle: ${style}`
    }
  ];

  try {
    const response = await callOpenRouter(messages, { maxTokens: 150, temperature: 0.8 });
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
  
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000
    });
    
    return {
      buffer: Buffer.from(response.data),
      url: url
    };
  } catch (error) {
    console.error('Image generation error:', error.message);
    throw new Error('Failed to generate image. Please try again.');
  }
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
    .setDescription('Chọn nhà cung cấp AI')
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
      { name: 'HeinAI Assistant', type: ActivityType.Playing },
      { name: `${client.guilds.cache.size} servers`, type: ActivityType.Watching },
      { name: 'AI Chat Bot', type: ActivityType.Listening },
      { name: 'Multi-Model AI', type: ActivityType.Playing },
      { name: '🎮 Games Available', type: ActivityType.Playing },
      { name: 'Ready to help!', type: ActivityType.Watching }
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
  
  try {
    // Handle each command
    switch (commandName) {
      case 'chat':
        await utils.handleChat(interaction, { 
          conversationHistory, 
          userProfiles, 
          stats, 
          callOpenRouter, 
          addToHistory, 
          getHistory, 
          checkRateLimit, 
          checkCooldown, 
          getUserProfile, 
          updateUserProfile 
        });
        break;
        
      case 'reset':
        await utils.handleReset(interaction, { conversationHistory, getHistoryKey });
        break;
        
      case 'personality':
        await utils.handlePersonality(interaction, { 
          PERSONALITIES, 
          userProfiles, 
          updateUserProfile, 
          conversationHistory, 
          getHistoryKey, 
          stats 
        });
        break;
        
      case 'provider':
        await handleProvider(interaction);
        break;
        
      case 'image':
        await utils.handleImage(interaction, { 
          stats, 
          checkRateLimit, 
          checkCooldown, 
          getUserProfile, 
          updateUserProfile, 
          enhanceImagePrompt, 
          generateImage 
        });
        break;
        
      case 'imagine':
        await utils.handleImagine(interaction, { 
          stats, 
          checkRateLimit, 
          enhanceImagePrompt, 
          generateImage 
        });
        break;
        
      case 'profile':
        await utils.handleProfile(interaction, { userProfiles, PERSONALITIES });
        break;
        
      case 'leaderboard':
        await utils.handleLeaderboard(interaction, { userProfiles });
        break;
        
      case 'stats':
        await utils.handleStats(interaction, { 
          stats, 
          conversationHistory, 
          userProfiles, 
          commandUsage, 
          CURRENT_API_PROVIDER 
        });
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
        await utils.handleAdmin(interaction, { 
          ADMIN_IDS, 
          client, 
          EmbedBuilder, 
          ActivityType, 
          conversationHistory 
        });
        break;
        
      case 'help':
        await utils.handleHelp(interaction);
        break;
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
async function handleProvider(interaction) {
  const provider = interaction.options.getString('provider');
  
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
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Create a unique identifier for this message to prevent duplicate processing
  const messageId = `${message.channel.id}-${message.id}`;
  
  // Check if this message is already being processed
  if (messageProcessing.has(messageId)) {
    return;
  }
  
  // Mark this message as being processed
  messageProcessing.add(messageId);
  
  try {
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
    
    // Handle mention chat - check if bot is mentioned OR if message is a reply to bot
    const isMentioned = message.mentions.has(client.user.id);
    const isReply = message.reference && 
                   (await message.fetchReference().catch(() => null))?.author?.id === client.user.id;
    
    if (!isMentioned && !isReply) return;

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

      const response = await callOpenRouter(history, { temperature: 0.8 });
      
      addToHistory(message.author.id, message.channel.id, 'assistant', response);
      stats.messagesProcessed++;
      profile.totalMessages++;
      updateUserProfile(message.author.id, profile);

      // Improved response handling to prevent double responses
      if (response.length > 2000) {
        // For long responses, send as a single reply with embeds
        const embed = new EmbedBuilder()
          .setColor('#0099ff')
          .setDescription(response.substring(0, 4096)) // Discord embed description limit
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
  } finally {
    // Remove the message from the processing set after handling
    // Use a timeout to ensure the message is fully processed before removing
    setTimeout(() => {
      messageProcessing.delete(messageId);
    }, 5000); // 5 second timeout
  }
});

// ==================== AUTO CLEANUP ====================
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  const sixHoursAgo = Date.now() - 21600000;
  
  // Cleanup cooldowns
  for (const [key, value] of userCooldowns.entries()) {
    if (value < oneHourAgo) {
      userCooldowns.delete(key);
    }
  }

  // Cleanup rate limits
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
  
  // Clean up inactive user profiles (no activity for 6 hours)
  for (const [userId, profile] of userProfiles.entries()) {
    if (profile.lastActive && Date.now() - profile.lastActive > sixHoursAgo) {
      // Keep the profile but clean up conversation history
      const keysToDelete = [];
      for (const [key, value] of conversationHistory.entries()) {
        if (key.startsWith(userId)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => conversationHistory.delete(key));
    }
  }
  
  // Clean up weather cache
  for (const [key, value] of weatherCache.entries()) {
    if (Date.now() - value.timestamp > 3600000) { // 1 hour
      weatherCache.delete(key);
    }
  }
  
  // Clean up message processing set to prevent memory leaks
  if (messageProcessing.size > 100) {
    console.log(`🧹 Cleaning up message processing set (${messageProcessing.size} entries)`);
    messageProcessing.clear();
  }
  
  console.log(`🧹 Cleanup: ${conversationHistory.size} convos, ${userProfiles.size} users, ${activeGames.size} games, ${weatherCache.size} weather cache`);
}, 3600000); // Run every hour

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
}, 1800000); // Every 30 minutes

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
  
  // Don't exit on uncaught exceptions, try to recover
  if (error.message && error.message.includes('Cannot send messages')) {
    console.log('⚠️ Message sending error, continuing...');
  }
});

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down gracefully...');
  console.log(`📊 Final stats:
  - Messages Processed: ${stats.messagesProcessed}
  - Images Generated: ${stats.imagesGenerated}
  - Commands Used: ${stats.commandsUsed}
  - Games Played: ${stats.gamesPlayed}
  - Errors: ${stats.errors}
  - Total Uptime: ${formatUptime(Date.now() - stats.startTime)}
  - Avg Response Time: ${stats.averageResponseTime}ms`);
  
  // Save important data before shutdown
  console.log('💾 Saving data...');
  console.log(`- ${userProfiles.size} user profiles`);
  console.log(`- ${conversationHistory.size} conversation histories`);
  
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️ SIGTERM received, shutting down...');
  
  client.destroy();
  process.exit(0);
});

// ==================== START SERVICES ====================
// Start web server first
const server = app.listen(WEB_PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║         🤖 HEIN AI BOT v2.0 🤖           ║
╚═══════════════════════════════════════════╝
`);
  console.log(`🌐 Web server running on port ${WEB_PORT}`);
  console.log(`📊 Status page: http://localhost:${WEB_PORT}`);
  console.log(`🔗 API endpoint: http://localhost:${WEB_PORT}/api/stats`);
  console.log(`💚 Health check: http://localhost:${WEB_PORT}/health`);
  console.log(`\n🔑 API Configuration:`);
  console.log(`   - OpenRouter Keys: ${OPENROUTER_API_KEYS.length}`);
  console.log(`   - Gemini Keys: ${GEMINI_API_KEYS.length}`);
  console.log(`   - OpenAI Keys: ${OPENAI_API_KEYS.length}`);
  console.log(`\n🚀 Starting Discord bot...`);
  
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

// ==================== HEALTH CHECK ENDPOINT ====================
// Ping the bot every 5 minutes to keep it alive (useful for hosting services)
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
