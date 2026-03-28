/* ========================================
   Netlify Function: create-payment
   - Returns Stripe publishable key
   - Creates Stripe Customer + PaymentIntent
   ======================================== */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);

    // Action: get_key — return publishable key for Stripe Elements init
    if (body.action === 'get_key') {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
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
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Geçersiz tutar.' })
        };
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
      // Stripe expects amount in smallest currency unit (kuruş for TRY)
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount), // already in kuruş from Shopify
        currency: currency || 'try',
        customer: stripeCustomer.id,
        description: `Svelte Chic - ${items.map(i => i.title).join(', ').substring(0, 200)}`,
        metadata: {
          customer_email: customer.email,
          customer_name: `${customer.firstName} ${customer.lastName}`,
          items_summary: items.map(i => `${i.sku || 'N/A'} x${i.quantity}`).join(', ').substring(0, 500)
        },
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        }
      });

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          clientSecret: paymentIntent.client_secret,
          stripeCustomerId: stripeCustomer.id,
          paymentIntentId: paymentIntent.id
        })
      };
    }

    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Geçersiz istek.' })
    };

  } catch (err) {
    console.error('create-payment error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message || 'Sunucu hatası.' })
    };
  }
};
