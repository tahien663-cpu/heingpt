const { EmbedBuilder, ActivityType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const axios = require('axios');

// ==================== COMMAND HANDLERS ====================
async function handleChat(interaction, { conversationHistory, userProfiles, stats, callOpenRouter, addToHistory, getHistory, checkRateLimit, checkCooldown, getUserProfile, updateUserProfile }) {
  const message = interaction.options.getString('message');
  const userId = interaction.user.id;
  const channelId = interaction.channel.id;
  
  const rateCheck = checkRateLimit(userId, 'message');
  if (rateCheck.limited) {
    return interaction.reply({
      content: `⏳ Rate limit! Đợi ${rateCheck.waitTime}s (Giới hạn: 20 tin/phút)`,
      flags: MessageFlags.Ephemeral
    });
  }

  const cooldown = checkCooldown(userId);
  if (cooldown > 0) {
    return interaction.reply({
      content: `⏳ Cooldown ${cooldown}s`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (message.length > 500) {
    return interaction.reply({
      content: '❌ Tin nhắn quá dài! Giới hạn 500 ký tự.',
      flags: MessageFlags.Ephemeral
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
      await interaction.followUp({ content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i] });
      }
    } else {
      await interaction.editReply({ content: response });
    }

  } catch (error) {
    stats.errors++;
    console.error('Error:', error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Lỗi')
      .setDescription('Không thể xử lý yêu cầu. Thử lại sau!')
      .setTimestamp();
    
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

async function handleReset(interaction, { conversationHistory, getHistoryKey }) {
  const key = getHistoryKey(interaction.user.id, interaction.channel.id);
  conversationHistory.delete(key);
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Reset thành công')
      .setDescription('Đã xóa lịch sử hội thoại!')
      .setTimestamp()]
  });
}

async function handlePersonality(interaction, { PERSONALITIES, userProfiles, updateUserProfile, conversationHistory, getHistoryKey, stats }) {
  const newPersonality = interaction.options.getString('type');
  
  if (!PERSONALITIES[newPersonality]) {
    return interaction.reply({
      content: '❌ Personality không tồn tại!',
      flags: MessageFlags.Ephemeral
    });
  }

  updateUserProfile(interaction.user.id, { personality: newPersonality });
  const key = getHistoryKey(interaction.user.id, interaction.channel.id);
  conversationHistory.delete(key);
  stats.personalityChanges++;

  const selected = PERSONALITIES[newPersonality];
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Đổi personality thành công')
      .setDescription(`**${selected.emoji} ${selected.name}**\n${selected.prompt}`)
      .setFooter({ text: 'Lịch sử chat đã được reset' })
      .setTimestamp()]
  });
}

async function handleImage(interaction, { stats, checkRateLimit, checkCooldown, getUserProfile, updateUserProfile, enhanceImagePrompt, generateImage }) {
  const prompt = interaction.options.getString('prompt');
  const style = interaction.options.getString('style') || 'realistic';
  
  const imgRateCheck = checkRateLimit(interaction.user.id, 'image');
  if (imgRateCheck.limited) {
    return interaction.reply({
      content: `⏳ Rate limit! Đợi ${imgRateCheck.waitTime}s (Giới hạn: 5 ảnh/phút)`,
      flags: MessageFlags.Ephemeral
    });
  }

  const imgCooldown = checkCooldown(interaction.user.id);
  if (imgCooldown > 0) {
    return interaction.reply({
      content: `⏳ Đợi ${imgCooldown}s`,
      flags: MessageFlags.Ephemeral
    });
  }

  const userProfile = getUserProfile(interaction.user.id);

  const processingEmbed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🎨 Đang tạo ảnh...')
    .setDescription(`**Mô tả:** ${prompt}\n**Style:** ${style}`)
    .setFooter({ text: 'Đang xử lý...' })
    .setTimestamp();
  
  await interaction.reply({ embeds: [processingEmbed] });

  try {
    const enhancedPrompt = await enhanceImagePrompt(prompt, style);
    
    processingEmbed
      .setDescription(`**Mô tả:** ${prompt}\n**Style:** ${style}\n**Prompt:** ${enhancedPrompt}`)
      .setFooter({ text: 'Đang render... (10-30s)' });
    await interaction.editReply({ embeds: [processingEmbed] });

    const imageData = await generateImage(enhancedPrompt, { width: 1024, height: 1024 });
    
    stats.imagesGenerated++;
    userProfile.totalImages++;
    updateUserProfile(interaction.user.id, userProfile);

    const attachment = new AttachmentBuilder(imageData.buffer, { name: 'ai_generated.png' });

    await interaction.editReply({ 
      embeds: [new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Ảnh hoàn thành!')
        .addFields(
          { name: '📝 Yêu cầu', value: prompt },
          { name: '🎨 Style', value: style, inline: true },
          { name: '🤖 Prompt', value: enhancedPrompt.substring(0, 100) + '...' }
        )
        .setImage('attachment://ai_generated.png')
        .setFooter({ text: `By ${interaction.user.tag} • Pollinations.ai` })
        .setTimestamp()],
      files: [attachment]
    });

  } catch (error) {
    console.error('Image error:', error);
    stats.errors++;
    
    await interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Lỗi tạo ảnh')
      .setDescription('Không thể tạo ảnh. Thử lại sau!')
      .setTimestamp()] });
  }
}

async function handleImagine(interaction, { stats, checkRateLimit, enhanceImagePrompt, generateImage }) {
  const prompt = interaction.options.getString('prompt');
  
  const imagineRateCheck = checkRateLimit(interaction.user.id, 'image');
  if (imagineRateCheck.limited) {
    return interaction.reply({
      content: `⏳ Rate limit! Đợi ${imagineRateCheck.waitTime}s`,
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.reply('🎨 Đang tạo 4 phiên bản khác nhau...');

  try {
    const styles = ['realistic', 'anime', 'artistic', 'cyberpunk'];
    const promises = styles.map(async (style) => {
      const enhanced = await enhanceImagePrompt(prompt, style);
      return generateImage(enhanced, { width: 512, height: 512 });
    });

    const results = await Promise.all(promises);
    
    const attachments = results.map((result, idx) => 
      new AttachmentBuilder(result.buffer, { name: `variant_${idx + 1}.png` })
    );

    stats.imagesGenerated += 4;

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('✨ 4 Phiên bản')
        .setDescription(`**Prompt:** ${prompt}`)
        .addFields(
          { name: '1️⃣ Realistic', value: 'Chân thực', inline: true },
          { name: '2️⃣ Anime', value: 'Phong cách Nhật', inline: true },
          { name: '3️⃣ Artistic', value: 'Nghệ thuật', inline: true },
          { name: '4️⃣ Cyberpunk', value: 'Tương lai', inline: true }
        )
        .setFooter({ text: `${interaction.user.tag}` })
        .setTimestamp()],
      files: attachments
    });

  } catch (error) {
    console.error('Imagine error:', error);
    stats.errors++;
    await interaction.editReply('❌ Lỗi tạo ảnh!');
  }
}

async function handleProfile(interaction, { userProfiles, PERSONALITIES, getUserProfile }) {
  const userProfile = getUserProfile(interaction.user.id);
  const personality = PERSONALITIES[userProfile.personality];
  const joinedDate = new Date(userProfile.createdAt).toLocaleDateString('vi-VN');

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle(`👤 Profile: ${interaction.user.username}`)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: '🎭 Personality', value: `${personality.emoji} ${personality.name}`, inline: true },
        { name: '🌐 Ngôn ngữ', value: userProfile.language.toUpperCase(), inline: true },
        { name: '🎨 Style ảnh', value: userProfile.imageStyle, inline: true },
        { name: '💬 Tin nhắn', value: `${userProfile.totalMessages}`, inline: true },
        { name: '🖼️ Ảnh tạo', value: `${userProfile.totalImages}`, inline: true },
        { name: '📅 Tham gia', value: joinedDate, inline: true },
        { name: '🌍 Vị trí thời tiết', value: userProfile.weatherLocation, inline: true },
        { name: '🎮 Trò chơi đã chơi', value: `${userProfile.gamesPlayed || 0}`, inline: true }
      )
      .setFooter({ text: 'Dùng /settings để thay đổi' })
      .setTimestamp()]
  });
}

