require('dotenv').config();
const { callAI } = require('./ai-helper');
const { Bot, InlineKeyboard } = require('grammy');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const bot = new Bot(process.env.BOT_TOKEN);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(Number).filter(Boolean);

// User settings storage (in-memory, resets on restart)
const userSettings = {};

function getSettings(userId) {
  if (!userSettings[userId]) {
    userSettings[userId] = { style: 'detailed', lang: 'ru' };
  }
  return userSettings[userId];
}

// Middleware: check allowed users
bot.use(async (ctx, next) => {
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(ctx.from?.id)) {
    return ctx.reply('Доступ запрещён.');
  }
  await next();
});

// /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    '🧠 *Prompt Generator для Claude Code*\n\n' +
    'Отправь мне идею текстом или голосовым — я превращу её в детальный промпт для Claude Code.\n\n' +
    '*Команды:*\n' +
    '/style casual|detailed|minimal — уровень детализации\n' +
    '/lang ru|en — язык промпта\n\n' +
    'Просто напиши идею — и получишь готовый промпт.',
    { parse_mode: 'Markdown' }
  );
});

// /style
bot.command('style', async (ctx) => {
  const style = ctx.match?.trim();
  if (!['casual', 'detailed', 'minimal'].includes(style)) {
    return ctx.reply('Используй: /style casual|detailed|minimal');
  }
  getSettings(ctx.from.id).style = style;
  await ctx.reply(`Стиль установлен: *${style}*`, { parse_mode: 'Markdown' });
});

// /lang
bot.command('lang', async (ctx) => {
  const lang = ctx.match?.trim();
  if (!['ru', 'en'].includes(lang)) {
    return ctx.reply('Используй: /lang ru|en');
  }
  getSettings(ctx.from.id).lang = lang;
  await ctx.reply(`Язык промптов: *${lang}*`, { parse_mode: 'Markdown' });
});

// Handle callback for regenerate
bot.callbackQuery(/^regen:(.+)$/, async (ctx) => {
  const ideaHash = ctx.match[1];
  const stored = regenerateStore.get(ideaHash);
  if (!stored) {
    return ctx.answerCallbackQuery({ text: 'Идея устарела, отправь заново' });
  }
  await ctx.answerCallbackQuery({ text: '🔄 Генерирую другой вариант...' });
  const settings = getSettings(ctx.from.id);
  const prompt = await generatePrompt(stored.idea, settings, true);
  const keyboard = buildKeyboard(ideaHash);
  // Send as new message
  await sendPromptMessage(ctx, prompt, keyboard);
});

// Handle callback for copy (monospace)
bot.callbackQuery(/^copy:(.+)$/, async (ctx) => {
  const ideaHash = ctx.match[1];
  const stored = regenerateStore.get(ideaHash);
  if (!stored || !stored.lastPrompt) {
    return ctx.answerCallbackQuery({ text: 'Промпт устарел, сгенерируй заново' });
  }
  await ctx.answerCallbackQuery({ text: '📋 Отправляю для копирования...' });
  // Send as plain text in code block for easy copying
  const text = stored.lastPrompt;
  // Split if too long for one message
  if (text.length > 4000) {
    const chunks = splitText(text, 4000);
    for (const chunk of chunks) {
      await ctx.reply('```\n' + chunk + '\n```', { parse_mode: 'Markdown' });
    }
  } else {
    await ctx.reply('```\n' + text + '\n```', { parse_mode: 'Markdown' });
  }
});

// Store for regeneration (ideaHash -> { idea, lastPrompt })
const regenerateStore = new Map();

function hashIdea(idea) {
  let hash = 0;
  for (let i = 0; i < idea.length; i++) {
    const char = idea.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function buildKeyboard(ideaHash) {
  return new InlineKeyboard()
    .text('📋 Скопировать', `copy:${ideaHash}`)
    .text('🔄 Другой вариант', `regen:${ideaHash}`);
}

function splitText(text, maxLen) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLen) {
      chunks.push(text);
      break;
    }
    let splitAt = text.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(text.substring(0, splitAt));
    text = text.substring(splitAt);
  }
  return chunks;
}

