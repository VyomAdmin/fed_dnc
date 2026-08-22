'use strict';

// ---------- config ----------
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const DNC_OAUTH_CLIENT_ID = process.env.DNC_OAUTH_CLIENT_ID;
const DNC_OAUTH_CLIENT_SECRET = process.env.DNC_OAUTH_CLIENT_SECRET;
const DNC_OAUTH_SCOPE = process.env.DNC_OAUTH_SCOPE;
const HAS_DNC_CREDS = Boolean(DNC_OAUTH_CLIENT_ID && DNC_OAUTH_CLIENT_SECRET && DNC_OAUTH_SCOPE);

const DAILY_LIMIT = Number(process.env.BULK_DAILY_LIMIT || 11000); // ~300k / 28-day rotation
const STALE_DAYS = Number(process.env.BULK_STALE_DAYS || 28);
const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || null;
const LIST_ID = process.env.HUBSPOT_LIST_ID || null;
const DRY_RUN = String(process.env.DRY_RUN || '').trim().toLowerCase() === 'true';
const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT || 0) || null;
const FORCE_REPROCESS = String(process.env.FORCE_REPROCESS || '').trim().toLowerCase() === 'true';
const EBR_OVERRIDE_LEADSOURCE = process.env.EBR_OVERRIDE_LEADSOURCE || null; // test-only: skip the isInstallCompleted gate for this exact leadsource
const ONLY_DNC_TRUE = String(process.env.ONLY_DNC_TRUE || '').trim().toLowerCase() === 'true'; // list mode: only reprocess contacts currently marked dnc_opt_out=Yes

const HS_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const HS_BATCH_UPDATE_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/update';
const HS_BATCH_READ_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/read';
const HS_ASSOC_BATCH_URL = 'https://api.hubapi.com/crm/v3/associations/contacts/deals/batch/read';
const HS_DEALS_BATCH_READ_URL = 'https://api.hubapi.com/crm/v3/objects/deals/batch/read';
const HS_LIST_MEMBERSHIPS_URL = (listId) => `https://api.hubapi.com/crm/v3/lists/${encodeURIComponent(listId)}/memberships`;
const DNC_OAUTH_TOKEN_URL = 'https://oauth.dncsolution.com/oauth2/v1/token';
const QUICKCHECK_CLIENT_ID = '18856';
const QUICKCHECK_AUTH_PROFILE_ID = '1524';
const QUICKCHECK_URL = `https://api.dncsolution.com/v4/${QUICKCHECK_CLIENT_ID}/Quickcheck/${QUICKCHECK_AUTH_PROFILE_ID}`;
const QUICKCHECK_CHUNK_SIZE = 500; // v4 QuickCheck POST max per call

const CONTACT_PROPERTIES = [
  'phone', 'mobilephone', 'dnc_scrubbed_on__c',
  'pewc__c', 'createdate', 'latest_deal_created_date', 'recent_deal_close_date',
  'leadsource', 'dnc_opt_out',
];

// install_completed_date__c / status_code__c live on the Deal, not the Contact
const DEAL_PROPERTIES = ['install_completed_date__c', 'status_code__c', 'closedate', 'hs_lastmodifieddate'];

// RNDStatus code → meaning (confirmed with vendor). Unmapped/unknown codes are logged
// to dnc_api_log but leave phone_reassigned unset rather than guess.
const RND_STATUS_MAP = { RNN: false, RNY: true };

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

function addMonthsSafe(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
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
let cachedTokenExpiresAt = 0; // epoch ms

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
  cachedTokenExpiresAt = now + expiresInMs - 30000; // refresh 30s before real expiry
  return cachedToken;
}

// ---------- HubSpot search (paginated) ----------
async function searchContacts(filterGroups, sorts, limitRemaining) {
  const results = [];
  let after;
  while (results.length < limitRemaining) {
    const body = {
      filterGroups,
      sorts,
      properties: CONTACT_PROPERTIES,
      limit: Math.min(100, limitRemaining - results.length),
      ...(after ? { after } : {}),
    };
    const { ok, json } = await requestWithRetry(HS_SEARCH_URL, { method: 'POST', headers: hsHeaders(), body: JSON.stringify(body) });
    if (!ok || !json) { console.error('[Search] failed, stopping pagination'); break; }
    results.push(...json.results);
    after = json.paging?.next?.after;
    if (!after) break;
  }
  return results;
}