async function handleLeaderboard(interaction, { userProfiles }) {
  const topUsers = Array.from(userProfiles.entries())
    .sort((a, b) => b[1].totalMessages - a[1].totalMessages)
    .slice(0, 10);

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🏆 Leaderboard - Top Users')
      .setDescription(
        topUsers.length === 0 
          ? 'Chưa có dữ liệu' 
          : topUsers.map(([userId, profile], idx) => {
              const medals = ['🥇', '🥈', '🥉'];
              const medal = medals[idx] || `${idx + 1}.`;
              return `${medal} <@${userId}>: ${profile.totalMessages} tin, ${profile.totalImages} ảnh`;
            }).join('\n')
      )
      .setFooter({ text: 'Dựa trên số tin nhắn' })
      .setTimestamp()]
  });
}

async function handleStats(interaction, { stats, conversationHistory, userProfiles, commandUsage, CURRENT_API_PROVIDER }) {
  const totalConversations = conversationHistory.size;
  const totalUsers = userProfiles.size;
  const uptime = Date.now() - stats.startTime;
  const hours = Math.floor(uptime / 3600000);
  const minutes = Math.floor((uptime % 3600000) / 60000);
  const successRate = stats.messagesProcessed > 0
    ? ((1 - stats.errors / stats.messagesProcessed) * 100).toFixed(2)
    : 100;

  const topCommands = Array.from(commandUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cmd, count]) => `\`${cmd}\`: ${count}`)
    .join('\n');

  // API provider status
  const apiStatus = Object.entries(stats.apiFailures).map(([provider, failures]) => {
    const status = failures === 0 ? '🟢' : failures < 5 ? '🟡' : '🔴';
    return `${status} ${provider.charAt(0).toUpperCase() + provider.slice(1)}: ${failures} failures`;
  }).join('\n');

  // Key failures summary
  const keyFailuresSummary = Object.entries(stats.keyFailures).map(([provider, keys]) => {
    const totalKeyFailures = Object.values(keys).reduce((sum, count) => sum + count, 0);
    return `${provider}: ${totalKeyFailures} key failures`;
  }).join('\n') || 'No key failures';

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('📊 Thống kê Bot')
      .addFields(
        { name: '💬 Tin nhắn', value: `${stats.messagesProcessed}`, inline: true },
        { name: '🎨 Ảnh tạo', value: `${stats.imagesGenerated}`, inline: true },
        { name: '⚡ Lệnh', value: `${stats.commandsUsed}`, inline: true },
        { name: '❌ Lỗi', value: `${stats.errors}`, inline: true },
        { name: '✅ Success rate', value: `${successRate}%`, inline: true },
        { name: '⏱️ Uptime', value: `${hours}h ${minutes}m`, inline: true },
        { name: '👥 Users', value: `${totalUsers}`, inline: true },
        { name: '💬 Conversations', value: `${totalConversations}`, inline: true },
        { name: '🎭 Personality switches', value: `${stats.personalityChanges}`, inline: true },
        { name: '🌤️ Truy vấn thời tiết', value: `${stats.weatherQueries}`, inline: true },
        { name: '🎮 Trò chơi chơi', value: `${stats.gamesPlayed}`, inline: true },
        { name: '🔄 Model switches', value: `${stats.modelSwitches}`, inline: true },
        { name: '🔥 Top Commands', value: topCommands || 'Chưa có' },
        { name: '🤖 API Provider', value: `Current: ${CURRENT_API_PROVIDER.current}\n\n${apiStatus}` },
        { name: '🔑 Key Failures', value: keyFailuresSummary }
      )
      .setFooter({ text: 'Từ lần restart cuối' })
      .setTimestamp()]
  });
}

async function handleTranslate(interaction, { callOpenRouter }) {
  const text = interaction.options.getString('text');
  
  await interaction.deferReply();

  try {
    const translatePrompt = [
      { role: 'system', content: 'Bạn là chuyên gia dịch thuật. Dịch text sang tiếng Việt nếu là tiếng Anh, hoặc ngược lại. CHỈ trả về bản dịch, không giải thích.' },
      { role: 'user', content: text }
    ];

    const translation = await callOpenRouter(translatePrompt, { maxTokens: 300 });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('🌐 Dịch thuật')
        .addFields(
          { name: '📝 Gốc', value: text },
          { name: '✅ Dịch', value: translation }
        )
        .setTimestamp()]
    });
  } catch (error) {
    console.error('Translate error:', error);
    await interaction.editReply('❌ Lỗi dịch thuật!');
  }
}

async function handleSummary(interaction, { callOpenRouter }) {
  const text = interaction.options.getString('text');
  
  if (text.length < 100) {
    return interaction.reply({
      content: '❌ Text quá ngắn để tóm tắt (cần >100 ký tự)',
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply();

  try {
    const summaryPrompt = [
      { role: 'system', content: 'Bạn là chuyên gia tóm tắt văn bản. Tóm tắt ngắn gọn (3-5 câu), giữ ý chính, dùng tiếng Việt.' },
      { role: 'user', content: text }
    ];

    const summary = await callOpenRouter(summaryPrompt, { maxTokens: 400 });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('📋 Tóm tắt')
        .addFields(
          { name: '📄 Gốc', value: text.substring(0, 200) + '...' },
          { name: '✨ Tóm tắt', value: summary }
        )
        .setFooter({ text: `${text.length} → ${summary.length} ký tự` })
        .setTimestamp()]
    });
  } catch (error) {
    console.error('Summary error:', error);
    await interaction.editReply('❌ Lỗi tóm tắt!');
  }
}

async function handleCode(interaction, { callOpenRouter }) {
  const request = interaction.options.getString('request');
  
  await interaction.deferReply();

  try {
    const codePrompt = [
      { role: 'system', content: 'Bạn là senior developer. Viết code sạch, có comment, giải thích ngắn gọn. Dùng markdown code block.' },
      { role: 'user', content: request }
    ];

    const codeResponse = await callOpenRouter(codePrompt, { maxTokens: 800, temperature: 0.3 });

    if (codeResponse.length > 2000) {
      const chunks = codeResponse.match(/[\s\S]{1,2000}/g) || [];
      await interaction.editReply({ content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i] });
      }
    } else {
      await interaction.editReply({ content: codeResponse });
    }
  } catch (error) {
    console.error('Code error:', error);
    await interaction.editReply('❌ Lỗi tạo code!');
  }
}

async function handleQuiz(interaction, { callOpenRouter }) {
  const topic = interaction.options.getString('topic') || 'kiến thức tổng quát';
  
  await interaction.deferReply();

  try {
    const quizPrompt = [
      { role: 'system', content: 'Tạo 1 câu hỏi trắc nghiệm với 4 đáp án A, B, C, D. Format:\n🎯 Câu hỏi: [câu hỏi]\nA) ...\nB) ...\nC) ...\nD) ...\n\nĐáp án đúng: X\nGiải thích: ...' },
      { role: 'user', content: `Tạo câu hỏi về: ${topic}` }
    ];

    const quiz = await callOpenRouter(quizPrompt, { maxTokens: 400, temperature: 0.8 });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#F39C12')
        .setTitle('🎯 Quiz Time!')
        .setDescription(quiz)
        .setFooter({ text: `Chủ đề: ${topic} • /quiz [chủ đề] để tạo mới` })
        .setTimestamp()]
    });
  } catch (error) {
    console.error('Quiz error:', error);
    await interaction.editReply('❌ Lỗi tạo quiz!');
  }
}

async function handleJoke(interaction, { callOpenRouter }) {
  await interaction.deferReply();

  try {
    const jokePrompt = [
      { role: 'system', content: 'Kể 1 câu chuyện cười tiếng Việt ngắn gọn, hài hước, lành mạnh.' },
      { role: 'user', content: 'Kể tao một câu chuyện cười' }
    ];

    const joke = await callOpenRouter(jokePrompt, { maxTokens: 300, temperature: 0.9 });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#E67E22')
        .setTitle('😄 Chuyện cười')
        .setDescription(joke)
        .setFooter({ text: 'Dùng /joke để nghe thêm' })
        .setTimestamp()]
    });
  } catch (error) {
    console.error('Joke error:', error);
    await interaction.editReply('❌ Hết chuyện để kể rồi 😅');
  }
}

