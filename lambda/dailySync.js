'use strict';

// Lambda entry point for the Day N Change List sync (scripts/daily_sync.js).
// Deployed but NOT wired to an enabled EventBridge trigger — the underlying
// script throws immediately if DNC_FULL_LIST_URL_TEMPLATE/DNC_SAN aren't
// configured, and the DNC registry must not be called until those are real.

const { main } = require('../scripts/daily_sync');

exports.handler = async () => {
  await main();
  return { statusCode: 200 };
};
