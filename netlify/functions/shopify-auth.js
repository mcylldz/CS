/* ========================================
   Shopify Auth — Client Credentials Grant
   Token valid for 24h, cached in memory.
   Includes retry logic for 429 rate limits.
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
 * Sleep helper for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch with timeout — prevents hanging requests from eating the function budget.
 */
function fetchWithTimeout(url, opts, timeoutMs = 8000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms: ${opts.method || 'GET'} ${url}`)), timeoutMs)
    )
  ]);
}

/**
 * Make an authenticated request to Shopify Admin API.
 * Retries only on 429 (rate limit) — max 2 retries, short backoff.
 * Every other error fails fast so the caller can handle it.
 */
async function shopifyRequest(endpoint, method = 'GET', data = null, retries = 2) {
  const token = await getShopifyToken();
  const API_VERSION = '2026-04';

  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  };
  if (data) opts.body = JSON.stringify(data);

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/${endpoint}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = 500 * Math.pow(2, attempt - 1); // 500ms, 1000ms
      console.log(`Shopify retry #${attempt} for ${method} ${endpoint} (waiting ${delay}ms)`);
      await sleep(delay);
    }

    const resp = await fetchWithTimeout(url, opts, 8000);

    // Handle 429 rate limit with retry
    if (resp.status === 429) {
      if (attempt < retries) {
        const retryAfter = resp.headers.get('retry-after');
        const waitMs = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 3000) : 500 * Math.pow(2, attempt);
        console.warn(`Shopify 429 on ${method} ${endpoint}, retry in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      const errJson = await resp.json().catch(() => ({}));
      console.error('Shopify 429 exhausted retries:', JSON.stringify(errJson));
      throw new Error(`Shopify rate limit exceeded after ${retries} retries`);
    }

    const json = await resp.json();

    if (!resp.ok) {
      console.error('Shopify API error:', JSON.stringify(json));
      throw new Error(`Shopify ${method} ${endpoint}: ${resp.status} - ${JSON.stringify(json.errors || json)}`);
    }

    return json;
  }
}

module.exports = { getShopifyToken, shopifyRequest };
