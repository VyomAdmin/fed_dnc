'use strict';

// The 34 area codes under the Nuvision SAN subscription (FL 23 + AZ 5 + SC 6).
// Same set already confirmed with DNC Solutions support and used in bulk_dnc_scrub.js /
// new_base_scrub.js — kept here as the single source of truth for the daily-sync app.
const SAN_AREA_CODES = [
  '239', '305', '321', '324', '352', '386', '407', '448', '480', '520',
  '561', '602', '623', '645', '656', '689', '727', '728', '754', '772',
  '786', '803', '813', '821', '839', '843', '850', '854', '863', '864',
  '904', '928', '941', '954',
];

module.exports = { SAN_AREA_CODES };
