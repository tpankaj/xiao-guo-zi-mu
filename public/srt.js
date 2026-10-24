// Pure subtitle logic, shared by the page (via <script src="srt.js">) and the
// node:test suite. No DOM or window access in this file.

const TIMESTAMP_RE = /^\d{2}:\d{2}:\d{2},\d+ --> \d{2}:\d{2}:\d{2},\d+$/;
const TIMESTAMP_SIDE_RE = /^\d{1,3}:\d{2}:\d{2},\d+$/;

function parseSRT(content) {
  const blocks = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\n+/);
  const cues = {};
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    for (const line of lines) {
      if (TIMESTAMP_RE.test(line.trim())) {
        const ts = line.trim();
        cues[ts] = cues[ts] ? cues[ts] + '\n' + block.trim() : block.trim();
        break;
      }
    }
  }
  return cues;
}

function getTextLines(cue) {
  return cue.split('\n').filter(l =>
    !TIMESTAMP_RE.test(l.trim()) && !/^\d+$/.test(l.trim()) && l.trim()
  );
}

function formatTimestamp(ts) {
  if (typeof ts !== 'string') return '';
  const parts = ts.split(' --> ');
  if (parts.length !== 2) return ts;
  if (!TIMESTAMP_SIDE_RE.test(parts[0].trim()) || !TIMESTAMP_SIDE_RE.test(parts[1].trim())) return ts;
  function fmt(t) {
    const [hms] = t.split(',');
    const [hStr, mStr, sStr] = hms.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const s = parseInt(sStr, 10);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }
  return `${fmt(parts[0].trim())} → ${fmt(parts[1].trim())}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (!failed && next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TIMESTAMP_RE, parseSRT, getTextLines, formatTimestamp, escapeHtml, mapWithConcurrency };
}
