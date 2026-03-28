/* ========================================
   Netlify Function: complete-order
   1. Find/Create Shopify Customer
   2. Create Shopify Order (paid)
   3. Send Meta Conversions API Purchase event
   - Uses Client Credentials Grant for Shopify auth
   ======================================== */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { shopifyRequest } = require('./shopify-auth');

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ---- SHA256 hash for Meta CAPI ----
function sha256(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// ---- Main Handler ----
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
      paymentIntentId,
      stripeCustomerId,
      customer,
      items,
      subtotal,
      discountAmount,
      couponCode,
      total,
      fbp, fbc, purchaseEventId,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      userAgent, sourceUrl,
      agreementHtml, marketingConsent
    } = body;

    // Get client IP from headers (Netlify provides this)
    const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || event.headers['x-nf-client-connection-ip']
      || event.headers['client-ip']
      || '';

    const clientUserAgent = userAgent || event.headers['user-agent'] || '';

    // =============================================
    // STEP 1: Find or Create Shopify Customer
    // =============================================
    let shopifyCustomerId = null;

    const searchResp = await shopifyRequest(
      `customers/search.json?query=email:${encodeURIComponent(customer.email)}&limit=1`
    );

    if (searchResp.customers && searchResp.customers.length > 0) {
      shopifyCustomerId = searchResp.customers[0].id;
      try {
        await shopifyRequest(`customers/${shopifyCustomerId}.json`, 'PUT', {
          customer: {
            id: shopifyCustomerId,
            phone: customer.phone,
            addresses: [{
              first_name: customer.firstName,
              last_name: customer.lastName,
              address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
              address2: customer.district || '',
              city: customer.city,
              province: customer.city,
              zip: customer.zip,
              country: 'TR',
              phone: customer.phone,
              default: true
            }]
          }
        });
      } catch (updateErr) {
        console.warn('Customer update warning:', updateErr.message);
      }
    } else {
      const createResp = await shopifyRequest('customers.json', 'POST', {
        customer: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          phone: customer.phone,
          verified_email: true,
          addresses: [{
            first_name: customer.firstName,
            last_name: customer.lastName,
            address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
            address2: customer.district || '',
            city: customer.city,
            province: customer.city,
            zip: customer.zip,
            country: 'TR',
            phone: customer.phone,
            default: true
          }],
          tags: marketingConsent ? 'custom-checkout, accepts-marketing' : 'custom-checkout',
          metafields: [{
            namespace: 'checkout',
            key: 'stripe_customer_id',
            value: stripeCustomerId || '',
            type: 'single_line_text_field'
          }]
        }
      });
      shopifyCustomerId = createResp.customer.id;
    }

    // =============================================
    // STEP 2: Create Shopify Order
    // =============================================
    const lineItems = items.map(item => ({
      variant_id: item.variant_id,
      quantity: item.quantity,
      price: (item.price / 100).toFixed(2),
      title: item.title,
      sku: item.sku || ''
    }));

    const noteAttributes = [];
    if (utm_source) noteAttributes.push({ name: 'utm_source', value: utm_source });
    if (utm_medium) noteAttributes.push({ name: 'utm_medium', value: utm_medium });
    if (utm_campaign) noteAttributes.push({ name: 'utm_campaign', value: utm_campaign });
    if (utm_term) noteAttributes.push({ name: 'utm_term', value: utm_term });
    if (utm_content) noteAttributes.push({ name: 'utm_content', value: utm_content });
    noteAttributes.push({ name: 'payment_gateway', value: 'stripe' });
    noteAttributes.push({ name: 'stripe_payment_intent', value: paymentIntentId });
    if (stripeCustomerId) noteAttributes.push({ name: 'stripe_customer_id', value: stripeCustomerId });
    if (marketingConsent) noteAttributes.push({ name: 'marketing_consent', value: 'true' });

    const orderPayload = {
      order: {
        customer: { id: shopifyCustomerId },
        email: customer.email,
        phone: customer.phone,
        line_items: lineItems,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: true,
        send_fulfillment_receipt: true,
        note: `Custom checkout | Stripe PI: ${paymentIntentId}\n\n--- MESAFELİ SATIŞ SÖZLEŞMESİ ---\nSözleşme elektronik ortamda onaylanmıştır. Detaylar sipariş notu olarak eklenmiştir.`,
        note_attributes: noteAttributes,
        tags: 'custom-checkout, stripe',
        shipping_address: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
          address2: customer.district || '',
          city: customer.city,
          province: customer.city,
          zip: customer.zip,
          country: 'TR',
          phone: customer.phone
        },
        billing_address: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
          address2: customer.district || '',
          city: customer.city,
          province: customer.city,
          zip: customer.zip,
          country: 'TR',
          phone: customer.phone
        },
        shipping_lines: [{
          title: 'Standart Kargo',
          price: '0.00',
          code: 'FREE_SHIPPING'
        }],
        transactions: [{
          kind: 'sale',
          status: 'success',
          amount: (total / 100).toFixed(2),
          currency: 'TRY',
          gateway: 'stripe'
        }]
      }
    };

    if (discountAmount > 0 && couponCode) {
      orderPayload.order.discount_codes = [{
        code: couponCode,
        amount: (discountAmount / 100).toFixed(2),
        type: 'fixed_amount'
      }];
    }

    const orderResp = await shopifyRequest('orders.json', 'POST', orderPayload);
    const shopifyOrder = orderResp.order;

    console.log(`Shopify order created: ${shopifyOrder.name} (ID: ${shopifyOrder.id})`);

    // Save agreement as order metafield
    if (agreementHtml) {
      try {
        await shopifyRequest(`orders/${shopifyOrder.id}/metafields.json`, 'POST', {
          metafield: {
            namespace: 'checkout',
            key: 'mesafeli_satis_sozlesmesi',
            value: agreementHtml,
            type: 'multi_line_text_field'
          }
        });
      } catch (mfErr) {
        console.warn('Agreement metafield save warning:', mfErr.message);
      }
    }

    // =============================================
    // STEP 3: Meta Conversions API — Purchase Event
    // =============================================
    try {
      const eventTime = Math.floor(Date.now() / 1000);
      // Use the same eventId from browser pixel for deduplication
      const eventId = purchaseEventId || `purchase_${shopifyOrder.id}_${eventTime}`;

      const metaPayload = {
        data: [{
          event_name: 'Purchase',
          event_time: eventTime,
          event_id: eventId,
          event_source_url: sourceUrl || 'https://checkout.thesveltechic.com',
          action_source: 'website',
          user_data: {
            em: [sha256(customer.email)],
            ph: [sha256(customer.phone.replace(/\D/g, ''))],
            fn: [sha256(customer.firstName)],
            ln: [sha256(customer.lastName)],
            ct: [sha256(customer.city)],
            zp: [sha256(customer.zip)],
            country: [sha256('tr')],
            st: [sha256(customer.district)],
            client_ip_address: clientIp,
            client_user_agent: clientUserAgent,
            external_id: [sha256(customer.email)],
            ...(fbp ? { fbp } : {}),
            ...(fbc ? { fbc } : {})
          },
          custom_data: {
            currency: 'TRY',
            value: parseFloat((total / 100).toFixed(2)),
            content_type: 'product',
            contents: items.map(item => ({
              id: item.sku || String(item.variant_id),
              quantity: item.quantity,
              item_price: parseFloat((item.price / 100).toFixed(2))
            })),
            content_ids: items.map(item => item.sku || String(item.variant_id)),
            num_items: items.reduce((sum, item) => sum + item.quantity, 0),
            order_id: shopifyOrder.name
          }
        }]
      };

      // Uncomment for testing in Meta Events Manager:
      // metaPayload.test_event_code = 'TEST12345';

      const metaResp = await fetch(
        `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(metaPayload)
        }
      );

      const metaResult = await metaResp.json();
      console.log('Meta CAPI response:', JSON.stringify(metaResult));

      if (metaResult.error) {
        console.error('Meta CAPI error:', metaResult.error);
      }
    } catch (metaErr) {
      console.error('Meta CAPI exception:', metaErr.message);
    }

    // =============================================
    // RESPONSE
    // =============================================
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        shopifyOrderId: shopifyOrder.id,
        shopifyOrderName: shopifyOrder.name,
        shopifyCustomerId: shopifyCustomerId
      })
    };

  } catch (err) {
    console.error('complete-order error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: err.message || 'Sipariş oluşturulurken bir hata oluştu.',
        success: false
      })
    };
  }
};
