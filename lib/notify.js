'use strict';

// Chat webhook post (Google Chat and Slack incoming webhooks both accept a
// plain {"text": "..."} JSON body), shared by daily_sync.js's failure alerts
// and the daily pipeline's summary report.

async function postChatMessage(webhookUrl, text) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error(`[Notify] webhook post failed: ${e.message}`);
  }
}

module.exports = { postChatMessage };