// Voice message handling — transcribe via OpenAI Whisper
async function transcribeVoice(fileUrl) {
  // Download the voice file
  const response = await fetch(fileUrl);
  const buffer = await response.buffer();

  const tmpPath = path.join('/tmp', `voice_${Date.now()}.ogg`);
  fs.writeFileSync(tmpPath, buffer);

  // Send to OpenAI Whisper via manual multipart body
  const boundary = '----FormBoundary' + Date.now();
  const fileContent = fs.readFileSync(tmpPath);

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nru\r\n`),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  // Clean up
  try { fs.unlinkSync(tmpPath); } catch {}

  const result = await whisperResp.json();
  if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
  return result.text;
}

// Generate a structured Claude Code prompt from an idea.
// Primary path: multi-provider LLM via ai-helper (Groq -> GPT -> OpenRouter).
// Dead-last fallback: Gemini 2.5 Flash.
async function generatePrompt(idea, settings, alternative = false) {
  const styleMap = {
    casual: 'Пиши кратко и по делу, без лишних деталей. Только самое важное.',
    detailed: 'Пиши максимально детально. Каждый шаг расписан, все edge-кейсы учтены.',
    minimal: 'Минимум текста. Только структура и ключевые пункты, без объяснений.',
  };

  const langMap = {
    ru: 'Пиши на русском языке.',
    en: 'Write in English.',
  };

  const alternativeHint = alternative
    ? '\n\nВАЖНО: Предложи ДРУГОЙ подход к реализации. Другой стек, другая архитектура, другой способ решения. Не повторяй предыдущий вариант.'
    : '';

  const systemPrompt = `Ты — генератор промптов для Claude Code (AI-агент который пишет код на сервере).
Юзер присылает идею, ты превращаешь её в детальный, структурированный промпт.

${styleMap[settings.style]}
${langMap[settings.lang]}

Формат ответа — СТРОГО такой:

## Задача
[Чёткое описание что нужно построить]

## Требования
- [Конкретное требование 1]
- [Конкретное требование 2]
- ...

## Технический стек
- [Технология — почему именно она]

## Шаги реализации
1. [Шаг 1]
2. [Шаг 2]
...

## Важные детали
- [Edge cases, безопасность, обработка ошибок]

## Результат
[Что должно получиться в итоге]

Правила:
- Расширяй размытые идеи в конкретные требования
- Выбирай оптимальный стек для задачи
- Разбивай на мелкие выполнимые шаги
- Добавляй обработку ошибок и безопасность
- Промпт должен быть готов к вставке в Claude Code — копипаст и поехали
- Будь конкретным, а не общим. Никаких "и т.д." или "по аналогии"
- Указывай пути файлов, порты, конфиги — всё что нужно для реализации
${alternativeHint}`;

  const fullPrompt = `${systemPrompt}\n\nИдея пользователя:\n${idea}`;

  // Primary: ai-helper (Groq -> GPT -> OpenRouter)
  try {
    const result = await callAI(fullPrompt, { temperature: alternative ? 1.0 : 0.8, maxTokens: 4096 });
    if (result) return result;
  } catch (e) { /* fallback to Gemini */ }

  // Gemini as dead-last fallback
  if (!GEMINI_API_KEY) {
    throw new Error('All providers failed and no GEMINI_API_KEY configured');
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: fullPrompt }] }
      ],
      generationConfig: {
        temperature: alternative ? 1.0 : 0.8,
        maxOutputTokens: 4096,
      },
    }),
  });

  const data = await resp.json();

  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Пустой ответ от Gemini: ' + JSON.stringify(data).substring(0, 500));
  }

  return text;
}

async function sendPromptMessage(ctx, prompt, keyboard) {
  // Store last prompt for copy button
  const ideaHash = keyboard?.inline_keyboard?.[0]?.[0]?.callback_data?.split(':')?.[1];
  if (ideaHash) {
    const stored = regenerateStore.get(ideaHash);
    if (stored) stored.lastPrompt = prompt;
  }

  // Try sending with Markdown, fall back to plain text
  try {
    if (prompt.length > 4000) {
      const chunks = splitText(prompt, 4000);
      for (let i = 0; i < chunks.length; i++) {
        const kb = i === chunks.length - 1 ? keyboard : undefined;
        await ctx.reply(chunks[i], { parse_mode: 'Markdown', reply_markup: kb });
      }
    } else {
      await ctx.reply(prompt, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (e) {
    // Markdown parsing failed, send as plain text
    if (prompt.length > 4000) {
      const chunks = splitText(prompt, 4000);
      for (let i = 0; i < chunks.length; i++) {
        const kb = i === chunks.length - 1 ? keyboard : undefined;
        await ctx.reply(chunks[i], { reply_markup: kb });
      }
    } else {
      await ctx.reply(prompt, { reply_markup: keyboard });
    }
  }
}

// Handle voice messages
bot.on('message:voice', async (ctx) => {
  const statusMsg = await ctx.reply('🎤 Транскрибирую голосовое...');

  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const transcription = await transcribeVoice(fileUrl);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `🎤 Распознано: "${transcription}"\n\n⏳ Генерирую промпт...`);

    const settings = getSettings(ctx.from.id);
    const prompt = await generatePrompt(transcription, settings);
    const ideaHash = hashIdea(transcription);
    regenerateStore.set(ideaHash, { idea: transcription, lastPrompt: prompt });
    const keyboard = buildKeyboard(ideaHash);

    await sendPromptMessage(ctx, prompt, keyboard);
  } catch (err) {
    console.error('Voice error:', err);
    await ctx.reply(`Ошибка: ${err.message}`);
  }
});

// Handle text messages — generate prompt
bot.on('message:text', async (ctx) => {
  const idea = ctx.message.text;
  if (!idea || idea.startsWith('/')) return;

  const statusMsg = await ctx.reply('⏳ Генерирую промпт...');

  try {
    const settings = getSettings(ctx.from.id);
    const prompt = await generatePrompt(idea, settings);
    const ideaHash = hashIdea(idea);
    regenerateStore.set(ideaHash, { idea, lastPrompt: prompt });
    const keyboard = buildKeyboard(ideaHash);

    // Delete "generating" message
    try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}

    await sendPromptMessage(ctx, prompt, keyboard);
  } catch (err) {
    console.error('Generate error:', err);
    try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
    await ctx.reply(`Ошибка генерации: ${err.message}`);
  }
});

// Start
bot.start({
  onStart: () => console.log('Prompt Bot started'),
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
