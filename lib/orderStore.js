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
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function get(reference) {
  const all = readAll();
  return all[reference] || null;
}

function save(order) {
  const all = readAll();
  all[order.reference] = order;
  writeAll(all);
  return order;
}

function list() {
  const all = readAll();
  return Object.values(all).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function findByAnyReference(reference) {
  if (!reference) return null;
  const all = readAll();
  const direct = all[reference];
  if (direct) return direct;
  const needle = String(reference).trim().toUpperCase();
  return Object.values(all).find((o) => {
    const dmRef = o.type === 'data' ? o.fulfillment?.orderReference : o.fulfillment?.reference;
    return dmRef && String(dmRef).trim().toUpperCase() === needle;
  }) || null;
}

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

module.exports = { get, save, list, readAll, writeAll, findByAnyReference, withLock };