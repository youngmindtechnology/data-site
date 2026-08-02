const axios = require('axios');
const crypto = require('crypto');

/*
 * DataMart Ghana API client — data bundles + result checkers.
 *
 * Written against DataMart's published developer docs. Two things worth
 * flagging that aren't 100% pinned down by the docs themselves:
 *
 * 1. Base path for the data endpoints. The docs state the base URL as
 *    https://api.datamartgh.shop/api/developer and list endpoints as
 *    POST /verify-number, POST /purchase, POST /bulk-purchase,
 *    GET /data-packages, GET /balance relative to it — but the curl
 *    examples in the "Purchase Data" and "Bulk Purchase" pages show
 *    https://api.datamartgh.shop/api/purchase and .../api/bulk-purchase
 *    (no "/developer" segment). That's an inconsistency in the docs, not
 *    something I'm guessing at. I've gone with the stated Base URL section
 *    since it's declared explicitly and applies uniformly; if you get 404s
 *    on live calls, try DATAMART_DATA_BASE_URL without the /developer
 *    segment and it'll match the curl examples instead.
 * 2. The HMAC-signed withdrawal API is admin-gated per-key and not wired up
 *    here since this storefront never triggers payouts — only DataMart
 *    wallet debits via /purchase and /api/checkers/purchase.
 */

const DATA_BASE_URL = process.env.DATAMART_DATA_BASE_URL || 'https://api.datamartgh.shop/api/developer';
const CHECKERS_BASE_URL = process.env.DATAMART_CHECKERS_BASE_URL || 'https://api.datamartgh.shop/api/checkers';
const API_KEY = process.env.DATAMART_API_KEY;
// Only set if you've enabled the "second secret" API rule on this key in the
// DataMart dashboard (Authentication docs → "API rules").
const API_SECRET = process.env.DATAMART_API_SECRET;

function authHeaders(extra = {}) {
  if (!API_KEY) throw new Error('DATAMART_API_KEY is not set');
  const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', ...extra };
  if (API_SECRET) headers['X-API-Secret'] = API_SECRET;
  return headers;
}

function dataClient() {
  return axios.create({ baseURL: DATA_BASE_URL, timeout: 20000 });
}

function checkersClient() {
  return axios.create({ baseURL: CHECKERS_BASE_URL, timeout: 20000 });
}

function newIdempotencyKey() {
  return crypto.randomUUID();
}

/**
 * GET /data-packages?network=YELLO|TELECEL|AT_PREMIUM
 * Omit network to get all three back at once.
 * Response: { status, pricingTier, data: { YELLO: [{capacity, mb, network, price}], TELECEL: [...], AT_PREMIUM: [...] } }
 */
async function getPackages(network) {
  const res = await dataClient().get('/data-packages', {
    headers: authHeaders(),
    params: network ? { network } : undefined,
  });
  return res.data;
}

/**
 * POST /verify-number — free, non-charging pre-check.
 * Hard-capped by DataMart at 2 requests/min PER API KEY (not per caller —
 * see the global limiter around verifyNumber's caller in server.js, since
 * every visitor to this site shares one key).
 * Response: { status, data: { phoneNumber, network, servable, recommendation, message, cached } }
 * On 429 the body includes a retryAfter (seconds) — surface that to the caller.
 */
async function verifyNumber(phoneNumber) {
  const res = await dataClient().post(
    '/verify-number',
    { phoneNumber },
    { headers: authHeaders() }
  );
  return res.data;
}

/**
 * POST /verify-number/bulk — up to 100 numbers per call, non-charging.
 * Accepts plain strings or order-item objects with number / _beneficiary_number.
 * Response: { status, summary: { total, accepted, rejected }, results: [...] }
 */
async function verifyNumberBulk(numbers) {
  const res = await dataClient().post(
    '/verify-number/bulk',
    { numbers },
    { headers: authHeaders() }
  );
  return res.data;
}

