/**
 * Postcode callout fee calculator
 *
 * Base: Didsbury, Manchester M20 (53.4282°N, 2.2141°W)
 * - Free within FREE_RADIUS_MILES (default 10)
 * - £CALLOUT_RATE_PER_MILE per mile beyond that
 * - Decline if beyond MAX_RADIUS_MILES (default 25)
 *
 * Uses the free postcodes.io API to resolve UK postcodes to lat/lng.
 * Falls back to Haversine formula for distance — no Google Maps key needed.
 */

const axios = require('axios');

const BASE_LAT = parseFloat(process.env.BASE_LAT || '53.4282');
const BASE_LNG = parseFloat(process.env.BASE_LNG || '-2.2141');
const FREE_RADIUS = parseFloat(process.env.FREE_RADIUS_MILES || '10');
const RATE_PER_MILE = parseFloat(process.env.CALLOUT_RATE_PER_MILE || '1.50');
const MAX_RADIUS = parseFloat(process.env.MAX_RADIUS_MILES || '25');

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return (deg * Math.PI) / 180; }

async function lookupPostcode(postcode) {
  const clean = postcode.replace(/\s+/g, '').toUpperCase();
  try {
    const res = await axios.get(`https://api.postcodes.io/postcodes/${clean}`);
    if (res.data.status !== 200) throw new Error('Not found');
    const { latitude, longitude, postcode: canonical } = res.data.result;
    return { lat: latitude, lng: longitude, postcode: canonical };
  } catch { throw new Error(`Could not find postcode "${postcode}".`); }
}

aasync function calculateCalloutFee(postcode) {
  const location = await lookupPostcode(postcode);
  const distanceMiles = haversineMiles(BASE_LAT, BASE_LNG, location.lat, location.lng);
  const roundedMiles = Math.round(distanceMiles * 10) / 10;
  if (distanceMiles > MAX_RADIUS) { return { postcode: location.postcode, distanceMiles: roundedMiles, fee: null, withinRange: false, message: `Sorry, ${location.postcode} is ${roundedMiles} miles away — we currently only cover up to ${MAX_RADIUS} miles from Didsbury M20.` }; }
  const chargeableMiles = Math.max(0, distanceMiles - FREE_RADIUS);
  const fee = Math.round(chargeableMiles * RATE_PER_MILE * 100) / 100;
  const message = fee === 0 ? `Great news - ${location.postcode} is within our free zone. No callout fee.` : `${location.postcode} is ${roundedMiles} miles away. Callout fee: £${fee.toFixed(2)}.`;
  return { postcode: location.postcode, distanceMiles: roundedMiles, fee, withinRange: true, message };
}

function extractPostcode(text) {
  const match = text.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2})\b/i);
  return match ? match[1].trim().toUpperCase() : null;
}

module.exports = { calculateCalloutFee, extractPostcode, lookupPostcode };
