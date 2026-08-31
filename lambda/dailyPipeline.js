'use strict';

// Single Lambda, one EventBridge schedule: runs the full daily DNC pipeline
// in sequence and posts a Slack summary at the end.
//
//   1. daily_sync.js      — pull today's Change List diff from the registry,
//                            upsert/delete in dnc_numbers.
//   2. hubspot_dnc_writeback.js --since=today — match today's newly added
//                            numbers against HubSpot contact phones, stamp
//                            dnc_opt_out=true on matches only.
//   3. Slack report       — "Diffs downloaded" (step 1 totals) and
//                            "DNC stamped in HubSpot" (step 2 totals),
//                            posted to DNC_REPORT_WEBHOOK_URL (falls back to
//                            ALERT_WEBHOOK_URL if unset).
//
// Deployed but its EventBridge trigger is created DISABLED — do not enable
// until DNC_FULL_LIST_URL_TEMPLATE/DNC_SAN are real and step 2 has been
// approved to run against live contacts.

const { main: runDailySync } = require('../scripts/daily_sync');
const { main: runWriteback } = require('../scripts/hubspot_dnc_writeback');
const { postSlackMessage } = require('../lib/notify');

exports.handler = async () => {
  const todayIso = new Date().toISOString().slice(0, 10);
  let syncResult = null;
  let writebackResult = null;
  let error = null;

  try {
    syncResult = await runDailySync();
  } catch (e) {
    error = e;
  }

  if (!error) {
    try {
      writebackResult = await runWriteback({ sinceDate: todayIso });
    } catch (e) {
      error = e;
    }
  }

  const webhook = process.env.DNC_REPORT_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;
  const lines = [`📋 DNC daily pipeline — ${todayIso}`];
  lines.push(
    syncResult
      ? `Diffs downloaded: +${syncResult.totalAdded} / -${syncResult.totalRemoved} across ${syncResult.successCount}/${syncResult.successCount + syncResult.failCount} area code(s)`
      : 'Diffs downloaded: FAILED before completion'
  );
  lines.push(
    writebackResult
      ? `DNC stamped in HubSpot: ${writebackResult.updated} contact(s) updated (of ${writebackResult.matched} matched)`
      : 'DNC stamped in HubSpot: not run'
  );
  if (error) lines.push(`⚠️ Error: ${error.message}`);
  await postSlackMessage(webhook, lines.join('\n'));

  if (error) throw error;
  return { statusCode: 200, syncResult, writebackResult };
};
