/* ========================================
   Netlify Function: complete-order
   1. Verify Stripe PaymentIntent succeeded
   2. Find/Create Shopify Customer
   3. Create Shopify Order (paid) — includes coupon, agreement, marketing consent
   4. Add agreement URL to order (needs order name)
   5. Mark PI as used (idempotency)
   6. Fire-and-forget: Stripe metafield, Meta CAPI (not Shopify-visible)
   ======================================== */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { shopifyRequest } = require('./shopify-auth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const ALLOWED_ORIGIN = process.env.CHECKOUT_ORIGIN || 'https://checkout.thesveltechic.com';

// ---- HTML Sanitizer ----
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

/**
 * Sanitize phone for Shopify API — returns E.164 format (+905XXXXXXXXX)
 * or empty string if the number can't be normalized to a valid Turkish mobile.
 * Shopify 2026-04 rejects invalid phone strings with 422.
 */
function sanitizePhoneForShopify(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  let normalized = '';
  if (digits.startsWith('90') && digits.length === 12) normalized = digits;
  else if (digits.startsWith('0') && digits.length === 11) normalized = '9' + digits;
  else if (digits.length === 10 && digits.startsWith('5')) normalized = '90' + digits;
  // Validate: must be 905XXXXXXXXX (12 digits, starts with 905)
  if (normalized.length === 12 && normalized.startsWith('905')) {
    return '+' + normalized;
  }
  return ''; // invalid — omit rather than crash the order
}

// ---- Fire-and-forget: only for non-Shopify tasks (Stripe metadata, Meta CAPI) ----
function fireAndForget(label, fn) {
  try { fn().catch(err => console.warn(`[fire-and-forget] ${label}:`, err.message)); }
  catch (err) { console.warn(`[fire-and-forget] ${label}:`, err.message); }
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
      autoDiscountAmount,
      autoDiscountTitle,
      total,
      fbp, fbc, purchaseEventId,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      userAgent, sourceUrl,
      agreementHtml: rawAgreementHtml, marketingConsent
    } = body;

    const agreementHtml = sanitizeHtml(rawAgreementHtml);

    // Sanitize phone — Shopify 2026-04 rejects invalid phone with 422
    const safePhone = sanitizePhoneForShopify(customer.phone);

    // =============================================
    // STEP 0: Verify Stripe PaymentIntent
    // =============================================
    if (!paymentIntentId || typeof paymentIntentId !== 'string' || !paymentIntentId.startsWith('pi_')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Geçersiz ödeme bilgisi.', success: false }) };
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ödeme onaylanmadı.', success: false }) };
    }

    const expectedTotal = Math.round(total);
    if (paymentIntent.amount !== expectedTotal) {
      console.error(`Amount mismatch: PI=${paymentIntent.amount}, expected=${expectedTotal}`);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Tutar uyuşmazlığı.', success: false }) };
    }

    // Duplicate check via Stripe PI metadata
    if (paymentIntent.metadata && paymentIntent.metadata.shopify_order_id) {
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

    const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || event.headers['x-nf-client-connection-ip']
      || event.headers['client-ip']
      || '';
    const clientUserAgent = userAgent || event.headers['user-agent'] || '';

    // =============================================
    // STEP 1: Find or Create Shopify Customer
    // =============================================
    let shopifyCustomerId = null;

    try {
      const searchResp = await shopifyRequest(
        `customers/search.json?query=email:${encodeURIComponent(customer.email)}&limit=1`
      );

      if (searchResp.customers && searchResp.customers.length > 0) {
        shopifyCustomerId = searchResp.customers[0].id;
        try {
          const customerUpdate = {
            customer: {
              id: shopifyCustomerId,
              addresses: [{
                first_name: customer.firstName, last_name: customer.lastName,
                address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
                address2: customer.district || '', city: customer.city, province: customer.city,
                zip: customer.zip, country: 'TR', default: true
              }]
            }
          };
          if (safePhone) {
            customerUpdate.customer.phone = safePhone;
            customerUpdate.customer.addresses[0].phone = safePhone;
          }
          await shopifyRequest(`customers/${shopifyCustomerId}.json`, 'PUT', customerUpdate);
        } catch (updateErr) {
          console.warn('Customer update warning:', updateErr.message);
        }
      } else {
        const newCustomer = {
          customer: {
            first_name: customer.firstName, last_name: customer.lastName,
            email: customer.email, verified_email: true,
            addresses: [{
              first_name: customer.firstName, last_name: customer.lastName,
              address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
              address2: customer.district || '', city: customer.city, province: customer.city,
              zip: customer.zip, country: 'TR', default: true
            }],
            tags: marketingConsent ? 'custom-checkout, accepts-marketing' : 'custom-checkout'
          }
        };
        if (safePhone) {
          newCustomer.customer.phone = safePhone;
          newCustomer.customer.addresses[0].phone = safePhone;
        }
        const createResp = await shopifyRequest('customers.json', 'POST', newCustomer);
        shopifyCustomerId = createResp.customer.id;
      }
    } catch (customerErr) {
      console.error('Customer creation failed, proceeding without customer ID:', customerErr.message);
    }

    // =============================================
    // STEP 2: Build & Create Shopify Order
    // Everything visible in Shopify goes into this ONE call:
    // - line items, addresses, discount, metafields, note_attributes
    // =============================================
    const verifiedTotal = paymentIntent.amount;

    const lineItems = items.map(item => ({
      variant_id: item.variant_id, quantity: item.quantity,
      price: (item.price / 100).toFixed(2), title: item.title, sku: item.sku || ''
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
    if (agreementHtml) noteAttributes.push({ name: 'mesafeli_satis_sozlesmesi', value: 'onaylandi' });

    // Metafields — packed into order creation (atomic)
    const orderMetafields = [];
    if (agreementHtml) {
      orderMetafields.push({
        namespace: 'checkout', key: 'mesafeli_satis_sozlesmesi',
        value: agreementHtml, type: 'multi_line_text_field'
      });
    }
    if (marketingConsent) {
      orderMetafields.push({
        namespace: 'checkout', key: 'marketing_consent',
        value: 'true', type: 'single_line_text_field'
      });
    }

    const orderPayload = {
      order: {
        email: customer.email,
        line_items: lineItems,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: true,
        send_fulfillment_receipt: true,
        note: `Custom checkout | Stripe PI: ${paymentIntentId}${customer.phone ? '\nTelefon (orijinal): ' + customer.phone : ''}\n\n--- MESAFELİ SATIŞ SÖZLEŞMESİ ---\nSözleşme elektronik ortamda onaylanmıştır.`,
        note_attributes: noteAttributes,
        metafields: orderMetafields,
        tags: `custom-checkout, stripe, pi_${paymentIntentId.replace('pi_', '')}`,
        shipping_address: {
          first_name: customer.firstName, last_name: customer.lastName,
          address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
          address2: customer.district || '', city: customer.city, province: customer.city,
          zip: customer.zip, country: 'TR'
        },
        billing_address: {
          first_name: customer.firstName, last_name: customer.lastName,
          address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
          address2: customer.district || '', city: customer.city, province: customer.city,
          zip: customer.zip, country: 'TR'
        },
        shipping_lines: [{ title: 'Standart Kargo', price: '0.00', code: 'FREE_SHIPPING' }],
        transactions: [{
          kind: 'sale', status: 'success',
          amount: (verifiedTotal / 100).toFixed(2), currency: 'TRY', gateway: 'stripe'
        }]
      }
    };

    // Only include phone if it's a valid E.164 Turkish number
    if (safePhone) {
      orderPayload.order.phone = safePhone;
      orderPayload.order.shipping_address.phone = safePhone;
      orderPayload.order.billing_address.phone = safePhone;
    }

    if (shopifyCustomerId) {
      orderPayload.order.customer = { id: shopifyCustomerId };
    }

    // ---- Automatic discount (Shopify cart-level discount) ----
    if (autoDiscountAmount > 0) {
      orderPayload.order.discount_codes = orderPayload.order.discount_codes || [];
      orderPayload.order.discount_codes.push({
        code: autoDiscountTitle || 'Otomatik İndirim',
        amount: (autoDiscountAmount / 100).toFixed(2),
        type: 'fixed_amount'
      });
    }

    // ---- Coupon: always include in order payload first (client value) ----
    // Then try server validation to upgrade it. If validation fails/times out,
    // order still has the discount the customer actually paid.
    if (discountAmount > 0 && couponCode) {
      // Fallback: use client-sent discount (already validated at payment time by create-payment)
      orderPayload.order.discount_codes = orderPayload.order.discount_codes || [];
      orderPayload.order.discount_codes.push({
        code: couponCode,
        amount: (discountAmount / 100).toFixed(2),
        type: 'fixed_amount'
      });

      // Try server re-validation to get exact Shopify-side amount
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
              let serverDiscount = 0;
              const ruleValue = parseFloat(rule.value);
              const clientSubtotal = subtotal || 0;
              if (rule.value_type === 'percentage') {
                serverDiscount = Math.round(clientSubtotal * Math.abs(ruleValue) / 100);
              } else if (rule.value_type === 'fixed_amount') {
                serverDiscount = Math.round(Math.abs(ruleValue) * 100);
              }
              if (serverDiscount > clientSubtotal) serverDiscount = clientSubtotal;
              // Upgrade: replace coupon entry with server-validated amount
              var codes = orderPayload.order.discount_codes || [];
              var couponIdx = codes.findIndex(c => c.code === couponCode);
              if (couponIdx >= 0) {
                codes[couponIdx].amount = (serverDiscount / 100).toFixed(2);
              }
              orderPayload.order.discount_codes = codes;
            }
          }
        }
      } catch (couponErr) {
        console.warn('Coupon server validation failed, using client discount:', couponErr.message);
        // orderPayload.order.discount_codes already set above — order proceeds with client value
      }
    }

    // ---- CREATE ORDER — single atomic call with ALL Shopify-visible data ----
    // Use PI ID as idempotency key to prevent duplicate orders from retries/webhook race
    const orderResp = await shopifyRequest('orders.json', 'POST', orderPayload, 2, `order_${paymentIntentId}`);
    const shopifyOrder = orderResp.order;
    console.log(`Shopify order created: ${shopifyOrder.name} (ID: ${shopifyOrder.id})`);

    // =============================================
    // STEP 3: Add agreement link to note_attributes (needs order name)
    // The agreement HTML itself is already in the order metafield (atomic).
    // This link is for convenience — retry once if it fails.
    // =============================================
    if (agreementHtml) {
      const agreementLink = `https://checkout.thesveltechic.com/api/get-agreement?order=${encodeURIComponent(shopifyOrder.name)}&email=${encodeURIComponent(customer.email)}`;
      const existingAttrs = shopifyOrder.note_attributes || [];
      existingAttrs.push({ name: 'sozlesme_linki', value: agreementLink });
      const notePayload = { order: { id: shopifyOrder.id, note_attributes: existingAttrs } };
      try {
        await shopifyRequest(`orders/${shopifyOrder.id}.json`, 'PUT', notePayload);
      } catch (noteErr) {
        console.warn('Agreement link first attempt failed, retrying:', noteErr.message);
        try {
          await shopifyRequest(`orders/${shopifyOrder.id}.json`, 'PUT', notePayload);
        } catch (retryErr) {
          console.error('Agreement link retry also failed:', retryErr.message);
        }
      }
    }

    // =============================================
    // STEP 4: Mark PI as used — idempotency guard for retries
    // =============================================
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

    // =============================================
    // STEP 5: Fire-and-forget — NOT visible in Shopify, safe to background
    // =============================================

    // Stripe customer ID metafield on Shopify customer
    if (stripeCustomerId && shopifyCustomerId) {
      fireAndForget('stripe-customer-metafield', () =>
        shopifyRequest(`customers/${shopifyCustomerId}/metafields.json`, 'POST', {
          metafield: { namespace: 'checkout', key: 'stripe_customer_id', value: stripeCustomerId, type: 'single_line_text_field' }
        })
      );
    }

    // Meta CAPI Purchase event — MUST await before response (Netlify kills function after return)
    if (META_PIXEL_ID && META_ACCESS_TOKEN) {
      try {
        const eventTime = Math.floor(Date.now() / 1000);
        const eventId = purchaseEventId || `purchase_${eventTime}_${Math.random().toString(36).substr(2, 9)}`;
        if (!purchaseEventId) {
          console.warn('⚠️ Missing purchaseEventId from browser — generated fallback:', eventId);
        }
        const capiResp = await fetch(
          `https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: [{
                event_name: 'Purchase',
                event_time: eventTime,
                event_id: eventId,
                event_source_url: sourceUrl || 'https://checkout.thesveltechic.com',
                action_source: 'website',
                user_data: {
                  client_ip_address: clientIp,
                  client_user_agent: clientUserAgent,
                  ...(fbp ? { fbp } : {}),
                  ...(fbc ? { fbc } : {}),
                  ...(customer.email ? { em: [customer.email.trim().toLowerCase()] } : {}),
                  ...(customer.phone ? { ph: [normalizePhone(customer.phone)] } : {}),
                  ...(customer.firstName ? { fn: [customer.firstName.trim().toLowerCase()] } : {}),
                  ...(customer.lastName ? { ln: [customer.lastName.trim().toLowerCase()] } : {}),
                  ...(customer.city ? { ct: [customer.city.trim().toLowerCase()] } : {}),
                  ...(customer.state ? { st: [customer.state.trim().toLowerCase()] } : {}),
                  ...(customer.zip ? { zp: [customer.zip.trim()] } : {}),
                  country: ['tr'],
                  ...(customer.email ? { external_id: [customer.email.trim().toLowerCase()] } : {})
                },
                custom_data: {
                  currency: 'TRY',
                  value: parseFloat((verifiedTotal / 100).toFixed(2)),
                  content_type: 'product',
                  contents: items.map(item => ({
                    id: String(item.variant_id),
                    quantity: item.quantity,
                    item_price: parseFloat((item.price / 100).toFixed(2)),
                    title: item.title || '',  // ← Product title (for dynamic ads)
                    image_url: item.image || '',  // ← Product image
                    url: `https://www.thesveltechic.com/products/${item.product_id}`  // ← Product URL
                  })),
                  content_ids: items.map(item => String(item.variant_id)),
                  num_items: items.reduce((sum, item) => sum + item.quantity, 0),
                  order_id: shopifyOrder.name,
                  transaction_id: paymentIntentId
                }
              }]
            })
          }
        );
        const capiResult = await capiResp.json();
        console.log('Meta CAPI:', JSON.stringify(capiResult));
        if (!capiResp.ok) {
          console.error('Meta CAPI HTTP error:', capiResp.status, JSON.stringify(capiResult));
        }
        if (capiResult.error) {
          console.error('Meta CAPI Purchase ERROR:', JSON.stringify(capiResult.error));
        }
        if (capiResult.events_received === 0) {
          console.error('Meta CAPI Purchase: 0 events received — event was dropped!');
        }
      } catch (capiErr) {
        console.error('Meta CAPI error:', capiErr.message);
      }
    }

    // =============================================
    // RESPONSE
    // =============================================
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        shopifyOrderId: shopifyOrder.id,
        shopifyOrderName: shopifyOrder.name,
        shopifyCustomerId: shopifyCustomerId,
        agreementUrl: agreementHtml
          ? `https://checkout.thesveltechic.com/api/get-agreement?order=${encodeURIComponent(shopifyOrder.name)}&email=${encodeURIComponent(customer.email)}`
          : null
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
