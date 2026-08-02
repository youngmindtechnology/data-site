require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const datamart = require('./lib/datamart');
const paystack = require('./lib/paystack');
const orders = require('./lib/orderStore');

const app = express();
app.use(cors());
// Keep the raw request body around — needed to verify Paystack's webhook signature
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT || 10);
const FLAT_MARKUP_GHS = Number(process.env.FLAT_MARKUP_GHS || 2);
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE || ''; // local format, e.g. 0551234567 — where fulfillment-failure alerts go
const sms = require('./lib/sms');

function networkLabelFor(net) {
  return { YELLO: 'MTN', TELECEL: 'Telecel', AT_PREMIUM: 'AirtelTigo' }[net] || net;
}

// Paystack Ghana charges 1.95% flat on local transactions (card + mobile
// money) as of writing — see https://paystack.com/gh/pricing. If Paystack
// changes this rate, update PAYSTACK_FEE_PERCENT in .env; nothing else
// needs to change.
const PAYSTACK_FEE_PERCENT = Number(process.env.PAYSTACK_FEE_PERCENT || 1.95);
const PASS_PAYSTACK_FEE_TO_CUSTOMER = String(process.env.PASS_PAYSTACK_FEE_TO_CUSTOMER ?? 'true').toLowerCase() === 'true';

// Applies the percentage markup first, then adds the flat cedi amount on top.
// This is your sticker price — no Paystack fee in it.
function toRetail(cost) {
  const withPercent = Number(cost) * (1 + MARKUP_PERCENT / 100);
  const retail = withPercent + FLAT_MARKUP_GHS;
  return Math.round(retail * 100) / 100;
}

// Grosses up a price so that AFTER Paystack takes its cut, you still net
// exactly `netAmount` — i.e. the customer effectively covers Paystack's fee
// instead of it coming out of your markup. Only ever applied at checkout,
// never to the price shown while browsing.
// Math: if Paystack takes feePercent% of the gross charge, then
//   net = gross * (1 - feePercent/100)  =>  gross = net / (1 - feePercent/100)
function addPaystackFee(netAmount) {
  if (!PASS_PAYSTACK_FEE_TO_CUSTOMER) return netAmount;
  const gross = netAmount / (1 - PAYSTACK_FEE_PERCENT / 100);
  return Math.round(gross * 100) / 100;
}

// Manual price overrides for specific data bundles — these win over the
// toRetail() formula above, and are treated as an exact final selling price
// (the Paystack fee is NOT added on top of an override — if you fixed a
// bundle at a specific number, that's what the customer pays, full stop).
// Key format: `${network}:${capacity}`.
// network codes: YELLO = MTN, TELECEL = Telecel, AT_PREMIUM = AirtelTigo.
const PRICE_OVERRIDES = {
  'YELLO:1': 5.00 // MTN 1GB fixed at GH₵5.00, per your instruction — ignores markup/flat fee/Paystack fee for this one bundle
};

// Sticker price — what's shown while browsing. Markup only, no Paystack fee.
function basePriceFor(network, capacity, cost) {
  const key = `${network}:${capacity}`;
  if (Object.prototype.hasOwnProperty.call(PRICE_OVERRIDES, key)) {
    return PRICE_OVERRIDES[key];
  }
  return toRetail(cost);
}

// What Paystack actually charges the customer — base price + Paystack's fee,
// added only at checkout. Checked by /api/orders/init so the customer is
// never charged anything the browser didn't already show them.
function chargePriceFor(network, capacity, cost) {
  const key = `${network}:${capacity}`;
  if (Object.prototype.hasOwnProperty.call(PRICE_OVERRIDES, key)) {
    return PRICE_OVERRIDES[key];
  }
  return addPaystackFee(toRetail(cost));
}

function newReference() {
  return ('YMDP-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')).toUpperCase();
}

function isValidPhone(p) { return typeof p === 'string' && /^0\d{9}$/.test(p); }
function isValidEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function relay(res, err) {
  if (err.response) return res.status(err.response.status).json(err.response.data);
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Server error. Please try again.' });
}