async function fetchSingleContact(contactId) {
  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${CONTACT_PROPERTIES.join(',')}`;
  const { ok, json } = await requestWithRetry(url, { method: 'GET', headers: hsHeaders() });
  if (!ok || !json) return [];
  return [json];
}

// ---------- HubSpot active list membership (scrub a specific segment) ----------
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

// ---------- associated deals (install_completed_date__c / status_code__c live here, not on the Contact) ----------
async function fetchAssociatedDealIdsBulk(contactIds) {
  const map = new Map(); // contactId -> [dealId, ...]
  for (const chunk of chunkArray(contactIds, 100)) {
    const body = { inputs: chunk.map((id) => ({ id })) };
    const { ok, json } = await requestWithRetry(HS_ASSOC_BATCH_URL, { method: 'POST', headers: hsHeaders(), body: JSON.stringify(body) });
    if (ok && Array.isArray(json?.results)) {
      for (const r of json.results) map.set(String(r.from.id), (r.to || []).map((t) => t.toObjectId || t.id));
    } else {
      console.warn(`[Deals] association batch failed for chunk of ${chunk.length}`);
    }
    await delay(150);
  }
  return map;
}

async function fetchDealsBulk(dealIds) {
  const map = new Map(); // dealId -> properties
  const uniqueIds = [...new Set(dealIds)];
  for (const chunk of chunkArray(uniqueIds, 100)) {
    const body = { properties: DEAL_PROPERTIES, inputs: chunk.map((id) => ({ id })) };
    const { ok, json } = await requestWithRetry(HS_DEALS_BATCH_READ_URL, { method: 'POST', headers: hsHeaders(), body: JSON.stringify(body) });
    if (ok && Array.isArray(json?.results)) {
      for (const d of json.results) map.set(String(d.id), d.properties);
    } else {
      console.warn(`[Deals] batch read failed for chunk of ${chunk.length}`);
    }
    await delay(150);
  }
  return map;
}

/** Pick the most recently closed/updated deal's properties from a contact's associated deals. */
function pickPrimaryDealProps(dealsProps) {
  if (!dealsProps || dealsProps.length === 0) return null;
  return dealsProps.slice().sort((a, b) => {
    const aKey = hsToDate(a.closedate) || hsToDate(a.hs_lastmodifieddate) || new Date(0);
    const bKey = hsToDate(b.closedate) || hsToDate(b.hs_lastmodifieddate) || new Date(0);
    return bKey - aKey;
  })[0];
}

async function fetchCandidates() {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - STALE_DAYS);
  const cutoffMs = cutoff.getTime();

  console.log(`[Candidates] never-scrubbed pass (limit ${DAILY_LIMIT})`);
  const neverScrubbed = await searchContacts(
    [{ filters: [{ propertyName: 'dnc_scrubbed_on__c', operator: 'NOT_HAS_PROPERTY' }] }],
    [{ propertyName: 'createdate', direction: 'ASCENDING' }],
    DAILY_LIMIT
  );
  console.log(`[Candidates] never-scrubbed: ${neverScrubbed.length}`);

  const remaining = DAILY_LIMIT - neverScrubbed.length;
  let stale = [];
  if (remaining > 0) {
    console.log(`[Candidates] stale pass (remaining quota ${remaining})`);
    stale = await searchContacts(
      [{ filters: [{ propertyName: 'dnc_scrubbed_on__c', operator: 'LT', value: String(cutoffMs) }] }],
      [{ propertyName: 'dnc_scrubbed_on__c', direction: 'ASCENDING' }],
      remaining
    );
    console.log(`[Candidates] stale: ${stale.length}`);
  }

  return [...neverScrubbed, ...stale];
}

// ---------- v4 QuickCheck (DNC + EBR + litigator + reassignment, one call per number) ----------
async function runQuickCheckChunks(contacts) {
  const byPhone = new Map();
  for (const chunk of chunkArray(contacts, QUICKCHECK_CHUNK_SIZE)) {
    const token = await getValidToken();
    if (!token) { console.error(`[QuickCheck] no token, skipping chunk of ${chunk.length}`); continue; }

    const body = chunk.map((c) => {
      const entry = { PhoneNumber: c.cleanPhone };
      // LastRNDDate (reassignment check) applies regardless of install status — reassignment
      // risk exists whether or not the deal has closed. LastEBRDate (EBR exemption) stays
      // gated on isInstallCompleted since that exemption legitimately requires it.
      if (c.consentDate) {
        entry.LastRNDDate = toMMDDYYYYSlash(c.consentDate);
        if (c.isInstallCompleted) entry.LastEBRDate = entry.LastRNDDate;
      }
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
  // dnc_scrubbed_on__c must only be stamped once a check actually happened (or there's
  // nothing to check). Stamping it on RETRY/SKIPPED_NO_OAUTH_CREDS would hide the failure
  // and skip this contact from re-scrub for STALE_DAYS while it was never really checked.
  if (!contact.cleanPhone) return { dnc_scrubbed_on__c: todayIso, dnc_api_log: 'NO_PHONE', dnc_opt_out: '' };

  if (!HAS_DNC_CREDS) return { dnc_api_log: 'SKIPPED_NO_OAUTH_CREDS', dnc_opt_out: '' };

  const result = resultsByPhone.get(contact.cleanPhone);
  if (!result) return { dnc_api_log: 'RETRY', dnc_opt_out: '' };

  const props = { dnc_scrubbed_on__c: todayIso };
  const pewcRaw = contact.properties.pewc__c;
  const isPewc = pewcRaw === true || String(pewcRaw).trim().toLowerCase() === 'true';
  const installDt = hsToDate(contact.dealInstallCompletedDate);
  const filters = Array.isArray(result.Filters) ? result.Filters : [];

  // --- Litigator ---
  const litigatorFlag = filters.some((f) => /litigator/i.test(f.FilterName || ''));
  props.litigator = litigatorFlag ? 'Yes' : 'No';

  // --- DNC/EBR ---
  // Trust the API's Status field literally — dnc_opt_out=Yes only when the API itself
  // reports Status="DNC". Otherwise clear the field (empty string) rather than writing
  // "No", so a not-DNC result never gets confused with "checked and clean."
  const dncOptOut = String(result.Status || '').trim().toUpperCase() === 'DNC';
  props.dnc_opt_out = dncOptOut ? true : '';

  if (dncOptOut) {
    props.dnc_call_thru_date__c = todayIso;
  } else if (isPewc) {
    // authorized until dnc_opt_out flips true; no expiration tracked
  } else if (installDt) {
    props.dnc_call_thru_date__c = addMonthsSafe(installDt, 18).toISOString().slice(0, 10);
  }

  // --- Reassignment ---
  let reassignedFlag = null;
  let reassignedUnknown = false;
  const rndStatus = result.RNDStatus;
  if (rndStatus != null) {
    if (Object.prototype.hasOwnProperty.call(RND_STATUS_MAP, rndStatus)) {
      reassignedFlag = RND_STATUS_MAP[rndStatus];
      props.phone_reassigned = reassignedFlag ? 'Yes' : 'No';
    } else {
      reassignedUnknown = true;
      console.warn(`[Reassigned] Unmapped RNDStatus='${rndStatus}' for contact ${contact.id} — leaving phone_reassigned unset, flagging composite risk for manual review`);
    }
  }

  // An unmapped RNDStatus is an unknown reassignment signal, not a clean one — treat as risky
  // rather than letting it silently fall through as "not reassigned".
  props.dnc_composite_risk = (dncOptOut === true || litigatorFlag === true || reassignedFlag === true || reassignedUnknown) ? 'Yes' : 'No';
  return props;
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

const PROCESS_CHUNK_SIZE = Number(process.env.PROCESS_CHUNK_SIZE || 2000);

/** Was this contact already scrubbed today? Used to make LIST MODE reruns resumable —
 *  a timed-out run's earlier chunks are already written, so a plain retrigger skips them
 *  instead of redoing the whole list from the start. */
function scrubbedToday(properties, todayIso) {
  const d = hsToDate(properties.dnc_scrubbed_on__c);
  return d ? d.toISOString().slice(0, 10) === todayIso : false;
}

/** Run the full deal-lookup + QuickCheck + derive + write pipeline for one chunk of contacts.
 *  Writes to HubSpot immediately so progress survives a job timeout on a later chunk. */
async function processChunk(candidates, todayIso) {
  const assocMap = await fetchAssociatedDealIdsBulk(candidates.map((c) => c.id));
  const dealPropsMap = await fetchDealsBulk([...assocMap.values()].flat());

  const contacts = candidates.map((c) => {
    const cleanPhone = cleanPhoneOf(c.properties.phone, c.properties.mobilephone);
    const dealIds = assocMap.get(String(c.id)) || [];
    const primaryDeal = pickPrimaryDealProps(dealIds.map((id) => dealPropsMap.get(String(id))).filter(Boolean));
    const dealInstallCompletedDate = primaryDeal?.install_completed_date__c || null;
    const dealStatusCode = primaryDeal?.status_code__c || null;

    const consentDate =
      hsToDate(dealInstallCompletedDate) ||
      hsToDate(c.properties.recent_deal_close_date) ||
      hsToDate(c.properties.latest_deal_created_date) ||
      hsToDate(c.properties.createdate);
    const statusIsInstallCompleted = String(dealStatusCode || '').trim().toLowerCase() === 'install completed';
    // Test-only override: for a specific leadsource, send LastEBRDate regardless of
    // install status (normally gated on statusIsInstallCompleted alone).
    const ebrOverride = Boolean(EBR_OVERRIDE_LEADSOURCE) && String(c.properties.leadsource || '').trim() === EBR_OVERRIDE_LEADSOURCE;
    const isInstallCompleted = statusIsInstallCompleted || ebrOverride;
    return { id: c.id, properties: c.properties, cleanPhone, consentDate, isInstallCompleted, dealInstallCompletedDate };
  });

  const withPhone = contacts.filter((c) => c.cleanPhone);
  const withoutPhone = contacts.filter((c) => !c.cleanPhone);
  console.log(`[Chunk] withPhone=${withPhone.length} withoutPhone=${withoutPhone.length}`);

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
      console.log(`  consentDate used for LastEBRDate/LastRNDDate: ${c.consentDate ? c.consentDate.toISOString().slice(0, 10) : 'none'}`);
      console.log(`  isInstallCompleted: ${c.isInstallCompleted}`);
      console.log(`  QuickCheck raw result: ${result ? JSON.stringify(result) : 'none (no phone / RETRY / not sent)'}`);
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
  if (!HAS_DNC_CREDS) console.warn('⚠️ Missing DNC_OAUTH_CLIENT_ID/SECRET/SCOPE; DNC/EBR/litigator/reassignment checks will be skipped for this run.');

  const todayIso = new Date().toISOString().slice(0, 10);
  console.log(TEST_CONTACT_ID
    ? `🟢 DNC scrub start — TEST MODE, single contact ${TEST_CONTACT_ID}`
    : LIST_ID
    ? `🟢 DNC scrub start — LIST MODE, listId=${LIST_ID}`
    : `🟢 Bulk DNC scrub start — dailyLimit=${DAILY_LIMIT} staleDays=${STALE_DAYS}`);

  let candidates = TEST_CONTACT_ID
    ? await fetchSingleContact(TEST_CONTACT_ID)
    : LIST_ID
    ? await fetchListCandidates(LIST_ID)
    : await fetchCandidates();

  if (LIST_ID && ONLY_DNC_TRUE) {
    const before = candidates.length;
    candidates = candidates.filter((c) => String(c.properties.dnc_opt_out).trim().toLowerCase() === 'true');
    console.log(`[List] ONLY_DNC_TRUE=true — filtering to ${candidates.length}/${before} contact(s) currently marked dnc_opt_out=Yes`);
  }

  if (LIST_ID && !FORCE_REPROCESS) {
    // Makes a plain retrigger resumable: a prior run's completed chunks are already
    // stamped with today's date, so they're skipped instead of reprocessed from scratch.
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
    : `✅ Bulk DNC scrub done — updated=${totalUpdated} failed=${totalFailed}`);
  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('❌ Fatal error in bulk DNC scrub:', err);
  process.exitCode = 1;
});
