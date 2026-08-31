'use strict';

const fs = require('fs');
const path = require('path');

// FTC National DNC Registry (telemarketing.donotcall.gov) client — Full List / Change
// List download per area code.
//
// The registry's SAN-authenticated download endpoints are account-specific and only show
// up once you're logged into telemarketing.donotcall.gov with the SAN — there's no public
// API doc to hardcode a URL against. Configure the real endpoints once you have them:
//
//   DNC_FULL_LIST_URL_TEMPLATE   e.g. https://telemarketing.donotcall.gov/.../fulllist?areaCode={areaCode}
//   DNC_CHANGE_LIST_URL_TEMPLATE e.g. https://telemarketing.donotcall.gov/.../changelist?areaCode={areaCode}&date={date}
//   DNC_SAN                      your Subscription Account Number
//   DNC_SAN_USERNAME / DNC_SAN_PASSWORD   Basic Auth, if that's how the portal authenticates
//   DNC_SAN_TOKEN                 Bearer token, if the portal issues one instead
//
// DNC_MOCK_DIR points at a local directory of fixture files (see test/fixtures) so the
// whole pipeline — download, parse, upsert/delete, sync_log — can be exercised end-to-end
// before real SAN credentials exist.

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(vars[key] ?? ''));
}

function authHeaders() {
  if (process.env.DNC_SAN_TOKEN) {
    return { Authorization: `Bearer ${process.env.DNC_SAN_TOKEN}` };
  }
  if (process.env.DNC_SAN_USERNAME && process.env.DNC_SAN_PASSWORD) {
    const b64 = Buffer.from(`${process.env.DNC_SAN_USERNAME}:${process.env.DNC_SAN_PASSWORD}`).toString('base64');
    return { Authorization: `Basic ${b64}` };
  }
  return {};
}

async function fetchWithRetry(url, opts, tries = 4, base = 1000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status} fetching ${url}`);
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) break;
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, base * Math.pow(2, i)));
  }
  throw lastErr;
}

function mockFilePath(kind, areaCode) {
  const dir = process.env.DNC_MOCK_DIR;
  return path.join(dir, `${kind}_${areaCode}.txt`);
}

async function fetchFullList(areaCode) {
  if (process.env.DNC_MOCK_DIR) {
    const p = mockFilePath('full', areaCode);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  const template = process.env.DNC_FULL_LIST_URL_TEMPLATE;
  if (!template) throw new Error('DNC_FULL_LIST_URL_TEMPLATE not configured — see lib/registryClient.js header');
  const url = fillTemplate(template, { areaCode, san: process.env.DNC_SAN });
  return fetchWithRetry(url, { headers: authHeaders() });
}

async function fetchChangeList(areaCode, dateIso) {
  if (process.env.DNC_MOCK_DIR) {
    const p = mockFilePath('change', areaCode);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  const template = process.env.DNC_CHANGE_LIST_URL_TEMPLATE;
  if (!template) throw new Error('DNC_CHANGE_LIST_URL_TEMPLATE not configured — see lib/registryClient.js header');
  const url = fillTemplate(template, { areaCode, date: dateIso, san: process.env.DNC_SAN });
  return fetchWithRetry(url, { headers: authHeaders() });
}

module.exports = { fetchFullList, fetchChangeList };
