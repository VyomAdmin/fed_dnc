'use strict';

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const LIST_ID = process.env.HUBSPOT_LIST_ID || '1988';
const COVERAGE_TARGET = Number(process.env.COVERAGE_TARGET || 0.9);

const HS_BATCH_READ_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/read';
const HS_LIST_MEMBERSHIPS_URL = (listId) => `https://api.hubapi.com/crm/v3/lists/${encodeURIComponent(listId)}/memberships`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const shouldRetry = (s) => [408, 429, 500, 502, 503, 504].includes(Number(s));

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cleanPhoneOf(phone, mobilephone) {
  const raw = phone || mobilephone;
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('1')) p = p.slice(1);
  return p.length === 10 ? p : null;
}

async function requestWithRetry(url, opts, tries = 6, base = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      const raw = (await res.text()) || '';
      if (res.ok) {
        try { return { ok: true, json: JSON.parse(raw) }; }
        catch { return { ok: false, json: null }; }
      }
      console.warn(`[HTTP] status=${res.status} bodySample=${raw.slice(0, 200)}`);
      if (shouldRetry(res.status) && i < tries - 1) { await delay(base * Math.pow(2, i)); continue; }
      return { ok: false, json: null };
    } catch (e) {
      console.warn(`[HTTP] network error attempt ${i + 1}: ${e.message}`);
      if (i < tries - 1) { await delay(base * Math.pow(2, i)); continue; }
      return { ok: false, json: null };
    }
  }
  return { ok: false, json: null };
}

const hsHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${HUBSPOT_TOKEN}` });

async function fetchListMemberIds(listId) {
  const ids = [];
  let after;
  for (;;) {
    const url = new URL(HS_LIST_MEMBERSHIPS_URL(listId));
    url.searchParams.set('limit', '250');
    if (after) url.searchParams.set('after', after);
    const { ok, json } = await requestWithRetry(url.toString(), { method: 'GET', headers: hsHeaders() });
    if (!ok || !json) { console.error('[List] membership fetch failed, stopping pagination'); break; }
    ids.push(...(json.results || []).map((r) => String(r.recordId)));
    after = json.paging?.next?.after;
    if (!after) break;
    if (ids.length % 10000 === 0) console.log(`[List] ${ids.length} member ids so far...`);
  }
  return ids;
}

async function fetchPhonesByIds(contactIds) {
  const areaCodeCounts = new Map();
  let withPhone = 0, withoutPhone = 0, processed = 0;
  for (const chunk of chunkArray(contactIds, 100)) {
    const body = { properties: ['phone', 'mobilephone'], inputs: chunk.map((id) => ({ id })) };
    const { ok, json } = await requestWithRetry(HS_BATCH_READ_URL, { method: 'POST', headers: hsHeaders(), body: JSON.stringify(body) });
    if (ok && Array.isArray(json?.results)) {
      for (const c of json.results) {
        const clean = cleanPhoneOf(c.properties.phone, c.properties.mobilephone);
        if (clean) {
          withPhone++;
          const areaCode = clean.slice(0, 3);
          areaCodeCounts.set(areaCode, (areaCodeCounts.get(areaCode) || 0) + 1);
        } else {
          withoutPhone++;
        }
      }
    } else {
      console.warn(`[Phones] batch read failed for chunk of ${chunk.length}`);
    }
    processed += chunk.length;
    if (processed % 5000 === 0) console.log(`[Phones] processed ${processed}/${contactIds.length}`);
    await delay(120);
  }
  return { areaCodeCounts, withPhone, withoutPhone };
}

async function main() {
  if (!HUBSPOT_TOKEN) throw new Error('Missing env HUBSPOT_PRIVATE_APP_TOKEN');
  console.log(`🟢 Area code report start — listId=${LIST_ID} coverageTarget=${COVERAGE_TARGET * 100}%`);

  const memberIds = await fetchListMemberIds(LIST_ID);
  console.log(`[List] total members: ${memberIds.length}`);
  if (memberIds.length === 0) { console.log('No members found.'); return; }

  const { areaCodeCounts, withPhone, withoutPhone } = await fetchPhonesByIds(memberIds);
  console.log(`[Phones] withPhone=${withPhone} withoutPhone=${withoutPhone}`);

  const sorted = [...areaCodeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const total = withPhone;
  let cumulative = 0;
  const coverageSet = [];
  for (const [areaCode, count] of sorted) {
    cumulative += count;
    coverageSet.push({ areaCode, count, pct: (count / total * 100).toFixed(2), cumulativePct: (cumulative / total * 100).toFixed(2) });
    if (cumulative / total >= COVERAGE_TARGET) break;
  }

  console.log(`\n=== Area codes covering ${(COVERAGE_TARGET * 100).toFixed(0)}% of ${total} phone numbers ===`);
  console.log(`Total distinct area codes in list: ${sorted.length}`);
  console.log(`Area codes needed for ${(COVERAGE_TARGET * 100).toFixed(0)}% coverage: ${coverageSet.length}\n`);
  console.log('AreaCode\tCount\t%ofTotal\tCumulative%');
  for (const row of coverageSet) {
    console.log(`${row.areaCode}\t${row.count}\t${row.pct}%\t${row.cumulativePct}%`);
  }
  console.log(`\n✅ Done — ${coverageSet.map((r) => r.areaCode).join(',')}`);
}

main().catch((err) => {
  console.error('❌ Fatal error in area code report:', err);
  process.exitCode = 1;
});
