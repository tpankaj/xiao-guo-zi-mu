const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

initializeApp();

const anthropicKey  = defineSecret('ANTHROPIC_API_KEY');
const allowedEmails = defineSecret('ALLOWED_EMAILS');

const MODEL = 'claude-haiku-4-5-20251001';

async function verifyAndCheckAccess(req, res) {
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  if (!bearer) { res.status(401).json({ error: 'Missing token' }); return null; }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(bearer);
  } catch {
    res.status(401).json({ error: 'Invalid token' }); return null;
  }

  const allowed = allowedEmails.value().split(',').map(e => e.trim().toLowerCase());
  if (!allowed.includes((decoded.email || '').toLowerCase())) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }

  return decoded;
}

async function callAnthropic(apiKey, body) {
  const maxRetries = 3;
  let lastRes;
  for (let i = 0; i < maxRetries; i++) {
    console.log('anthropic call', { attempt: i + 1, model: body.model, chunkLength: body.messages[0].content.length });
    lastRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (lastRes.status !== 529) return lastRes;
    console.error('anthropic overloaded', { attempt: i + 1 });
    if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i)));
  }
  return lastRes;
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

    const { srtChunk } = req.body;
    if (!srtChunk) {
      res.status(400).json({ error: 'Missing srtChunk' });
      return;
    }

    let inputEntries;
    try {
      inputEntries = JSON.parse(srtChunk).entries.length;
    } catch {
      res.status(400).json({ error: 'Invalid srtChunk JSON' });
      return;
    }

    console.log('translate request', { inputEntries, chunkLength: srtChunk.length, email: decoded.email });

    const prompt =
      'You are translating Chinese subtitle entries to English.\n\n' +
      'Input JSON has three fields:\n' +
      '  "context_before" – entries immediately before this chunk (for context only, do not translate)\n' +
      '  "entries"        – the entries you must translate; each has "id", "ts", and "lines"\n' +
      '  "context_after"  – entries immediately after this chunk (for context only, do not translate)\n\n' +
      'Use context_before and context_after to understand sentences that continue across boundaries, ' +
      'but do NOT include them in your output.\n\n' +
      `Output: return ONLY a valid JSON array containing exactly ${inputEntries} objects — one per input entry. ` +
      'Keep every "id" and "ts" exactly as given. Replace each "lines" array with the English translation. ' +
      'Do not add, remove, merge, or reorder entries. ' +
      'The output must be valid JSON: no trailing commas, no markdown fences, no commentary.\n\n' +
      srtChunk;

    const anthropicRes = await callAnthropic(anthropicKey.value(), {
      model: MODEL,
      max_tokens: 8192,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('anthropic error', { status: anthropicRes.status, message: err.error?.message });
      res.status(502).json({ error: err.error?.message || 'Upstream API error' });
      return;
    }

    const data = await anthropicRes.json();

    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.error('Invalid response structure:', JSON.stringify(data));
      res.status(502).json({ error: 'Invalid response from Anthropic API' });
      return;
    }

    const tokenInfo = { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
    if (data.usage?.output_tokens >= 8192) {
      console.warn('translate: output token limit reached, response likely truncated', tokenInfo);
    }

    const raw = data.content[0].text.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/,(\s*[\]}])/g, '$1');
      try {
        parsed = JSON.parse(cleaned);
        console.warn('translate: fixed malformed JSON (trailing commas)', { ...tokenInfo, tail: raw.slice(-200) });
      } catch (e2) {
        console.error('translate: unparseable JSON from model', { ...tokenInfo, error: e2.message, raw });
        res.status(502).json({ error: 'Model returned invalid JSON', retryable: true });
        return;
      }
    }

    const outputEntries = Array.isArray(parsed) ? parsed.length : null;
    if (outputEntries !== inputEntries) {
      console.warn('translate: entry count mismatch', { inputEntries, outputEntries, ...tokenInfo, srtChunk, raw });
      res.status(502).json({ error: `Entry count mismatch: sent ${inputEntries}, got ${outputEntries}`, retryable: true });
      return;
    }

    console.log('translate ok', { inputEntries, outputEntries, ...tokenInfo });
    res.json({ text: JSON.stringify(parsed) });
  },
);
