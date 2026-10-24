const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getAppCheck } = require('firebase-admin/app-check');

initializeApp();

const anthropicKey  = defineSecret('ANTHROPIC_API_KEY');
const allowedEmails = defineSecret('ALLOWED_EMAILS');

const MODEL = 'claude-haiku-5-5';
const MAX_CHUNK_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 60000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_TOKENS = 16000;

// Static instructions, identical for every chunk of every file, so the API
// can serve them from the prompt cache (Haiku 5.5 caches prefixes of 512+
// tokens for 5 minutes). Anything that varies per chunk — notably the entry
// count — must stay in the user message below, never in here.
const SYSTEM_PROMPT =
  'You are translating Chinese subtitle entries to English for SRT files.\n\n' +
  'Input JSON has three fields:\n' +
  '  "context_before" – entries immediately before this chunk (for context only, do not translate)\n' +
  '  "entries" – the entries you must translate; each has "id", "ts", and "lines"\n' +
  '  "context_after" – entries immediately after this chunk (for context only, do not translate)\n\n' +
  'Use context_before and context_after to resolve pronouns and sentences that continue ' +
  'across chunk boundaries, but do NOT include them in your output.\n\n' +
  'Translation rules:\n' +
  '- Write natural, fluent English that reads well as on-screen subtitles.\n' +
  '- Keep each entry to at most two short lines; split long lines at natural phrase breaks.\n' +
  '- Preserve the meaning, tone, and register of the original: formal speech stays formal, ' +
  'slang stays casual, jokes stay jokes.\n' +
  '- Translate idioms and chengyu by meaning, not word for word, unless a literal rendering is the joke.\n' +
  '- Transliterate proper names with standard English spellings and use the same spelling ' +
  'for a name in every entry.\n' +
  '- Keep honorifics and titles appropriate to the setting; do not add explanations of cultural terms.\n' +
  '- If a line is a sound effect or music cue in brackets or parentheses, translate it literally ' +
  'and keep the brackets.\n' +
  '- Keep on-screen text signs concise; translate what they say without describing the sign.\n' +
  '- Never merge or split entries: one input entry always produces exactly one output entry, ' +
  'even if the sentence continues.\n' +
  '- Do not add commentary, explanations, or content that is not in the original lines.\n\n' +
  'Consistency rules for multi-chunk files:\n' +
  '- The same Chinese word or phrase must be translated the same way in every entry.\n' +
  '- Match the tense and point of view established by surrounding entries.\n' +
  '- If context entries suggest a scene change, do not carry over assumptions from earlier lines.\n\n' +
  'Punctuation and formatting:\n' +
  '- Use standard English punctuation; convert full-width punctuation to half-width.\n' +
  '- Keep question marks and exclamation marks where the original has them; do not add them elsewhere.\n' +
  '- Do not use quotation marks around translated dialogue unless the original marks it as quoted speech.\n\n' +
  'Example input entry:\n' +
  '{"id": 7, "ts": "00:01:12,000 --> 00:01:14,500", "lines": ["你到底想怎么样？"]}\n\n' +
  'Example output entry:\n' +
  '{"id": 7, "ts": "00:01:12,000 --> 00:01:14,500", "lines": ["What do you actually want?"]}\n\n' +
  'A sentence split across two entries must still be translated entry by entry: "他说" / "他明天回来" ' +
  'becomes "He said" / "he will be back tomorrow".\n\n' +
  'Output: return ONLY a valid JSON array, one object per input entry. ' +
  'Keep every "id" and "ts" exactly as given. Replace each "lines" array with the English translation. ' +
  'Do not add, remove, merge, or reorder entries. ' +
  'The output must be valid JSON: no trailing commas, no markdown fences, no commentary.';

function usageInfo(usage = {}) {
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheHit: cacheRead > 0,
    cacheReadShare: input > 0 ? Math.round((cacheRead / input) * 100) / 100 : 0,
  };
}

// App Check enforcement: requests without a valid App Check token are
// rejected. (Was monitor-only while client token flow was verified live.)
const APPCHECK_ENFORCE = true;

async function checkAppCheck(req, res) {
  const token = req.headers['x-firebase-appcheck'];
  if (!token) {
    console.warn('appcheck: missing token', { enforce: APPCHECK_ENFORCE });
    if (APPCHECK_ENFORCE) { res.status(401).json({ error: 'Missing App Check token' }); return false; }
    return true;
  }
  try {
    const decoded = await getAppCheck().verifyToken(token);
    console.log('appcheck: valid token', { appId: decoded.appId });
    return true;
  } catch {
    console.warn('appcheck: invalid token', { enforce: APPCHECK_ENFORCE });
    if (APPCHECK_ENFORCE) { res.status(401).json({ error: 'Invalid App Check token' }); return false; }
    return true;
  }
}

