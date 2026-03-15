# 小郭字幕

A browser-based tool for combining Chinese and English SRT subtitle files into a single file with Hanzi, Pinyin, and English on separate lines.

## What it does

Load a Chinese `.srt` and an English `.srt` with matching timestamps and the tool will:

- Match cues by timestamp and merge them into one file
- Generate Pinyin automatically from the Chinese text
- Let you choose any combination of Hanzi / Pinyin / English layers in the output
- Highlight cues where timestamps don't match between files, with navigation to jump directly to each problem
- Let you inline-edit any Chinese or English cue before downloading

## Usage

1. Open the page
2. Drop (or click to select) your Chinese `.srt` and English `.srt` files
3. Toggle which layers to include (汉字 / 拼音 / 英文)
4. Click **生成 / Generate / Générer**
5. Review the cue list, edit anything that needs fixing
6. Click **↓ Download .srt**

The UI is available in Chinese, English, and French.

## Privacy

All processing happens locally in your browser. No files are uploaded anywhere.

## License

MIT
