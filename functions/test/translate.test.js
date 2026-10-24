'use strict';
// Suite for the translate + verify Cloud Functions.
// Run: npm test (from functions/)
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  handlers, stubs, logged, clearLogs,
  makeReq, makeRes, chunkJson, entriesJson, stubFetch, okReply, errReply,
} = require('./helper');

const { translate, verify } = handlers;

function textData(text, extra = {}) {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text }],
    ...extra,
  };
}

beforeEach(() => {
  stubs.secrets = { ANTHROPIC_API_KEY: 'sk-test', ALLOWED_EMAILS: 'test@example.com' };
  stubs.authEmail = 'test@example.com';
  stubs.authError = null;
  global.fetch = async () => { throw new Error('fetch not stubbed'); };
  clearLogs();
});

describe('verify', () => {
  it('returns ok for an allowed user', async () => {
    const res = makeRes();
    await verify(makeReq({ body: {} }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('rejects non-POST', async () => {
    const res = makeRes();
    await verify(makeReq({ method: 'GET', body: {} }), res);
    assert.equal(res.statusCode, 405);
  });
});

describe('translate auth and validation', () => {
  it('rejects non-POST', async () => {
    stubFetch([okReply(textData('[]'))]);
    const res = makeRes();
    await translate(makeReq({ method: 'GET', body: {} }), res);
    assert.equal(res.statusCode, 405);
  });

  it('401 on missing token', async () => {
    stubFetch([okReply(textData('[]'))]);
    const res = makeRes();
    await translate(makeReq({ token: '', body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 401);
  });

  it('401 on invalid token', async () => {
    stubs.authError = new Error('bad token');
    stubFetch([okReply(textData('[]'))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 401);
  });

  it('403 for non-allowlisted email', async () => {
    stubs.authEmail = 'intruder@example.com';
    stubFetch([okReply(textData('[]'))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 403);
  });

  it('400 on missing srtChunk', async () => {
    const calls = stubFetch([okReply(textData('[]'))]);
    const res = makeRes();
    await translate(makeReq({ body: {} }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('400 on invalid srtChunk JSON', async () => {
    const calls = stubFetch([okReply(textData('[]'))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: 'not json' } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('413 on oversize srtChunk without calling the API', async () => {
    const calls = stubFetch([okReply(textData('[]'))]);
    const big = JSON.stringify({ entries: [{ id: 1, ts: 't', lines: ['x'.repeat(300 * 1024)] }] });
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: big } }), res);
    assert.equal(res.statusCode, 413);
    assert.equal(calls.length, 0);
  });
});

describe('translate happy path', () => {
  it('translates and echoes parsed entries', async () => {
    stubFetch([okReply(textData(entriesJson(1)))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body.text), JSON.parse(entriesJson(1)));
  });

  it('sends model, limits, effort and a cached system prompt', async () => {
    const calls = stubFetch([okReply(textData(entriesJson(2)))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(2) } }), res);
    assert.equal(res.statusCode, 200);
    const sent = calls[0].body;
    assert.equal(sent.model, 'claude-haiku-5-5');
    assert.equal(sent.max_tokens, 16000);
    assert.deepEqual(sent.output_config, { effort: 'low' });
    assert.ok(Array.isArray(sent.system) && sent.system.length > 0);
    const lastBlock = sent.system[sent.system.length - 1];
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' });
    assert.ok(calls[0].signal instanceof AbortSignal);
  });

  it('keeps the cached system prefix identical across chunks', async () => {
    const calls = stubFetch([
      okReply(textData(entriesJson(2))),
      okReply(textData(entriesJson(1))),
    ]);
    const res1 = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(2) } }), res1);
    const res2 = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res2);
    assert.equal(res1.statusCode, 200);
    assert.equal(res2.statusCode, 200);
    assert.deepEqual(calls[0].body.system, calls[1].body.system);
    assert.notDeepEqual(calls[0].body.messages, calls[1].body.messages);
  });

  it('parses thinking-first responses (adaptive thinking default)', async () => {
    stubFetch([okReply({
      ...textData(entriesJson(1)),
      content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: entriesJson(1) }],
    })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body.text), JSON.parse(entriesJson(1)));
  });

  it('strips markdown fences from the answer', async () => {
    stubFetch([okReply(textData('```json\n' + entriesJson(1) + '\n```'))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body.text), JSON.parse(entriesJson(1)));
  });

  it('logs token counts and cache performance on success', async () => {
    stubFetch([okReply({
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 600, cache_read_input_tokens: 400 },
      content: [{ type: 'text', text: entriesJson(1) }],
    })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 200);
    const okLog = logged.log.find((args) => args[0] === 'translate ok');
    assert.ok(okLog);
    assert.equal(okLog[1].inputTokens, 1000);
    assert.equal(okLog[1].outputTokens, 200);
    assert.equal(okLog[1].cacheCreation, 600);
    assert.equal(okLog[1].cacheRead, 400);
    assert.equal(okLog[1].cacheHit, true);
    assert.equal(okLog[1].cacheReadShare, 0.4);
  });

  it('logs a cache miss when nothing was served from cache', async () => {
    stubFetch([okReply(textData(entriesJson(1)))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 200);
    const okLog = logged.log.find((args) => args[0] === 'translate ok');
    assert.ok(okLog);
    assert.equal(okLog[1].cacheHit, false);
    assert.equal(okLog[1].cacheReadShare, 0);
  });
});

describe('translate model errors', () => {
  it('refusal short-circuits as non-retryable', async () => {
    stubFetch([okReply({ stop_reason: 'refusal', content: [] })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: 'Model declined the request', retryable: false });
  });

  it('rejects thinking-only responses', async () => {
    stubFetch([okReply({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }] })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
  });

  it('rejects missing content', async () => {
    stubFetch([okReply({ stop_reason: 'end_turn' })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
  });

  it('marks entry count mismatch retryable', async () => {
    stubFetch([okReply(textData(entriesJson(2)))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.retryable, true);
  });

  it('marks unparseable model JSON retryable', async () => {
    stubFetch([okReply(textData('definitely not json {{{'))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.retryable, true);
  });

  it('never logs full subtitle payloads', async () => {
    const canary = '霓虹深渊 sequester canary';
    stubFetch([okReply(textData(entriesJson(2)))]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1, canary) } }), res);
    assert.equal(res.statusCode, 502);
    const dumped = logged.error.map((args) => JSON.stringify(args)).join('\n')
      + logged.warn.map((args) => JSON.stringify(args)).join('\n');
    assert.ok(!dumped.includes(canary), 'subtitle text must not appear in logs');
  });
});

describe('translate upstream retries', () => {
  it('does not retry plain 400s and passes the message through', async () => {
    const calls = stubFetch([errReply(400, { error: { message: 'bad request' } })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, 'bad request');
    assert.equal(calls.length, 1);
  });

  it('retries 429 then succeeds', async () => {
    const calls = stubFetch([
      errReply(429, { error: { message: 'rate limited' } }),
      okReply(textData(entriesJson(1))),
    ]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
  });

  it('gives up after repeated 500s', async () => {
    const calls = stubFetch([errReply(500, { error: { message: 'overloaded' } })]);
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(calls.length, 3);
  });

  it('returns retryable 502 when fetch always throws', async () => {
    global.fetch = async () => { throw new Error('socket hang up'); };
    const res = makeRes();
    await translate(makeReq({ body: { srtChunk: chunkJson(1) } }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.retryable, true);
  });
});