// DataMart caps /verify-number at 2 requests/min for the WHOLE API key, not
// per caller (confirmed in their docs). Every visitor to this site shares
// that one key, so the throttle has to be global — a per-IP guard would
// still let several different visitors blow through the 2/min ceiling
// within the same minute. This only works within a single Node process; if
// you ever run multiple instances behind a load balancer, swap this for a
// shared counter (e.g. Redis) or the instances will each think they have
// their own 2/min budget.
const GLOBAL_VERIFY_LIMIT = 2;
const GLOBAL_VERIFY_WINDOW_MS = 60 * 1000;
let verifyTimestamps = [];
function verifyThrottle(req, res, next) {
  const now = Date.now();
  verifyTimestamps = verifyTimestamps.filter((t) => now - t < GLOBAL_VERIFY_WINDOW_MS);
  if (verifyTimestamps.length >= GLOBAL_VERIFY_LIMIT) {
    const retryAfter = Math.ceil((GLOBAL_VERIFY_WINDOW_MS - (now - verifyTimestamps[0])) / 1000);
    return res.status(429).json({
      status: 'error',
      message: 'Number checks are limited right now — please try again shortly.',
      retryAfter,
    });
  }
  verifyTimestamps.push(now);
  next();
}

/* ============================================================
   PUBLIC CATALOG — cost price never leaves the server
   ============================================================ */

app.get('/api/config', (req, res) => {
  res.json({
    status: 'success',
    data: {
      paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
      // Exposed so the frontend can show an accurate "+X% Paystack fee"
      // note without hardcoding the number in two places.
      paystackFeePercent: PAYSTACK_FEE_PERCENT,
      passFeeToCustomer: PASS_PAYSTACK_FEE_TO_CUSTOMER,
    },
  });
});

app.get('/api/packages', async (req, res) => {
  try {
    const r = await datamart.getPackages(req.query.network);
    const out = {};
    Object.keys(r.data).forEach((net) => {
      out[net] = r.data[net].map((p) => ({
        capacity: p.capacity,
        mb: p.mb,
        network: p.network,
        price: basePriceFor(net, p.capacity, p.price),       // sticker price, no Paystack fee
        payable: chargePriceFor(net, p.capacity, p.price),   // what Paystack will actually charge
      }));
    });
    res.json({ status: 'success', data: out });
  } catch (err) { relay(res, err); }
});

app.get('/api/checkers/products', async (req, res) => {
  try {
    const r = await datamart.getCheckerProducts();
    const out = r.data.map((p) => ({
      name: p.name,
      description: p.description,
      inStock: p.inStock,
      price: toRetail(p.price),
      payable: addPaystackFee(toRetail(p.price)),
    }));
    res.json({ status: 'success', data: out });
  } catch (err) { relay(res, err); }
});

app.post('/api/verify-number', verifyThrottle, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({ status: 'error', message: 'Enter a valid 10-digit number, e.g. 0551234567.' });
    }
    const r = await datamart.verifyNumber(phoneNumber);
    res.json(r);
  } catch (err) { relay(res, err); }
});

/* ============================================================
   ORDERS — customer starts a purchase, we start a Paystack charge
   ============================================================ */

