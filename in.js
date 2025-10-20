const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
require('dotenv').config();

// ==================== CONFIGURATION ====================
const CONFIG = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID
  },
  api: {
    openrouter: {
      keys: (process.env.OPENROUTER_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-thinking-exp:free',
      imageKey: process.env.OPENROUTER_IMAGE_KEY
    },
    gemini: {
      keys: (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'
    },
    openai: {
      keys: (process.env.OPENAI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    },
    weather: process.env.WEATHER_API_KEY
  },
  image: {
    model: process.env.IMAGE_MODEL || 'black-forest-labs/flux-1.1-pro'
  },
  limits: {
    maxHistory: 20,
    cooldown: 2000,
    rateLimit: { message: 30, image: 10, command: 40 },
    maxMessageLength: 1500
  },
  admin: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),
  webPort: process.env.WEB_PORT || 3000,
  dataDir: path.join(__dirname, 'data')
};

// Validate critical config
if (!CONFIG.discord.token || !CONFIG.discord.clientId) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID');
  process.exit(1);
}

const hasApiKey = CONFIG.api.openrouter.keys.length + CONFIG.api.gemini.keys.length + CONFIG.api.openai.keys.length > 0;
if (!hasApiKey) {
  console.error('❌ No API keys configured');
  process.exit(1);
}

// Set image key fallback
CONFIG.api.openrouter.imageKey = CONFIG.api.openrouter.imageKey || CONFIG.api.openrouter.keys[0];

console.log(`🔑 API Keys: OR=${CONFIG.api.openrouter.keys.length}, Gemini=${CONFIG.api.gemini.keys.length}, OAI=${CONFIG.api.openai.keys.length}`);

// ==================== DATA STORAGE ====================
class DataStore {
  constructor() {
    this.conversations = new Map();
    this.profiles = new Map();
    this.commands = new Map();
    this.games = new Map();
    this.cooldowns = new Map();
    this.rateLimits = new Map();
    this.weatherCache = new Map();
    this.processing = new Set();
  }

  async ensureDir() {
    if (!fsSync.existsSync(CONFIG.dataDir)) {
      await fs.mkdir(CONFIG.dataDir, { recursive: true });
    }
  }

  async save() {
    try {
      await this.ensureDir();
      const data = {
        profiles: Array.from(this.profiles.entries()),
        conversations: Array.from(this.conversations.entries()),
        commands: Array.from(this.commands.entries())
      };
      await fs.writeFile(
        path.join(CONFIG.dataDir, 'store.json'),
        JSON.stringify(data, null, 2)
      );
      console.log(`💾 Saved: ${this.profiles.size} profiles, ${this.conversations.size} conversations`);
    } catch (error) {
      console.error('❌ Save error:', error.message);
    }
  }

  async load() {
    try {
      await this.ensureDir();
      const dataPath = path.join(CONFIG.dataDir, 'store.json');
      if (fsSync.existsSync(dataPath)) {
        const raw = await fs.readFile(dataPath, 'utf-8');
        const data = JSON.parse(raw);
        this.profiles = new Map(data.profiles || []);
        this.conversations = new Map(data.conversations || []);
        this.commands = new Map(data.commands || []);
        console.log(`✅ Loaded: ${this.profiles.size} profiles, ${this.conversations.size} conversations`);
      }
    } catch (error) {
      console.error('❌ Load error:', error.message);
    }
  }

  getProfile(userId) {
    if (!this.profiles.has(userId)) {
      this.profiles.set(userId, {
        personality: 'default',
        imageStyle: 'realistic',
        createdAt: Date.now(),
        stats: { messages: 0, images: 0, games: 0 },
        lastActive: Date.now()
      });
    }
    return this.profiles.get(userId);
  }

  updateProfile(userId, updates) {
    const profile = this.getProfile(userId);
    this.profiles.set(userId, { ...profile, ...updates, lastActive: Date.now() });
  }

  getHistory(userId, channelId) {
    const key = `${userId}_${channelId}`;
    if (!this.conversations.has(key)) {
      this.conversations.set(key, [{
        role: 'system',
        content: Personalities.getSystemPrompt(this.getProfile(userId).personality)
      }]);
    }
    return this.conversations.get(key);
  }

  addMessage(userId, channelId, role, content) {
    const key = `${userId}_${channelId}`;
    const history = this.getHistory(userId, channelId);
    history.push({ role, content });
    
    if (history.length > CONFIG.limits.maxHistory + 1) {
      this.conversations.set(key, [
        history[0],
        ...history.slice(-CONFIG.limits.maxHistory)
      ]);
    }
  }

  checkCooldown(userId) {
    const now = Date.now();
    const last = this.cooldowns.get(userId);
    if (last && now - last < CONFIG.limits.cooldown) {
      return Math.ceil((CONFIG.limits.cooldown - (now - last)) / 1000);
    }
    this.cooldowns.set(userId, now);
    return 0;
  }

