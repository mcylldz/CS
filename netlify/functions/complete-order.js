/* ========================================
   Netlify Function: complete-order
   1. Verify Stripe PaymentIntent succeeded
   2. Find/Create Shopify Customer
   3. Create Shopify Order (paid)
   4. Send Meta Conversions API Purchase event
   - Uses Client Credentials Grant for Shopify auth
   ======================================== */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { shopifyRequest } = require('./shopify-auth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const ALLOWED_ORIGIN = process.env.CHECKOUT_ORIGIN || 'https://checkout.thesveltechic.com';

// ---- HTML Sanitizer: strip dangerous tags/attributes before storing ----
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  clean = clean.replace(/<\/?(iframe|object|embed|form|input|textarea|select|button|link|meta|base|applet)\b[^>]*>/gi, '');
  clean = clean.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  clean = clean.replace(/(href|src|action)\s*=\s*["']?\s*javascript\s*:/gi, '$1="');
  clean = clean.replace(/src\s*=\s*["']?\s*data\s*:/gi, 'src="');
  clean = clean.replace(/style\s*=\s*"[^"]*expression\s*\([^"]*"/gi, '');
  clean = clean.replace(/style\s*=\s*'[^']*expression\s*\([^']*'/gi, '');
  return clean;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

// ---- SHA256 hash for Meta CAPI ----
function sha256(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// ---- Main Handler ----
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
      agreementHtml: rawAgreementHtml, marketingConsent
    } = body;

    // Sanitize agreement HTML to prevent stored XSS
    const agreementHtml = sanitizeHtml(rawAgreementHtml);

    // =============================================
    // STEP 0: Verify Stripe PaymentIntent
    // =============================================
    if (!paymentIntentId || typeof paymentIntentId !== 'string' || !paymentIntentId.startsWith('pi_')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Geçersiz ödeme bilgisi.', success: false })
      };
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      console.error(`PaymentIntent ${paymentIntentId} status: ${paymentIntent.status}`);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Ödeme onaylanmadı.', success: false })
      };
    }

    // Verify amount matches (prevent price manipulation)
    const expectedTotal = Math.round(total);
    if (paymentIntent.amount !== expectedTotal) {
      console.error(`Amount mismatch: PI=${paymentIntent.amount}, expected=${expectedTotal}`);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Tutar uyuşmazlığı.', success: false })
      };
    }

    // Check if this PaymentIntent was already used (prevent duplicate orders)
    // Uses Stripe PI metadata — reliable, no extra Shopify API calls
    if (paymentIntent.metadata && paymentIntent.metadata.shopify_order_id) {
      console.warn(`PaymentIntent ${paymentIntentId} already used for order ${paymentIntent.metadata.shopify_order_name}`);
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'Bu ödeme zaten işlenmiş.',
          success: false,
          shopifyOrderName: paymentIntent.metadata.shopify_order_name || ''
        })
      };
    }

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
        const updatePayload = {
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
        };
        await shopifyRequest(`customers/${shopifyCustomerId}.json`, 'PUT', updatePayload);
        // Save Stripe Customer ID as metafield if provided
        if (stripeCustomerId) {
          try {
            await shopifyRequest(`customers/${shopifyCustomerId}/metafields.json`, 'POST', {
              metafield: {
                namespace: 'checkout',
                key: 'stripe_customer_id',
                value: stripeCustomerId,
                type: 'single_line_text_field'
              }
            });
          } catch (mfErr) {
            console.warn('Stripe customer metafield update warning:', mfErr.message);
          }
        }
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
    // Use the verified amount from Stripe, not the client-sent total
    const verifiedTotal = paymentIntent.amount;

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

    if (agreementHtml) {
      noteAttributes.push({ name: 'mesafeli_satis_sozlesmesi', value: 'onaylandi' });
    }

    const orderMetafields = [];
    if (agreementHtml) {
      orderMetafields.push({
        namespace: 'checkout',
        key: 'mesafeli_satis_sozlesmesi',
        value: agreementHtml,
        type: 'multi_line_text_field'
      });
    }
    if (marketingConsent) {
      orderMetafields.push({
        namespace: 'checkout',
        key: 'marketing_consent',
        value: 'true',
        type: 'single_line_text_field'
      });
    }

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
        note: `Custom checkout | Stripe PI: ${paymentIntentId}\n\n--- MESAFELİ SATIŞ SÖZLEŞMESİ ---\nSözleşme elektronik ortamda onaylanmıştır.`,
        note_attributes: noteAttributes,
        tags: `custom-checkout, stripe, pi_${paymentIntentId.replace('pi_', '')}`,
        metafields: orderMetafields,
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
          amount: (verifiedTotal / 100).toFixed(2),
          currency: 'TRY',
          gateway: 'stripe'
        }]
      }
    };

    // Server-side coupon re-validation before applying discount to Shopify order
    if (discountAmount > 0 && couponCode) {
      let couponValid = false;
      try {
        const lookupResp = await shopifyRequest(
          `discount_codes/lookup.json?code=${encodeURIComponent(couponCode.trim().toUpperCase())}`
        );
        if (lookupResp.discount_code && lookupResp.discount_code.price_rule_id) {
          const ruleResp = await shopifyRequest(
            `price_rules/${lookupResp.discount_code.price_rule_id}.json`
          );
          const rule = ruleResp.price_rule;
          if (rule) {
            const now = new Date();
            const notExpired = !rule.ends_at || new Date(rule.ends_at) >= now;
            const started = !rule.starts_at || new Date(rule.starts_at) <= now;
            if (notExpired && started) {
              // Recalculate discount server-side
              let serverDiscount = 0;
              const ruleValue = parseFloat(rule.value);
              const clientSubtotal = subtotal || 0;
              if (rule.value_type === 'percentage') {
                serverDiscount = Math.round(clientSubtotal * Math.abs(ruleValue) / 100);
              } else if (rule.value_type === 'fixed_amount') {
                serverDiscount = Math.round(Math.abs(ruleValue) * 100);
              }
              if (serverDiscount > clientSubtotal) serverDiscount = clientSubtotal;

              // Use server-calculated discount (don't trust client value)
              orderPayload.order.discount_codes = [{
                code: couponCode,
                amount: (serverDiscount / 100).toFixed(2),
                type: 'fixed_amount'
              }];
              couponValid = true;
            }
          }
        }
      } catch (couponErr) {
        console.warn('Coupon re-validation warning:', couponErr.message);
      }
      if (!couponValid) {
        console.warn(`Coupon "${couponCode}" failed server-side re-validation, skipping discount on order`);
      }
    }

    const orderResp = await shopifyRequest('orders.json', 'POST', orderPayload);
    const shopifyOrder = orderResp.order;

    console.log(`Shopify order created: ${shopifyOrder.name} (ID: ${shopifyOrder.id})`);

    // Mark PaymentIntent as used (prevents duplicate order creation)
    try {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          ...paymentIntent.metadata,
          shopify_order_id: shopifyOrder.id.toString(),
          shopify_order_name: shopifyOrder.name
        }
      });
    } catch (piUpdateErr) {
      console.warn('PI metadata update warning:', piUpdateErr.message);
    }

    // Update order with agreement URL in note_attributes
    if (agreementHtml) {
      const agreementLink = `https://checkout.thesveltechic.com/api/get-agreement?order=${encodeURIComponent(shopifyOrder.name)}&email=${encodeURIComponent(customer.email)}`;
      try {
        const existingAttrs = shopifyOrder.note_attributes || [];
        existingAttrs.push({ name: 'sozlesme_linki', value: agreementLink });
        await shopifyRequest(`orders/${shopifyOrder.id}.json`, 'PUT', {
          order: {
            id: shopifyOrder.id,
            note_attributes: existingAttrs
          }
        });
      } catch (noteErr) {
        console.error('Failed to add agreement URL:', noteErr.message);
      }
    }

    // Metafield fallback
    if (agreementHtml && (!shopifyOrder.metafields || shopifyOrder.metafields.length === 0)) {
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
        console.error('Agreement metafield fallback failed:', mfErr.message);
      }
    }

    // =============================================
    // STEP 3: Meta Conversions API — Purchase Event
    // =============================================
    try {
      const eventTime = Math.floor(Date.now() / 1000);
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
            value: parseFloat((verifiedTotal / 100).toFixed(2)),
            content_type: 'product',
            contents: items.map(item => ({
              id: `shopify_TR_${item.product_id}_${item.variant_id}`,
              quantity: item.quantity,
              item_price: parseFloat((item.price / 100).toFixed(2))
            })),
            content_ids: items.map(item => `shopify_TR_${item.product_id}_${item.variant_id}`),
            num_items: items.reduce((sum, item) => sum + item.quantity, 0),
            order_id: shopifyOrder.name
          }
        }]
      };

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
    } catch (metaErr) {
      console.error('Meta CAPI exception:', metaErr.message);
    }

    // =============================================
    // RESPONSE
    // =============================================
    const agreementUrl = `https://checkout.thesveltechic.com/api/get-agreement?order=${encodeURIComponent(shopifyOrder.name)}&email=${encodeURIComponent(customer.email)}`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        shopifyOrderId: shopifyOrder.id,
        shopifyOrderName: shopifyOrder.name,
        shopifyCustomerId: shopifyCustomerId,
        agreementUrl: agreementUrl
      })
    };

  } catch (err) {
    console.error('complete-order error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Sipariş oluşturulurken bir hata oluştu. Lütfen destek ile iletişime geçin.',
        success: false
      })
    };
  }
};
