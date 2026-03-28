/* ========================================
   Netlify Function: validate-coupon
   - Validates coupon code via Shopify discount_codes/lookup
   - Returns discount amount in kuruş
   - Uses Client Credentials Grant for Shopify auth
   ======================================== */

const { shopifyRequest } = require('./shopify-auth');

const ALLOWED_ORIGIN = process.env.CHECKOUT_ORIGIN || 'https://checkout.thesveltechic.com';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN,
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
    const { code, subtotal, items } = JSON.parse(event.body);

    if (!code || typeof code !== 'string' || code.length > 50) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, message: 'Kupon kodu gerekli.' })
      };
    }

    // Use discount_codes/lookup.json — single API call to find any code
    const cleanCode = code.trim().toUpperCase();
    let lookupResp;
    try {
      lookupResp = await shopifyRequest(
        `discount_codes/lookup.json?code=${encodeURIComponent(cleanCode)}`
      );
    } catch (lookupErr) {
      // 404 means code doesn't exist
      if (lookupErr.message && lookupErr.message.includes('404')) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ valid: false, message: 'Geçersiz kupon kodu.' })
        };
      }
      throw lookupErr;
    }

    const discountCode = lookupResp.discount_code;
    if (!discountCode || !discountCode.price_rule_id) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, message: 'Geçersiz kupon kodu.' })
      };
    }

    // Get the associated price rule (1 more API call)
    const ruleResp = await shopifyRequest(
      `price_rules/${discountCode.price_rule_id}.json`
    );
    const matchedPriceRule = ruleResp.price_rule;

    if (!matchedPriceRule) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, message: 'Kupon tanımı bulunamadı.' })
      };
    }

    // Validate the price rule
    const now = new Date();

    if (matchedPriceRule.starts_at && new Date(matchedPriceRule.starts_at) > now) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, message: 'Bu kupon henüz aktif değil.' })
      };
    }

    if (matchedPriceRule.ends_at && new Date(matchedPriceRule.ends_at) < now) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: false, message: 'Bu kuponun süresi dolmuş.' })
      };
    }

    // Check usage limit
    if (matchedPriceRule.usage_limit && matchedPriceRule.usage_limit > 0) {
      if (discountCode.usage_count >= matchedPriceRule.usage_limit) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ valid: false, message: 'Bu kupon kullanım limitine ulaşmış.' })
        };
      }
    }

    // Check minimum subtotal prerequisite
    if (matchedPriceRule.prerequisite_subtotal_range) {
      const minSubtotal = parseFloat(matchedPriceRule.prerequisite_subtotal_range.greater_than_or_equal_to) * 100;
      if (subtotal < minSubtotal) {
        const minFormatted = (minSubtotal / 100).toFixed(2).replace('.', ',') + 'TL';
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            valid: false,
            message: `Minimum sepet tutarı ${minFormatted} olmalıdır.`
          })
        };
      }
    }

    // Calculate discount amount
    let discountAmount = 0;
    const ruleValue = parseFloat(matchedPriceRule.value);

    if (matchedPriceRule.value_type === 'percentage') {
      discountAmount = Math.round(subtotal * Math.abs(ruleValue) / 100);
    } else if (matchedPriceRule.value_type === 'fixed_amount') {
      discountAmount = Math.round(Math.abs(ruleValue) * 100);
    }

    if (discountAmount > subtotal) {
      discountAmount = subtotal;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        discount_amount: discountAmount,
        discount_type: matchedPriceRule.value_type,
        discount_value: Math.abs(ruleValue),
        message: 'Kupon uygulandı.'
      })
    };

  } catch (err) {
    console.error('validate-coupon error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ valid: false, message: 'Kupon doğrulanamadı. Tekrar deneyin.' })
    };
  }
};
