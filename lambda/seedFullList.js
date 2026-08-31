'use strict';

// Lambda entry point for the Day 0 Full List seed (scripts/seed_full_list.js).
// Ops-triggered only (aws lambda invoke), never scheduled.
// Event shape: { "areaCodes": ["407", "813"] }  — omit to seed all subscribed codes.

const { main } = require('../scripts/seed_full_list');

exports.handler = async (event) => {
  await main(event?.areaCodes);
  return { statusCode: 200 };
};
