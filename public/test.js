const axios = require('axios');

// ===================================================
// CONFIGURATION - Put your actual DataMart API Key here
// ===================================================
const API_KEY = 'f9c65cb7d4c87c176406336793d7d40a927c7d533adeaf86622dc1654ee80f2e'; 
const ORDER_REFERENCE = 'MN-PR0456ZE'; // Put your order reference here

async function testApiKeyAuth() {
  const cleanRef = ORDER_REFERENCE.trim();
  const cleanKey = API_KEY.trim();
  const baseUrl = `https://api.datamartgh.shop/api/developer/order-status/${encodeURIComponent(cleanRef)}`;

  console.log(`🔍 Testing DataMart lookup for Ref: ${cleanRef}...\n`);

  // Method 1: Header - x-api-key
  try {
    console.log('Testing Method 1: Header [x-api-key]...');
    const res1 = await axios.get(baseUrl, {
      headers: {
        'x-api-key': cleanKey,
        'Accept': 'application/json'
      }
    });
    console.log('\n✅ SUCCESS! (Method 1 Worked)');
    console.dir(res1.data, { depth: null, colors: true });
    return;
  } catch (err) {
    console.log(` └─ Status: ${err.response?.status} | ${JSON.stringify(err.response?.data || err.message)}\n`);
  }

  // Method 2: Header - api-key
  try {
    console.log('Testing Method 2: Header [api-key]...');
    const res2 = await axios.get(baseUrl, {
      headers: {
        'api-key': cleanKey,
        'Accept': 'application/json'
      }
    });
    console.log('\n✅ SUCCESS! (Method 2 Worked)');
    console.dir(res2.data, { depth: null, colors: true });
    return;
  } catch (err) {
    console.log(` └─ Status: ${err.response?.status} | ${JSON.stringify(err.response?.data || err.message)}\n`);
  }

  // Method 3: Query Parameter - ?api_key=...
  try {
    console.log('Testing Method 3: Query Param [?api_key=...]...');
    const res3 = await axios.get(`${baseUrl}?api_key=${cleanKey}`, {
      headers: { 'Accept': 'application/json' }
    });
    console.log('\n✅ SUCCESS! (Method 3 Worked)');
    console.dir(res3.data, { depth: null, colors: true });
    return;
  } catch (err) {
    console.log(` └─ Status: ${err.response?.status} | ${JSON.stringify(err.response?.data || err.message)}\n`);
  }
}

testApiKeyAuth();