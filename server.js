require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');

const datamart = require('./lib/Datamart');
const paystack = require('./lib/paystack');
const orders = require('./lib/orderStore');
const sms = require('./lib/sms');

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT || 10);
const FLAT_MARKUP_GHS = Number(process.env.FLAT_MARKUP_GHS || 2);
const BASE_URL = process.env.BASE_URL || 'https://youngmind.shop';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

// ============================================================
// ADMIN MIDDLEWARE
// ============================================================
function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ status: 'error', message: 'Forbidden' });
  next();
}

function networkLabelFor(net) {
  return { YELLO: 'MTN', TELECEL: 'Telecel', AT_PREMIUM: 'AirtelTigo' }[net] || net;
}

// Maps our internal network codes to the provider codes Paystack's
// Mobile Money charge API expects.
function toPaystackProvider(net) {
  return { YELLO: 'mtn', TELECEL: 'vod', AT_PREMIUM: 'tgo' }[net] || String(net || '').toLowerCase();
}

const PAYSTACK_FEE_PERCENT = Number(process.env.PAYSTACK_FEE_PERCENT || 1.95);
const PASS_PAYSTACK_FEE_TO_CUSTOMER = String(process.env.PASS_PAYSTACK_FEE_TO_CUSTOMER ?? 'true').toLowerCase() === 'true';

function toRetail(cost) {
  const withPercent = Number(cost) * (1 + MARKUP_PERCENT / 100);
  const retail = withPercent + FLAT_MARKUP_GHS;
  return Math.round(retail * 100) / 100;
}

function addPaystackFee(netAmount) {
  if (!PASS_PAYSTACK_FEE_TO_CUSTOMER) return netAmount;
  const gross = netAmount / (1 - PAYSTACK_FEE_PERCENT / 100);
  return Math.round(gross * 100) / 100;
}

const PRICE_OVERRIDES = {
  'YELLO:1': 5.00
};

function basePriceFor(network, capacity, cost) {
  const key = `${network}:${capacity}`;
  if (Object.prototype.hasOwnProperty.call(PRICE_OVERRIDES, key)) {
    return PRICE_OVERRIDES[key];
  }
  return toRetail(cost);
}

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
const VALID_NETWORKS = ['YELLO', 'TELECEL', 'AT_PREMIUM'];

function relay(res, err) {
  if (err.response) return res.status(err.response.status).json(err.response.data);
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Server error. Please try again.' });
}

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
   PUBLIC CATALOG
   ============================================================ */

