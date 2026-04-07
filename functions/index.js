const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

initializeApp();

const anthropicKey = defineSecret('ANTHROPIC_API_KEY');

exports.translate = onRequest(
  { secrets: [anthropicKey], timeoutSeconds: 300 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Verify Firebase ID token
    const bearer = (req.headers.authorization || '').replace('Bearer ', '');
    if (!bearer) {
      res.status(401).json({ error: 'Missing token' });
      return;
    }
    try {
      await getAuth().verifyIdToken(bearer);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { srtChunk } = req.body;
    if (!srtChunk) {
      res.status(400).json({ error: 'Missing srtChunk' });
      return;
    }

    // Call Anthropic with streaming
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey.value(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        stream: true,
        messages: [{
          role: 'user',
          content:
            'I have a subtitle file that is all in chinese. Make me an identical subtitle file ' +
            '(same timestamps, same meaning, etc) but translate everything to English. There should ' +
            'be zero Chinese left, and it should have exactly the same number of subtitle entries, ' +
            'with exactly matching timestamps\n\n' + srtChunk,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      res.status(502).json({ error: err.error?.message || 'Upstream API error' });
      return;
    }

    // Stream SSE back to the browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const part of parts) {
          if (part.startsWith('data: ') || part.startsWith('event: ') || part === '') {
            res.write(part + '\n');
          }
        }
      }
    } finally {
      res.end();
    }
  },
);
