# Prompt Bot

A Telegram bot that turns a rough idea — typed **or spoken** — into a clean, structured prompt ready to paste into an AI coding agent (Claude Code, Cursor, etc.).

Send it a one-line thought and it returns a fully fleshed-out spec: task, requirements, tech stack, step-by-step plan, edge cases, and expected result. Inline buttons let you copy the result or regenerate an alternative approach.

## Features

- **Text or voice input** — voice messages are transcribed with OpenAI Whisper (`whisper-1`) before processing.
- **Structured prompt generation** — expands vague ideas into a strict template (Task / Requirements / Stack / Steps / Details / Result).
- **Multi-provider LLM fallback** — a small self-contained `ai-helper` module tries **Groq → OpenAI → OpenRouter** in order, with Google **Gemini 2.5 Flash** as a dead-last fallback. A single provider outage never takes the bot down.
- **Inline keyboards** — one tap to copy the prompt as a code block, or to regenerate a different implementation approach.
- **Per-user settings** — adjustable detail level (`casual` / `detailed` / `minimal`) and output language (`ru` / `en`).
- **Allowlist access control** — restrict usage to specific Telegram user IDs via env.

## Architecture

```
bot.js         grammY bot: commands, voice/text handlers, inline keyboards, allowlist middleware
ai-helper.js   self-contained multi-provider LLM client (Groq -> OpenAI -> OpenRouter)
```

Prompt generation flow:

```
idea (text | voice) --> [Whisper transcription] --> generatePrompt()
   --> ai-helper.callAI()  (Groq -> OpenAI -> OpenRouter)
   --> Gemini 2.5 Flash    (fallback if all of the above fail)
   --> structured prompt + inline "copy / regenerate" keyboard
```

## Tech stack

- Node.js
- [grammY](https://grammy.dev/) — Telegram Bot framework
- OpenAI Whisper — voice transcription
- Groq / OpenAI / OpenRouter / Gemini — LLM providers

## Setup

```bash
npm install
cp .env.example .env   # then fill in your tokens/keys
npm start
```

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USERS` | Comma-separated Telegram user IDs (empty = open to all) |
| `GROQ_API_KEY` | Primary LLM provider (free tier) |
| `OPENAI_API_KEY` | Whisper transcription + LLM fallback |
| `OPENROUTER_API_KEY` | LLM fallback |
| `GEMINI_API_KEY` | Dead-last LLM fallback |

## Usage

- `/start` — intro and command list
- `/style casual|detailed|minimal` — set detail level
- `/lang ru|en` — set output language
- Send any text or voice message — receive a structured prompt

## License

MIT