async function handleFact(interaction, { callOpenRouter }) {
  await interaction.deferReply();

  try {
    const factPrompt = [
      { role: 'system', content: 'Đưa ra 1 fact thú vị, ít người biết. Ngắn gọn 2-3 câu, tiếng Việt.' },
      { role: 'user', content: 'Cho tôi một fact thú vị' }
    ];

    const fact = await callOpenRouter(factPrompt, { maxTokens: 200, temperature: 0.8 });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#1ABC9C')
        .setTitle('💡 Fact thú vị')
        .setDescription(fact)
        .setFooter({ text: 'Dùng /fact để xem thêm' })
        .setTimestamp()]
    });
  } catch (error) {
    console.error('Fact error:', error);
    await interaction.editReply('❌ Lỗi lấy fact!');
  }
}

async function handleRemind(interaction) {
  const timeArg = interaction.options.getString('time');
  const reminderMsg = interaction.options.getString('message');

  const timeMatch = timeArg.match(/^(\d+)([smh])$/);
  if (!timeMatch) {
    return interaction.reply({
      content: '❌ Thời gian không hợp lệ! Dùng: 30s, 5m, 2h',
      flags: MessageFlags.Ephemeral
    });
  }

  const [, value, unit] = timeMatch;
  const multiplier = { s: 1000, m: 60000, h: 3600000 }[unit];
  const delay = parseInt(value) * multiplier;

  if (delay > 86400000) {
    return interaction.reply({
      content: '❌ Thời gian tối đa: 24h',
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#27AE60')
      .setTitle('⏰ Reminder đã đặt')
      .setDescription(`Sẽ nhắc sau **${value}${unit}**:\n${reminderMsg}`)
      .setTimestamp()]
  });

  setTimeout(async () => {
    try {
      await interaction.followUp({ 
        content: `<@${interaction.user.id}>`,
        embeds: [new EmbedBuilder()
          .setColor('#E67E22')
          .setTitle('🔔 Reminder!')
          .setDescription(reminderMsg)
          .setFooter({ text: `Đã đặt ${value}${unit} trước` })
          .setTimestamp()]
      });
    } catch (error) {
      console.error('Reminder send error:', error);
    }
  }, delay);
}

async function handleRoll(interaction) {
  const sides = interaction.options.getInteger('sides') || 6;
  const result = Math.floor(Math.random() * sides) + 1;

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🎲 Roll Dice')
      .setDescription(`**Kết quả:** ${result} / ${sides}`)
      .setFooter({ text: `${interaction.user.username} rolled` })
      .setTimestamp()]
  });
}

async function handleFlip(interaction) {
  const result = Math.random() < 0.5 ? 'NGỬA 🪙' : 'SẤP 🎴';

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#F1C40F')
      .setTitle('🪙 Toss Coin')
      .setDescription(`**Kết quả:** ${result}`)
      .setFooter({ text: `${interaction.user.username} tossed` })
      .setTimestamp()]
  });
}

async function handleRPS(interaction, { stats }) {
  const choices = ['rock', 'paper', 'scissors'];
  const emojis = { rock: '✊', paper: '✋', scissors: '✌️' };
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
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('✊ Oẳn Tù Tì')
      .addFields(
        { name: 'Bạn chọn', value: `${emojis[userChoice]} ${userChoice}`, inline: true },
        { name: 'Bot chọn', value: `${emojis[botChoice]} ${botChoice}`, inline: true },
        { name: 'Kết quả', value: result, inline: true }
      )
      .setTimestamp()]
  });
}

async function handleNumberGuess(interaction, { activeGames, stats }) {
  const number = Math.floor(Math.random() * 100) + 1;
  const gameId = `numberguess_${interaction.user.id}_${Date.now()}`;
  
  activeGames.set(gameId, {
    type: 'numberguess',
    number: number,
    attempts: 0,
    maxAttempts: 7,
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    createdAt: Date.now()
  });
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('🔢 Đoán Số (1-100)')
      .setDescription('Tôi đã nghĩ một số từ 1-100. Hãy đoán xem!')
      .addFields(
        { name: 'Cách chơi', value: 'Sử dụng `/guess [số]` để đoán số' },
        { name: 'Lượt đoán', value: '0/7' }
      )
      .setFooter({ text: `Game ID: ${gameId}` })
      .setTimestamp()]
  });
  
  stats.gamesPlayed++;
}

