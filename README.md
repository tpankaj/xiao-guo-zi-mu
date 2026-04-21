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
- **Backend**: Firebase Cloud Function (`functions/index.js`) that proxies translation requests to the Anthropic API (Claude Haiku)
- **Auth**: Google OAuth via Firebase Authentication; only pre-approved email addresses can use the translation feature

Translation is done in chunks of 75 entries. The function validates the response is well-formed JSON with the correct entry count before returning it; the client retries failed chunks up to 3 times automatically.

## Development

```bash
npm install -g firebase-tools
firebase login
firebase serve          # local dev server
firebase deploy         # deploy functions + hosting
```

## Privacy

Subtitle text is sent to the Anthropic API for translation. Everything else (Pinyin generation, file parsing, merging, downloading) happens locally in your browser.

## License

MIT
