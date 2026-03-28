/* ========================================
   Netlify Function: get-agreement
   Retrieves the mesafeli satış sözleşmesi
   from a Shopify order's metafield and
   renders it as a styled HTML page.

   Usage: /api/get-agreement?order=1234&email=x@y.com
   ======================================== */

const { shopifyRequest } = require('./shopify-auth');

// No CORS needed — this endpoint serves HTML pages directly in the browser

// ---- HTML Sanitizer: strip dangerous tags/attributes to prevent XSS ----
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';

  // Remove <script> tags and their content
  let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove <iframe>, <object>, <embed>, <form>, <input>, <textarea>, <select>, <button> tags
  clean = clean.replace(/<\/?(iframe|object|embed|form|input|textarea|select|button|link|meta|base|applet)\b[^>]*>/gi, '');

  // Remove on* event handlers (onclick, onerror, onload, etc.)
  clean = clean.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');

  // Remove javascript: URLs from href/src/action attributes
  clean = clean.replace(/(href|src|action)\s*=\s*["']?\s*javascript\s*:/gi, '$1="');

  // Remove data: URLs from src (can embed scripts)
  clean = clean.replace(/src\s*=\s*["']?\s*data\s*:/gi, 'src="');

  // Remove style attributes containing expression() or url(javascript:)
  clean = clean.replace(/style\s*=\s*"[^"]*expression\s*\([^"]*"/gi, '');
  clean = clean.replace(/style\s*=\s*'[^']*expression\s*\([^']*'/gi, '');

  return clean;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: 'Method not allowed' };
  }

  try {
    const params = event.queryStringParameters || {};
    const orderName = params.order; // e.g. "STC1175" or "#STC1175"
    const email = params.email;

    if (!orderName || !email) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: renderErrorPage('Geçersiz istek. Sipariş numarası ve e-posta adresi gereklidir.')
      };
    }

    // Search for the order by name
    const cleanOrderName = orderName.replace('#', '').trim();
    const searchResp = await shopifyRequest(
      `orders.json?name=${encodeURIComponent(cleanOrderName)}&status=any&limit=1`
    );

    if (!searchResp.orders || searchResp.orders.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: renderErrorPage('Sipariş bulunamadı.')
      };
    }

    const order = searchResp.orders[0];

    // Verify email matches (security check)
    if (order.email && order.email.toLowerCase() !== email.toLowerCase().trim()) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: renderErrorPage('Erişim reddedildi. E-posta adresi sipariş ile eşleşmiyor.')
      };
    }

    // Get metafields for this order
    const metafieldsResp = await shopifyRequest(
      `orders/${order.id}/metafields.json?namespace=checkout&key=mesafeli_satis_sozlesmesi`
    );

    let agreementHtml = '';
    if (metafieldsResp.metafields && metafieldsResp.metafields.length > 0) {
      const mf = metafieldsResp.metafields[0];
      if (mf.type === 'json') {
        try {
          const parsed = JSON.parse(mf.value);
          agreementHtml = parsed.html || mf.value;
        } catch (e) {
          agreementHtml = mf.value;
        }
      } else {
        agreementHtml = mf.value;
      }
    }

    if (!agreementHtml) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: renderErrorPage('Bu sipariş için sözleşme bulunamadı.')
      };
    }

    // Sanitize agreement HTML to prevent stored XSS
    const safeHtml = sanitizeHtml(agreementHtml);

    // Render the agreement as a styled page
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: renderAgreementPage(safeHtml, order.name)
    };

  } catch (err) {
    console.error('get-agreement error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: renderErrorPage('Bir hata oluştu. Lütfen daha sonra tekrar deneyin.')
    };
  }
};

function renderAgreementPage(agreementHtml, orderName) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mesafeli Satış Sözleşmesi — ${orderName || 'Svelte Chic'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #fafaf8;
      color: #333;
      line-height: 1.7;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #e8e4dc;
      border-radius: 8px;
      padding: 40px;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #b5a07c;
    }
    .header img { height: 40px; margin-bottom: 10px; }
    .header p { color: #888; font-size: 13px; }
    .agreement-content h3 { color: #1a1a1a; margin: 20px 0 10px; }
    .agreement-content h4 { color: #1a1a1a; margin: 24px 0 8px; font-size: 15px; }
    .agreement-content p { margin-bottom: 8px; font-size: 14px; }
    .agreement-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0 16px;
      font-size: 13px;
    }
    .agreement-content table td {
      padding: 6px 10px;
      border: 1px solid #e8e4dc;
    }
    .agreement-content table tr:nth-child(even) { background: #fafaf8; }
    .agreement-content strong { color: #1a1a1a; }
    .agreement-content hr { border: none; border-top: 1px solid #e8e4dc; margin: 20px 0; }
    .footer {
      text-align: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e8e4dc;
      color: #999;
      font-size: 12px;
    }
    .print-btn {
      display: inline-block;
      background: #b5a07c;
      color: #fff;
      padding: 10px 24px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      margin: 20px 0;
    }
    .print-btn:hover { background: #a08c6a; }
    @media print {
      .print-btn { display: none; }
      body { background: #fff; padding: 0; }
      .container { border: none; box-shadow: none; padding: 20px; }
    }
    @media (max-width: 600px) {
      .container { padding: 20px; }
      .agreement-content table { font-size: 12px; }
      .agreement-content table td { padding: 4px 6px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="color:#b5a07c; font-weight:400; letter-spacing:2px;">SVELTE CHIC</h2>
      <p>Sipariş: ${orderName || ''}</p>
    </div>
    <div class="agreement-content">
      ${agreementHtml}
    </div>
    <div style="text-align:center;">
      <button class="print-btn" onclick="window.print()">Yazdır / PDF Olarak Kaydet</button>
    </div>
    <div class="footer">
      <p>Bu belge, sipariş sırasında elektronik ortamda onaylanmış olan Mesafeli Satış Sözleşmesi'nin bir kopyasıdır.</p>
      <p style="margin-top:8px;">Svelte Chic — www.thesveltechic.com — destek@thesveltechic.com</p>
    </div>
  </div>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hata — Svelte Chic</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #fafaf8; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .error-box { background: #fff; border: 1px solid #e8e4dc; border-radius: 8px; padding: 40px; text-align: center; max-width: 500px; }
    .error-box h2 { color: #b5a07c; margin-bottom: 16px; }
    .error-box p { color: #666; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="error-box">
    <h2>Svelte Chic</h2>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
