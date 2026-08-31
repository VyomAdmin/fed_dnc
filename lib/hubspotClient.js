'use strict';

// Shared HubSpot REST helpers — retry/backoff, pagination, batch read/update.
// Extracted from area_code_report.js so the write-back job can reuse the same
// tested request plumbing instead of duplicating it.

const HS_BATCH_READ_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/read';
const HS_BATCH_UPDATE_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/update';
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

function hsHeaders(token) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function fetchListMemberIds(token, listId) {
  const ids = [];
  let after;
  for (;;) {
    const url = new URL(HS_LIST_MEMBERSHIPS_URL(listId));
    url.searchParams.set('limit', '250');
    if (after) url.searchParams.set('after', after);
    const { ok, json } = await requestWithRetry(url.toString(), { method: 'GET', headers: hsHeaders(token) });
    if (!ok || !json) { console.error('[List] membership fetch failed, stopping pagination'); break; }
    ids.push(...(json.results || []).map((r) => String(r.recordId)));
    after = json.paging?.next?.after;
    if (!after) break;
    if (ids.length % 10000 === 0) console.log(`[List] ${ids.length} member ids so far...`);
  }
  return ids;
}

/** Batch-read a set of contact properties by id, 100 at a time. */
async function batchReadContacts(token, contactIds, properties) {
  const out = [];
  for (const chunk of chunkArray(contactIds, 100)) {
    const body = { properties, inputs: chunk.map((id) => ({ id })) };
    const { ok, json } = await requestWithRetry(HS_BATCH_READ_URL, { method: 'POST', headers: hsHeaders(token), body: JSON.stringify(body) });
    if (ok && Array.isArray(json?.results)) out.push(...json.results);
    else console.warn(`[HubSpot] batch read failed for chunk of ${chunk.length}`);
    await delay(120);
  }
  return out;
}

/** Batch-update a set of contacts, 100 at a time. updates: [{ id, properties }]. */
async function batchUpdateContacts(token, updates) {
  let updated = 0;
  for (const chunk of chunkArray(updates, 100)) {
    const body = { inputs: chunk };
    const { ok, json } = await requestWithRetry(HS_BATCH_UPDATE_URL, { method: 'POST', headers: hsHeaders(token), body: JSON.stringify(body) });
    if (ok && Array.isArray(json?.results)) updated += json.results.length;
    else console.warn(`[HubSpot] batch update failed for chunk of ${chunk.length}`);
    await delay(120);
  }
  return updated;
}

module.exports = {
  chunkArray,
  cleanPhoneOf,
  requestWithRetry,
  hsHeaders,
  fetchListMemberIds,
  batchReadContacts,
  batchUpdateContacts,
};