async function verifyAndCheckAccess(req, res) {
  if (!await checkAppCheck(req, res)) return null;

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  if (!bearer) { res.status(401).json({ error: 'Missing token' }); return null; }

  let decoded;
  try {
    // checkRevoked=true so revoked/disabled users lose access immediately.
    decoded = await getAuth().verifyIdToken(bearer, true);
  } catch {
    res.status(401).json({ error: 'Invalid token' }); return null;
  }

  // Google-only: reject any other sign-in provider (e.g. email/password or
  // anonymous if ever enabled in the console) and unverified emails. Real
  // Google tokens always carry email_verified=true and provider google.com,
  // so legitimate Google sign-ins are unaffected.
  if (decoded.email_verified !== true || decoded.firebase?.sign_in_provider !== 'google.com') {
    res.status(403).json({ error: 'Access denied' }); return null;
  }

  const allowed = allowedEmails.value().split(',').map(e => e.trim().toLowerCase());
  if (!allowed.includes((decoded.email || '').toLowerCase())) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }

  return decoded;
}

async function callAnthropic(apiKey, body) {
  const maxAttempts = 3;
  let lastRes = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log('anthropic call', { attempt, model: body.model, chunkLength: body.messages[0].content.length });
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      console.error('anthropic retryable error', { attempt, status: res.status });
      lastRes = res;
    } catch (err) {
      console.error('anthropic request failed', { attempt, error: err && err.message });
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
  }
  if (lastRes) return lastRes;
  throw new Error('Anthropic API unreachable after retries');
}

exports.verify = onRequest(
  { secrets: [allowedEmails], timeoutSeconds: 10 },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const decoded = await verifyAndCheckAccess(req, res);
    if (decoded) res.json({ ok: true });
  },
);

exports.translate = onRequest(
  { secrets: [anthropicKey, allowedEmails], timeoutSeconds: 300 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const decoded = await verifyAndCheckAccess(req, res);
    if (!decoded) return;

    const { srtChunk } = req.body || {};
    if (typeof srtChunk !== 'string' || !srtChunk) {
      res.status(400).json({ error: 'Missing srtChunk' });
      return;
    }
    // Byte length, not string length: CJK text is ~3 bytes per char in UTF-8.
    if (Buffer.byteLength(srtChunk, 'utf8') > MAX_CHUNK_BYTES) {
      res.status(413).json({ error: 'srtChunk too large' });
      return;
    }

    let inputEntries;
    try {
      const parsedChunk = JSON.parse(srtChunk);
      if (!parsedChunk || !Array.isArray(parsedChunk.entries)) throw new Error('entries must be an array');
      inputEntries = parsedChunk.entries.length;
    } catch {
      res.status(400).json({ error: 'Invalid srtChunk JSON' });
      return;
    }

    console.log('translate request', { inputEntries, chunkLength: srtChunk.length, email: decoded.email });

    let anthropicRes;
    try {
      anthropicRes = await callAnthropic(anthropicKey.value(), {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        stream: false,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content:
            `Translate the ${inputEntries} entries in "entries" now. ` +
            `Return exactly ${inputEntries} objects.\n\n` +
            srtChunk,
        }],
      });
    } catch {
      res.status(502).json({ error: 'Upstream API unreachable', retryable: true });
      return;
    }

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('anthropic error', { status: anthropicRes.status, message: err.error?.message });
      res.status(502).json({ error: err.error?.message || 'Upstream API error' });
      return;
    }

    const data = await anthropicRes.json();

    if (data.stop_reason === 'refusal') {
      console.error('translate: model refused the request', { stopReason: data.stop_reason, ...usageInfo(data.usage) });
      res.status(502).json({ error: 'Model declined the request', retryable: false });
      return;
    }

    // Haiku 5.5 uses adaptive thinking by default, so the response can start
    // with thinking blocks. Select the text block by type, not position.
    const textBlock = Array.isArray(data.content)
      ? data.content.find((b) => b.type === 'text')
      : null;
    if (!textBlock || !textBlock.text) {
      console.error('Invalid response structure:', {
        stopReason: data.stop_reason,
        blockTypes: Array.isArray(data.content) ? data.content.map((b) => b.type) : null,
        ...usageInfo(data.usage),
      });
      res.status(502).json({ error: 'Invalid response from Anthropic API' });
      return;
    }

    const tokenInfo = usageInfo(data.usage);
    if (data.stop_reason === 'max_tokens' || data.usage?.output_tokens >= MAX_TOKENS) {
      console.warn('translate: output token limit reached, response likely truncated', tokenInfo);
    }

    const raw = textBlock.text.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/,(\s*[\]}])/g, '$1');
      try {
        parsed = JSON.parse(cleaned);
        console.warn('translate: fixed malformed JSON (trailing commas)', { ...tokenInfo, tail: raw.slice(-200) });
      } catch (e2) {
        console.error('translate: unparseable JSON from model', { ...tokenInfo, error: e2.message, rawLength: raw.length, rawTail: raw.slice(-200) });
        res.status(502).json({ error: 'Model returned invalid JSON', retryable: true });
        return;
      }
    }

    const outputEntries = Array.isArray(parsed) ? parsed.length : null;
    if (outputEntries !== inputEntries) {
      console.warn('translate: entry count mismatch', { inputEntries, outputEntries, ...tokenInfo, chunkLength: srtChunk.length, rawTail: raw.slice(-200) });
      res.status(502).json({ error: `Entry count mismatch: sent ${inputEntries}, got ${outputEntries}`, retryable: true });
      return;
    }

    console.log('translate ok', { inputEntries, outputEntries, ...tokenInfo });
    res.json({ text: JSON.stringify(parsed) });
  },
);
