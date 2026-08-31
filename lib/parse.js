'use strict';

// Parsers for the FTC National DNC Registry flat-file formats described in
// .scratch/National_DNC_daily.md.

/** Full List line: "areacode,number" e.g. "407,5551234" -> { areaCode, number } */
function parseFullListLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [areaCode, number] = trimmed.split(',').map((s) => s.trim());
  if (!/^\d{3}$/.test(areaCode) || !/^\d{7}$/.test(number)) return null;
  return { areaCode, number };
}

/** Change List line: "number,timestamp,transaction" e.g. "4075551234,2026-08-29T08:00:00,A"
 *  -> { areaCode, number, timestamp, transaction } */
function parseChangeListLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [fullNumber, timestamp, transaction] = trimmed.split(',').map((s) => s.trim());
  if (!/^\d{10}$/.test(fullNumber || '')) return null;
  if (!['A', 'D'].includes(transaction)) return null;
  const ts = new Date(timestamp);
  if (isNaN(ts.getTime())) return null;
  return {
    areaCode: fullNumber.slice(0, 3),
    number: fullNumber.slice(3),
    timestamp: ts,
    transaction,
  };
}

function parseFullListText(text) {
  return text.split(/\r?\n/).map(parseFullListLine).filter(Boolean);
}

/** Parsed rows sorted by timestamp ascending, per spec: "process changes in timestamp
 *  order if a run ever pulls more than one day's change file at once." */
function parseChangeListText(text) {
  const rows = text.split(/\r?\n/).map(parseChangeListLine).filter(Boolean);
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

module.exports = { parseFullListLine, parseChangeListLine, parseFullListText, parseChangeListText };
