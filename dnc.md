'use strict';

// ---------- helpers ----------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const shouldRetry = (s) => [408, 429, 500, 502, 503, 504].includes(Number(s));

async function fetchWithRetry(url, opts = {}, tries = 2, base = 500) {
  let lastErr, lastBody = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!shouldRetry(res.status)) return res;
      lastBody = await res.text().catch(() => '');
      console.warn(`[fetchWithRetry] retry ${i + 1}/${tries} status=${res.status} url=${url} bodySample=${lastBody.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      console.warn(`[fetchWithRetry] network retry ${i + 1}/${tries}: ${e.message}`);
    }
    await delay(base * Math.pow(2, i) + Math.floor(Math.random() * 200));
  }
  throw new Error(`fetchWithRetry exhausted: ${lastErr?.message || 'unknown'}`);
}

/** Parse HS-ish date value to Date object (or null) */
function hsToDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    let n = Number(s);
    if (n > 1e12) n = n / 1000000; // micros → sec
    if (n > 1e10) n = n / 1000;     // millis → sec
    const d = new Date(n * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Add months safely (handles end-of-month rollovers) */
function addMonthsSafe(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

/** Format a Date as MM/DD/YYYY (for LastEBRDate / LastRNDDate params) */
function toMMDDYYYYSlash(date) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

const DNC_OAUTH_TOKEN_URL = 'https://oauth.dncsolution.com/oauth2/v1/token';
const QUICKCHECK_CLIENT_ID = '18856';
const QUICKCHECK_AUTH_PROFILE_ID = '1524';

/** Fetch an OAuth2 client-credentials bearer token for the v4 QuickCheck API */
async function fetchDncOAuthToken(clientId, clientSecret, scope, tries = 3, base = 500) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope, client_id: clientId, client_secret: clientSecret });
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(DNC_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString(),
      });
      const raw = await res.text();
      if (res.ok) {
        const json = JSON.parse(raw);
        return json.access_token;
      }
      console.warn(`[OAuth] status=${res.status} bodySample=${raw.slice(0, 200)}`);
      if (shouldRetry(res.status) && i < tries - 1) { await delay(base * Math.pow(2, i)); continue; }
      return null;
    } catch (e) {
      console.warn(`[OAuth] network error attempt ${i + 1}: ${e.message}`);
      if (i < tries - 1) { await delay(base * Math.pow(2, i)); continue; }
      return null;
    }
  }
  return null;
}

/** POST with retry to the v4 QuickCheck API (bearer token auth) */
async function quickcheckRequestWithRetry(token, body, tries = 6, base = 500) {
  const url = `https://api.dncsolution.com/v4/${QUICKCHECK_CLIENT_ID}/Quickcheck/${QUICKCHECK_AUTH_PROFILE_ID}`;
  let lastRaw = '';
  for (let i = 0; i < tries; i++) {
    try {
      console.log(`[QuickCheck] POST ${url} (attempt ${i + 1}/${tries})`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      lastRaw = (await res.text()) || '';
      console.log(`[QuickCheck] status=${res.status} bodySample=${lastRaw.slice(0, 200)}`);
      if (res.ok) {
        try { return { ok: true, json: JSON.parse(lastRaw), raw: lastRaw }; }
        catch { console.warn('[QuickCheck] Non-JSON response'); }
      }
      if (shouldRetry(res.status) && i < tries - 1) {
        await delay(base * Math.pow(2, i) + Math.floor(Math.random() * 250));
        continue;
      }
      return { ok: false, json: null, raw: lastRaw };
    } catch (e) {
      console.warn(`[QuickCheck] network error attempt ${i + 1}: ${e.message}`);
      if (i < tries - 1) { await delay(base * Math.pow(2, i) + Math.floor(Math.random() * 250)); continue; }
      return { ok: false, json: null, raw: lastRaw };
    }
  }
  return { ok: false, json: null, raw: lastRaw };
}

// RNDStatus code → meaning (confirmed with vendor). Unmapped/unknown codes are logged
// to reassigned_api_log but leave phone_reassigned unset rather than guess.
const RND_STATUS_MAP = { RNN: false, RNY: true };

const DEAL_PROPERTIES = ['install_completed_date__c', 'status_code__c', 'closedate', 'hs_lastmodifieddate'];

/** install_completed_date__c and status_code__c live on the Deal, not the Contact —
 *  look up the contact's associated deals and use the most recently closed/updated one. */
async function fetchPrimaryDeal(contactId, hubspotToken) {
  const assocUrl = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/deals`;
  const assocRes = await fetchWithRetry(assocUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${hubspotToken}` } });
  const assocTxt = await assocRes.text();
  if (!assocRes.ok) { console.warn(`[Deals] association lookup failed status=${assocRes.status}`); return null; }

  let dealIds = [];
  try { dealIds = (JSON.parse(assocTxt).results || []).map((r) => r.toObjectId); } catch { /* leave empty */ }
  if (dealIds.length === 0) { console.warn(`[Deals] no associated deals for contact ${contactId}`); return null; }

  const dealsRes = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hubspotToken}` },
    body: JSON.stringify({ properties: DEAL_PROPERTIES, inputs: dealIds.map((id) => ({ id })) }),
  });
  const dealsTxt = await dealsRes.text();
  if (!dealsRes.ok) { console.warn(`[Deals] batch read failed status=${dealsRes.status}`); return null; }

  let deals = [];
  try { deals = JSON.parse(dealsTxt).results || []; } catch { return null; }
  if (deals.length === 0) return null;

  deals.sort((a, b) => {
    const aKey = hsToDate(a.properties.closedate) || hsToDate(a.properties.hs_lastmodifieddate) || new Date(0);
    const bKey = hsToDate(b.properties.closedate) || hsToDate(b.properties.hs_lastmodifieddate) || new Date(0);
    return bKey - aKey;
  });
  console.log(`[Deals] ${deals.length} associated deal(s), using most recently closed/updated: ${deals[0].id}`);
  return deals[0].properties;
}

// ---------- HubSpot Custom Code entry ----------
exports.main = async (event, callback) => {
  try {
    console.log('🟢 Start Node DNC/HubSpot handler');
    const input = event.inputFields || {};

    // --- Env & IDs ---
    const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!HUBSPOT_TOKEN) throw new Error('Missing env HUBSPOT_PRIVATE_APP_TOKEN');

    const DNC_OAUTH_CLIENT_ID = process.env.DNC_OAUTH_CLIENT_ID;
    const DNC_OAUTH_CLIENT_SECRET = process.env.DNC_OAUTH_CLIENT_SECRET;
    const DNC_OAUTH_SCOPE = process.env.DNC_OAUTH_SCOPE;
    const hasDncCreds = DNC_OAUTH_CLIENT_ID && DNC_OAUTH_CLIENT_SECRET && DNC_OAUTH_SCOPE;
    if (!hasDncCreds) console.warn('⚠️ Missing DNC_OAUTH_CLIENT_ID/SECRET/SCOPE; DNC/litigator/reassignment checks will be skipped.');

    const contactId = input.hs_object_id;
    if (!contactId) throw new Error('Contact ID (contactId) not provided by the workflow');

    // Phone (optional, only needed for DNC call)
    const phoneRaw = input.phone || input.mobilephone;
    let cleanPhone = null;
    if (phoneRaw) {
      let digits = String(phoneRaw).replace(/\D/g, '');
      if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
      cleanPhone = digits.length === 10 ? digits : null;
      if (!cleanPhone) console.warn(`⚠️ Phone '${phoneRaw}' did not resolve to 10 digits; skipping DNC lookup but will still PATCH HubSpot.`);
    } else {
      console.warn('⚠️ Phone missing; skipping DNC lookup but will still PATCH HubSpot.');
    }

    // Dates
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // install_completed_date__c / status_code__c live on the Deal — pull from the primary associated deal
    const primaryDeal = await fetchPrimaryDeal(contactId, HUBSPOT_TOKEN);
    const rawInstallCompleted = primaryDeal?.install_completed_date__c || null;
    const statusCodeRaw       = primaryDeal?.status_code__c || null;
    const isInstallCompleted = String(statusCodeRaw || '').trim().toLowerCase() === 'install completed';

    // Inputs used for rules
    const rawLatestDealCreated = input.latest_deal_created_date;
    const rawContactCreated    = input.createdate;
    const rawLastContact       = input.recent_deal_close_date;
    const pewcRaw              = input.pewc__c;
    const isPewc = pewcRaw === true || String(pewcRaw).trim().toLowerCase() === 'true';

    console.log(`[HubSpot] install_completed_date__c='${rawInstallCompleted}', status_code__c='${statusCodeRaw}', pewc__c='${pewcRaw}' (isPewc=${isPewc})`);

    // --- Build properties to update (always stamp scrub date) ---
    const updateProps = {};
    updateProps.dnc_scrubbed_on__c = todayIso; // <-- ALWAYS set every run

    // (A) DNC / EBR / litigator / reassignment — all via one v4 QuickCheck call, only if we have a phone
    if (cleanPhone && hasDncCreds) {
      // Consent date for EBR/RND evaluation: install date is the authoritative anchor;
      // fall back to older signals only if install_completed_date__c is missing.
      const consentDate =
        hsToDate(rawInstallCompleted) ||
        hsToDate(rawLastContact) ||
        hsToDate(rawLatestDealCreated) ||
        hsToDate(rawContactCreated);
      const consentDateSlash = consentDate ? toMMDDYYYYSlash(consentDate) : null;

      console.log(isInstallCompleted
        ? `[QuickCheck] status_code__c='Install Completed' ⇒ EBR check (consentDate=${consentDateSlash || 'none'})`
        : `[QuickCheck] status_code__c='${statusCodeRaw}' ⇒ regular DNC check (no EBR/RND date sent)`);

      const token = await fetchDncOAuthToken(DNC_OAUTH_CLIENT_ID, DNC_OAUTH_CLIENT_SECRET, DNC_OAUTH_SCOPE);

      if (!token) {
        updateProps.dnc_api_log = 'OAUTH_TOKEN_FETCH_FAILED';
      } else {
        const qcEntry = { PhoneNumber: cleanPhone };
        if (isInstallCompleted && consentDateSlash) {
          qcEntry.LastEBRDate = consentDateSlash;
          qcEntry.LastRNDDate = consentDateSlash;
        }

        const { ok, json, raw } = await quickcheckRequestWithRetry(token, [qcEntry]);

        if (ok && json && Array.isArray(json.QuickCheckResults) && json.QuickCheckResults.length > 0) {
          updateProps.dnc_api_log = (raw || '').slice(0, 64000);
          const result = json.QuickCheckResults[0];
          const filters = Array.isArray(result.Filters) ? result.Filters : [];

          // --- Litigator ---
          const litigatorFlag = filters.some((f) => /litigator/i.test(f.FilterName || ''));
          updateProps.litigator = litigatorFlag ? 'Yes' : 'No';

          // --- DNC/EBR ---
          // A litigator-only match also sets Status="DNC", so exclude litigator filters when
          // deciding dnc_opt_out — otherwise litigator hits would wrongly flip opt-out too.
          const nonLitigatorHit = filters.some((f) => !/litigator/i.test(f.FilterName || ''));
          const dncOptOut = String(result.Status || '').trim().toUpperCase() === 'DNC' && nonLitigatorHit;
          updateProps.dnc_opt_out = dncOptOut;

          if (dncOptOut) {
            updateProps.dnc_call_thru_date__c = todayIso;
          } else if (isPewc) {
            console.log('[EBR] pewc__c=true ⇒ authorized until dnc_opt_out flips true; no expiration set');
          } else {
            const installDt = hsToDate(rawInstallCompleted);
            if (installDt) {
              updateProps.dnc_call_thru_date__c = addMonthsSafe(installDt, 18).toISOString().slice(0, 10);
            } else {
              console.warn('[EBR] Missing/unparseable install_completed_date__c; cannot compute 18-month EBR window');
            }
          }

          // --- Reassignment ---
          let reassignedFlag = null;
          const rndStatus = result.RNDStatus;
          if (rndStatus != null) {
            if (Object.prototype.hasOwnProperty.call(RND_STATUS_MAP, rndStatus)) {
              reassignedFlag = RND_STATUS_MAP[rndStatus];
              updateProps.phone_reassigned = reassignedFlag ? 'Yes' : 'No';
            } else {
              console.warn(`[Reassigned] Unmapped RNDStatus='${rndStatus}' — leaving phone_reassigned unset`);
            }
          }

          // --- Composite risk rollup ---
          updateProps.dnc_composite_risk = (dncOptOut === true || litigatorFlag === true || reassignedFlag === true) ? 'Yes' : 'No';
        } else {
          updateProps.dnc_api_log = 'RETRY';
        }
      }
    } else if (cleanPhone && !hasDncCreds) {
      updateProps.dnc_api_log = 'SKIPPED_NO_OAUTH_CREDS';
    }

    console.log('[HubSpot] Prepared properties:', updateProps);

    // --- PATCH contact ---
    const patchUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
    const patchRes = await fetchWithRetry(patchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
      },
      body: JSON.stringify({ properties: updateProps }),
    });

    const patchTxt = await patchRes.text();
    console.log(`[HubSpot] PATCH status=${patchRes.status} ok=${patchRes.ok}`);
    if (!patchRes.ok) {
      console.error('[HubSpot] PATCH error body:', patchTxt);
      return callback({
        outputFields: {
          status: `HubSpot PATCH failed: ${patchRes.status}`,
          error_body: patchTxt.slice(0, 5000),
        }
      });
    }

    console.log('[HubSpot] PATCH response sample:', patchTxt.slice(0, 800));
    return callback({ outputFields: { status: 'Contact updated successfully' } });
  } catch (err) {
    console.error('❌ Error in DNC workflow:', err);
    return callback({ outputFields: { status: `Error: ${err.message}` } });
  }
};