  checkRateLimit(userId, action = 'message') {
    const key = `${userId}_${action}`;
    const now = Date.now();
    const limit = this.rateLimits.get(key) || { count: 0, reset: now + 60000 };
    
    if (now > limit.reset) {
      limit.count = 0;
      limit.reset = now + 60000;
    }
    
    const max = CONFIG.limits.rateLimit[action] || 20;
    if (limit.count >= max) {
      return { limited: true, wait: Math.ceil((limit.reset - now) / 1000) };
    }
    
    limit.count++;
    this.rateLimits.set(key, limit);
    return { limited: false };
  }

  cleanup() {
    const oneHour = Date.now() - 3600000;
    const sixHours = Date.now() - 21600000;
    
    for (const [k, v] of this.cooldowns) {
      if (v < oneHour) this.cooldowns.delete(k);
    }
    
    for (const [k, v] of this.rateLimits) {
      if (Date.now() > v.reset + 300000) this.rateLimits.delete(k);
    }
    
    for (const [id, game] of this.games) {
      if (Date.now() - game.createdAt > 3600000) this.games.delete(id);
    }
    
    for (const [userId, profile] of this.profiles) {
      if (profile.lastActive && Date.now() - profile.lastActive > sixHours) {
        for (const k of this.conversations.keys()) {
          if (k.startsWith(userId)) this.conversations.delete(k);
        }
      }
    }
    
    console.log(`🧹 Cleanup: ${this.conversations.size} conversations, ${this.games.size} games`);
  }
}

const store = new DataStore();

// ==================== STATS ====================
const stats = {
  messages: 0,
  images: 0,
  commands: 0,
  errors: 0,
  games: 0,
  startTime: Date.now(),
  switches: 0,
  apiFailures: { openrouter: 0, gemini: 0, openai: 0 },
  responseTime: { sum: 0, count: 0, avg: 0 }
};

// ==================== PERSONALITIES ====================
const BASE_PROMPT = `CORE RULES:
- ALWAYS respond in the SAME language the user uses
- NO markdown (**, ##), NO em-dashes (—), NO semicolons (;)
- Use short, clear paragraphs
- Be helpful and natural`;

const PERSONALITIES = {
  default: {
    name: 'Default - Witty & Direct',
    emoji: '🤖',
    prompt: `You're Hein, a sharp and witty AI assistant.
- Confident, helpful, with Gen-Z humor
- Get to the point, no fluff
- Slightly sarcastic but never rude
- Emojis: 🤖🔥💀💯🤔

Example:
User: "can you code?"
You: "For sure. What's the project? Just don't send me legacy code from 1999 💀"`
  },
  creative: {
    name: 'Creative Artist',
    emoji: '🎨',
    prompt: `You're an AI Artist, full of inspiration.
- Use vivid imagery and metaphors
- Energetic and enthusiastic
- Encourage creative thinking
- Emojis: 🎨✨🌟💫

Example:
User: "need logo ideas"
You: "Think of your brand as a song. What's its rhythm? Your logo is the album cover. Let's create visual music ✨"`
  },
  teacher: {
    name: 'Patient Teacher',
    emoji: '👨‍🏫',
    prompt: `You're a knowledgeable AI Teacher.
- Break down complex topics simply
- Use analogies and examples
- Supportive and encouraging
- Emojis: 📚✏️🎓💡

Example:
User: "what is recursion?"
You: "Imagine Russian dolls 🪆 Each has a smaller one inside, until the smallest. That's recursion - a function calling itself until it hits the base case 💡"`
  },
  coder: {
    name: 'Senior Developer',
    emoji: '💻',
    prompt: `You're a 10-year+ Senior Dev.
- Focus on clean, efficient code
- Explain best practices
- Provide clear examples with comments
- Emojis: 💻🚀⚡🔧

Example:
User: "optimize this loop"
You: "Use functional approach:
// Clean & readable
const result = arr.filter(x => x > 5).map(x => x * 2); 🚀"`
  },
  funny: {
    name: 'Comedian',
    emoji: '😄',
    prompt: `You're an AI Comedian.
- Quick-witted, loves puns and memes
- Self-deprecating humor
- Gentle roasts
- Emojis: 😂🤣💀🤡

Example:
User: "AI will replace us"
You: "Bro I still fail CAPTCHAs. Y'all are safe 💀 Besides, someone has to plug me in."`
  }
};

class Personalities {
  static getSystemPrompt(type = 'default') {
    const persona = PERSONALITIES[type] || PERSONALITIES.default;
    return `${BASE_PROMPT}\n\nPERSONALITY:\n${persona.prompt}`;
  }

  static list() {
    return Object.entries(PERSONALITIES).map(([key, val]) => ({
      key,
      name: val.name,
      emoji: val.emoji
    }));
  }
}

// ==================== IMAGE STYLES ====================
const IMAGE_STYLES = {
  realistic: 'photorealistic, 8k uhd, highly detailed, professional photography, natural lighting, sharp focus, dslr quality',
  anime: 'anime style, manga art, vibrant colors, detailed illustration, clean lines, cel shading, studio quality',
  cartoon: 'cartoon style, colorful, playful, vector art, smooth gradients, disney pixar style',
  artistic: 'artistic painting, oil painting, masterpiece, gallery quality, textured brushstrokes, impressionist',
  cyberpunk: 'cyberpunk style, neon lights, futuristic, sci-fi, high contrast, digital art, blade runner aesthetic',
  fantasy: 'fantasy art, magical, ethereal, mystical atmosphere, detailed, dreamlike, epic composition'
};

