/* ========================================
   Netlify Function: create-payment
   - Returns Stripe publishable key
   - Creates Stripe Customer + PaymentIntent
   - Validates amount server-side via Shopify
   ======================================== */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { shopifyRequest } = require('./shopify-auth');

const ALLOWED_ORIGIN = process.env.CHECKOUT_ORIGIN || 'https://checkout.thesveltechic.com';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : '',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = corsHeaders(origin);

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);

    // Action: get_key — return publishable key for Stripe Elements init
    if (body.action === 'get_key') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
          metaPixelId: process.env.META_PIXEL_ID || ''
        })
      };
    }

    // Action: create_intent — create Stripe Customer + PaymentIntent
    if (body.action === 'create_intent') {
      const { amount, currency, customer, items } = body;

      if (!amount || amount < 100) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Geçersiz tutar.' })
        };
      }

      // ---- Server-side price verification ----
      // Verify item prices against Shopify to prevent price manipulation
      if (items && items.length > 0) {
        let verifiedSubtotal = 0;
        for (const item of items) {
          if (!item.variant_id || !item.quantity || item.quantity < 1) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'Geçersiz ürün bilgisi.' })
            };
          }
          try {
            const variantResp = await shopifyRequest(
              `variants/${item.variant_id}.json`
            );
            const shopifyPrice = Math.round(parseFloat(variantResp.variant.price) * 100);
            verifiedSubtotal += shopifyPrice * item.quantity;
          } catch (vErr) {
            console.error(`Variant ${item.variant_id} verification failed:`, vErr.message);
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'Ürün fiyatı doğrulanamadı.' })
            };
          }
        }

        // Allow up to verifiedSubtotal (amount could be less due to discount)
        // But amount should never exceed verified subtotal
        if (amount > verifiedSubtotal) {
          console.error(`Price manipulation detected: client=${amount}, shopify=${verifiedSubtotal}`);
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Tutar uyuşmazlığı.' })
          };
        }
      }

      // Find or create Stripe customer by email
      let stripeCustomer;
      const existingCustomers = await stripe.customers.list({
        email: customer.email,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        stripeCustomer = existingCustomers.data[0];
        // Update with latest info
        await stripe.customers.update(stripeCustomer.id, {
          name: `${customer.firstName} ${customer.lastName}`,
          phone: customer.phone,
          address: {
            line1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
            line2: customer.district || '',
            city: customer.city,
            postal_code: customer.zip,
            country: customer.country || 'TR'
          }
        });
      } else {
        stripeCustomer = await stripe.customers.create({
          email: customer.email,
          name: `${customer.firstName} ${customer.lastName}`,
          phone: customer.phone,
          address: {
            line1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
            line2: customer.district || '',
            city: customer.city,
            postal_code: customer.zip,
            country: customer.country || 'TR'
          },
          metadata: {
            source: 'sveltechic_checkout'
          }
        });
      }

      // Create PaymentIntent
      // setup_future_usage: 'off_session' saves the payment method
      // to the customer for future charges (subscriptions, manual orders)
      // Store cart data in metadata for webhook recovery (Stripe limit: 500 chars/value)
      const cartCompact = JSON.stringify(
        items.map(i => ({ v: i.variant_id, q: i.quantity, p: Math.round(parseFloat(i.price || i.line_price / i.quantity)), t: (i.title || '').substring(0, 60) }))
      ).substring(0, 500);

      const shippingCompact = JSON.stringify({
        first_name: customer.firstName, last_name: customer.lastName,
        address1: ((customer.mahalle ? customer.mahalle + ', ' : '') + (customer.address || '')).substring(0, 120),
        address2: (customer.district || '').substring(0, 60),
        city: customer.city || '', province: customer.city || '',
        zip: customer.zip || '', country: 'TR'
      }).substring(0, 500);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount),
        currency: currency || 'try',
        customer: stripeCustomer.id,
        setup_future_usage: 'off_session',
        description: `Svelte Chic - ${items.map(i => i.title).join(', ').substring(0, 200)}`,
        metadata: {
          customer_email: customer.email,
          customer_name: `${customer.firstName} ${customer.lastName}`,
          customer_phone: customer.phone || '',
          items_summary: items.map(i => `${i.sku || 'N/A'} x${i.quantity}`).join(', ').substring(0, 500),
          cart_items: cartCompact,
          shipping_address: shippingCompact
        },
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        }
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          clientSecret: paymentIntent.client_secret,
          stripeCustomerId: stripeCustomer.id,
          paymentIntentId: paymentIntent.id
        })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Geçersiz istek.' })
    };

  } catch (err) {
    console.error('create-payment error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Ödeme işlemi başlatılamadı. Lütfen tekrar deneyin.' })
    };
  }
};