app.get('/api/config', (req, res) => {
  res.json({
    status: 'success',
    data: {
      paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
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
        price: basePriceFor(net, p.capacity, p.price),
        payable: chargePriceFor(net, p.capacity, p.price),
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
   ORDERS — customer starts a purchase (hosted checkout redirect)
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
      const pkgRes = await datamart.getPackages();
      const list = (pkgRes.data && pkgRes.data[network]) || [];
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
   ORDERS — direct Mobile Money charge (modal flow)
   Customer enters a beneficiary number + a MoMo number/network and
   pays right there via a USSD/approval prompt or OTP, no redirect.
   ============================================================ */

app.post('/api/orders/charge/init', async (req, res) => {
  try {
    const { type, network, capacity, recipientPhone, momoPhone, momoNetwork } = req.body;

    if (type !== 'data') {
      return res.status(400).json({ status: 'error', message: 'This payment flow currently supports data bundles only.' });
    }
    if (!isValidPhone(recipientPhone)) {
      return res.status(400).json({ status: 'error', message: 'Enter a valid beneficiary number, e.g. 0551234567.' });
    }
    if (!isValidPhone(momoPhone)) {
      return res.status(400).json({ status: 'error', message: 'Enter a valid Mobile Money number.' });
    }
    if (!VALID_NETWORKS.includes(momoNetwork)) {
      return res.status(400).json({ status: 'error', message: 'Select the Mobile Money network to pay with.' });
    }

    const pkgRes = await datamart.getPackages();
    const list = (pkgRes.data && pkgRes.data[network]) || [];
    const pkg = list.find((p) => String(p.capacity) === String(capacity));
    if (!pkg) return res.status(400).json({ status: 'error', message: 'That bundle is not available right now.' });

    const order = {
      reference: newReference(),
      type: 'data',
      status: 'pending',
      network,
      capacity: pkg.capacity,
      phoneNumber: recipientPhone,
      momoPhone,
      momoNetwork,
      email: `${momoPhone}@paystack.com`,
      amount: chargePriceFor(network, pkg.capacity, pkg.price),
      createdAt: new Date().toISOString(),
    };
    orders.save(order);

    let chargeRes;
    try {
      chargeRes = await paystack.chargeMobileMoney({
        email: order.email,
        amountPesewas: Math.round(order.amount * 100),
        reference: order.reference,
        phone: momoPhone,
        provider: toPaystackProvider(momoNetwork),
        metadata: { type: order.type, phoneNumber: recipientPhone },
      });
    } catch (chargeErr) {
      order.status = 'payment_failed';
      orders.save(order);
      return relay(res, chargeErr);
    }

    const chargeStatus = chargeRes.data && chargeRes.data.status;
    order.chargeStatus = chargeStatus;
    orders.save(order);

    if (chargeStatus === 'success') {
      await fulfillOrder(order.reference);
      return res.json({ status: 'success', data: { reference: order.reference, chargeStatus: 'success' } });
    }
    if (chargeStatus === 'pay_offline') {
      return res.json({
        status: 'success',
        data: {
          reference: order.reference,
          chargeStatus: 'pay_offline',
          displayText: chargeRes.data.display_text || 'A prompt was sent to your phone. Enter your Mobile Money PIN to approve the payment.',
        },
      });
    }
    if (chargeStatus === 'send_otp') {
      return res.json({ status: 'success', data: { reference: order.reference, chargeStatus: 'send_otp' } });
    }

    order.status = 'payment_failed';
    orders.save(order);
    return res.status(400).json({
      status: 'error',
      message: (chargeRes.data && chargeRes.data.gateway_response) || 'Payment could not be started. Please try again.',
    });
  } catch (err) { relay(res, err); }
});

app.post('/api/orders/charge/otp', async (req, res) => {
  try {
    const { reference, otp } = req.body;
    if (!reference || !otp) {
      return res.status(400).json({ status: 'error', message: 'Reference and verification code are required.' });
    }

    const order = orders.get(reference);
    if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });

    const otpRes = await paystack.submitOtp({ otp, reference });
    const chargeStatus = otpRes.data && otpRes.data.status;
    order.chargeStatus = chargeStatus;
    orders.save(order);

    if (chargeStatus === 'success') {
      await fulfillOrder(reference);
      return res.json({ status: 'success', data: { reference, chargeStatus: 'success' } });
    }
    if (chargeStatus === 'pay_offline') {
      return res.json({
        status: 'success',
        data: {
          reference,
          chargeStatus: 'pay_offline',
          displayText: otpRes.data.display_text || 'Approve the prompt sent to your phone to finish paying.',
        },
      });
    }
    if (chargeStatus === 'send_otp') {
      // Some networks issue a second OTP round.
      return res.json({ status: 'success', data: { reference, chargeStatus: 'send_otp' } });
    }

    order.status = 'payment_failed';
    orders.save(order);
    return res.status(400).json({
      status: 'error',
      message: (otpRes.data && otpRes.data.gateway_response) || 'That code was invalid or has expired.',
    });
  } catch (err) { relay(res, err); }
});

/**
 * The customer taps "I've completed payment" — this must NEVER just echo
 * back our locally-stored status, because that status only changes once
 * Paystack's webhook fires (or this route runs). We ask Paystack directly
 * every time, and only ever report success once Paystack itself says so.
 */
app.post('/api/orders/charge/verify', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ status: 'error', message: 'Reference is required.' });

    const order = orders.get(reference);
    if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });

    // Already resolved (e.g. the webhook beat us to it) — no need to re-ask Paystack.
    if (order.status === 'fulfilled') {
      return res.json({ status: 'success', data: { reference, chargeStatus: 'success' } });
    }
    if (order.status === 'fulfillment_failed') {
      return res.json({ status: 'success', data: { reference, chargeStatus: 'success', note: 'Payment succeeded; delivery is being retried.' } });
    }
    if (order.status === 'payment_failed') {
      return res.json({ status: 'success', data: { reference, chargeStatus: 'failed', message: 'This payment was not approved.' } });
    }

    let chargeStatus = 'pending';
    try {
      const chargeRes = await paystack.checkPendingCharge(reference);
      chargeStatus = (chargeRes.data && chargeRes.data.status) || 'pending';
    } catch (checkErr) {
      // Fall back to a plain transaction verify if the charge lookup itself fails.
      try {
        const v = await paystack.verifyTransaction(reference);
        chargeStatus = v.data && v.data.status === 'success' ? 'success' : 'pending';
      } catch (verifyErr) {
        return res.json({
          status: 'success',
          data: { reference, chargeStatus: 'pending', message: "We couldn't confirm your payment yet. Please try again in a moment." },
        });
      }
    }

    order.chargeStatus = chargeStatus;
    orders.save(order);

    if (chargeStatus === 'success') {
      await fulfillOrder(reference);
      return res.json({ status: 'success', data: { reference, chargeStatus: 'success' } });
    }

    if (['failed', 'abandoned', 'reversed', 'timeout'].includes(chargeStatus)) {
      order.status = 'payment_failed';
      orders.save(order);
      return res.json({ status: 'success', data: { reference, chargeStatus: 'failed', message: 'This payment was not approved.' } });
    }

    // Still pay_offline / send_otp / pending — nothing confirmed yet. Do not tell the customer it's done.
    return res.json({
      status: 'success',
      data: {
        reference,
        chargeStatus: 'pending',
        message: "We haven't received your approval yet. Approve the prompt on your phone, or dial the USSD code to approve, then check again.",
      },
    });
  } catch (err) { relay(res, err); }
});