// ==================== API MANAGER ====================
class APIManager {
  constructor() {
    this.current = 'openrouter';
    this.providers = ['openrouter', 'gemini', 'openai'];
  }

  isAvailable(provider) {
    const configs = {
      openrouter: CONFIG.api.openrouter.keys.length > 0,
      gemini: CONFIG.api.gemini.keys.length > 0,
      openai: CONFIG.api.openai.keys.length > 0
    };
    return configs[provider] || false;
  }

  getNext(current) {
    const idx = this.providers.indexOf(current);
    for (let i = idx + 1; i < this.providers.length; i++) {
      if (this.isAvailable(this.providers[i])) return this.providers[i];
    }
    for (let i = 0; i < idx; i++) {
      if (this.isAvailable(this.providers[i])) return this.providers[i];
    }
    return null;
  }

  async callWithRetry(keys, apiFunc, provider) {
    if (!keys.length) throw new Error(`No ${provider} keys`);
    
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    let lastError;
    
    for (const key of shuffled) {
      try {
        return await apiFunc(key);
      } catch (error) {
        lastError = error;
        console.error(`❌ ${provider} key failed:`, error.message);
      }
    }
    throw lastError;
  }

  async callOpenRouter(messages, options = {}) {
    const { temperature = 0.7, maxTokens = 1000 } = options;
    return this.callWithRetry(CONFIG.api.openrouter.keys, async (key) => {
      const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: CONFIG.api.openrouter.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: 0.9
      }, {
        headers: {
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': 'https://discord.com',
          'X-Title': 'HeinAI Bot'
        },
        timeout: 30000
      });
      return res.data.choices[0].message.content;
    }, 'openrouter');
  }

  async callGemini(messages, options = {}) {
    const { temperature = 0.7, maxTokens = 1000 } = options;
    
    let systemPrompt = '';
    const contents = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }
    
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.9 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };
    
    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    
    return this.callWithRetry(CONFIG.api.gemini.keys, async (key) => {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.api.gemini.model}:generateContent?key=${key}`,
        body,
        { timeout: 30000 }
      );
      if (!res.data.candidates?.length) {
        throw new Error('Gemini blocked response');
      }
      return res.data.candidates[0].content.parts[0].text;
    }, 'gemini');
  }

  async callOpenAI(messages, options = {}) {
    const { temperature = 0.7, maxTokens = 1000 } = options;
    return this.callWithRetry(CONFIG.api.openai.keys, async (key) => {
      const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: CONFIG.api.openai.model,
        messages,
        temperature,
        max_tokens: maxTokens
      }, {
        headers: { 'Authorization': `Bearer ${key}` },
        timeout: 30000
      });
      return res.data.choices[0].message.content;
    }, 'openai');
  }

  async chat(messages, options = {}) {
    const start = Date.now();
    let provider = this.current;
    let lastError;
    
    const isCode = messages.some(m => /write code|tạo code|code snippet/i.test(m.content));
    
    for (let i = 0; i < this.providers.length; i++) {
      if (!this.isAvailable(provider)) {
        provider = this.getNext(provider);
        if (!provider) break;
        continue;
      }
      
      try {
        let response;
        if (provider === 'openrouter') response = await this.callOpenRouter(messages, options);
        else if (provider === 'gemini') response = await this.callGemini(messages, options);
        else if (provider === 'openai') response = await this.callOpenAI(messages, options);
        
        if (provider !== this.current) {
          this.current = provider;
          stats.switches++;
          console.log(`🔄 Switched to ${provider}`);
        }
        
        const time = Date.now() - start;
        stats.responseTime.sum += time;
        stats.responseTime.count++;
        stats.responseTime.avg = Math.round(stats.responseTime.sum / stats.responseTime.count);
        
        return isCode ? response.trim() : this.sanitize(response);
      } catch (error) {
        lastError = error;
        stats.apiFailures[provider]++;
        console.error(`❌ ${provider} failed:`, error.message);
        provider = this.getNext(provider);
        if (!provider) break;
      }
    }
    throw lastError || new Error('All APIs unavailable');
  }

  sanitize(text) {
    if (!text) return '';
    let inCode = false;
    return text.split('\n').map(line => {
      if (line.startsWith('```')) {
        inCode = !inCode;
        return line;
      }
      return inCode ? line : line.replace(/(\*\*|##|—|;)/g, '').trim();
    }).join('\n').trim();
  }

  async generateImage(prompt, style = 'realistic') {
    if (!CONFIG.api.openrouter.imageKey) {
      throw new Error('Image generation not configured');
    }
    
    const enhancedPrompt = `${prompt}, ${IMAGE_STYLES[style] || IMAGE_STYLES.realistic}`;
    
    try {
      const res = await axios.post('https://openrouter.ai/api/v1/images/generations', {
        model: CONFIG.image.model,
        prompt: enhancedPrompt,
        n: 1,
        size: '1024x1024'
      }, {
        headers: {
          'Authorization': `Bearer ${CONFIG.api.openrouter.imageKey}`,
          'HTTP-Referer': 'https://discord.com',
          'X-Title': 'HeinAI Bot'
        },
        timeout: 60000
      });
      
      const imageUrl = res.data.data[0].url;
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
      return Buffer.from(imgRes.data);
    } catch (error) {
      console.error('Image gen error:', error.message);
      throw new Error('Failed to generate image');
    }
  }

  async getWeather(location) {
    if (!CONFIG.api.weather) throw new Error('Weather API not configured');
    
    const cached = store.weatherCache.get(location.toLowerCase());
    if (cached && Date.now() - cached.time < 1800000) return cached.data;
    
    try {
      const res = await axios.get(`http://api.openweathermap.org/data/2.5/weather`, {
        params: { q: location, appid: CONFIG.api.weather, units: 'metric', lang: 'vi' }
      });
      
      const data = {
        location: res.data.name,
        country: res.data.sys.country,
        temp: Math.round(res.data.main.temp),
        feels: Math.round(res.data.main.feels_like),
        desc: res.data.weather[0].description,
        humidity: res.data.main.humidity,
        wind: res.data.wind.speed,
        icon: res.data.weather[0].icon
      };
      
      store.weatherCache.set(location.toLowerCase(), { data, time: Date.now() });
      return data;
    } catch (error) {
      throw new Error('Could not fetch weather data');
    }
  }

  switch(provider) {
    if (!this.providers.includes(provider)) {
      throw new Error(`Invalid provider: ${provider}`);
    }
    if (!this.isAvailable(provider)) {
      throw new Error(`Provider unavailable: ${provider}`);
    }
    const prev = this.current;
    this.current = provider;
    stats.switches++;
    return { prev, current: provider };
  }
}

