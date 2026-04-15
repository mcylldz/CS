/* ========================================
   Netlify Function: track-event
   Sends Meta Conversions API events:
   - InitiateCheckout
   - AddPaymentInfo
   ======================================== */

const fetch = require('node-fetch');
const crypto = require('crypto');

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const ALLOWED_ORIGIN = process.env.CHECKOUT_ORIGIN || 'https://checkout.thesveltechic.com';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : '',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function normalizeTurkish(str) {
  if (!str) return '';
  return str
    .replace(/İ/g, 'i').replace(/I/g, 'i')
    .replace(/Ş/g, 's').replace(/ş/g, 's')
    .replace(/Ç/g, 'c').replace(/ç/g, 'c')
    .replace(/Ü/g, 'u').replace(/ü/g, 'u')
    .replace(/Ö/g, 'o').replace(/ö/g, 'o')
    .replace(/Ğ/g, 'g').replace(/ğ/g, 'g');
}

function sha256(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(normalizeTurkish(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('90') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '9' + digits;
  if (digits.length === 10 && digits.startsWith('5')) return '90' + digits;
  return digits;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const {
      eventName,       // 'InitiateCheckout' or 'AddPaymentInfo'
      customer,        // { email, phone, firstName, lastName, city, district, mahalle, zip, country }
      items,           // cart items array
      subtotal,        // in kuruş
      discountAmount,  // in kuruş
      total,           // in kuruş
      fbp, fbc,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      userAgent, sourceUrl,
      eventId          // for deduplication
    } = body;

    // Validate event name
    const allowedEvents = ['InitiateCheckout', 'AddPaymentInfo'];
    if (!allowedEvents.includes(eventName)) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Invalid event name' })
      };
    }

    const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || event.headers['x-nf-client-connection-ip']
      || event.headers['client-ip']
      || '';

    const clientUserAgent = userAgent || event.headers['user-agent'] || '';
    const eventTime = Math.floor(Date.now() / 1000);
    const finalEventId = eventId || `${eventName.toLowerCase()}_${eventTime}_${Math.random().toString(36).substr(2, 9)}`;

    // Build user_data (EMQ — Email Matching Quality)
    const userData = {
      client_ip_address: clientIp,
      client_user_agent: clientUserAgent,
      ...(fbp ? { fbp } : {}),
      ...(fbc ? { fbc } : {})
    };

    if (customer) {
      if (customer.email) {
        userData.em = [sha256(customer.email)];
        userData.external_id = [sha256(customer.email)];
      }
      if (customer.phone) {
        const normalized = normalizePhone(customer.phone);
        if (normalized) userData.ph = [sha256(normalized)];
      }
      if (customer.firstName) userData.fn = [sha256(customer.firstName)];
      if (customer.lastName) userData.ln = [sha256(customer.lastName)];
      if (customer.city) userData.ct = [sha256(customer.city)];
      if (customer.state) userData.st = [sha256(customer.state)];
      if (customer.zip) userData.zp = [sha256(customer.zip)];
      userData.country = [sha256('tr')];
    }

    // Build custom_data
    const customData = {
      currency: 'TRY',
      value: parseFloat(((total != null ? total : (subtotal || 0)) / 100).toFixed(2))
    };

    if (items && items.length > 0) {
      customData.content_type = 'product_group';
      customData.contents = items.map(item => ({
        id: String(item.product_id),
        quantity: item.quantity,
        item_price: parseFloat((item.price / 100).toFixed(2))
      }));
      customData.content_ids = items.map(item => String(item.product_id));
      customData.num_items = items.reduce((sum, item) => sum + item.quantity, 0);
    }

    if (discountAmount > 0) {
      customData.discount = parseFloat((discountAmount / 100).toFixed(2));
    }

    // Build Meta CAPI payload
    const metaPayload = {
      data: [{
        event_name: eventName,
        event_time: eventTime,
        event_id: finalEventId,
        event_source_url: sourceUrl || 'https://checkout.thesveltechic.com',
        action_source: 'website',
        user_data: userData,
        custom_data: customData
      }]
    };

    // Send to Meta
    const metaResp = await fetch(
      `https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metaPayload)
      }
    );

    const metaResult = await metaResp.json();
    console.log(`Meta CAPI [${eventName}] response:`, JSON.stringify(metaResult));

    if (metaResult.error) {
      console.error(`Meta CAPI [${eventName}] error:`, metaResult.error);
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: true,
        eventName: eventName,
        eventId: finalEventId,
        metaEvents: metaResult.events_received || 0
      })
    };

  } catch (err) {
    console.error('track-event error:', err);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Olay kaydedilemedi.', success: false })
    };
  }
};
