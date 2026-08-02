const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'orders.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
}

function readAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
  } catch (err) {
    console.error('orderStore: corrupt data file, starting fresh:', err.message);
    return {};
  }
}

function writeAll(all) {
  ensureStore();
  // Write to a temp file then rename — avoids leaving a half-written file
  // behind if the process dies mid-write.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function save(order) {
  const all = readAll();
  all[order.reference] = order;
  writeAll(all);
  return order;
}

// Looks up strictly by YOUR reference (the YMDP-... key the store is
// actually keyed by). Kept as-is for callers that already know they have
// your reference (webhook/callback handlers, admin retry, etc).
function get(reference) {
  const all = readAll();
  return all[reference] || null;
}

function list() {
  const all = readAll();
  return Object.values(all).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Customers are given TWO references once an order is fulfilled: your own
// YMDP-... reference, and DataMart's own reference (GN-... for data,
// CHKW... for checkers) — the latter is sent in the confirmation SMS as
// "Tracking ID: ...". A customer plausibly pastes either one into "Track
// order", so lookups from customer-facing routes should match on both, not
// just the store's primary key. Falls back to a full scan only when the
// direct key lookup misses — the common case (searching by your own
// reference) stays O(1).
function findByAnyReference(reference) {
  if (!reference) return null;
  const all = readAll();

  const direct = all[reference];
  if (direct) return direct;

  const needle = String(reference).trim().toUpperCase();
  return (
    Object.values(all).find((o) => {
      const dmRef = o.type === 'data' ? o.fulfillment?.orderReference : o.fulfillment?.reference;
      return dmRef && String(dmRef).trim().toUpperCase() === needle;
    }) || null
  );
}

/*
 * Both the Paystack redirect callback and the webhook can try to fulfill the
 * same order at roughly the same time. This in-memory queue makes sure only
 * one fulfillment routine runs per reference at a time — the second caller
 * just waits its turn, sees status === 'fulfilled' already, and returns.
 * This only works within a single Node process; if you ever run this behind
 * a multi-instance/cluster deployment, swap it for a real distributed lock
 * (e.g. a DB row lock or Redis).
 */
const locks = new Map();

async function withLock(reference, fn) {
  const previous = locks.get(reference) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(reference, previous.then(() => current));

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(reference) === current) locks.delete(reference);
  }
}

module.exports = { save, get, list, findByAnyReference, withLock };