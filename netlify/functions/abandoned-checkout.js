/* ========================================
   Netlify Function: abandoned-checkout
   Creates a DraftOrder in Shopify when a user
   abandons the checkout at the payment step.
   Visible in Shopify Admin > Draft Orders
   tagged as "abandoned-checkout".
   ======================================== */

const { shopifyRequest } = require('./shopify-auth');

const ALLOWED_ORIGIN = process.env.CHECKOUT_ORIGIN || 'https://checkout.thesveltechic.com';

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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const {
      customer,   // { email, phone, firstName, lastName, address, mahalle, district, city, zip, country }
      items,      // cart items array
      subtotal,   // in kuruş
      discountAmount, // in kuruş
      couponCode,
      abandonedAt // ISO timestamp of when the checkout was abandoned
    } = body;

    if (!customer || !customer.email || !items || items.length === 0) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Customer email and items are required' })
      };
    }

    const safePhone = sanitizePhoneForShopify(customer.phone);

    // ---- Build line items for DraftOrder ----
    const lineItems = items.map(item => ({
      variant_id: item.variant_id,
      quantity: item.quantity,
      title: item.title,
      price: (item.price / 100).toFixed(2),
      sku: item.sku || ''
    }));

    // ---- Build address ----
    const fullAddress1 = (customer.mahalle ? customer.mahalle + ', ' : '') + (customer.address || '');

    // ---- Build note with abandon details ----
    const abandonTime = abandonedAt || new Date().toISOString();
    const note = [
      '⚠️ YARIM BIRAKILAN ÖDEME (Abandoned Checkout)',
      `Tarih: ${new Date(abandonTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`,
      `Müşteri: ${customer.firstName} ${customer.lastName}`,
      `E-posta: ${customer.email}`,
      `Telefon: ${customer.phone || '-'}`,
      `Adres: ${fullAddress1}, ${customer.district || ''}, ${customer.city || ''}${customer.zip ? ' ' + customer.zip : ''}`,
      '',
      'Müşteri ödeme adımına geçtikten sonra 10 dakika içinde işlem tamamlanmadı.',
      'Kaynak: checkout.thesveltechic.com (Custom Checkout)'
    ].join('\n');

    // ---- Create DraftOrder in Shopify ----
    const draftPayload = {
      draft_order: {
        line_items: lineItems,
        customer: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          ...(safePhone ? { phone: safePhone } : {})
        },
        shipping_address: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          address1: fullAddress1,
          address2: customer.district || '',
          city: customer.city || '',
          province: customer.city || '',
          zip: customer.zip || '',
          country: 'TR',
          ...(safePhone ? { phone: safePhone } : {})
        },
        billing_address: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          address1: fullAddress1,
          address2: customer.district || '',
          city: customer.city || '',
          province: customer.city || '',
          zip: customer.zip || '',
          country: 'TR',
          ...(safePhone ? { phone: safePhone } : {})
        },
        note: note,
        tags: 'abandoned-checkout, custom-checkout',
        shipping_line: {
          title: 'Standart Kargo',
          price: '0.00'
        },
        use_customer_default_address: false,
        send_receipt: false,
        send_fulfillment_receipt: false
      }
    };

    // Apply discount if there was one
    if (discountAmount > 0 && couponCode) {
      draftPayload.draft_order.applied_discount = {
        title: couponCode,
        value: (discountAmount / 100).toFixed(2),
        value_type: 'fixed_amount',
        description: `Kupon: ${couponCode}`
      };
    }

    const draftResp = await shopifyRequest('draft_orders.json', 'POST', draftPayload);
    const draftOrder = draftResp.draft_order;

    console.log(`Abandoned checkout DraftOrder created: ${draftOrder.name} (ID: ${draftOrder.id}) for ${customer.email}`);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: true,
        draftOrderId: draftOrder.id,
        draftOrderName: draftOrder.name
      })
    };

  } catch (err) {
    console.error('abandoned-checkout error:', err);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        error: 'Yarım bırakılan ödeme kaydedilemedi.',
        success: false
      })
    };
  }
};
