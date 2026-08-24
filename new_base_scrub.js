'use strict';

// ---------- config ----------
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const DNC_OAUTH_CLIENT_ID = process.env.DNC_OAUTH_CLIENT_ID;
const DNC_OAUTH_CLIENT_SECRET = process.env.DNC_OAUTH_CLIENT_SECRET;
const DNC_OAUTH_SCOPE = process.env.DNC_OAUTH_SCOPE;
const HAS_DNC_CREDS = Boolean(DNC_OAUTH_CLIENT_ID && DNC_OAUTH_CLIENT_SECRET && DNC_OAUTH_SCOPE);

const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || null;
const LIST_ID = process.env.HUBSPOT_LIST_ID || null;
const DRY_RUN = String(process.env.DRY_RUN || '').trim().toLowerCase() === 'true';
const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT || 0) || null;
const FORCE_REPROCESS = String(process.env.FORCE_REPROCESS || '').trim().toLowerCase() === 'true';

// Area codes actually covered by our current DNC Solutions SAN (confirmed with vendor support, 2026-08).
const SAN_AREA_CODES = new Set([
  '239', '305', '321', '324', '352', '386', '407', '448', '480', '520',
  '561', '602', '623', '645', '656', '689', '727', '728', '754', '772',
  '786', '803', '813', '821', '839', '843', '850', '854', '863', '864',
  '904', '928', '941', '954',
]);

const HS_BATCH_UPDATE_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/update';
const HS_BATCH_READ_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/read';
const HS_LIST_MEMBERSHIPS_URL = (listId) => `https://api.hubapi.com/crm/v3/lists/${encodeURIComponent(listId)}/memberships`;
const DNC_OAUTH_TOKEN_URL = 'https://oauth.dncsolution.com/oauth2/v1/token';
const QUICKCHECK_CLIENT_ID = '18856';
const QUICKCHECK_AUTH_PROFILE_ID = '1524';
const QUICKCHECK_URL = `https://api.dncsolution.com/v4/${QUICKCHECK_CLIENT_ID}/Quickcheck/${QUICKCHECK_AUTH_PROFILE_ID}`;
const QUICKCHECK_CHUNK_SIZE = 500; // v4 QuickCheck POST max per call
const PROCESS_CHUNK_SIZE = Number(process.env.PROCESS_CHUNK_SIZE || 2000);

// policy_effective_date is a real property (tied to policy_number__c, an actual insurance
// policy) — used as the EBR date because it reflects a genuine relationship, unlike a
// fabricated/random date. Contacts without one get no LastEBRDate sent (no invented basis).
const CONTACT_PROPERTIES = [
  'phone', 'mobilephone', 'dnc_scrubbed_on__c', 'policy_effective_date', 'createdate',
];

// ---------- helpers ----------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const shouldRetry = (s) => [408, 429, 500, 502, 503, 504].includes(Number(s));

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function hsToDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    let n = Number(s);
    if (n > 1e12) n = n / 1000000;
    if (n > 1e10) n = n / 1000;
    const d = new Date(n * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toMMDDYYYYSlash(date) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function cleanPhoneOf(phone, mobilephone) {
  const raw = phone || mobilephone;
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('1')) p = p.slice(1);
  return p.length === 10 ? p : null;
}

async function requestWithRetry(url, opts, tries = 6, base = 500) {
  let lastRaw = '';
  for (let i = 0; i < tries; i++) {
    try {
      console.log(`[HTTP] ${opts.method || 'GET'} ${url} (attempt ${i + 1}/${tries})`);
      const res = await fetch(url, opts);
      lastRaw = (await res.text()) || '';
      if (res.ok) {
        try { return { ok: true, json: JSON.parse(lastRaw), raw: lastRaw }; }
        catch { console.warn('[HTTP] Non-JSON response'); return { ok: false, json: null, raw: lastRaw }; }
      }
      console.warn(`[HTTP] status=${res.status} bodySample=${lastRaw.slice(0, 200)}`);
      if (shouldRetry(res.status) && i < tries - 1) {
        await delay(base * Math.pow(2, i) + Math.floor(Math.random() * 250));
        continue;
      }
      return { ok: false, json: null, raw: lastRaw };
    } catch (e) {
      console.warn(`[HTTP] network error attempt ${i + 1}: ${e.message}`);
      if (i < tries - 1) { await delay(base * Math.pow(2, i) + Math.floor(Math.random() * 250)); continue; }
      return { ok: false, json: null, raw: lastRaw };
    }
  }
  return { ok: false, json: null, raw: lastRaw };
}

const hsHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${HUBSPOT_TOKEN}` });

// ---------- OAuth token (client_credentials, cached with proactive refresh) ----------
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function fetchDncOAuthToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: DNC_OAUTH_SCOPE,
    client_id: DNC_OAUTH_CLIENT_ID,
    client_secret: DNC_OAUTH_CLIENT_SECRET,
  });
  const { ok, json } = await requestWithRetry(DNC_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  }, 3);
  if (!ok || !json?.access_token) return null;
  return json;
}

async function getValidToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;
  const token = await fetchDncOAuthToken();
  if (!token) { cachedToken = null; return null; }
  cachedToken = token.access_token;
  const expiresInMs = (Number(token.expires_in) || 300) * 1000;
  cachedTokenExpiresAt = now + expiresInMs - 30000;
  return cachedToken;
}

// ---------- HubSpot list membership + contact fetch ----------
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
  }
  return ids;
}

async function fetchContactsByIds(contactIds) {
  const results = [];
  for (const chunk of chunkArray(contactIds, 100)) {
    const body = { properties: CONTACT_PROPERTIES, inputs: chunk.map((id) => ({ id })) };
    const { ok, json } = await requestWithRetry(HS_BATCH_READ_URL, { method: 'POST', headers: hsHeaders(), body: JSON.stringify(body) });
    if (ok && Array.isArray(json?.results)) results.push(...json.results);
    else console.warn(`[List] contact batch read failed for chunk of ${chunk.length}`);
    await delay(150);
  }
  return results;
}

async function fetchListCandidates(listId) {
  console.log(`[Candidates] list mode — listId=${listId}`);
  const memberIds = await fetchListMemberIds(listId);
  console.log(`[Candidates] list members: ${memberIds.length}`);
  if (memberIds.length === 0) return [];
  return fetchContactsByIds(memberIds);
}

async function fetchSingleContact(contactId) {
  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${CONTACT_PROPERTIES.join(',')}`;
  const { ok, json } = await requestWithRetry(url, { method: 'GET', headers: hsHeaders() });
  if (!ok || !json) return [];
  return [json];
}