/* ============================================================
   FULFILLMENT
   ============================================================ */

async function fulfillOrder(reference) {
  return orders.withLock(reference, async () => {
    const order = orders.get(reference);
    if (!order) return null;
    if (order.status === 'fulfilled') return order;

    order.status = 'paid';
    orders.save(order);

    try {
      let result;
      if (order.type === 'data') {
        result = await datamart.purchaseData(
          { phoneNumber: order.phoneNumber, network: order.network, capacity: order.capacity },
          order.reference
        );
      } else {
        result = await datamart.purchaseChecker(
          { checkerType: order.checkerType, phoneNumber: order.phoneNumber, skipSms: order.skipSms, ref: order.reference }
        );
      }

      order.status = 'fulfilled';
      order.fulfillment = result.data;

      const dmRef = order.type === 'data' ? result.data?.orderReference : result.data?.reference;

      if (!order.confirmationSmsSent) {
        let smsMessage = '';

        if (order.type === 'data') {
          const dmMsg = result.data?.message || result.message;
          if (dmMsg) {
            smsMessage = `${dmMsg}\nRef: ${order.reference}${dmRef ? ` | Track ID: ${dmRef}` : ''} - Young Mind Data Plug`;
          } else {
            smsMessage = `Your ${order.capacity}GB ${networkLabelFor(order.network)} bundle has been sent to ${order.phoneNumber}. Ref: ${order.reference}${dmRef ? ` | Track ID: ${dmRef}` : ''} - Young Mind Data Plug`;
          }
        } else {
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
      order.status = 'fulfillment_failed';
      order.fulfillmentError = err.response?.data?.message || err.message;

      const itemLabel = order.type === 'data'
        ? `${order.capacity}GB ${networkLabelFor(order.network)} data bundle`
        : `${order.checkerType} checker`;

      if (!order.failureSmsSent) {
        order.failureSmsSent = true;
        orders.save(order);

        const customerMsg = `We received your payment for ${itemLabel}! Delivery is being processed. Quote Ref: ${order.reference} if you need support. - Young Mind Data Plug`;
        sms.sendSms(order.phoneNumber, customerMsg)
          .catch((smsErr) => console.error(`Customer error SMS failed for ${order.reference}:`, smsErr.message));

        if (ADMIN_PHONE) {
          const adminMsg = `[ALERT] FULFILLMENT FAILED\nRef: ${order.reference}\nItem: ${itemLabel}\nPhone: ${order.phoneNumber}\nError: ${String(order.fulfillmentError).slice(0, 70)}`;
          sms.sendSms(ADMIN_PHONE, adminMsg)
            .catch((smsErr) => console.error(`Admin alert SMS failed for ${order.reference}:`, smsErr.message));
        }
      }
    }

    orders.save(order);
    return order;
  });
}

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
  }
  res.redirect(`/confirm.html?order=${encodeURIComponent(reference || '')}`);
});

app.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest('hex');

  if (signature !== expected) return res.sendStatus(401);
  res.sendStatus(200);

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
      safe.orderReference = order.fulfillment.reference;
    }
  }
  if (order.status === 'fulfillment_failed') {
    safe.note = "Payment received — we're resolving delivery now. Contact support with this reference if it doesn't update shortly.";
  }
  return safe;
}

async function attachLiveDataStatus(safe, order) {
  if (order.type !== 'data' || order.status !== 'fulfilled' || !order.fulfillment?.orderReference) {
    return safe;
  }
  try {
    const r = await datamart.getOrderStatus(order.fulfillment.orderReference);
    safe.liveStatus = r.data?.orderStatus || null;
  } catch (err) {
    console.error(`Live DataMart status check failed for ${order.reference}:`, err.response?.data?.message || err.message);
  }
  return safe;
}

app.get('/api/orders/:reference', async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });
  const safe = await attachLiveDataStatus(buildSafeOrder(order), order);
  res.json({ status: 'success', data: safe });
});

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
   ADMIN ROUTES
   ============================================================ */

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/admin/api/orders', requireAdmin, (req, res) => {
  res.json({ status: 'success', data: orders.list() });
});

app.get('/admin/api/balance', requireAdmin, async (req, res) => {
  try { res.json(await datamart.getBalance()); } catch (err) { relay(res, err); }
});

// DELETE order by reference
app.delete('/admin/api/orders/:reference', requireAdmin, (req, res) => {
  const reference = req.params.reference;
  const order = orders.get(reference);
  
  if (!order) {
    return res.status(404).json({ status: 'error', message: 'Order not found.' });
  }
  
  const all = orders.readAll();
  delete all[reference];
  orders.writeAll(all);
  
  res.json({ status: 'success', message: 'Order deleted successfully.' });
});

app.post('/admin/api/orders/:reference/retry', requireAdmin, async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order) return res.status(404).json({ status: 'error', message: 'Order not found.' });
  const updated = await fulfillOrder(order.reference);
  res.json({ status: 'success', data: updated });
});

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