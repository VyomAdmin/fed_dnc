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

const HS_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const HS_BATCH_UPDATE_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/update';
const DNC_OAUTH_TOKEN_URL = 'https://oauth.dncsolution.com/oauth2/v1/token';
const QUICKCHECK_CLIENT_ID = '18856';
const QUICKCHECK_AUTH_PROFILE_ID = '1524';
const QUICKCHECK_URL = `https://api.dncsolution.com/v4/${QUICKCHECK_CLIENT_ID}/Quickcheck/${QUICKCHECK_AUTH_PROFILE_ID}`;
const QUICKCHECK_CHUNK_SIZE = 500; // v4 QuickCheck POST max per call

const CONTACT_PROPERTIES = [
  'phone', 'mobilephone', 'dnc_scrubbed_on__c',
  'install_completed_date__c', 'pewc__c',
  'createdate', 'latest_deal_created_date', 'recent_deal_close_date',
];

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
      if (c.consentDate) {
        const d = toMMDDYYYYSlash(c.consentDate);
        entry.LastEBRDate = d;
        entry.LastRNDDate = d;
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
  const props = { dnc_scrubbed_on__c: todayIso };
  if (!contact.cleanPhone) return props;

  if (!HAS_DNC_CREDS) { props.dnc_api_log = 'SKIPPED_NO_OAUTH_CREDS'; return props; }

  const result = resultsByPhone.get(contact.cleanPhone);
  if (!result) { props.dnc_api_log = 'RETRY'; return props; }

  const pewcRaw = contact.properties.pewc__c;
  const isPewc = pewcRaw === true || String(pewcRaw).trim().toLowerCase() === 'true';
  const installDt = hsToDate(contact.properties.install_completed_date__c);
  const filters = Array.isArray(result.Filters) ? result.Filters : [];

  // --- Litigator ---
  const litigatorFlag = filters.some((f) => /litigator/i.test(f.FilterName || ''));
  props.litigator = litigatorFlag ? 'Yes' : 'No';

  // --- DNC/EBR ---
  // A litigator-only match also sets Status="DNC"; exclude litigator filters so those
  // don't wrongly flip dnc_opt_out.
  const nonLitigatorHit = filters.some((f) => !/litigator/i.test(f.FilterName || ''));
  const dncOptOut = String(result.Status || '').trim().toUpperCase() === 'DNC' && nonLitigatorHit;
  props.dnc_opt_out = dncOptOut;

  if (dncOptOut) {
    props.dnc_call_thru_date__c = todayIso;
  } else if (isPewc) {
    // authorized until dnc_opt_out flips true; no expiration tracked
  } else if (installDt) {
    props.dnc_call_thru_date__c = addMonthsSafe(installDt, 18).toISOString().slice(0, 10);
  }

  // --- Reassignment ---
  let reassignedFlag = null;
  const rndStatus = result.RNDStatus;
  if (rndStatus != null) {
    if (Object.prototype.hasOwnProperty.call(RND_STATUS_MAP, rndStatus)) {
      reassignedFlag = RND_STATUS_MAP[rndStatus];
      props.phone_reassigned = reassignedFlag ? 'Yes' : 'No';
    } else {
      console.warn(`[Reassigned] Unmapped RNDStatus='${rndStatus}' for contact ${contact.id} — leaving phone_reassigned unset`);
    }
  }

  props.dnc_composite_risk = (dncOptOut === true || litigatorFlag === true || reassignedFlag === true) ? 'Yes' : 'No';
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

// ---------- main ----------
async function main() {
  if (!HUBSPOT_TOKEN) throw new Error('Missing env HUBSPOT_PRIVATE_APP_TOKEN');
  if (!HAS_DNC_CREDS) console.warn('⚠️ Missing DNC_OAUTH_CLIENT_ID/SECRET/SCOPE; DNC/EBR/litigator/reassignment checks will be skipped for this run.');

  const todayIso = new Date().toISOString().slice(0, 10);
  console.log(TEST_CONTACT_ID
    ? `🟢 DNC scrub start — TEST MODE, single contact ${TEST_CONTACT_ID}`
    : `🟢 Bulk DNC scrub start — dailyLimit=${DAILY_LIMIT} staleDays=${STALE_DAYS}`);

  const candidates = TEST_CONTACT_ID
    ? await fetchSingleContact(TEST_CONTACT_ID)
    : await fetchCandidates();
  console.log(`[Main] total candidates: ${candidates.length}`);
  if (candidates.length === 0) { console.log('Nothing to scrub today.'); return; }

  const contacts = candidates.map((c) => {
    const cleanPhone = cleanPhoneOf(c.properties.phone, c.properties.mobilephone);
    const consentDate =
      hsToDate(c.properties.install_completed_date__c) ||
      hsToDate(c.properties.recent_deal_close_date) ||
      hsToDate(c.properties.latest_deal_created_date) ||
      hsToDate(c.properties.createdate);
    return { id: c.id, properties: c.properties, cleanPhone, consentDate };
  });

  const withPhone = contacts.filter((c) => c.cleanPhone);
  const withoutPhone = contacts.filter((c) => !c.cleanPhone);
  console.log(`[Main] withPhone=${withPhone.length} withoutPhone=${withoutPhone.length}`);

  let resultsByPhone = new Map();
  if (HAS_DNC_CREDS && withPhone.length > 0) {
    resultsByPhone = await runQuickCheckChunks(withPhone);
  }

  const inputs = contacts.map((c) => ({
    id: c.id,
    properties: deriveProps(c, resultsByPhone, todayIso),
  }));

  const { updated, failed } = await batchUpdate(inputs);
  console.log(`✅ Bulk DNC scrub done — updated=${updated} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('❌ Fatal error in bulk DNC scrub:', err);
  process.exitCode = 1;
});
