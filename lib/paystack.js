const axios = require('axios');

const BASE_URL = 'https://api.paystack.co';

function client() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

/**
 * Starts a Paystack transaction and returns the authorization URL the
 * customer is redirected to in order to pay.
 * amountPesewas must be an integer (Paystack works in the currency's
 * smallest unit — pesewas for GHS, same idea as kobo for NGN).
 */
async function initializeTransaction({ email, amountPesewas, reference, callback_url, metadata }) {
  const res = await client().post('/transaction/initialize', {
    email,
    amount: amountPesewas,
    reference,
    callback_url,
    currency: 'GHS',
    metadata,
  });
  return res.data; // { status, message, data: { authorization_url, access_code, reference } }
}

/**
 * Confirms what actually happened to a transaction server-side. Always call
 * this rather than trusting the client redirect — the redirect only tells
 * you the browser came back, not that Paystack considers the charge valid.
 */
async function verifyTransaction(reference) {
  const res = await client().get(`/transaction/verify/${encodeURIComponent(reference)}`);
  return res.data; // { status, message, data: { status: 'success'|'failed'|..., amount, reference, ... } }
}

/**
 * Initiates a direct Mobile Money charge (Ghana). Paystack will push a
 * USSD/approval prompt to the customer's phone asking for their MoMo PIN.
 *
 * provider must be one of: 'mtn', 'vod' (Telecel/Vodafone Cash), 'tgo' (AirtelTigo).
 *
 * Response data.status will be one of:
 *   'pay_offline' - customer must approve the prompt / dial USSD on their phone
 *   'send_otp'    - customer must supply an OTP sent by their network (submitOtp)
 *   'success'     - charge completed immediately
 *   'failed'      - charge could not be started
 */
async function chargeMobileMoney({ email, amountPesewas, reference, phone, provider, metadata }) {
  const res = await client().post('/charge', {
    email,
    amount: amountPesewas,
    currency: 'GHS',
    reference,
    mobile_money: { phone, provider },
    metadata,
  });
  return res.data;
}

/**
 * Submits the OTP a customer received from their mobile network to
 * complete a pending mobile money charge.
 */
async function submitOtp({ otp, reference }) {
  const res = await client().post('/charge/submit_otp', { otp, reference });
  return res.data;
}

/**
 * Some providers require a phone number confirmation step instead of/ in
 * addition to OTP. Included for completeness.
 */
async function submitPhone({ phone, reference }) {
  const res = await client().post('/charge/submit_phone', { phone, reference });
  return res.data;
}

/**
 * Polls the current state of a charge that was started with
 * chargeMobileMoney (useful while waiting on a 'pay_offline' approval).
 */
async function checkPendingCharge(reference) {
  const res = await client().get(`/charge/${encodeURIComponent(reference)}`);
  return res.data;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  chargeMobileMoney,
  submitOtp,
  submitPhone,
  checkPendingCharge,
};