// ---------- v4 QuickCheck ----------
async function runQuickCheckChunks(contacts) {
  const byPhone = new Map();
  for (const chunk of chunkArray(contacts, QUICKCHECK_CHUNK_SIZE)) {
    const token = await getValidToken();
    if (!token) { console.error(`[QuickCheck] no token, skipping chunk of ${chunk.length}`); continue; }

    const body = chunk.map((c) => {
      const entry = { PhoneNumber: c.cleanPhone };
      // policy_effective_date is a real relationship date (tied to an actual insurance
      // policy) — send it as-is. No fallback/invented date if it's missing: absence of a
      // real basis means no EBR exemption gets requested, which is the correct outcome.
      if (c.policyEffectiveDate) entry.LastEBRDate = toMMDDYYYYSlash(c.policyEffectiveDate);
      return entry;
    });

    const { ok, json } = await requestWithRetry(QUICKCHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (ok && Array.isArray(json?.QuickCheckResults)) {
      for (const row of json.QuickCheckResults) byPhone.set(String(row.PhoneNumber), row);
    } else {
      console.warn(`[QuickCheck] chunk of ${chunk.length} failed after retries`);
    }
    await delay(300);
  }
  return byPhone;
}

// ---------- per-contact property derivation ----------
function deriveProps(contact, resultsByPhone, todayIso) {
  if (!contact.cleanPhone) return { dnc_scrubbed_on__c: todayIso, dnc_api_log: 'NO_PHONE', dnc_opt_out: '' };

  // Out-of-SAN numbers never got an API call — no check happened, so log it plainly
  // rather than guessing at a DNC status we don't have.
  if (contact.inSan === false) {
    return { dnc_scrubbed_on__c: todayIso, dnc_api_log: 'OUT_OF_SAN', dnc_opt_out: '' };
  }

  if (!HAS_DNC_CREDS) return { dnc_api_log: 'SKIPPED_NO_OAUTH_CREDS', dnc_opt_out: '' };

  const result = resultsByPhone.get(contact.cleanPhone);
  if (!result) return { dnc_api_log: 'RETRY', dnc_opt_out: '' };

  // In-SAN, checked with LastEBRDate=policy_effective_date (if present) — derive purely
  // from the API's own Status/litigator signal.
  const filters = Array.isArray(result.Filters) ? result.Filters : [];
  const litigatorFlag = filters.some((f) => /litigator/i.test(f.FilterName || ''));
  const statusDnc = String(result.Status || '').trim().toUpperCase() === 'DNC';
  return {
    dnc_scrubbed_on__c: todayIso,
    litigator: litigatorFlag ? 'Yes' : 'No',
    dnc_opt_out: (statusDnc || litigatorFlag) ? true : '',
  };
}

// ---------- HubSpot batch update ----------
async function batchUpdate(inputs) {
  let updated = 0, failed = 0;
  for (const chunk of chunkArray(inputs, 100)) {
    const { ok, raw } = await requestWithRetry(HS_BATCH_UPDATE_URL, {
      method: 'POST', headers: hsHeaders(),
      body: JSON.stringify({ inputs: chunk }),
    });
    if (ok) { updated += chunk.length; }
    else { failed += chunk.length; console.error(`[BatchUpdate] chunk of ${chunk.length} failed: ${(raw || '').slice(0, 500)}`); }
    await delay(150);
  }
  return { updated, failed };
}

/** Was this contact already scrubbed today? Used to make LIST MODE reruns resumable. */
function scrubbedToday(properties, todayIso) {
  const d = hsToDate(properties.dnc_scrubbed_on__c);
  return d ? d.toISOString().slice(0, 10) === todayIso : false;
}

/** Run the deal-free QuickCheck + derive + write pipeline for one chunk of contacts. */
async function processChunk(candidates, todayIso) {
  const contacts = candidates.map((c) => {
    const cleanPhone = cleanPhoneOf(c.properties.phone, c.properties.mobilephone);
    const inSan = cleanPhone ? SAN_AREA_CODES.has(cleanPhone.slice(0, 3)) : null;
    const policyEffectiveDate = hsToDate(c.properties.policy_effective_date);
    return { id: c.id, properties: c.properties, cleanPhone, inSan, policyEffectiveDate };
  });

  const outOfSan = contacts.filter((c) => c.cleanPhone && c.inSan === false);
  const checkable = contacts.filter((c) => !(c.cleanPhone && c.inSan === false));
  const withPhone = checkable.filter((c) => c.cleanPhone);
  const withoutPhone = checkable.filter((c) => !c.cleanPhone);
  console.log(`[Chunk] withPhone=${withPhone.length} withoutPhone=${withoutPhone.length} outOfSan=${outOfSan.length}`);

  let resultsByPhone = new Map();
  if (HAS_DNC_CREDS && withPhone.length > 0) {
    resultsByPhone = await runQuickCheckChunks(withPhone);
  }

  const inputs = contacts.map((c) => ({
    id: c.id,
    properties: deriveProps(c, resultsByPhone, todayIso),
  }));

  if (DRY_RUN) {
    console.log(`🧪 DRY RUN — no HubSpot writes will be made. Detailed results for ${inputs.length} contact(s):`);
    for (const c of contacts) {
      const result = resultsByPhone.get(c.cleanPhone) || null;
      const derived = inputs.find((i) => i.id === c.id).properties;
      console.log('----------------------------------------');
      console.log(`Contact ${c.id}`);
      console.log(`  phone (cleaned): ${c.cleanPhone || 'MISSING/INVALID'}`);
      console.log(`  inSan: ${c.inSan}`);
      console.log(`  policyEffectiveDate used for LastEBRDate: ${c.policyEffectiveDate ? c.policyEffectiveDate.toISOString().slice(0, 10) : 'none'}`);
      console.log(`  QuickCheck raw result: ${result ? JSON.stringify(result) : 'none (no phone / out-of-SAN / RETRY / not sent)'}`);
      console.log(`  Derived properties: ${JSON.stringify(derived)}`);
    }
    return { updated: 0, failed: 0, checked: inputs.length };
  }

  const { updated, failed } = await batchUpdate(inputs);
  return { updated, failed, checked: inputs.length };
}

// ---------- main ----------
async function main() {
  if (!HUBSPOT_TOKEN) throw new Error('Missing env HUBSPOT_PRIVATE_APP_TOKEN');
  if (!HAS_DNC_CREDS) console.warn('⚠️ Missing DNC_OAUTH_CLIENT_ID/SECRET/SCOPE; DNC/litigator checks will be skipped for this run.');
  if (!TEST_CONTACT_ID && !LIST_ID) throw new Error('new_base_scrub.js requires TEST_CONTACT_ID or HUBSPOT_LIST_ID — no unscoped bulk mode here.');

  const todayIso = new Date().toISOString().slice(0, 10);
  console.log(TEST_CONTACT_ID
    ? `🟢 New base scrub start — TEST MODE, single contact ${TEST_CONTACT_ID}`
    : `🟢 New base scrub start — LIST MODE, listId=${LIST_ID}`);

  let candidates = TEST_CONTACT_ID
    ? await fetchSingleContact(TEST_CONTACT_ID)
    : await fetchListCandidates(LIST_ID);

  if (LIST_ID && !FORCE_REPROCESS) {
    const before = candidates.length;
    candidates = candidates.filter((c) => !scrubbedToday(c.properties, todayIso));
    console.log(`[List] skipping ${before - candidates.length} already scrubbed today; ${candidates.length} remaining`);
  } else if (LIST_ID && FORCE_REPROCESS) {
    console.log(`[List] FORCE_REPROCESS=true — re-checking all ${candidates.length} list member(s) regardless of today's scrub status`);
  }

  if (SAMPLE_LIMIT) candidates = candidates.slice(0, SAMPLE_LIMIT);
  console.log(`[Main] total candidates: ${candidates.length}${SAMPLE_LIMIT ? ` (capped to SAMPLE_LIMIT=${SAMPLE_LIMIT})` : ''}`);
  if (candidates.length === 0) { console.log('Nothing to scrub today.'); return; }

  const chunks = chunkArray(candidates, PROCESS_CHUNK_SIZE);
  console.log(`[Main] processing ${candidates.length} candidate(s) in ${chunks.length} chunk(s) of up to ${PROCESS_CHUNK_SIZE}`);

  let totalUpdated = 0, totalFailed = 0, totalChecked = 0;
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[Main] === chunk ${i + 1}/${chunks.length} (${chunks[i].length} contacts) ===`);
    const { updated, failed, checked } = await processChunk(chunks[i], todayIso);
    totalUpdated += updated;
    totalFailed += failed;
    totalChecked += checked;
    console.log(`[Main] chunk ${i + 1}/${chunks.length} done — updated=${updated} failed=${failed}`);
  }

  console.log(DRY_RUN
    ? `🧪 DRY RUN complete — ${totalChecked} contact(s) checked, 0 HubSpot properties written.`
    : `✅ New base scrub done — updated=${totalUpdated} failed=${totalFailed}`);
  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('❌ Fatal error in new base scrub:', err);
  process.exitCode = 1;
});