/**
 * POST /purchase — debits the wallet and delivers a data bundle.
 * idempotencyKey should be unique per logical purchase (use the internal
 * order reference). Same key seen again within 24h returns the original
 * response instead of double-charging — safe to retry on timeout/5xx with
 * the SAME key, never generate a new one after a timeout.
 * Response: { status, message, data: { purchaseId, orderReference,
 *   transactionReference, network, capacity, price, balanceBefore,
 *   balanceAfter, orderStatus, processingMethod }, rateLimit: {...} }
 */
async function purchaseData({ phoneNumber, network, capacity }, idempotencyKey) {
  const res = await dataClient().post(
    '/purchase',
    { phoneNumber, network, capacity, gateway: 'wallet' },
    { headers: authHeaders({ 'X-Idempotency-Key': idempotencyKey || newIdempotencyKey() }) }
  );
  return res.data;
}

/**
 * POST /bulk-purchase — up to 50 orders in one call, single idempotency key
 * for the whole batch (not per-order). If balance runs out mid-batch,
 * remaining orders stop; already-processed ones are still charged/delivered.
 * orders: [{ phoneNumber, network, capacity, ref? }, ...]
 */
async function bulkPurchaseData(ordersList, idempotencyKey) {
  const res = await dataClient().post(
    '/bulk-purchase',
    { orders: ordersList },
    { headers: authHeaders({ 'X-Idempotency-Key': idempotencyKey || newIdempotencyKey() }) }
  );
  return res.data;
}

/**
 * GET /balance — the shared DataMart wallet balance.
 * Response: { status, data: { balance, currency, user: {...}, timestamp } }
 */
async function getBalance() {
  const res = await dataClient().get('/balance', { headers: authHeaders() });
  return res.data;
}

/**
 * GET /api/checkers/products — WAEC/BECE checker catalog with live stock.
 * Response: { status, data: [{ id, name, description, price, inStock, stockCount }, ...] }
 */
async function getCheckerProducts() {
  const res = await checkersClient().get('/products', { headers: authHeaders() });
  return res.data;
}

/**
 * POST /api/checkers/purchase — debits the (same) wallet, issues one
 * serial/PIN. `ref` is DataMart's own de-dup / idempotency mechanism here
 * (not a header) — pass the internal order reference. If you've set a
 * reference-prefix rule on your API key, this ref must match it, since
 * checker purchases are covered by data-order reference rules by default
 * (see Authentication docs) unless you scoped that rule to data orders only.
 * skipSms: true withholds DataMart's SMS so you can display serial/pin
 * yourselves — if you pass that, you MUST persist the response, since it's
 * the only place the buyer's card ever appears.
 * Response: { status, message, data: { purchaseId, reference, checkerType,
 *   serialNumber, pin, phoneNumber, price, balanceBefore, balanceAfter,
 *   transactionId, createdAt, smsNotification } }
 */
async function purchaseChecker({ checkerType, phoneNumber, skipSms, ref }) {
  const res = await checkersClient().post(
    '/purchase',
    { checkerType, phoneNumber, skipSms: !!skipSms, ref },
    { headers: authHeaders() }
  );
  return res.data;
}

/**
 * GET /api/checkers/order-status/:reference — re-read a checker purchase,
 * including the serial/PIN, scoped to your own account.
 */
async function getCheckerOrderStatus(reference) {
  const res = await checkersClient().get(`/order-status/${encodeURIComponent(reference)}`, {
    headers: authHeaders(),
  });
  return res.data;
}

/**
 * GET /order-status/:reference — re-check a data order's status directly
 * with DataMart, using THEIR orderReference (the GN-... code), not your
 * own YMDP-... reference. Get this value from order.fulfillment.orderReference
 * on an already-fulfilled order.
 * Response: { status, data: { orderId, reference, phoneNumber, network,
 *   capacity, price, orderStatus, processingMethod, createdAt, updatedAt } }
 */
async function getOrderStatus(orderReference) {
  const res = await dataClient().get(`/order-status/${encodeURIComponent(orderReference)}`, {
    headers: authHeaders(),
  });
  return res.data;
}

module.exports = {
  getPackages,
  verifyNumber,
  verifyNumberBulk,
  purchaseData,
  bulkPurchaseData,
  getBalance,
  getCheckerProducts,
  purchaseChecker,
  getCheckerOrderStatus,
};