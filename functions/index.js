const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

initializeApp();

const anthropicKey  = defineSecret('ANTHROPIC_API_KEY');
const allowedEmails = defineSecret('ALLOWED_EMAILS');

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

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey.value(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
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

    const data = await anthropicRes.json();
    res.json({ text: data.content[0].text });
  },
);
