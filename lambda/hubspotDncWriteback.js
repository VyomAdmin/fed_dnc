'use strict';

// Lambda entry point for scripts/hubspot_dnc_writeback.js — writes dnc_opt_out
// back onto HubSpot contacts matched against the local dnc_numbers table.
// Deployed with NO trigger attached. Do not invoke until explicitly approved —
// this is a write against real contact data.
//
// Event shape: { "listId": "1988", "sinceDate": "2026-08-31", "dryRun": true }
//   - omit sinceDate for the one-time full check (run once, after seed_full_list)
//   - pass sinceDate (typically today) for the daily diff check (run once/day,
//     after dailySync), so this only processes that day's newly added numbers

const { main } = require('../scripts/hubspot_dnc_writeback');

exports.handler = async (event) => {
  const result = await main({ listId: event?.listId, sinceDate: event?.sinceDate, dryRun: event?.dryRun });
  return { statusCode: 200, body: result };
};
