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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function sha256(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
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
        headers: CORS_HEADERS,
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

    // Build user_data
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
      if (customer.phone) userData.ph = [sha256(customer.phone.replace(/\D/g, ''))];
      if (customer.firstName) userData.fn = [sha256(customer.firstName)];
      if (customer.lastName) userData.ln = [sha256(customer.lastName)];
      if (customer.city) userData.ct = [sha256(customer.city)];
      if (customer.zip) userData.zp = [sha256(customer.zip)];
      if (customer.district) userData.st = [sha256(customer.district)];
      if (customer.country) userData.country = [sha256(customer.country)];
    }

    // Build custom_data
    const customData = {
      currency: 'TRY',
      value: parseFloat(((total || subtotal || 0) / 100).toFixed(2))
    };

    if (items && items.length > 0) {
      customData.content_type = 'product';
      customData.contents = items.map(item => ({
        id: item.sku || String(item.variant_id),
        quantity: item.quantity,
        item_price: parseFloat((item.price / 100).toFixed(2))
      }));
      customData.content_ids = items.map(item => item.sku || String(item.variant_id));
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
      `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
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
      headers: CORS_HEADERS,
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
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message, success: false })
    };
  }
};