app.post('/api/orders/init', async (req, res) => {
  try {
    const { type, phoneNumber, email } = req.body;

    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({ status: 'error', message: 'Enter a valid 10-digit phone number.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ status: 'error', message: 'Enter a valid email — Paystack sends your receipt there.' });
    }

    let order;

    if (type === 'data') {
      const { network, capacity } = req.body;
      // NOTE: fetch the FULL catalog (no network filter) — same call
      // /api/packages uses successfully. Calling datamart.getPackages(network)
      // with a network filter was returning a shape that isn't keyed by
      // network, which made every lookup below silently come back empty.
      const pkgRes = await datamart.getPackages();
      const list = (pkgRes.data && pkgRes.data[network]) || [];
      // Re-check the real price server-side — never trust a price sent from the browser.
      const pkg = list.find((p) => String(p.capacity) === String(capacity));
      if (!pkg) return res.status(400).json({ status: 'error', message: 'That bundle is not available right now.' });

      order = {
        reference: newReference(),
        type: 'data',
        status: 'pending',
        network,
        capacity: pkg.capacity,
        phoneNumber,
        email,
        amount: chargePriceFor(network, pkg.capacity, pkg.price),
        createdAt: new Date().toISOString(),
      };
    } else if (type === 'checker') {
      const { checkerType, skipSms } = req.body;
      const prodRes = await datamart.getCheckerProducts();
      const prod = prodRes.data.find((p) => p.name === checkerType);
      if (!prod) return res.status(400).json({ status: 'error', message: 'That checker type is not available.' });
      if (!prod.inStock) return res.status(400).json({ status: 'error', message: `${checkerType} checkers are out of stock right now.` });

      order = {
        reference: newReference(),
        type: 'checker',
        status: 'pending',
        checkerType,
        phoneNumber,
        email,
        skipSms: !!skipSms,
        amount: addPaystackFee(toRetail(prod.price)),
        createdAt: new Date().toISOString(),
      };
    } else {
      return res.status(400).json({ status: 'error', message: 'Unknown order type.' });
    }

    orders.save(order);

    const paystackRes = await paystack.initializeTransaction({
      email,
      amountPesewas: Math.round(order.amount * 100),
      reference: order.reference,
      callback_url: `${BASE_URL}/api/payment/callback`,
      metadata: { type: order.type, phoneNumber },
    });

    if (!paystackRes.status) {
      return res.status(502).json({ status: 'error', message: 'Could not start payment. Please try again.' });
    }

    order.authorizationUrl = paystackRes.data.authorization_url;
    orders.save(order);

    res.json({
      status: 'success',
      data: { reference: order.reference, authorizationUrl: order.authorizationUrl, amount: order.amount },
    });
  } catch (err) { relay(res, err); }
});

/* ============================================================
   FULFILLMENT — only ever runs after Paystack confirms payment,
   server-side, and only debits YOUR DataMart wallet.
   ============================================================ */

/* ============================================================
   FULFILLMENT — runs after Paystack confirms payment.
   ============================================================ */

/* ============================================================
   FULFILLMENT — runs after Paystack confirms payment.
   ============================================================ */

async function fulfillOrder(reference) {
  return orders.withLock(reference, async () => {
    const order = orders.get(reference);
    if (!order) return null;
    if (order.status === 'fulfilled') return order; // already done — idempotent

    order.status = 'paid';
    orders.save(order);

    try {
      let result;
      if (order.type === 'data') {
        result = await datamart.purchaseData(
          { phoneNumber: order.phoneNumber, network: order.network, capacity: order.capacity },
          order.reference // DataMart idempotency key
        );
      } else {
        result = await datamart.purchaseChecker(
          { checkerType: order.checkerType, phoneNumber: order.phoneNumber, skipSms: order.skipSms, ref: order.reference }
        );
      }

      order.status = 'fulfilled';
      order.fulfillment = result.data;

      // Extract DataMart's reference (GN-... for data, CHKW... for checkers)
      const dmRef = order.type === 'data' ? result.data?.orderReference : result.data?.reference;

      // --- SUCCESSFUL SMS DELIVERY ---
      if (!order.confirmationSmsSent) {
        let smsMessage = '';

        if (order.type === 'data') {
          // Extract message directly from DataMart's response for Data Bundles
          const dmMsg = result.data?.message || result.message;
          
          if (dmMsg) {
            smsMessage = `${dmMsg}\nRef: ${order.reference}${dmRef ? ` | Track ID: ${dmRef}` : ''} - Young Mind Data Plug`;
          } else {
            smsMessage = `Your ${order.capacity}GB ${networkLabelFor(order.network)} bundle has been sent to ${order.phoneNumber}. Ref: ${order.reference}${dmRef ? ` | Track ID: ${dmRef}` : ''} - Young Mind Data Plug`;
          }
        } else {
          // Extract message or credentials directly from DataMart's response for Result Checkers
          const dmMsg = result.data?.message || result.message;
          const serial = result.data?.serialNumber;
          const pin = result.data?.pin;

          if (serial && pin) {
            smsMessage = `Your ${order.checkerType} checker details:\nSerial: ${serial}\nPIN: ${pin}\nRef: ${order.reference}${dmRef ? ` | Track ID: ${dmRef}` : ''} - Young Mind Data Plug`;
          } else if (dmMsg) {
            smsMessage = `${dmMsg}\nRef: ${order.reference}${dmRef ? ` | Track ID: ${dmRef}` : ''} - Young Mind Data Plug`;
          } else {
            smsMessage = `Your ${order.checkerType} checker order was successful. Ref: ${order.reference} - Young Mind Data Plug`;
          }
        }

        order.confirmationSmsSent = true;
        orders.save(order);

        sms.sendSms(order.phoneNumber, smsMessage)
          .catch((smsErr) => console.error(`Confirmation SMS failed for ${order.reference}:`, smsErr.message));
      }
    } catch (err) {
      // --- FULFILLMENT ERROR (Paid, but DataMart API call errored) ---
      order.status = 'fulfillment_failed';
      order.fulfillmentError = err.response?.data?.message || err.message;

      const itemLabel = order.type === 'data'
        ? `${order.capacity}GB ${networkLabelFor(order.network)} data bundle`
        : `${order.checkerType} checker`;

      if (!order.failureSmsSent) {
        order.failureSmsSent = true;
        orders.save(order);

        // 1. Send SMS to Customer with their YMDP Reference
        const customerMsg = `We received your payment for ${itemLabel}! Delivery is being processed. Quote Ref: ${order.reference} if you need support. - Young Mind Data Plug`;
        sms.sendSms(order.phoneNumber, customerMsg)
          .catch((smsErr) => console.error(`Customer error SMS failed for ${order.reference}:`, smsErr.message));

        // 2. Send SMS Alert to Admin (Your Phone) with Reference & Failure Details
        if (ADMIN_PHONE) {
          const adminMsg = `[ALERT] FULFILLMENT FAILED\nRef: ${order.reference}\nItem: ${itemLabel}\nPhone: ${order.phoneNumber}\nError: ${String(order.fulfillmentError).slice(0, 70)}`;
          sms.sendSms(ADMIN_PHONE, adminMsg)
            .catch((smsErr) => console.error(`Admin alert SMS failed for ${order.reference}:`, smsErr.message));
        } else {
          console.error(`ADMIN_PHONE not set in .env — no admin alert sent for failed order ${order.reference}`);
        }
      }
    }

    orders.save(order);
    return order;
  });
}

// Paystack redirects the customer's browser here after checkout
app.get('/api/payment/callback', async (req, res) => {
  const reference = req.query.reference || req.query.trxref;
  try {
    const v = await paystack.verifyTransaction(reference);
    const order = orders.get(reference);

    if (v.data?.status === 'success' && order && Math.round(order.amount * 100) === v.data.amount) {
      await fulfillOrder(reference);
    } else if (order) {
      order.status = 'payment_failed';
      orders.save(order);
    }
  } catch (err) {
    console.error('Callback verification error:', err.message);
    // The webhook below is the safety net if this fails.
  }
  res.redirect(`/confirm.html?order=${encodeURIComponent(reference || '')}`);
});

// Backup path: fires even if the customer closes the tab before the redirect completes
app.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest('hex');

  if (signature !== expected) return res.sendStatus(401);
  res.sendStatus(200); // acknowledge immediately, process after

  const event = req.body;
  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    try {
      const v = await paystack.verifyTransaction(reference);
      const order = orders.get(reference);
      if (v.data?.status === 'success' && order && Math.round(order.amount * 100) === v.data.amount) {
        await fulfillOrder(reference);
      }
    } catch (err) {
      console.error('Webhook fulfillment error:', err.message);
    }
  }
});