async function handleWordle(interaction, { activeGames, stats }) {
  const words = ['ABOUT', 'ABOVE', 'ABUSE', 'ACTOR', 'ACUTE', 'ADMIT', 'ADOPT', 'ADULT', 'AFTER', 'AGAIN', 'AGENT', 'AGREE', 'AHEAD', 'ALARM', 'ALBUM', 'ALERT', 'ALIKE', 'ALIVE', 'ALLOW', 'ALONE', 'ALONG', 'ALTER', 'ANGEL', 'ANGER', 'ANGLE', 'ANGRY', 'APART', 'APPLE', 'APPLY', 'ARENA', 'ARGUE', 'ARISE', 'ARRAY', 'ASIDE', 'ASSET', 'AVOID', 'AWAKE', 'AWARE', 'BADLY', 'BAKER', 'BASES', 'BASIC', 'BEACH', 'BEGAN', 'BEING', 'BELOW', 'BENCH', 'BILLY', 'BIRTH', 'BLACK', 'BLAME', 'BLIND', 'BLOCK', 'BLOOD', 'BOARD', 'BOOST', 'BOOTH', 'BOUND', 'BRAIN', 'BRAND', 'BRAVE', 'BREAD', 'BREAK', 'BREED', 'BRIEF', 'BRING', 'BROAD', 'BROKE', 'BROWN', 'BUILD', 'BUILT', 'BUYER', 'CABLE', 'CALIF', 'CARRY', 'CATCH', 'CAUSE', 'CHAIN', 'CHAIR', 'CHAOS', 'CHARM', 'CHART', 'CHASE', 'CHEAP', 'CHECK', 'CHEST', 'CHIEF', 'CHILD', 'CHINA', 'CHOSE', 'CIVIL', 'CLAIM', 'CLASS', 'CLEAN', 'CLEAR', 'CLICK', 'CLIMB', 'CLOCK', 'CLOSE', 'CLOUD', 'COACH', 'COAST', 'COULD', 'COUNT', 'COURT', 'COVER', 'CRAFT', 'CRASH', 'CRAZY', 'CREAM', 'CRIME', 'CROSS', 'CROWD', 'CROWN', 'CRUDE', 'CURVE', 'CYCLE', 'DAILY', 'DANCE', 'DATED', 'DEALT', 'DEATH', 'DEBUT', 'DELAY', 'DELTA', 'DELTA', 'DENSE', 'DEPOT', 'DEPTH', 'DERBY', 'DIGIT', 'DIRTY', 'DOZEN', 'DRAFT', 'DRAMA', 'DRANK', 'DRAWN', 'DREAM', 'DRESS', 'DRILL', 'DRINK', 'DRIVE', 'DROVE', 'DYING', 'EAGER', 'EARLY', 'EARTH', 'EIGHT', 'EIGHT', 'ELITE', 'EMPTY', 'ENEMY', 'ENJOY', 'ENTER', 'ENTRY', 'EQUAL', 'ERROR', 'EVENT', 'EVERY', 'EXACT', 'EXIST', 'EXTRA', 'FAITH', 'FALSE', 'FANCY', 'FAULT', 'FENCE', 'FIBER', 'FIELD', 'FIFTH', 'FIFTH', 'FIFTY', 'FIFTY', 'FIGHT', 'FINAL', 'FIRST', 'FIXED', 'FLASH', 'FLEET', 'FLESH', 'FLIER', 'FLOAT', 'FLOOD', 'FLOOR', 'FLUID', 'FOCUS', 'FORCE', 'FORTH', 'FORTY', 'FORUM', 'FOUND', 'FRAME', 'FRANK', 'FRAUD', 'FRESH', 'FRONT', 'FRUIT', 'FULLY', 'FUNNY', 'GIANT', 'GIVEN', 'GLASS', 'GLOBE', 'GOING', 'GRACE', 'GRADE', 'GRAIN', 'GRAND', 'GRANT', 'GRASS', 'GRAVE', 'GREAT', 'GREEN', 'GROSS', 'GROUP', 'GROWN', 'GROWN', 'GUARD', 'GUESS', 'GUEST', 'GUIDE', 'GUILD', 'HABIT', 'HAPPY', 'HARRY', 'HEART', 'HEAVY', 'HENCE', 'HENRY', 'HORSE', 'HOTEL', 'HOUSE', 'HUMAN', 'IDEAL', 'IMAGE', 'IMPLY', 'INDEX', 'INNER', 'INPUT', 'ISSUE', 'JAPAN', 'JIMMY', 'JOINT', 'JONES', 'JUDGE', 'KNOWN', 'LABEL', 'LARGE', 'LASER', 'LATER', 'LAUGH', 'LAYER', 'LEARN', 'LEASE', 'LEAST', 'LEAVE', 'LEGAL', 'LEMON', 'LEVEL', 'LEWIS', 'LIGHT', 'LIMIT', 'LINKS', 'LIVES', 'LOCAL', 'LOGIC', 'LOOSE', 'LOWER', 'LUCKY', 'LUNCH', 'LYING', 'MAGIC', 'MAJOR', 'MAKER', 'MARCH', 'MARIA', 'MATCH', 'MAYBE', 'MAYOR', 'MEANT', 'MEDIA', 'METAL', 'MIGHT', 'MINOR', 'MINUS', 'MIXED', 'MODEL', 'MONEY', 'MONTH', 'MORAL', 'MOTOR', 'MOUNT', 'MOUSE', 'MOUTH', 'MOVED', 'MOVIE', 'MUSIC', 'NEEDS', 'NEVER', 'NEWLY', 'NIGHT', 'NOISE', 'NORTH', 'NOTED', 'NOVEL', 'NURSE', 'OCCUR', 'OCEAN', 'OFFER', 'OFTEN', 'ORDER', 'OTHER', 'OUGHT', 'OUTER', 'OWNER', 'PAINT', 'PANEL', 'PAPER', 'PARIS', 'PARTY', 'PEACE', 'PENNY', 'PETER', 'PHASE', 'PHONE', 'PHOTO', 'PIANO', 'PIECE', 'PILOT', 'PILOT', 'PLAZA', 'POINT', 'POUND', 'POWER', 'PRESS', 'PRICE', 'PRIDE', 'PRIME', 'PRINT', 'PRIOR', 'PRIZE', 'PROOF', 'PROUD', 'PROVE', 'QUEEN', 'QUICK', 'QUIET', 'QUIET', 'QUITE', 'RADIO', 'RAISE', 'RANGE', 'RAPID', 'RATIO', 'REACH', 'READY', 'REALM', 'REFER', 'RELAX', 'REPLY', 'RIDER', 'RIDGE', 'RIFLE', 'RIFLE', 'RIGID', 'RIGHT', 'RIGID', 'RIVER', 'ROBIN', 'ROCKY', 'ROGER', 'ROMAN', 'ROUGH', 'ROUND', 'ROUTE', 'ROYAL', 'RURAL', 'SCALE', 'SCENE', 'SCOPE', 'SCORE', 'SENSE', 'SERVE', 'SEVEN', 'SHALL', 'SHAPE', 'SHARE', 'SHARP', 'SHEET', 'SHELF', 'SHELL', 'SHELL', 'SHIFT', 'SHINE', 'SHIRT', 'SHOCK', 'SHOOT', 'SHORT', 'SHOWN', 'SIGHT', 'SILLY', 'SIMON', 'SINCE', 'SIXTH', 'SIXTY', 'SIZED', 'SKILL', 'SLASH', 'SLEEP', 'SLIDE', 'SMALL', 'SMART', 'SMILE', 'SMITH', 'SMOKE', 'SOLID', 'SOLVE', 'SORRY', 'SOUND', 'SOUTH', 'SPACE', 'SPARE', 'SPEAK', 'SPEED', 'SPEND', 'SPENT', 'SPLIT', 'SPOKE', 'SPORT', 'STAFF', 'STAGE', 'STAKE', 'STAND', 'START', 'STATE', 'STEAM', 'STEEL', 'STICK', 'STILL', 'STOCK', 'STONE', 'STOOD', 'STOOD', 'STOOD', 'STORM', 'STORY', 'STRIP', 'STUCK', 'STUDY', 'STUFF', 'STYLE', 'SUGAR', 'SUITE', 'SUNNY', 'SUPER', 'SURGE', 'SWEET', 'TABLE', 'TAKEN', 'TASTE', 'TAXES', 'TEACH', 'TEETH', 'TEMPO', 'TERRY', 'TEXAS', 'THANK', 'THEFT', 'THEIR', 'THEME', 'THERE', 'THESE', 'THICK', 'THING', 'THINK', 'THIRD', 'THOSE', 'THREE', 'THREW', 'THROW', 'THUMB', 'TIGHT', 'TIMER', 'TITLE', 'TODAY', 'TOMMY', 'TOPIC', 'TOTAL', 'TOUCH', 'TOUGH', 'TOWER', 'TRACK', 'TRADE', 'TRAIN', 'TRASH', 'TREAT', 'TREND', 'TRIAL', 'TRIBE', 'TRICK', 'TRIED', 'TRIES', 'TROOP', 'TROOP', 'TRUCK', 'TRULY', 'TRUST', 'TRUTH', 'TWICE', 'TWINS', 'UNCLE', 'UNDER', 'UNDUE', 'UNION', 'UNITY', 'UNTIL', 'UPPER', 'UPSET', 'URBAN', 'USAGE', 'USUAL', 'VALID', 'VALUE', 'VIDEO', 'VIRUS', 'VISIT', 'VITAL', 'VOCAL', 'VOICE', 'WASTE', 'WATCH', 'WATER', 'WHEEL', 'WHERE', 'WHICH', 'WHILE', 'WHITE', 'WHOLE', 'WHOSE', 'WOMAN', 'WOMEN', 'WORLD', 'WORRY', 'WORSE', 'WORST', 'WORTH', 'WOULD', 'WOUND', 'WRITE', 'WRONG', 'WROTE', 'YIELD', 'YOUNG', 'YOURS', 'YOUTH', 'ZEBRA'];
  
  const word = words[Math.floor(Math.random() * words.length)];
  const gameId = `wordle_${interaction.user.id}_${Date.now()}`;
  
  activeGames.set(gameId, {
    type: 'wordle',
    word: word,
    attempts: [],
    maxAttempts: 6,
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    createdAt: Date.now()
  });
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('📝 Wordle Game')
      .setDescription('Đoán từ tiếng Anh 5 chữ cái!')
      .addFields(
        { name: 'Cách chơi', value: '🟩 Chữ đúng, đúng vị trí\n🟨 Chữ đúng, sai vị trí\n⬛ Không có trong từ' },
        { name: 'Lượt đoán', value: '0/6' }
      )
      .setFooter({ text: `Game ID: ${gameId}` })
      .setTimestamp()]
  });
  
  stats.gamesPlayed++;
}

// NEW GAMES HANDLERS
async function handleMemoryGame(interaction, { activeGames, stats }) {
  const emojis = ['🍎', '🍌', '🍇', '🍓', '🍒', '🍑', '🍉', '🥝', '🍊', '🍋'];
  const pairs = [];
  
  // Create pairs of emojis
  for (let i = 0; i < 8; i++) {
    const emoji = emojis[i];
    pairs.push(emoji, emoji); // Add each emoji twice
  }
  
  // Shuffle the pairs
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  
  const gameId = `memory_${interaction.user.id}_${Date.now()}`;
  
  activeGames.set(gameId, {
    type: 'memory',
    cards: pairs,
    revealed: new Array(16).fill(false),
    matched: new Array(16).fill(false),
    attempts: 0,
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    createdAt: Date.now()
  });
  
  // Create the game board
  let board = '';
  for (let i = 0; i < 16; i++) {
    if (i % 4 === 0) board += '\n';
    board += '||❓|| ';
  }
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🧠 Memory Game')
      .setDescription('Tìm tất cả các cặp emoji giống nhau!')
      .addFields(
        { name: 'Cách chơi', value: 'Sử dụng `/memoryflip [số]` để lật thẻ (1-16)' },
        { name: 'Bảng chơi', value: board }
      )
      .setFooter({ text: `Game ID: ${gameId}` })
      .setTimestamp()]
  });
  
  stats.gamesPlayed++;
}

