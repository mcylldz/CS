/* ========================================
   Netlify Function: validate-coupon
   - Validates coupon code against Shopify Price Rules / Discount Codes
   - Returns discount amount in kuruş
   - Uses Client Credentials Grant for Shopify auth
   ======================================== */

const { shopifyRequest } = require('./shopify-auth');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { code, subtotal, items } = JSON.parse(event.body);

    if (!code) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ valid: false, message: 'Kupon kodu gerekli.' })
      };
    }

    // Step 1: Get all price rules and find matching discount code
    let matchedPriceRule = null;
    let found = false;

    const priceRulesResp = await shopifyRequest('price_rules.json?limit=250');
    const priceRules = priceRulesResp.price_rules || [];

    for (const rule of priceRules) {
      const codesResp = await shopifyRequest(`price_rules/${rule.id}/discount_codes.json`);
      const codes = codesResp.discount_codes || [];

      for (const dc of codes) {
        if (dc.code.toUpperCase() === code.toUpperCase()) {
          matchedPriceRule = rule;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!matchedPriceRule) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ valid: false, message: 'Geçersiz kupon kodu.' })
      };
    }

    // Step 2: Validate the price rule
    const now = new Date();

    if (matchedPriceRule.starts_at && new Date(matchedPriceRule.starts_at) > now) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ valid: false, message: 'Bu kupon henüz aktif değil.' })
      };
    }

    if (matchedPriceRule.ends_at && new Date(matchedPriceRule.ends_at) < now) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ valid: false, message: 'Bu kuponun süresi dolmuş.' })
      };
    }

    if (matchedPriceRule.usage_limit && matchedPriceRule.usage_limit > 0) {
      const codesResp = await shopifyRequest(`price_rules/${matchedPriceRule.id}/discount_codes.json`);
      const matchedCode = codesResp.discount_codes.find(
        dc => dc.code.toUpperCase() === code.toUpperCase()
      );
      if (matchedCode && matchedCode.usage_count >= matchedPriceRule.usage_limit) {
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ valid: false, message: 'Bu kupon kullanım limitine ulaşmış.' })
        };
      }
    }

    if (matchedPriceRule.prerequisite_subtotal_range) {
      const minSubtotal = parseFloat(matchedPriceRule.prerequisite_subtotal_range.greater_than_or_equal_to) * 100;
      if (subtotal < minSubtotal) {
        const minFormatted = (minSubtotal / 100).toFixed(2).replace('.', ',') + 'TL';
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            valid: false,
            message: `Minimum sepet tutarı ${minFormatted} olmalıdır.`
          })
        };
      }
    }

    // Step 3: Calculate discount amount
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
      headers: CORS_HEADERS,
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
      headers: CORS_HEADERS,
      body: JSON.stringify({ valid: false, message: 'Kupon doğrulanamadı. Tekrar deneyin.' })
    };
  }
};
