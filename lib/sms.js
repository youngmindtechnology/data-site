const axios = require('axios');

const ARKESEL_SMS_URL = 'https://sms.arkesel.com/api/v2/sms/send';

function client() {
  const apiKey = process.env.ARKESEL_API_KEY;
  if (!apiKey) throw new Error('ARKESEL_API_KEY is not set');
  return axios.create({
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

// This app stores phone numbers as local 10-digit (0XXXXXXXXX). Arkesel
// wants international format — swap the leading 0 for +233.
function toInternational(localPhone) {
  return '+233' + String(localPhone).replace(/^0/, '');
}

// Fire off a single SMS. Throws on failure — callers decide whether that
// should block anything (it shouldn't: an SMS failing is never a reason to
// fail an order that already succeeded or already failed for its own reason).
async function sendSms(toLocalPhone, message) {
  const sender = process.env.ARKESEL_SENDER_ID || 'YMDataPlug';
  const res = await client().post(ARKESEL_SMS_URL, {
    sender,
    message,
    recipients: [toInternational(toLocalPhone)],
  });
  if (res.data?.status !== 'success') {
    throw new Error(res.data?.message || 'Arkesel returned a non-success status');
  }
  return res.data;
}

module.exports = { sendSms, toInternational };