async function handleTicTacToe(interaction, { activeGames, stats }) {
  const gameId = `tictactoe_${interaction.user.id}_${Date.now()}`;
  
  activeGames.set(gameId, {
    type: 'tictactoe',
    board: Array(9).fill(''),
    currentPlayer: 'X',
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    createdAt: Date.now()
  });
  
  // Create the game board
  let boardDisplay = '';
  for (let i = 0; i < 9; i++) {
    if (i % 3 === 0 && i > 0) boardDisplay += '\n';
    boardDisplay += `${i + 1} `;
  }
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('tictactoe_1')
        .setLabel('1')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('tictactoe_2')
        .setLabel('2')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('tictactoe_3')
        .setLabel('3')
        .setStyle(ButtonStyle.Secondary)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('tictactoe_4')
        .setLabel('4')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('tictactoe_5')
        .setLabel('5')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('tictactoe_6')
        .setLabel('6')
        .setStyle(ButtonStyle.Secondary)
    );
  
  const row3 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('tictactoe_7')
        .setLabel('7')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('tictactoe_8')
        .setLabel('8')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('tictactoe_9')
        .setLabel('9')
        .setStyle(ButtonStyle.Secondary)
    );
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('⭕ Tic Tac Toe')
      .setDescription('Chơi cờ ca-rô với bot!')
      .addFields(
        { name: 'Cách chơi', value: 'Bạn là X, Bot là O. Nhấn vào các ô để đi.' },
        { name: 'Bảng chơi', value: boardDisplay }
      )
      .setFooter({ text: `Game ID: ${gameId}` })
      .setTimestamp()],
    components: [row, row2, row3]
  });
  
  stats.gamesPlayed++;
}

async function handleTrivia(interaction, { callOpenRouter, stats }) {
  const category = interaction.options.getString('category') || 'general';
  
  await interaction.deferReply();
  
  try {
    const triviaPrompt = [
      { role: 'system', content: `Tạo 1 câu hỏi trắc nghiệm về ${category} với 4 đáp án A, B, C, D. Format:\n🎯 Câu hỏi: [câu hỏi]\nA) ...\nB) ...\nC) ...\nD) ...\n\nĐáp án đúng: X\nGiải thích: ...` },
      { role: 'user', content: `Tạo câu hỏi về: ${category}` }
    ];

    const trivia = await callOpenRouter(triviaPrompt, { maxTokens: 400, temperature: 0.8 });

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('🧠 Trivia Quiz')
        .setDescription(trivia)
        .setFooter({ text: `Chủ đề: ${category} • /trivia [chủ đề] để tạo mới` })
        .setTimestamp()]
    });
    
    stats.gamesPlayed++;
  } catch (error) {
    console.error('Trivia error:', error);
    await interaction.editReply('❌ Lỗi tạo câu hỏi trivia!');
  }
}

async function handleHangman(interaction, { activeGames, stats }) {
  const words = {
    easy: ['CAT', 'DOG', 'SUN', 'MOON', 'STAR', 'TREE', 'BOOK', 'FISH', 'BIRD', 'HOME'],
    medium: ['HOUSE', 'WATER', 'PHONE', 'MUSIC', 'HAPPY', 'DREAM', 'LIGHT', 'NIGHT', 'CLOUD', 'BEACH'],
    hard: ['COMPUTER', 'ELEPHANT', 'BUTTERFLY', 'MOUNTAIN', 'KEYBOARD', 'RAINBOW', 'UNIVERSE', 'ADVENTURE', 'CHOCOLATE', 'TECHNOLOGY']
  };
  
  const difficulty = interaction.options.getString('difficulty') || 'medium';
  const wordList = words[difficulty] || words.medium;
  const word = wordList[Math.floor(Math.random() * wordList.length)];
  
  const gameId = `hangman_${interaction.user.id}_${Date.now()}`;
  
  activeGames.set(gameId, {
    type: 'hangman',
    word: word,
    guessedLetters: [],
    wrongGuesses: 0,
    maxWrongGuesses: 6,
    difficulty: difficulty,
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    createdAt: Date.now()
  });
  
  // Create the hangman display
  let display = '';
  for (const letter of word) {
    display += '_ ';
  }
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#E67E22')
      .setTitle('🎯 Hangman Game')
      .setDescription('Đoán từ bằng cách đoán từng chữ cái!')
      .addFields(
        { name: 'Từ', value: display },
        { name: 'Độ khó', value: difficulty, inline: true },
        { name: 'Lượt đoán sai', value: `0/6`, inline: true },
        { name: 'Cách chơi', value: 'Sử dụng `/hangmanguess [chữ cái]` để đoán chữ cái' }
      )
      .setFooter({ text: `Game ID: ${gameId}` })
      .setTimestamp()]
  });
  
  stats.gamesPlayed++;
}

async function handleConnect4(interaction, { activeGames, stats }) {
  const gameId = `connect4_${interaction.user.id}_${Date.now()}`;
  
  // Initialize a 7x6 grid (7 columns, 6 rows)
  const grid = Array(6).fill(null).map(() => Array(7).fill(''));
  
  activeGames.set(gameId, {
    type: 'connect4',
    grid: grid,
    currentPlayer: '🔴',
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    createdAt: Date.now()
  });
  
  // Create the game board display
  let boardDisplay = '';
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 7; col++) {
      boardDisplay += '⚪ ';
    }
    boardDisplay += '\n';
  }
  boardDisplay += '1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣';
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('connect4_1')
        .setLabel('1')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('connect4_2')
        .setLabel('2')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('connect4_3')
        .setLabel('3')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('connect4_4')
        .setLabel('4')
        .setStyle(ButtonStyle.Secondary)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('connect4_5')
        .setLabel('5')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('connect4_6')
        .setLabel('6')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('connect4_7')
        .setLabel('7')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('connect4_reset')
        .setLabel('Reset')
        .setStyle(ButtonStyle.Danger)
    );
  
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('🔴 Connect 4')
      .setDescription('Chơi Connect 4 với bot! Kết nối 4 quân cờ theo hàng ngang, dọc hoặc chéo để thắng.')
      .addFields(
        { name: 'Bảng chơi', value: boardDisplay },
        { name: 'Cách chơi', value: 'Bạn là 🔴, Bot là 🔵. Nhấn vào các cột để thả quân cờ.' }
      )
      .setFooter({ text: `Game ID: ${gameId}` })
      .setTimestamp()],
    components: [row, row2]
  });
  
  stats.gamesPlayed++;
}

async function handleWeather(interaction, { getUserProfile, getWeather }) {
  const location = interaction.options.getString('location') || getUserProfile(interaction.user.id).weatherLocation;
  
  await interaction.deferReply();
  
  try {
    const weatherData = await getWeather(location);
    
    const iconUrl = `http://openweathermap.org/img/wn/${weatherData.icon}@2x.png`;
    
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle(`🌤️ Thời tiết tại ${weatherData.location}, ${weatherData.country}`)
        .setThumbnail(iconUrl)
        .addFields(
          { name: '🌡 Nhiệt độ', value: `${weatherData.temperature}°C (cảm nhận ${weatherData.feelsLike}°C)`, inline: true },
          { name: '💧 Độ ẩm', value: `${weatherData.humidity}%`, inline: true },
          { name: '💨 Tốc độ gió', value: `${weatherData.windSpeed} m/s`, inline: true },
          { name: '☁️ Mô tả', value: weatherData.description, inline: false }
        )
        .setFooter({ text: `Cập nhật: ${new Date(weatherData.timestamp).toLocaleString('vi-VN')}` })
        .setTimestamp()]
    });
  } catch (error) {
    await interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleAdmin(interaction, { ADMIN_IDS, client, EmbedBuilder, ActivityType, conversationHistory }) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    return interaction.reply({
      content: '❌ Chỉ admin mới dùng được lệnh này!',
      flags: MessageFlags.Ephemeral
    });
  }
  
  const subcommand = interaction.options.getSubcommand();
  
  switch (subcommand) {
    case 'clearall':
      conversationHistory.clear();
      await interaction.reply('✅ Đã xóa tất cả lịch sử chat!');
      break;
      
    case 'broadcast':
      const message = interaction.options.getString('message');
      const broadcastEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('📢 Thông báo từ Admin')
        .setDescription(message)
        .setFooter({ text: 'Hein AI Bot' })
        .setTimestamp();

      let sentCount = 0;
      for (const guild of client.guilds.cache.values()) {
        const defaultChannel = guild.systemChannel || guild.channels.cache.find(
          channel => channel.type === 0 && channel.permissionsFor(guild.members.me).has('SendMessages')
        );
        
        if (defaultChannel) {
          try {
            await defaultChannel.send({ embeds: [broadcastEmbed] });
            sentCount++;
          } catch (error) {
            console.error(`Failed to broadcast to ${guild.name}:`, error);
          }
        }
      }

      await interaction.reply(`✅ Đã gửi broadcast đến ${sentCount} servers!`);
      break;
      
    case 'setstatus':
      const status = interaction.options.getString('status');
      client.user.setActivity(status, { type: ActivityType.Playing });
      await interaction.reply(`✅ Đã đổi status: **${status}**`);
      break;
  }
}

