'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFullListLine, parseChangeListLine, parseFullListText, parseChangeListText } = require('../lib/parse');

test('parseFullListLine parses a valid areacode,number line', () => {
  assert.deepEqual(parseFullListLine('407,5551234'), { areaCode: '407', number: '5551234' });
});

test('parseFullListLine rejects malformed lines', () => {
  assert.equal(parseFullListLine(''), null);
  assert.equal(parseFullListLine('40,5551234'), null);
  assert.equal(parseFullListLine('407,551234'), null);
});

test('parseFullListText skips blank lines', () => {
  const rows = parseFullListText('407,5551234\n\n813,5559999\n');
  assert.equal(rows.length, 2);
});

test('parseChangeListLine splits areacode/number and preserves transaction', () => {
  const row = parseChangeListLine('4075551234,2026-08-29T08:00:00,A');
  assert.equal(row.areaCode, '407');
  assert.equal(row.number, '5551234');
  assert.equal(row.transaction, 'A');
  assert.ok(row.timestamp instanceof Date);
});

test('parseChangeListLine rejects unknown transaction codes', () => {
  assert.equal(parseChangeListLine('4075551234,2026-08-29T08:00:00,X'), null);
});

test('parseChangeListText sorts rows ascending by timestamp regardless of file order', () => {
  const text = [
    '4075551234,2026-08-29T08:00:00,D',
    '8135559999,2026-08-27T08:00:00,A',
  ].join('\n');
  const rows = parseChangeListText(text);
  assert.equal(rows[0].number, '5559999');
  assert.equal(rows[1].number, '5551234');
});
