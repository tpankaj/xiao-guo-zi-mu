'use strict';
// Loads the real functions/index.js with Firebase/Admin SDKs stubbed out,
// so the HTTPS handlers run in-process with no credentials or network.
// Handler console output is captured in `logged` (silenced from test output).
const Module = require('module');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');

const logged = { log: [], warn: [], error: [] };
for (const level of Object.keys(logged)) {
  console[level] = (...args) => { logged[level].push(args); };
}
function clearLogs() {
  for (const key of Object.keys(logged)) logged[key] = [];
}

const stubs = {
  secrets: { ANTHROPIC_API_KEY: 'sk-test', ALLOWED_EMAILS: 'test@example.com' },
  authEmail: 'test@example.com',
  authError: null,
  // Shape of a real Google token: verified email + google.com provider.
  authEmailVerified: true,
  authProvider: 'google.com',
  verifyArgs: null,
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-functions/v2/https') {
    return { onRequest: (opts, fn) => fn };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: (name) => ({ value: () => stubs.secrets[name] }) };
  }
  if (request === 'firebase-admin/app') {
    return { initializeApp: () => ({}) };
  }
  if (request === 'firebase-admin/auth') {
    return {
      getAuth: () => ({
        verifyIdToken: async (...args) => {
          stubs.verifyArgs = args;
          if (stubs.authError) throw stubs.authError;
          return {
            email: stubs.authEmail,
            email_verified: stubs.authEmailVerified,
            firebase: { sign_in_provider: stubs.authProvider },
          };
        },
      }),
    };
  }
  return origLoad.call(this, request, ...rest);
};

const handlers = require(INDEX_PATH);

function makeReq({ method = 'POST', token = 'Bearer test-token', body = {} } = {}) {
  return { method, headers: { authorization: token }, body };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

function chunkJson(n, canary = '你好') {
  const entries = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ts: `00:00:${String(i + 1).padStart(2, '0')},000 --> 00:00:${String(i + 2).padStart(2, '0')},000`,
    lines: [`${canary}${i}`],
  }));
  return JSON.stringify({ context_before: [], entries, context_after: [] });
}

function entriesJson(n) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ts: `00:00:${String(i + 1).padStart(2, '0')},000 --> 00:00:${String(i + 2).padStart(2, '0')},000`,
    lines: [`Hello ${i}`],
  })));
}

// Stubs global.fetch with a reply sequence (last reply repeats).
// Returns the captured request bodies.
function stubFetch(replies) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), signal: opts.signal });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof next === 'function' ? next(calls.length) : next;
  };
  return calls;
}

const okReply = (data) => ({ ok: true, status: 200, json: async () => data });
const errReply = (status, data = {}) => ({ ok: false, status, json: async () => data });

module.exports = {
  handlers, stubs, logged, clearLogs,
  makeReq, makeRes, chunkJson, entriesJson, stubFetch, okReply, errReply,
};