async function handleHelp(interaction) {
  const category = interaction.options.getString('category');
  
  if (!category) {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('📚 Hướng dẫn Hein AI Bot')
        .setDescription('Bot AI đa năng với nhiều tính năng mạnh mẽ')
        .addFields(
          { name: '💬 AI Chat', value: '`/chat` - Chat với AI Hein' },
          { name: '🎨 Tạo ảnh', value: '`/image` - Tạo ảnh bằng AI\n`/imagine` - Tạo 4 phiên bản' },
          { name: '👤 Hồ sơ & Thống kê', value: '`/profile` - Xem profile\n`/leaderboard` - Bảng xếp hạng\n`/stats` - Thống kê bot' },
          { name: '🔧 Tiện ích', value: '`/translate` - Dịch văn bản\n`/summary` - Tóm tắt\n`/code` - Tạo code' },
          { name: '🎮 Giải trí', value: '`/quiz` - Câu hỏi trắc nghiệm\n`/joke` - Chuyện cười\n`/rps` - Oẳn tù tì' },
          { name: '🎮 Trò chơi mới', value: '`/memory` - Game nhớ\n`/tictactoe` - Cờ ca-rô\n`/trivia` - Đố vui\n`/hangman` - Treo cổ\n`/connect4` - Connect 4' },
          { name: '🌤️ Thời tiết', value: '`/weather` - Xem thông tin thời tiết' },
          { name: '⚙️ Cài đặt', value: '`/personality` - Đổi personality\n`/reset` - Xóa lịch sử' }
        )
        .setFooter({ text: 'Sử dụng /help [danh mục] để xem chi tiết' })
        .setTimestamp()]
    });
    return;
  }
  
  let helpEmbed;
  
  switch (category) {
    case 'ai':
      helpEmbed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('💬 AI Chat Commands')
        .setDescription('Các lệnh để trò chuyện với AI Hein')
        .addFields(
          { name: '`/chat [message]`', value: 'Trò chuyện với AI Hein' },
          { name: '`/personality [type]`', value: 'Chọn personality cho AI (default, creative, teacher, coder, funny)' },
          { name: '`/reset`', value: 'Xóa lịch sử hội thoại' }
        )
        .setTimestamp();
      break;
      
    case 'image':
      helpEmbed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('🎨 Image Generation Commands')
        .setDescription('Các lệnh tạo ảnh bằng AI')
        .addFields(
          { name: '`/image [prompt] [style]`', value: 'Tạo ảnh theo mô tả và phong cách' },
          { name: '`/imagine [prompt]`', value: 'Tạo 4 phiên bản ảnh khác nhau' }
        )
        .addFields(
          { name: 'Các style có sẵn', value: 'realistic, anime, cartoon, artistic, cyberpunk, fantasy' }
        )
        .setTimestamp();
      break;
      
    case 'profile':
      helpEmbed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('👤 Profile & Stats Commands')
        .setDescription('Các lệnh xem thông tin cá nhân và thống kê')
        .addFields(
          { name: '`/profile`', value: 'Xem profile của bạn' },
          { name: '`/leaderboard`', value: 'Xem bảng xếp hạng người dùng' },
          { name: '`/stats`', value: 'Xem thống kê bot chi tiết' }
        )
        .setTimestamp();
      break;
      
    case 'utility':
      helpEmbed = new EmbedBuilder()
        .setColor('#E67E22')
        .setTitle('🔧 Utility Commands')
        .setDescription('Các lệnh tiện ích hữu ích')
        .addFields(
          { name: '`/translate [text]`', value: 'Dịch văn bản Anh ↔ Việt' },
          { name: '`/summary [text]`', value: 'Tóm tắt văn bản dài' },
          { name: '`/code [request]`', value: 'Tạo code theo yêu cầu' },
          { name: '`/remind [time] [message]`', value: 'Đặt lời nhắc' }
        )
        .setTimestamp();
      break;
      
    case 'fun':
      helpEmbed = new EmbedBuilder()
        .setColor('#F39C12')
        .setTitle('🎮 Fun Commands')
        .setDescription('Các lệnh giải trí')
        .addFields(
          { name: '`/quiz [topic]`', value: 'Tạo câu hỏi trắc nghiệm' },
          { name: '`/joke`', value: 'Nghe một câu chuyện cười' },
          { name: '`/fact`', value: 'Xem một sự thật thú vị' },
          { name: '`/roll [sides]`', value: 'Tung xúc xắc' },
          { name: '`/flip`', value: 'Tung đồng xu' },
          { name: '`/rps [choice]`', value: 'Chơi oẳn tù tì' },
          { name: '`/numberguess`', value: 'Chơi game đoán số' },
          { name: '`/wordle`', value: 'Chơi game Wordle' }
        )
        .setTimestamp();
      break;
      
    case 'games':
      helpEmbed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('🎮 Game Commands')
        .setDescription('Các lệnh chơi game')
        .addFields(
          { name: '`/memory`', value: 'Game nhớ - Tìm các cặp emoji giống nhau' },
          { name: '`/tictactoe`', value: 'Cờ ca-rô - Chơi với bot' },
          { name: '`/trivia [category]`', value: 'Đố vui - Trả lời câu hỏi kiến thức' },
          { name: '`/hangman [difficulty]`', value: 'Treo cổ - Đoán từ từng chữ cái' },
          { name: '`/connect4`', value: 'Connect 4 - Kết nối 4 quân cờ để thắng' }
        )
        .addFields(
          { name: 'Lệnh hỗ trợ game', value: '`/memoryflip [số]` - Lật thẻ game nhớ\n`/hangmanguess [chữ]` - Đoán chữ cái trong game treo cổ' }
        )
        .setTimestamp();
      break;
      
    case 'admin':
      helpEmbed = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('⚙️ Admin Commands')
        .setDescription('Các lệnh dành cho admin')
        .addFields(
          { name: '`/admin clearall`', value: 'Xóa tất cả lịch sử dùng chat' },
          { name: '`/admin broadcast [message]`', value: 'Gửi thông báo toàn bot' },
          { name: '`/admin setstatus [status]`', value: 'Đổi status bot' }
        )
        .setTimestamp();
      break;
      
    default:
      helpEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setTitle('❓ Không tìm thấy danh mục')
        .setDescription('Danh mục không tồn tại. Vui lòng thử lại.');
      break;
  }
  
  await interaction.reply({ embeds: [helpEmbed] });
}

async function handleGuessCommand(message, { activeGames }) {
  const guessValue = message.content.substring(7).trim();
  const guess = parseInt(guessValue);
  
  if (isNaN(guess) || guess < 1 || guess > 100) {
    return message.reply('❌ Vui lòng nhập một số từ 1-100!');
  }
  
  // Find active game for this user
  let gameFound = false;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.type === 'numberguess' && game.userId === message.author.id && game.channelId === message.channel.id) {
      game.attempts++;
      
      let result;
      if (guess === game.number) {
        result = `🎉 Chính xác! Số là ${game.number}! Bạn đã đoán đúng sau ${game.attempts} lần!`;
        activeGames.delete(gameId);
      } else if (guess < game.number) {
        result = `📈 Số ${guess} quá thấp!`;
      } else {
        result = `📉 Số ${guess} quá cao!`;
      }
      
      if (game.attempts >= game.maxAttempts && guess !== game.number) {
        result += `\n\n❌ Hết lượt đoán! Số đúng là ${game.number}.`;
        activeGames.delete(gameId);
      } else if (guess !== game.number) {
        result += ` Bạn còn ${game.maxAttempts - game.attempts} lượt.`;
      }
      
      await message.reply(result);
      gameFound = true;
      break;
    }
  }
  
  if (!gameFound) {
    await message.reply('❌ Bạn chưa bắt đầu game đoán số! Sử dụng `/numberguess` để bắt đầu.');
  }
}