// Strips an order down to what's safe to hand back to a browser — never the
// DataMart cost, only the customer-facing fields. Shared by the post-redirect
// poll (below) and the phone-verified "track my order" search.
function buildSafeOrder(order) {
  const safe = {
    reference: order.reference,
    type: order.type,
    status: order.status,
    amount: order.amount,
    phoneNumber: order.phoneNumber,
    network: order.network,
    capacity: order.capacity,
    checkerType: order.checkerType,
    createdAt: order.createdAt,
  };

  if (order.status === 'fulfilled' && order.fulfillment) {
    if (order.type === 'data') {
      safe.orderReference = order.fulfillment.orderReference;
    } else {
      safe.serialNumber = order.fulfillment.serialNumber;
      safe.pin = order.fulfillment.pin;
      safe.orderReference = order.fulfillment.reference; // DataMart's ref for this checker purchase
    }
  }
  if (order.status === 'fulfillment_failed') {
    safe.note = "Payment received — we're resolving delivery now. Contact support with this reference if it doesn't update shortly.";
  }
  return safe;
}

// For a fulfilled data order, ask DataMart for the bundle's real-time
// delivery status (pending/waiting/processing/completed/failed/refunded) and
// attach it as `liveStatus` on the safe order object. Non-fatal: if DataMart
// is slow or errors, the customer still gets everything buildSafeOrder()
// already gives them — this is a nice-to-have layered on top, not something
// that should ever break the track-order response. Checkers don't have an
// equivalent "in-flight delivery" concept (the card is issued instantly), so
// this only applies to type === 'data'.
async function attachLiveDataStatus(safe, order) {
  if (order.type !== 'data' || order.status !== 'fulfilled' || !order.fulfillment?.orderReference) {
    return safe;
  }
  try {
    const r = await datamart.getOrderStatus(order.fulfillment.orderReference);
    safe.liveStatus = r.data?.orderStatus || null;
  } catch (err) {
    console.error(`Live DataMart status check failed for ${order.reference}:`, err.response?.data?.message || err.message);
    // leave safe.liveStatus unset — frontend just won't show that line
  }
  return safe;
}

