/* ========================================
   Shopify Auth — Client Credentials Grant
   Token valid for 24h, cached in memory.
   ======================================== */

const fetch = require('node-fetch');

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // thesveltechic.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get a valid Shopify Admin API access token.
 * Uses Client Credentials Grant, caches for ~23 hours (1h safety margin).
 */
async function getShopifyToken() {
  const now = Date.now();

  // Return cached token if still valid (with 1 hour safety margin)
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  // Request new token via Client Credentials Grant
  const tokenUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Shopify token error:', resp.status, errText);
    throw new Error(`Shopify token request failed: ${resp.status}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  // Token is valid for 24h, we cache for 23h (safety margin)
  tokenExpiry = now + (23 * 60 * 60 * 1000);

  console.log('Shopify token refreshed successfully');
  return cachedToken;
}

/**
 * Make an authenticated request to Shopify Admin API.
 */
async function shopifyRequest(endpoint, method = 'GET', data = null) {
  const token = await getShopifyToken();
  const API_VERSION = '2024-10';

  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  };
  if (data) opts.body = JSON.stringify(data);

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/${endpoint}`;
  const resp = await fetch(url, opts);
  const json = await resp.json();

  if (!resp.ok) {
    console.error('Shopify API error:', JSON.stringify(json));
    throw new Error(`Shopify ${method} ${endpoint}: ${resp.status} - ${JSON.stringify(json.errors || json)}`);
  }
  return json;
}

module.exports = { getShopifyToken, shopifyRequest };