async function handleWordleGuessCommand(message, { activeGames }) {
  const guess = message.content.substring(13).trim().toUpperCase();
  
  if (guess.length !== 5 || !/^[A-Z]+$/.test(guess)) {
    return message.reply('❌ Vui lòng nhập một từ tiếng Anh 5 chữ cái!');
  }
  
  // Find active game for this user
  let gameFound = false;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.type === 'wordle' && game.userId === message.author.id && game.channelId === message.channel.id) {
      game.attempts.push(guess);
      
      // Check guess against word
      let result = '';
      let correctCount = 0;
      
      for (let i = 0; i < 5; i++) {
        if (guess[i] === game.word[i]) {
          result += '🟩';
          correctCount++;
        } else if (game.word.includes(guess[i])) {
          result += '🟨';
        } else {
          result += '⬛';
        }
      }
      
      const attemptsText = game.attempts.map(a => {
        let res = '';
        for (let i = 0; i < 5; i++) {
          if (a[i] === game.word[i]) {
            res += '🟩';
          } else if (game.word.includes(a[i])) {
            res += '🟨';
          } else {
            res += '⬛';
          }
        }
        return `${a} ${res}`;
      }).join('\n');
      
      let response = `**${guess} ${result}\n\n${attemptsText}`;
      
      if (correctCount === 5) {
        response += `\n\n🎉 Chúc mừng! Bạn đã đoán đúng từ **${game.word}** sau ${game.attempts.length} lần!`;
        activeGames.delete(gameId);
      } else if (game.attempts.length >= game.maxAttempts) {
        response += `\n\n❌ Hết lượt đoán! Từ đúng là **${game.word}**.`;
        activeGames.delete(gameId);
      } else {
        response += `\n\nBạn còn ${game.maxAttempts - game.attempts.length} lượt.`;
      }
      
      await message.reply(response);
      gameFound = true;
      break;
    }
  }
  
  if (!gameFound) {
    await message.reply('❌ Bạn chưa bắt đầu game Wordle! Sử dụng `/wordle` để bắt đầu.');
  }
}

// NEW GAME COMMAND HANDLERS
async function handleMemoryFlipCommand(message, { activeGames }) {
  const cardIndex = parseInt(message.content.substring(13).trim()) - 1;
  
  if (isNaN(cardIndex) || cardIndex < 0 || cardIndex > 15) {
    return message.reply('❌ Vui lòng nhập một số từ 1-16!');
  }
  
  // Find active game for this user
  let gameFound = false;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.type === 'memory' && game.userId === message.author.id && game.channelId === message.channel.id) {
      if (game.revealed[cardIndex] || game.matched[cardIndex]) {
        return message.reply('❌ Thẻ này đã được lật!');
      }
      
      // Reveal the card
      game.revealed[cardIndex] = true;
      game.attempts++;
      
      // Check if there's another revealed card
      let revealedIndex = -1;
      for (let i = 0; i < 16; i++) {
        if (i !== cardIndex && game.revealed[i] && !game.matched[i]) {
          revealedIndex = i;
          break;
        }
      }
      
      // Create the game board
      let board = '';
      for (let i = 0; i < 16; i++) {
        if (i % 4 === 0) board += '\n';
        if (game.matched[i]) {
          board += `||${game.cards[i]}|| `;
        } else if (game.revealed[i]) {
          board += `${game.cards[i]} `;
        } else {
          board += '||❓|| ';
        }
      }
      
      if (revealedIndex === -1) {
        // First card revealed
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('🧠 Memory Game')
            .setDescription('Lật một thẻ khác để tìm cặp!')
            .addFields(
              { name: 'Bảng chơi', value: board },
              { name: 'Lượt lật', value: `${game.attempts}` }
            )
            .setFooter({ text: `Game ID: ${gameId}` })
            .setTimestamp()]
        });
      } else {
        // Second card revealed, check for match
        if (game.cards[cardIndex] === game.cards[revealedIndex]) {
          // Match found
          game.matched[cardIndex] = true;
          game.matched[revealedIndex] = true;
          
          // Check if all cards are matched
          let allMatched = true;
          for (let i = 0; i < 16; i++) {
            if (!game.matched[i]) {
              allMatched = false;
              break;
            }
          }
          
          if (allMatched) {
            activeGames.delete(gameId);
            await message.reply({
              embeds: [new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🎉 Memory Game - Bạn thắng!')
                .setDescription(`Chúc mừng! Bạn đã tìm tất cả các cặp sau ${game.attempts} lượt lật!`)
                .addFields(
                  { name: 'Bảng chơi hoàn thành', value: board }
                )
                .setTimestamp()]
            });
          } else {
            await message.reply({
              embeds: [new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🧠 Memory Game - Tìm thấy cặp!')
                .setDescription('Tiếp tục tìm các cặp còn lại!')
                .addFields(
                  { name: 'Bảng chơi', value: board },
                  { name: 'Lượt lật', value: `${game.attempts}` }
                )
                .setFooter({ text: `Game ID: ${gameId}` })
                .setTimestamp()]
            });
          }
        } else {
          // No match
          await message.reply({
            embeds: [new EmbedBuilder()
              .setColor('#FF0000')
              .setTitle('🧠 Memory Game - Không khớp!')
              .setDescription('Hai thẻ không giống nhau. Thử lại!')
              .addFields(
                { name: 'Bảng chơi', value: board },
                { name: 'Lượt lật', value: `${game.attempts}` }
              )
              .setFooter({ text: `Game ID: ${gameId}` })
              .setTimestamp()]
          });
          
          // Hide the cards after a delay
          setTimeout(() => {
            game.revealed[cardIndex] = false;
            game.revealed[revealedIndex] = false;
          }, 2000);
        }
      }
      
      gameFound = true;
      break;
    }
  }
  
  if (!gameFound) {
    await message.reply('❌ Bạn chưa bắt đầu game Memory! Sử dụng `/memory` để bắt đầu.');
  }
}

async function handleHangmanGuessCommand(message, { activeGames }) {
  const letter = message.content.substring(16).trim().toUpperCase();
  
  if (!/^[A-Z]$/.test(letter)) {
    return message.reply('❌ Vui lòng nhập một chữ cái từ A-Z!');
  }
  
  // Find active game for this user
  let gameFound = false;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.type === 'hangman' && game.userId === message.author.id && game.channelId === message.channel.id) {
      if (game.guessedLetters.includes(letter)) {
        return message.reply('❌ Bạn đã đoán chữ cái này rồi!');
      }
      
      game.guessedLetters.push(letter);
      
      // Check if the letter is in the word
      let found = false;
      let display = '';
      for (const char of game.word) {
        if (char === letter) {
          display += `${char} `;
          found = true;
        } else if (game.guessedLetters.includes(char)) {
          display += `${char} `;
        } else {
          display += '_ ';
        }
      }
      
      if (!found) {
        game.wrongGuesses++;
      }
      
      // Create the hangman display based on wrong guesses
      let hangmanDisplay = '';
      if (game.wrongGuesses >= 1) hangmanDisplay += '```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========\n```';
      if (game.wrongGuesses >= 2) hangmanDisplay = '```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========\n```';
      if (game.wrongGuesses >= 3) hangmanDisplay = '```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========\n```';
      if (game.wrongGuesses >= 4) hangmanDisplay = '```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========\n```';
      if (game.wrongGuesses >= 5) hangmanDisplay = '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========\n```';
      if (game.wrongGuesses >= 6) hangmanDisplay = '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========\n```';
      
      // Check if the word is complete or if the player lost
      let gameStatus = '';
      if (!display.includes('_')) {
        gameStatus = `🎉 Chúc mừng! Bạn đã đoán đúng từ **${game.word}**!`;
        activeGames.delete(gameId);
      } else if (game.wrongGuesses >= game.maxWrongGuesses) {
        gameStatus = `❌ Bạn đã thua! Từ đúng là **${game.word}**.`;
        activeGames.delete(gameId);
      } else {
        gameStatus = `Bạn còn ${game.maxWrongGuesses - game.wrongGuesses} lượt đoán sai.`;
      }
      
      await message.reply({
        embeds: [new EmbedBuilder()
          .setColor('#E67E22')
          .setTitle('🎯 Hangman Game')
          .setDescription(gameStatus)
          .addFields(
            { name: 'Từ', value: display },
            { name: 'Chữ cái đã đoán', value: game.guessedLetters.join(', ') || 'Chưa có' },
            { name: 'Lượt đoán sai', value: `${game.wrongGuesses}/${game.maxWrongGuesses}`, inline: true },
            { name: 'Độ khó', value: game.difficulty, inline: true }
          )
          .addFields(
            { name: 'Hình ảnh', value: hangmanDisplay }
          )
          .setFooter({ text: `Game ID: ${gameId}` })
          .setTimestamp()]
      });
      
      gameFound = true;
      break;
    }
  }
  
  if (!gameFound) {
    await message.reply('❌ Bạn chưa bắt đầu game Hangman! Sử dụng `/hangman` để bắt đầu.');
  }
}

