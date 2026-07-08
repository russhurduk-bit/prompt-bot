/**
 * Universal AI helper — a small, self-contained multi-provider LLM client.
 *
 * Tries a chain of chat-completion providers in order and returns the first
 * successful response, so a single provider outage never takes the bot down:
 *
 *   1. Groq       (free, fast)      — with a short retry loop
 *   2. OpenAI     (gpt-4o-mini)
 *   3. OpenRouter (free Llama 3.3)
 *
 * All three speak the OpenAI chat-completions wire format, so one POST helper
 * covers every provider. Providers with no configured API key are skipped.
 *
 * Usage:
 *   const { callAI } = require('./ai-helper');
 *   const answer = await callAI('Translate: Hello world', { temperature: 0.2 });
 */
const https = require('https');

const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

function _post(hostname, path, headers, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          const text = json.choices?.[0]?.message?.content || '';
          if (!text && json.error) reject(new Error(json.error.message?.substring(0, 100) || 'API error'));
          else resolve(text);
        } catch (e) { reject(new Error('Parse: ' + buf.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function callAI(prompt, { temperature = 0.1, maxTokens = 4096, system = '' } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const errors = [];

  // 1. Groq (free) — with retry
  if (GROQ_KEY) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await _post('api.groq.com', '/openai/v1/chat/completions',
          { 'Authorization': `Bearer ${GROQ_KEY}` },
          { model: 'llama-3.1-8b-instant', messages, temperature, max_tokens: Math.min(maxTokens, 8192) }, 45000);
        if (r) return r;
      } catch (e) {
        errors.push(`Groq#${attempt}: ${e.message?.substring(0, 60)}`);
        if (attempt < 2) await new Promise(ok => setTimeout(ok, 1500));
      }
    }
  }

  // 2. GPT-4o-mini
  if (OPENAI_KEY) {
    try {
      const r = await _post('api.openai.com', '/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}` },
        { model: 'gpt-4o-mini', messages, temperature, max_tokens: maxTokens });
      if (r) return r;
    } catch (e) { errors.push(`OpenAI: ${e.message?.substring(0, 60)}`); }
  }

  // 3. OpenRouter (free)
  if (OPENROUTER_KEY) {
    try {
      const r = await _post('openrouter.ai', '/api/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENROUTER_KEY}` },
        { model: 'meta-llama/llama-3.3-70b-instruct:free', messages, temperature, max_tokens: maxTokens }, 60000);
      if (r) return r;
    } catch (e) { errors.push(`OpenRouter: ${e.message?.substring(0, 60)}`); }
  }

  throw new Error('All AI providers failed: ' + errors.join(' | '));
}

module.exports = { callAI };
