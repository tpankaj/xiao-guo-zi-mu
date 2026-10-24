# 小郭字幕

A browser-based tool for combining Chinese and English SRT subtitle files into a single file with Hanzi, Pinyin, and English on separate lines. Includes an AI-powered translation feature that can generate the English SRT automatically from a Chinese-only file.

## What it does

Load a Chinese `.srt` (and optionally an English `.srt`) and the tool will:

- Translate a Chinese-only file to English automatically using Claude AI
- Match cues by timestamp and merge them into one file
- Generate Pinyin automatically from the Chinese text
- Let you choose any combination of Hanzi / Pinyin / English layers in the output
- Highlight cues where timestamps don't match between files, with navigation to jump directly to each problem
- Let you inline-edit any Chinese or English cue before downloading

The UI is available in Chinese, English, and French.

## Usage

### Translate + combine (one file)

1. Open the page and sign in with Google
2. Drop your Chinese `.srt` file
3. Click **翻译成英文 / Translate to English** — the tool will call Claude AI to translate in chunks and populate the English track automatically
4. Toggle which layers to include (汉字 / 拼音 / 英文)
5. Click **生成 / Generate**
6. Review the cue list, edit anything that needs fixing
7. Click **↓ Download .srt**

### Combine two existing files

1. Drop your Chinese `.srt` and English `.srt` files
2. Follow steps 4–7 above

## Architecture

- **Frontend**: single-page app (`public/index.html`), hosted on Firebase Hosting
- **Backend**: Firebase Cloud Function (`functions/index.js`) that proxies translation requests to the Anthropic API (Claude Haiku 5.5)
- **Auth**: Google OAuth via Firebase Authentication; only pre-approved email addresses can use the translation feature

Translation is done in chunks of 75 entries. Static instructions are sent as a cached system prompt (Anthropic prompt caching, 5-minute TTL), so repeat chunks in a file read from cache at ~10% of input cost; only the per-chunk entries travel in the user message. The function validates the response is well-formed JSON with the correct entry count before returning it; the client retries failed chunks up to 3 times automatically. Upstream 429/5xx errors are retried server-side with backoff, and oversize chunks are rejected with 413. Every translate outcome logs input/output token counts plus cache performance (cache hit flag and share of input served from cache). For debugging, Cloud logs also record the requester's email on each translate request and, only when the model's reply fails to parse or has the wrong entry count, the last up to 200 characters of that reply — which may contain a short fragment of translated subtitle text. Full subtitle files are not logged.

## Development

```bash
npm install -g firebase-tools
firebase login
(cd functions && npm test)    # backend test suite (node:test, no network)
firebase serve          # local dev server
firebase deploy         # deploy functions + hosting
```

## Privacy

Subtitle text is sent to the Anthropic API for translation. Everything else (Pinyin generation, file parsing, merging, downloading) happens locally in your browser. On the server, translate requests are logged with the requester's email and token/cache metrics; if a model reply fails to parse or has the wrong entry count, its last up to 200 characters are also logged for debugging, which may include a short fragment of translated text (see Architecture). Full subtitle files are not logged.

## License

MIT
