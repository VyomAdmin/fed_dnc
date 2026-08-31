'use strict';

// Lambda entry point for scripts/hubspot_dnc_writeback.js — writes dnc_opt_out
// back onto HubSpot contacts matched against the local dnc_numbers table.
// Deployed with NO trigger attached. Do not invoke until explicitly approved —
// this is a write against real contact data.
// Event shape: { "listId": "1988", "dryRun": true }

const { main } = require('../scripts/hubspot_dnc_writeback');

exports.handler = async (event) => {
  const result = await main({ listId: event?.listId, dryRun: event?.dryRun });
  return { statusCode: 200, body: result };
};