// Frontend polls this after the Paystack redirect to show live order status.
// No phone check here on purpose — this only ever runs immediately after
// Paystack sends the browser back with the reference it just paid for, so
// the reference itself (a long random token, never guessable) is the proof.
app.get('/api/orders/:reference', async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });
  const safe = await attachLiveDataStatus(buildSafeOrder(order), order);
  res.json({ status: 'success', data: safe });
});

// Manual "track my order" search — a customer coming back later (different
// device, different day) types in their reference. Unlike the route above,
// this isn't tied to a fresh Paystack redirect, so we also require the phone
// number they checked out with as a lightweight second factor. No accounts,
// no passwords — just enough to stop someone else's reference (seen in a
// screenshot, shared link, etc.) from pulling up a checker's PIN.
/* ============================================================
   MANUAL ORDER LOOKUP / SEARCH
   ============================================================ */

// Express route: Queries DataMart directly without checking a local DB
const axios = require('axios');

app.post('/api/orders/lookup', async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ 
      status: false, 
      message: 'Order reference is required.' 
    });
  }

  try {
    const cleanRef = reference.trim();
    const targetUrl = `https://api.datamartgh.shop/api/developer/order-status/${encodeURIComponent(cleanRef)}`;

    const response = await axios.get(targetUrl, {
      headers: {
        'x-api-key': process.env.DATAMART_API_KEY,
        'Accept': 'application/json'
      }
    });

    // Successfully retrieved order from DataMart
    return res.json({
      status: true,
      data: response.data.data
    });

  } catch (error) {
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.message || 'Order reference not found on DataMart.';

    return res.status(statusCode).json({
      status: false,
      message: errorMessage
    });
  }
});
/* ============================================================
   ADMIN — owner-only, protected by ADMIN_KEY
   ============================================================ */

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ status: 'error', message: 'Forbidden' });
  next();
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/admin/api/orders', requireAdmin, (req, res) => {
  res.json({ status: 'success', data: orders.list() });
});

app.get('/admin/api/balance', requireAdmin, async (req, res) => {
  try { res.json(await datamart.getBalance()); } catch (err) { relay(res, err); }
});

// For orders stuck in fulfillment_failed (customer paid, DataMart call errored — e.g. low wallet balance)
app.post('/admin/api/orders/:reference/retry', requireAdmin, async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });
  const updated = await fulfillOrder(order.reference);
  res.json({ status: 'success', data: updated });
});

// Re-check an order's live status directly with DataMart, using DataMart's
// own reference (order.fulfillment.orderReference for data, or
// order.fulfillment.reference for checkers) — not your YMDP-... reference.
// Handles both order types, since data and checkers use different DataMart
// endpoints (/order-status/:ref vs /api/checkers/order-status/:ref).
app.get('/admin/api/orders/:reference/datamart-status', requireAdmin, async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });
  if (!order.fulfillment) {
    return res.status(400).json({ status: 'error', message: 'This order has no DataMart reference on file yet — it has not been fulfilled.' });
  }
  try {
    let r;
    if (order.type === 'data') {
      r = await datamart.getOrderStatus(order.fulfillment.orderReference);
    } else {
      r = await datamart.getCheckerOrderStatus(order.fulfillment.reference);
    }
    res.json(r);
  } catch (err) { relay(res, err); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Young Mind Data Plug running at ${BASE_URL}`));