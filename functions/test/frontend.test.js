'use strict';
// Suite for the pure subtitle logic in public/srt.js (no DOM needed).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSRT, getTextLines, formatTimestamp, escapeHtml, mapWithConcurrency,
} = require('../../public/srt.js');

const TS1 = '00:00:01,000 --> 00:00:02,000';
const TS2 = '00:01:12,000 --> 00:01:14,500';

describe('parseSRT', () => {
  it('parses cues keyed by timestamp', () => {
    const cues = parseSRT(`1\n${TS1}\n你好\n\n2\n${TS2}\n世界\n`);
    assert.deepEqual(Object.keys(cues), [TS1, TS2]);
    assert.deepEqual(getTextLines(cues[TS1]), ['你好']);
  });

  it('handles CRLF line endings', () => {
    const cues = parseSRT(`1\r\n${TS1}\r\n你好\r\n`);
    assert.deepEqual(getTextLines(cues[TS1]), ['你好']);
  });

  it('skips blocks without a timestamp', () => {
    const cues = parseSRT(`NOTE just a comment\n\n1\n${TS1}\n你好\n`);
    assert.deepEqual(Object.keys(cues), [TS1]);
  });

  it('merges duplicate timestamps instead of dropping cues', () => {
    const cues = parseSRT(`1\n${TS1}\n第一行\n\n2\n${TS1}\n第二行\n`);
    assert.deepEqual(Object.keys(cues), [TS1]);
    assert.deepEqual(getTextLines(cues[TS1]), ['第一行', '第二行']);
  });

  it('returns {} for empty input', () => {
    assert.deepEqual(parseSRT(''), {});
  });
});

describe('getTextLines', () => {
  it('strips sequence numbers, timestamps and blanks', () => {
    assert.deepEqual(
      getTextLines(`12\n${TS1}\n你好\n\n世界\n`),
      ['你好', '世界']
    );
  });
});

describe('formatTimestamp', () => {
  it('formats without hours', () => {
    assert.equal(formatTimestamp(TS2), '1:12 → 1:14');
  });

  it('keeps hours', () => {
    assert.equal(formatTimestamp('01:02:03,000 --> 01:02:05,500'), '1:02:03 → 1:02:05');
  });

  it('returns malformed input unchanged', () => {
    assert.equal(formatTimestamp('garbage'), 'garbage');
    assert.equal(formatTimestamp('00:01:12 --> xx'), '00:01:12 --> xx');
  });

  it('returns empty string for non-strings', () => {
    assert.equal(formatTimestamp(null), '');
    assert.equal(formatTimestamp(undefined), '');
  });
});

describe('escapeHtml', () => {
  it('escapes &, < and >', () => {
    assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order under staggered delays', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (x) => {
      await new Promise((r) => setTimeout(r, (4 - x) * 5));
      return x * 10;
    });
    assert.deepEqual(out, [30, 10, 20]);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x;
    });
    assert.equal(maxActive, 2);
  });

  it('resolves [] for empty input', async () => {
    assert.deepEqual(await mapWithConcurrency([], 3, async (x) => x), []);
  });

  it('propagates worker errors', async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
      /boom/
    );
  });
});
