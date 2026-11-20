import { round2 } from './http.ts';

const DAY = 24 * 60 * 60 * 1000;
export const TIMEZONE = 'Asia/Kolkata';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export const dayKey = (date) => dayFormat.format(date);

/** Ranges over 90 days are bucketed by month, shorter ones by day. */
export const bucketFormat = (days) => (days > 90 ? '%Y-%m' : '%Y-%m-%d');

/** Turns sparse aggregation rows ({ _id: bucketKey, ...fields }) into a continuous, zero-filled series. */
export function fillSeries(rows, days, fields) {
  const monthly = days > 90;
  const byKey = new Map(rows.map((r) => [r._id, r]));
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(new Date(Date.now() - i * DAY));
    const bucket = monthly ? key.slice(0, 7) : key;
    if (keys[keys.length - 1] !== bucket) keys.push(bucket);
  }
  return keys.map((key) => {
    const row = byKey.get(key) || {};
    return { date: key, ...Object.fromEntries(fields.map((f) => [f, round2(row[f] || 0)])) };
  });
}

export const percentChange = (current, previous) =>
  previous ? round2(((current - previous) / previous) * 100) : current ? 100 : 0;

export const rangeStart = (days) => new Date(Date.now() - days * DAY);