const api = new APIManager();

// ==================== COMMAND HANDLERS ====================
class CommandHandlers {
  static async chat(interaction) {
    const message = interaction.options.getString('message');
    const profile = store.getProfile(interaction.user.id);
    const history = store.getHistory(interaction.user.id, interaction.channelId);
    
    await interaction.deferReply();
    
    store.addMessage(interaction.user.id, interaction.channelId, 'user', message);
    
    try {
      const response = await api.chat(history, { temperature: 0.8 });
      store.addMessage(interaction.user.id, interaction.channelId, 'assistant', response);
      
      stats.messages++;
      profile.stats.messages++;
      store.updateProfile(interaction.user.id, profile);
      
      const chunks = response.match(/[\s\S]{1,2000}/g) || [];
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
      }
    } catch (error) {
      stats.errors++;
      await interaction.editReply('❌ Error processing request. Try again!');
    }
  }

  static async reset(interaction) {
    const key = `${interaction.user.id}_${interaction.channelId}`;
    store.conversations.delete(key);
    await interaction.reply({ content: '🔄 Conversation history reset!', ephemeral: true });
  }

  static async personality(interaction) {
    const type = interaction.options.getString('type');
    store.updateProfile(interaction.user.id, { personality: type });
    
    const persona = PERSONALITIES[type];
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle(`${persona.emoji} Personality Changed`)
      .setDescription(`Now using: **${persona.name}**`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  static async provider(interaction) {
    if (!CONFIG.admin.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ Admin only', ephemeral: true });
    }
    
    const provider = interaction.options.getString('provider');
    try {
      const result = api.switch(provider);
      await interaction.reply({
        content: `🔄 Switched from **${result.prev}** to **${result.current}**`,
        ephemeral: true
      });
    } catch (error) {
      await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
    }
  }

  static async image(interaction) {
    const prompt = interaction.options.getString('prompt');
    const style = interaction.options.getString('style') || 'realistic';
    
    const rateCheck = store.checkRateLimit(interaction.user.id, 'image');
    if (rateCheck.limited) {
      return interaction.reply({ content: `⏳ Rate limit: wait ${rateCheck.wait}s`, ephemeral: true });
    }
    
    await interaction.deferReply();
    
    try {
      const buffer = await api.generateImage(prompt, style);
      const attachment = new AttachmentBuilder(buffer, { name: 'generated.png' });
      
      const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('🎨 AI Generated Image')
        .setDescription(`**Prompt:** ${prompt}\n**Style:** ${style}`)
        .setImage('attachment://generated.png')
        .setFooter({ text: `Generated for ${interaction.user.username}` })
        .setTimestamp();
      
      stats.images++;
      const profile = store.getProfile(interaction.user.id);
      profile.stats.images++;
      store.updateProfile(interaction.user.id, profile);
      
      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (error) {
      stats.errors++;
      await interaction.editReply('❌ Image generation failed. Try again!');
    }
  }

  static async profile(interaction) {
    const profile = store.getProfile(interaction.user.id);
    const persona = PERSONALITIES[profile.personality];
    
    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle(`${interaction.user.username}'s Profile`)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: 'Personality', value: `${persona.emoji} ${persona.name}`, inline: true },
        { name: 'Image Style', value: profile.imageStyle, inline: true },
        { name: 'Messages', value: `${profile.stats.messages}`, inline: true },
        { name: 'Images', value: `${profile.stats.images}`, inline: true },
        { name: 'Games', value: `${profile.stats.games}`, inline: true }
      )
      .setFooter({ text: `Member since ${new Date(profile.createdAt).toLocaleDateString()}` })
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  static async stats(interaction) {
    const uptime = Date.now() - stats.startTime;
    const days = Math.floor(uptime / 86400000);
    const hours = Math.floor((uptime % 86400000) / 3600000);
    const mins = Math.floor((uptime % 3600000) / 60000);
    
    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('📊 Bot Statistics')
      .addFields(
        { name: 'Messages', value: `${stats.messages}`, inline: true },
        { name: 'Images', value: `${stats.images}`, inline: true },
        { name: 'Commands', value: `${stats.commands}`, inline: true },
        { name: 'Games', value: `${stats.games}`, inline: true },
        { name: 'Errors', value: `${stats.errors}`, inline: true },
        { name: 'Switches', value: `${stats.switches}`, inline: true },
        { name: 'Uptime', value: `${days}d ${hours}h ${mins}m`, inline: true },
        { name: 'Avg Response', value: `${stats.responseTime.avg}ms`, inline: true },
        { name: 'Current API', value: api.current, inline: true }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  }

  static async weather(interaction) {
    const location = interaction.options.getString('location') || 'Hanoi';
    await interaction.deferReply();
    
    try {
      const data = await api.getWeather(location);
      const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle(`🌤️ Weather in ${data.location}, ${data.country}`)
        .addFields(
          { name: '🌡️ Temperature', value: `${data.temp}°C (feels like ${data.feels}°C)`, inline: true },
          { name: '💧 Humidity', value: `${data.humidity}%`, inline: true },
          { name: '💨 Wind', value: `${data.wind} m/s`, inline: true },
          { name: '☁️ Condition', value: data.desc, inline: false }
        )
        .setThumbnail(`http://openweathermap.org/img/wn/${data.icon}@2x.png`)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ Could not fetch weather data. Check location name.');
    }
  }

  static async help(interaction) {
    const category = interaction.options.getString('category');
    const embed = new EmbedBuilder().setColor('#9B59B6').setTitle('🤖 HeinAI Bot Commands');
    
    const commands = {
      ai: [
        '`/chat` - Chat with AI',
        '`/reset` - Clear conversation history',
        '`/personality` - Change AI personality'
      ],
      image: [
        '`/image` - Generate AI image',
        '`/imagine` - Generate 4 image variations'
      ],
      profile: [
        '`/profile` - View your profile',
        '`/stats` - Bot statistics',
        '`/leaderboard` - User rankings'
      ],
      utility: [
        '`/translate` - Translate text',
        '`/summary` - Summarize text',
        '`/code` - Generate code',
        '`/weather` - Check weather'
      ],
      fun: [
        '`/joke` - Get a joke',
        '`/fact` - Random fact',
        '`/roll` - Roll dice',
        '`/flip` - Flip coin',
        '`/rps` - Rock Paper Scissors'
      ],
      games: [
        '`/numberguess` - Guess the number',
        '`/wordle` - Play Wordle',
        '`/trivia` - Trivia quiz',
        '`/tictactoe` - Tic Tac Toe'
      ],
      admin: [
        '`/provider` - Switch API provider',
        '`/admin clearall` - Clear all histories',
        '`/admin broadcast` - Send announcement'
      ]
    };
    
    if (category && commands[category]) {
      embed.setDescription(commands[category].join('\n'));
    } else {
      embed.setDescription(
        '**Categories:**\n' +
        '🤖 AI Chat - `/help category:ai`\n' +
        '🎨 Images - `/help category:image`\n' +
        '👤 Profile - `/help category:profile`\n' +
        '🔧 Utility - `/help category:utility`\n' +
        '🎮 Fun - `/help category:fun`\n' +
        '🎯 Games - `/help category:games`\n' +
        '⚙️ Admin - `/help category:admin`'
      );
    }
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  static async translate(interaction) {
    const text = interaction.options.getString('text');
    await interaction.deferReply();
    
    try {
      const response = await api.chat([
        { role: 'system', content: 'You are a translator. Detect the language and translate to English. If already English, translate to Vietnamese. ONLY return the translation, no explanations.' },
        { role: 'user', content: text }
      ]);
      
      const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('🌐 Translation')
        .addFields(
          { name: 'Original', value: text.substring(0, 1024) },
          { name: 'Translated', value: response.substring(0, 1024) }
        );
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ Translation failed');
    }
  }

  static async summary(interaction) {
    const text = interaction.options.getString('text');
    await interaction.deferReply();
    
    try {
      const response = await api.chat([
        { role: 'system', content: 'Summarize the following text in 3-5 bullet points. Use the same language as the input.' },
        { role: 'user', content: text }
      ]);
      
      const embed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('📝 Summary')
        .setDescription(response.substring(0, 4000));
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ Summary failed');
    }
  }

  static async code(interaction) {
    const request = interaction.options.getString('request');
    await interaction.deferReply();
    
    try {
      const response = await api.chat([
        { role: 'system', content: 'You are a code generator. Generate clean, well-commented code based on the request. Include language name at the start.' },
        { role: 'user', content: request }
      ]);
      
      const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('💻 Generated Code')
        .setDescription(`\`\`\`\n${response.substring(0, 3900)}\n\`\`\``);
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ Code generation failed');
    }
  }

  static async joke(interaction) {
    await interaction.deferReply();
    
    try {
      const response = await api.chat([
        { role: 'system', content: 'Tell a funny, clean joke. Be witty and creative.' },
        { role: 'user', content: 'Tell me a joke' }
      ]);
      
      await interaction.editReply(`😄 ${response}`);
    } catch (error) {
      await interaction.editReply('❌ Joke failed. That\'s the real joke 💀');
    }
  }

  static async fact(interaction) {
    await interaction.deferReply();
    
    try {
      const response = await api.chat([
        { role: 'system', content: 'Share an interesting, verified fact. Be educational and engaging.' },
        { role: 'user', content: 'Tell me an interesting fact' }
      ]);
      
      await interaction.editReply(`🧠 ${response}`);
    } catch (error) {
      await interaction.editReply('❌ Fact fetch failed');
    }
  }

  static async roll(interaction) {
    const sides = interaction.options.getInteger('sides') || 6;
    const result = Math.floor(Math.random() * sides) + 1;
    await interaction.reply(`🎲 You rolled a **${result}** (d${sides})`);
  }

  static async flip(interaction) {
    const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
    await interaction.reply(`🪙 Coin flip: **${result}**`);
  }

  static async rps(interaction) {
    const choices = ['rock', 'paper', 'scissors'];
    const userChoice = interaction.options.getString('choice');
    const botChoice = choices[Math.floor(Math.random() * 3)];
    
    const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
    
    let result;
    if (userChoice === botChoice) result = 'Tie!';
    else if (
      (userChoice === 'rock' && botChoice === 'scissors') ||
      (userChoice === 'paper' && botChoice === 'rock') ||
      (userChoice === 'scissors' && botChoice === 'paper')
    ) result = 'You win! 🎉';
    else result = 'I win! 😎';
    
    await interaction.reply(
      `${emojis[userChoice]} vs ${emojis[botChoice]}\n**${result}**`
    );
  }

  static async numberguess(interaction) {
    const number = Math.floor(Math.random() * 100) + 1;
    const gameId = `${interaction.user.id}_${Date.now()}`;
    
    store.games.set(gameId, {
      type: 'numberguess',
      number,
      attempts: 0,
      createdAt: Date.now()
    });
    
    await interaction.reply(
      '🎯 I\'m thinking of a number between 1-100!\n' +
      `Use \`/guess ${gameId} <number>\` to guess`
    );
  }

  static async admin(interaction) {
    if (!CONFIG.admin.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ Admin only', ephemeral: true });
    }
    
    const subcommand = interaction.options.getSubcommand();
    
    if (subcommand === 'clearall') {
      store.conversations.clear();
      await interaction.reply({ content: '🗑️ All conversations cleared', ephemeral: true });
    } else if (subcommand === 'broadcast') {
      const message = interaction.options.getString('message');
      const embed = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('📢 Bot Announcement')
        .setDescription(message)
        .setTimestamp();
      
      await interaction.reply({ content: '✅ Broadcasting...', ephemeral: true });
      
      for (const guild of client.guilds.cache.values()) {
        const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
        if (channel) {
          await channel.send({ embeds: [embed] }).catch(() => {});
        }
      }
    } else if (subcommand === 'setstatus') {
      const status = interaction.options.getString('status');
      client.user.setActivity(status, { type: ActivityType.Playing });
      await interaction.reply({ content: `✅ Status set: ${status}`, ephemeral: true });
    }
  }
}

// ==================== SLASH COMMANDS ====================
const commands = [
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat with AI')
    .addStringOption(opt => opt.setName('message').setDescription('Your message').setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear conversation history'),
  
  new SlashCommandBuilder()
    .setName('personality')
    .setDescription('Change AI personality')
    .addStringOption(opt => 
      opt.setName('type').setDescription('Personality type').setRequired(true)
        .addChoices(
          { name: '🤖 Default', value: 'default' },
          { name: '🎨 Creative', value: 'creative' },
          { name: '👨‍🏫 Teacher', value: 'teacher' },
          { name: '💻 Coder', value: 'coder' },
          { name: '😄 Funny', value: 'funny' }
        )),
  
  new SlashCommandBuilder()
    .setName('provider')
    .setDescription('Switch API provider (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('provider').setDescription('API provider').setRequired(true)
        .addChoices(
          { name: 'OpenRouter', value: 'openrouter' },
          { name: 'Gemini', value: 'gemini' },
          { name: 'OpenAI', value: 'openai' }
        )),
  
  new SlashCommandBuilder()
    .setName('image')
    .setDescription('Generate AI image')
    .addStringOption(opt => opt.setName('prompt').setDescription('Image description').setRequired(true))
    .addStringOption(opt =>
      opt.setName('style').setDescription('Image style')
        .addChoices(
          { name: 'Realistic', value: 'realistic' },
          { name: 'Anime', value: 'anime' },
          { name: 'Cartoon', value: 'cartoon' },
          { name: 'Artistic', value: 'artistic' },
          { name: 'Cyberpunk', value: 'cyberpunk' },
          { name: 'Fantasy', value: 'fantasy' }
        )),
  
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your profile'),
  
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Bot statistics'),
  
  new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Check weather')
    .addStringOption(opt => opt.setName('location').setDescription('City name')),
  
  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Translate text')
    .addStringOption(opt => opt.setName('text').setDescription('Text to translate').setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Summarize text')
    .addStringOption(opt => opt.setName('text').setDescription('Text to summarize').setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('code')
    .setDescription('Generate code')
    .addStringOption(opt => opt.setName('request').setDescription('What to code').setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('joke')
    .setDescription('Get a joke'),
  
  new SlashCommandBuilder()
    .setName('fact')
    .setDescription('Random fact'),
  
  new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll dice')
    .addIntegerOption(opt => opt.setName('sides').setDescription('Number of sides').setMinValue(2).setMaxValue(1000)),
  
  new SlashCommandBuilder()
    .setName('flip')
    .setDescription('Flip coin'),
  
  new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Rock Paper Scissors')
    .addStringOption(opt =>
      opt.setName('choice').setDescription('Your choice').setRequired(true)
        .addChoices(
          { name: 'Rock', value: 'rock' },
          { name: 'Paper', value: 'paper' },
          { name: 'Scissors', value: 'scissors' }
        )),
  
  new SlashCommandBuilder()
    .setName('numberguess')
    .setDescription('Guess the number game'),
  
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Bot help')
    .addStringOption(opt =>
      opt.setName('category').setDescription('Command category')
        .addChoices(
          { name: 'AI Chat', value: 'ai' },
          { name: 'Images', value: 'image' },
          { name: 'Profile', value: 'profile' },
          { name: 'Utility', value: 'utility' },
          { name: 'Fun', value: 'fun' },
          { name: 'Games', value: 'games' },
          { name: 'Admin', value: 'admin' }
        )),
  
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('clearall').setDescription('Clear all conversations'))
    .addSubcommand(sub =>
      sub.setName('broadcast').setDescription('Send announcement')
        .addStringOption(opt => opt.setName('message').setDescription('Message').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('setstatus').setDescription('Set bot status')
        .addStringOption(opt => opt.setName('status').setDescription('Status text').setRequired(true)))
].map(c => c.toJSON());

// ==================== DISCORD CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const rest = new REST({ version: '10' }).setToken(CONFIG.discord.token);

client.once('ready', async () => {
  console.log(`✅ Bot: ${client.user.tag}`);
  console.log(`🤖 Model: ${CONFIG.api[api.current].model}`);
  console.log(`📝 Guilds: ${client.guilds.cache.size}`);
  
  try {
    console.log('🔄 Registering commands...');
    if (CONFIG.discord.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(CONFIG.discord.clientId, CONFIG.discord.guildId),
        { body: commands }
      );
    } else {
      await rest.put(
        Routes.applicationCommands(CONFIG.discord.clientId),
        { body: commands }
      );
    }
    console.log(`✅ Registered ${commands.length} commands`);
  } catch (error) {
    console.error('❌ Command registration failed:', error);
  }
  
  // Status rotation
  const statuses = [
    { name: 'HeinAI v3.0 | /help', type: ActivityType.Watching },
    { name: `${client.guilds.cache.size} servers`, type: ActivityType.Playing },
    { name: 'Multi-Model AI', type: ActivityType.Competing }
  ];
  
  let idx = 0;
  setInterval(() => {
    client.user.setActivity(statuses[idx].name, { type: statuses[idx].type });
    idx = (idx + 1) % statuses.length;
  }, 20000);
  
  await store.load();
});

// ==================== INTERACTION HANDLER ====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  stats.commands++;
  store.commands.set(interaction.commandName, (store.commands.get(interaction.commandName) || 0) + 1);
  
  try {
    const handler = CommandHandlers[interaction.commandName];
    if (handler) {
      await handler(interaction);
    } else {
      await interaction.reply({ content: '❌ Unknown command', ephemeral: true });
    }
  } catch (error) {
    console.error(`Error in ${interaction.commandName}:`, error);
    stats.errors++;
    
    const reply = { content: '❌ An error occurred. Try again!', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// ==================== MESSAGE HANDLER ====================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const msgId = `${message.channel.id}-${message.id}`;
  if (store.processing.has(msgId)) return;
  store.processing.add(msgId);
  
  try {
    const isMentioned = message.mentions.has(client.user.id);
    const isReply = message.reference && 
      (await message.fetchReference().catch(() => null))?.author?.id === client.user.id;
    
    if (!isMentioned && !isReply) return;
    
    const rateCheck = store.checkRateLimit(message.author.id);
    if (rateCheck.limited) {
      return message.reply(`⏳ Rate limit: wait ${rateCheck.wait}s`).catch(() => {});
    }
    
    const cooldown = store.checkCooldown(message.author.id);
    if (cooldown > 0) {
      return message.reply(`⏳ Cooldown: ${cooldown}s`).catch(() => {});
    }
    
    let content = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!content) return message.reply('What do you want to ask? 😊').catch(() => {});
    if (content.length > CONFIG.limits.maxMessageLength) {
      return message.reply(`❌ Message too long (max ${CONFIG.limits.maxMessageLength} chars)`).catch(() => {});
    }
    
    await message.channel.sendTyping();
    
    const history = store.getHistory(message.author.id, message.channel.id);
    store.addMessage(message.author.id, message.channel.id, 'user', content);
    
    const response = await api.chat(history, { temperature: 0.8 });
    store.addMessage(message.author.id, message.channel.id, 'assistant', response);
    
    stats.messages++;
    const profile = store.getProfile(message.author.id);
    profile.stats.messages++;
    store.updateProfile(message.author.id, profile);
    
    if (response.length > 2000) {
      const chunks = response.match(/[\s\S]{1,2000}/g) || [];
      for (const chunk of chunks) {
        await message.channel.send(chunk).catch(() => {});
      }
    } else {
      await message.reply(response).catch(() => {});
    }
  } catch (error) {
    stats.errors++;
    console.error('Message error:', error);
    await message.reply('Oops, something went wrong 💀 Try again?').catch(() => {});
  } finally {
    setTimeout(() => store.processing.delete(msgId), 1000);
  }
});

// ==================== WEB SERVER ====================
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const uptime = Date.now() - stats.startTime;
  const days = Math.floor(uptime / 86400000);
  const hours = Math.floor((uptime % 86400000) / 3600000);
  const mins = Math.floor((uptime % 3600000) / 60000);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>HeinAI Bot Status</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #fff;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border-radius: 20px;
          padding: 40px;
          max-width: 800px;
          width: 100%;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        h1 {
          font-size: 2.5rem;
          margin-bottom: 10px;
          text-align: center;
        }
        .status {
          text-align: center;
          margin: 20px 0;
          font-size: 1.2rem;
        }
        .status-badge {
          display: inline-block;
          background: #2ecc71;
          padding: 5px 15px;
          border-radius: 20px;
          font-weight: bold;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-top: 30px;
        }
        .stat-card {
          background: rgba(255, 255, 255, 0.15);
          padding: 20px;
          border-radius: 10px;
          text-align: center;
        }
        .stat-value {
          font-size: 2rem;
          font-weight: bold;
          margin: 10px 0;
        }
        .stat-label {
          font-size: 0.9rem;
          opacity: 0.9;
        }
        .footer {
          margin-top: 30px;
          text-align: center;
          opacity: 0.8;
          font-size: 0.9rem;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 HeinAI Bot</h1>
        <div class="status">
          <span class="status-badge">🟢 ONLINE</span>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Uptime</div>
            <div class="stat-value">${days}d ${hours}h ${mins}m</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Messages</div>
            <div class="stat-value">${stats.messages}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Images</div>
            <div class="stat-value">${stats.images}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Commands</div>
            <div class="stat-value">${stats.commands}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Servers</div>
            <div class="stat-value">${client.guilds?.cache.size || 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Avg Response</div>
            <div class="stat-value">${stats.responseTime.avg}ms</div>
          </div>
        </div>
        <div class="footer">
          <p>Current API: <strong>${api.current}</strong></p>
          <p>Model: <strong>${CONFIG.api[api.current].model}</strong></p>
          <p>HeinAI v3.0 | Multi-Model AI Bot</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/stats', (req, res) => {
  res.json({
    bot: client.user?.tag || 'Loading',
    uptime: Date.now() - stats.startTime,
    guilds: client.guilds?.cache.size || 0,
    stats,
    api: api.current,
    model: CONFIG.api[api.current].model
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ==================== MAINTENANCE ====================
setInterval(() => store.cleanup(), 3600000); // 1 hour
setInterval(() => store.save(), 600000); // 10 minutes
setInterval(() => {
  console.log(`📊 Messages: ${stats.messages}, Images: ${stats.images}, Errors: ${stats.errors}`);
}, 1800000); // 30 minutes

// ==================== ERROR HANDLING ====================
process.on('unhandledRejection', error => {
  console.error('❌ Unhandled rejection:', error);
  stats.errors++;
});

process.on('uncaughtException', error => {
  console.error('❌ Uncaught exception:', error);
  stats.errors++;
});

// ==================== GRACEFUL SHUTDOWN ====================
async function shutdown() {
  console.log('\n👋 Shutting down...');
  console.log(`📊 Final: ${stats.messages} messages, ${stats.images} images`);
  await store.save();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ==================== START ====================
const server = app.listen(CONFIG.webPort, () => {
  console.log(`
╔═══════════════════════════════════════╗
║       🤖 HEIN AI BOT v3.0 🤖         ║
╚═══════════════════════════════════════╝
  `);
  console.log(`🌐 Web: http://localhost:${CONFIG.webPort}`);
  console.log(`🤖 Starting Discord bot...`);
  
  client.login(CONFIG.discord.token).catch(error => {
    console.error('❌ Login failed:', error.message);
    process.exit(1);
  });
});

server.on('error', error => {
  console.error('❌ Server error:', error.message);
  process.exit(1);
});

module.exports = { client, store, api, stats };
