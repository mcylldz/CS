/* ========================================
   Netlify Function: stripe-webhook
   Safety net: if complete-order fails (timeout, crash, browser closes),
   this webhook catches payment_intent.succeeded and creates the
   Shopify order server-side using cart data stored in PI metadata.

   Setup in Stripe Dashboard:
   1. Go to Developers > Webhooks
   2. Add endpoint: https://checkout.thesveltechic.com/api/stripe-webhook
   3. Select event: payment_intent.succeeded
   4. Copy signing secret → set as STRIPE_WEBHOOK_SECRET in Netlify env
   ======================================== */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { shopifyRequest } = require('./shopify-auth');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// === FEATURE FLAG: Shopify native checkout aktif ===
// Shopify native checkout + Shopify Stripe app aynı Stripe hesabını kullanıyor.
// Bu webhook Shopify-originated payment'lar için de tetiklenir ve duplicate order yaratır.
// Custom checkout'a geri dönüldüğünde bu flag'i false yap.
const DISABLE_WEBHOOK_RECOVERY = true;

function sanitizePhoneForShopify(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  let normalized = '';
  if (digits.startsWith('90') && digits.length === 12) normalized = digits;
  else if (digits.startsWith('0') && digits.length === 11) normalized = '9' + digits;
  else if (digits.length === 10 && digits.startsWith('5')) normalized = '90' + digits;
  if (normalized.length === 12 && normalized.startsWith('905')) {
    return '+' + normalized;
  }
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Feature flag: Shopify native checkout aktifken webhook recovery'yi durdur
  if (DISABLE_WEBHOOK_RECOVERY) {
    console.log('[stripe-webhook] DISABLED (Shopify native checkout aktif) — skipping');
    return { statusCode: 200, body: JSON.stringify({ received: true, skipped: 'native_checkout_mode' }) };
  }

  // Verify webhook signature
  let stripeEvent;
  try {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.error('STRIPE_WEBHOOK_SECRET not configured');
      return { statusCode: 500, body: 'Webhook secret not configured' };
    }
    const sig = event.headers['stripe-signature'];
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Only handle payment_intent.succeeded
  if (stripeEvent.type !== 'payment_intent.succeeded') {
    return { statusCode: 200, body: JSON.stringify({ received: true, skipped: true }) };
  }

  const paymentIntent = stripeEvent.data.object;
  const piId = paymentIntent.id;

  console.log(`[stripe-webhook] Received payment_intent.succeeded: ${piId}`);

  // Check if order already exists (complete-order already handled it)
  if (paymentIntent.metadata && paymentIntent.metadata.shopify_order_id) {
    console.log(`[stripe-webhook] Order already exists: ${paymentIntent.metadata.shopify_order_name} — skipping`);
    return { statusCode: 200, body: JSON.stringify({ received: true, already_processed: true }) };
  }

  // Wait 20 seconds to give complete-order a chance to finish first
  await new Promise(r => setTimeout(r, 20000));

  // Re-check PI metadata (complete-order may have finished during the wait)
  const freshPI = await stripe.paymentIntents.retrieve(piId);
  if (freshPI.metadata && freshPI.metadata.shopify_order_id) {
    console.log(`[stripe-webhook] Order created during wait: ${freshPI.metadata.shopify_order_name} — skipping`);
    return { statusCode: 200, body: JSON.stringify({ received: true, already_processed: true }) };
  }

  // Double-check: query Shopify for an order with this PI tag (prevents race condition)
  try {
    const piTag = `pi_${piId.replace('pi_', '')}`;
    const existingOrders = await shopifyRequest(
      `orders.json?tag=${encodeURIComponent(piTag)}&status=any&limit=1`
    );
    if (existingOrders.orders && existingOrders.orders.length > 0) {
      const existing = existingOrders.orders[0];
      console.log(`[stripe-webhook] Found existing Shopify order by tag: ${existing.name} — skipping`);
      // Update PI metadata for future lookups
      await stripe.paymentIntents.update(piId, {
        metadata: { ...freshPI.metadata, shopify_order_id: existing.id.toString(), shopify_order_name: existing.name }
      }).catch(() => {});
      return { statusCode: 200, body: JSON.stringify({ received: true, already_processed: true }) };
    }
  } catch (tagErr) {
    console.warn('[stripe-webhook] Tag search failed, proceeding with recovery:', tagErr.message);
  }

  // ---- Order was NOT created by complete-order — create it now ----
  console.warn(`[stripe-webhook] No Shopify order for PI ${piId} — creating from webhook`);

  try {
    const meta = freshPI.metadata || {};
    const customerEmail = meta.customer_email || '';
    const customerName = meta.customer_name || '';
    const customerPhone = meta.customer_phone || '';
    const cartJson = meta.cart_items || ''; // stored by create-payment
    const shippingJson = meta.shipping_address || ''; // stored by create-payment

    if (!customerEmail) {
      console.error(`[stripe-webhook] No customer_email in PI metadata for ${piId}`);
      // Return 500 so Stripe retries — data might appear after a retry
      return { statusCode: 500, body: JSON.stringify({ error: 'no_customer_email' }) };
    }

    // Try to find existing Shopify customer
    let shopifyCustomerId = null;
    try {
      const searchResp = await shopifyRequest(
        `customers/search.json?query=email:${encodeURIComponent(customerEmail)}&limit=1`
      );
      if (searchResp.customers && searchResp.customers.length > 0) {
        shopifyCustomerId = searchResp.customers[0].id;
      }
    } catch (custErr) {
      console.warn('[stripe-webhook] Customer search failed:', custErr.message);
    }

    const nameParts = customerName.split(' ');
    const firstName = nameParts[0] || 'Müşteri';
    const lastName = nameParts.slice(1).join(' ') || '';
    const safePhone = sanitizePhoneForShopify(customerPhone);

    // Build line items — prefer real cart data from PI metadata
    let lineItems;
    if (cartJson) {
      try {
        // Format: [{"v":variantId,"q":qty,"p":priceInKurus,"t":"title"}]
        const cartItems = JSON.parse(cartJson);
        lineItems = cartItems.map(item => ({
          variant_id: item.v,
          quantity: item.q,
          price: (item.p / 100).toFixed(2),
          title: item.t || ''
        }));
      } catch (parseErr) {
        console.warn('[stripe-webhook] Cart parse failed, using fallback line item');
        lineItems = null;
      }
    }

    if (!lineItems) {
      // Fallback: single generic line item (needs manual review)
      lineItems = [{
        title: 'Sipariş (Webhook Recovery — ürünleri doğrulayın)',
        quantity: 1,
        price: (freshPI.amount / 100).toFixed(2)
      }];
    }

    // Build shipping address from PI metadata if available
    let shippingAddress = null;
    if (shippingJson) {
      try {
        shippingAddress = JSON.parse(shippingJson);
      } catch (e) {}
    }

    const orderPayload = {
      order: {
        email: customerEmail,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: true,
        send_fulfillment_receipt: true,
        note: `[WEBHOOK RECOVERY] Stripe PI: ${piId}\nÖdeme alındı, sipariş webhook üzerinden oluşturuldu.\n${!cartJson ? 'UYARI: Ürün bilgisi metadata\'da bulunamadı, lütfen doğrulayın.' : ''}`,
        tags: `custom-checkout, stripe, webhook-recovery, pi_${piId.replace('pi_', '')}`,
        line_items: lineItems,
        shipping_lines: [{ title: 'Standart Kargo', price: '0.00', code: 'FREE_SHIPPING' }],
        transactions: [{
          kind: 'sale',
          status: 'success',
          amount: (freshPI.amount / 100).toFixed(2),
          currency: (freshPI.currency || 'try').toUpperCase(),
          gateway: 'stripe'
        }]
      }
    };

    if (shopifyCustomerId) {
      orderPayload.order.customer = { id: shopifyCustomerId };
    }
    if (safePhone) {
      orderPayload.order.phone = safePhone;
    }
    if (shippingAddress) {
      orderPayload.order.shipping_address = shippingAddress;
      orderPayload.order.billing_address = shippingAddress;
    }

    // Use same idempotency key pattern as complete-order to prevent duplicates
    const orderResp = await shopifyRequest('orders.json', 'POST', orderPayload, 2, `order_${piId}`);
    const shopifyOrder = orderResp.order;

    console.log(`[stripe-webhook] Recovery order created: ${shopifyOrder.name} (ID: ${shopifyOrder.id})`);

    // Mark PI as used
    await stripe.paymentIntents.update(piId, {
      metadata: {
        ...freshPI.metadata,
        shopify_order_id: shopifyOrder.id.toString(),
        shopify_order_name: shopifyOrder.name,
        webhook_recovery: 'true'
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        recovery: true,
        shopifyOrderName: shopifyOrder.name,
        shopifyOrderId: shopifyOrder.id
      })
    };

  } catch (err) {
    console.error(`[stripe-webhook] Recovery FAILED for PI ${piId}:`, err.message);
    // Return 500 so Stripe retries this webhook delivery
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