// Handle button interactions for games
async function handleButtonInteraction(interaction, { activeGames }) {
  const customId = interaction.customId;
  
  if (customId.startsWith('tictactoe_')) {
    const position = parseInt(customId.split('_')[1]) - 1;
    
    // Find active game for this user
    for (const [gameId, game] of activeGames.entries()) {
      if (game.type === 'tictactoe' && game.userId === interaction.user.id && game.channelId === interaction.channel.id) {
        if (game.board[position] !== '') {
          return interaction.reply({
            content: '❌ Ô này đã được đánh!',
            flags: MessageFlags.Ephemeral
          });
        }
        
        // Player's move
        game.board[position] = 'X';
        
        // Check if player won
        if (checkWin(game.board, 'X')) {
          activeGames.delete(gameId);
          
          // Update the board display
          let boardDisplay = '';
          for (let i = 0; i < 9; i++) {
            if (i % 3 === 0 && i > 0) boardDisplay += '\n';
            boardDisplay += `${game.board[i] || (i + 1)} `;
          }
          
          await interaction.update({
            embeds: [new EmbedBuilder()
              .setColor('#00FF00')
              .setTitle('⭕ Tic Tac Toe - Bạn thắng!')
              .addFields(
                { name: 'Bảng chơi', value: boardDisplay }
              )
              .setTimestamp()],
            components: []
          });
          return;
        }
        
        // Check if draw
        if (!game.board.includes('')) {
          activeGames.delete(gameId);
          
          // Update the board display
          let boardDisplay = '';
          for (let i = 0; i < 9; i++) {
            if (i % 3 === 0 && i > 0) boardDisplay += '\n';
            boardDisplay += `${game.board[i] || (i + 1)} `;
          }
          
          await interaction.update({
            embeds: [new EmbedBuilder()
              .setColor('#FFD700')
              .setTitle('⭕ Tic Tac Toe - Hòa!')
              .addFields(
                { name: 'Bảng chơi', value: boardDisplay }
              )
              .setTimestamp()],
            components: []
          });
          return;
        }
        
        // Bot's move
        const availablePositions = [];
        for (let i = 0; i < 9; i++) {
          if (game.board[i] === '') {
            availablePositions.push(i);
          }
        }
        
        const botPosition = availablePositions[Math.floor(Math.random() * availablePositions.length)];
        game.board[botPosition] = 'O';
        
        // Check if bot won
        if (checkWin(game.board, 'O')) {
          activeGames.delete(gameId);
          
          // Update the board display
          let boardDisplay = '';
          for (let i = 0; i < 9; i++) {
            if (i % 3 === 0 && i > 0) boardDisplay += '\n';
            boardDisplay += `${game.board[i] || (i + 1)} `;
          }
          
          await interaction.update({
            embeds: [new EmbedBuilder()
              .setColor('#FF0000')
              .setTitle('⭕ Tic Tac Toe - Bot thắng!')
              .addFields(
                { name: 'Bảng chơi', value: boardDisplay }
              )
              .setTimestamp()],
            components: []
          });
          return;
        }
        
        // Check if draw
        if (!game.board.includes('')) {
          activeGames.delete(gameId);
          
          // Update the board display
          let boardDisplay = '';
          for (let i = 0; i < 9; i++) {
            if (i % 3 === 0 && i > 0) boardDisplay += '\n';
            boardDisplay += `${game.board[i] || (i + 1)} `;
          }
          
          await interaction.update({
            embeds: [new EmbedBuilder()
              .setColor('#FFD700')
              .setTitle('⭕ Tic Tac Toe - Hòa!')
              .addFields(
                { name: 'Bảng chơi', value: boardDisplay }
              )
              .setTimestamp()],
            components: []
          });
          return;
        }
        
        // Update the board display
        let boardDisplay = '';
        for (let i = 0; i < 9; i++) {
          if (i % 3 === 0 && i > 0) boardDisplay += '\n';
          boardDisplay += `${game.board[i] || (i + 1)} `;
        }
        
        // Update the buttons
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('tictactoe_1')
              .setLabel(game.board[0] || '1')
              .setStyle(game.board[0] ? (game.board[0] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[0] !== ''),
            new ButtonBuilder()
              .setCustomId('tictactoe_2')
              .setLabel(game.board[1] || '2')
              .setStyle(game.board[1] ? (game.board[1] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[1] !== ''),
            new ButtonBuilder()
              .setCustomId('tictactoe_3')
              .setLabel(game.board[2] || '3')
              .setStyle(game.board[2] ? (game.board[2] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[2] !== '')
          );
        
        const row2 = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('tictactoe_4')
              .setLabel(game.board[3] || '4')
              .setStyle(game.board[3] ? (game.board[3] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[3] !== ''),
            new ButtonBuilder()
              .setCustomId('tictactoe_5')
              .setLabel(game.board[4] || '5')
              .setStyle(game.board[4] ? (game.board[4] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[4] !== ''),
            new ButtonBuilder()
              .setCustomId('tictactoe_6')
              .setLabel(game.board[5] || '6')
              .setStyle(game.board[5] ? (game.board[5] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[5] !== '')
          );
        
        const row3 = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('tictactoe_7')
              .setLabel(game.board[6] || '7')
              .setStyle(game.board[6] ? (game.board[6] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[6] !== ''),
            new ButtonBuilder()
              .setCustomId('tictactoe_8')
              .setLabel(game.board[7] || '8')
              .setStyle(game.board[7] ? (game.board[7] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[7] !== ''),
            new ButtonBuilder()
              .setCustomId('tictactoe_9')
              .setLabel(game.board[8] || '9')
              .setStyle(game.board[8] ? (game.board[8] === 'X' ? ButtonStyle.Success : ButtonStyle.Danger) : ButtonStyle.Secondary)
              .setDisabled(game.board[8] !== '')
          );
        
        await interaction.update({
          embeds: [new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('⭕ Tic Tac Toe')
            .setDescription('Chơi cờ ca-rô với bot!')
            .addFields(
              { name: 'Bảng chơi', value: boardDisplay }
            )
            .setFooter({ text: `Game ID: ${gameId}` })
            .setTimestamp()],
          components: [row, row2, row3]
        });
        
        return;
      }
    }
    
    return interaction.reply({
      content: '❌ Bạn chưa bắt đầu game Tic Tac Toe! Sử dụng `/tictactoe` để bắt đầu.',
      flags: MessageFlags.Ephemeral
    });
  } else if (customId.startsWith('connect4_')) {
    const column = parseInt(customId.split('_')[1]) - 1;
    
    // Find active game for this user
    for (const [gameId, game] of activeGames.entries()) {
      if (game.type === 'connect4' && game.userId === interaction.user.id && game.channelId === interaction.channel.id) {
        if (column < 0 || column > 6) {
          return interaction.reply({
            content: '❌ Cột không hợp lệ!',
            flags: MessageFlags.Ephemeral
          });
        }
        
        // Find the lowest empty row in the column
        let row = -1;
        for (let r = 5; r >= 0; r--) {
          if (game.grid[r][column] === '') {
            row = r;
            break;
          }
        }
        
        if (row === -1) {
          return interaction.reply({
            content: '❌ Cột này đã đầy!',
            flags: MessageFlags.Ephemeral
          });
        }
        
        // Player's move
        game.grid[row][column] = '🔴';
        
        // Check if player won
        if (checkConnect4Win(game.grid, '🔴')) {
          activeGames.delete(gameId);
          
          // Update the board display
          let boardDisplay = '';
          for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 7; c++) {
              boardDisplay += game.grid[r][c] || '⚪ ';
            }
            boardDisplay += '\n';
          }
          boardDisplay += '1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣';
          
          await interaction.update({
            embeds: [new EmbedBuilder()
              .setColor('#00FF00')
              .setTitle('🔴 Connect 4 - Bạn thắng!')
              .addFields(
                { name: 'Bảng chơi', value: boardDisplay }
              )
              .setTimestamp()],
            components: []
          });
          return;
        }
        
        // Check if draw
        let isDraw = true;
        for (let c = 0; c < 7; c++) {
          if (game.grid[0][c] === '') {
            isDraw = false;
            break;
          }
        }
        
        if (isDraw) {
          activeGames.delete(gameId);
          
          // Update the board display
          let boardDisplay = '';
          for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 7; c++) {
              boardDisplay += game.grid[r][c] || '⚪ ';
            }
            boardDisplay += '\n';
