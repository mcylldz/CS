/* ========================================
   Netlify Function: order-tracking
   Müşteri sipariş no + email ile sipariş durumunu sorgular.
   - Shopify Admin API'den siparişi çeker
   - Email eşleşmesini doğrular
   - Sipariş tarihine göre timeline hesaplar
   - Fulfillment/tracking bilgisini döner
   ======================================== */

const { shopifyRequest } = require('./shopify-auth');

const ALLOWED_ORIGINS = [
  'https://www.thesveltechic.com',
  'https://thesveltechic.com',
  'https://checkout.thesveltechic.com'
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

/**
 * İş günü hesaplama — Cumartesi/Pazar atlar
 * @param {Date} startDate - Başlangıç tarihi
 * @param {number} days - Eklenecek iş günü sayısı
 * @returns {Date}
 */
function addBusinessDays(startDate, days) {
  const result = new Date(startDate);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}

/**
 * Sipariş tarihine göre timeline aşamalarını hesapla
 * @param {string} createdAt - Sipariş oluşturma tarihi (ISO)
 * @param {object} fulfillment - Shopify fulfillment objesi (varsa)
 * @returns {Array} Timeline aşamaları
 */
function calculateTimeline(createdAt, fulfillment) {
  const orderDate = new Date(createdAt);
  const now = new Date();

  // İş günü bazlı milestone tarihleri
  const productionDate = addBusinessDays(orderDate, 1);    // +1 iş günü
  const packagingDate = addBusinessDays(productionDate, 2); // +2 iş günü
  const shippedDate = addBusinessDays(packagingDate, 1);    // +1 iş günü

  // Tracking bilgisi
  const trackingNumber = fulfillment?.tracking_number || null;
  const trackingUrl = fulfillment?.tracking_url || null;
  const fulfillmentStatus = fulfillment?.status || null; // pending, open, success, cancelled

  // Shopify fulfillment "success" = teslim edildi
  const isDelivered = fulfillmentStatus === 'success';
  // Tracking number varsa "dağıtımda" aşamasına geçmiş demek
  const isInTransit = !!trackingNumber && !isDelivered;

  const stages = [
    {
      key: 'order_placed',
      label: 'Siparişiniz Alındı',
      date: orderDate.toISOString(),
      active: true, // Sipariş varsa her zaman aktif
      completed: true,
      description: 'Siparişiniz başarıyla alındı ve sisteme kaydedildi.'
    },
    {
      key: 'production',
      label: 'Üretim Başladı',
      date: productionDate.toISOString(),
      active: now >= productionDate,
      completed: now >= productionDate,
      description: 'Ürünleriniz üretim sürecine alındı.'
    },
    {
      key: 'packaging',
      label: 'Paketleme Aşamasında',
      date: packagingDate.toISOString(),
      active: now >= packagingDate,
      completed: now >= packagingDate,
      description: 'Ürünleriniz özenle paketleniyor.'
    },
    {
      key: 'shipped',
      label: 'Kargoya Verildi',
      date: shippedDate.toISOString(),
      active: now >= shippedDate,
      completed: now >= shippedDate,
      description: 'Siparişiniz başarılı bir şekilde kargoya verildi. Yerel kargo şirketine teslim edildikten sonra kargo takip numaranız e-posta adresinize iletilecek ve aynı zamanda buradan da takibini yapabileceksiniz. Yerel kargo takip numaranızın oluşması 7 ila 9 iş günü sürmektedir.'
    },
    {
      key: 'in_transit',
      label: 'Dağıtımda',
      date: null,
      active: isInTransit || isDelivered,
      completed: isInTransit || isDelivered,
      trackingNumber: trackingNumber,
      trackingUrl: trackingNumber
        ? `https://t.17track.net/tr#nums=${trackingNumber}`
        : null,
      description: trackingNumber
        ? `Kargonuz yola çıktı. Takip numaranız: ${trackingNumber}`
        : 'Kargo takip numarası henüz oluşmadı.'
    },
    {
      key: 'delivered',
      label: 'Teslim Edildi',
      date: null,
      active: isDelivered,
      completed: isDelivered,
      description: isDelivered
        ? 'Siparişiniz başarıyla teslim edildi. İyi alışverişler!'
        : 'Siparişiniz henüz teslim edilmedi.'
    }
  ];

  return stages;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { order_number, email } = JSON.parse(event.body || '{}');

    if (!order_number || !email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Sipariş numarası ve e-posta adresi gereklidir.' })
      };
    }

    // Input temizleme
    const cleanOrderNumber = String(order_number).replace(/[^0-9]/g, '');
    const cleanEmail = String(email).trim().toLowerCase();

    if (!cleanOrderNumber || cleanOrderNumber.length < 1) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Geçerli bir sipariş numarası giriniz.' })
      };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Geçerli bir e-posta adresi giriniz.' })
      };
    }

    // Shopify'dan siparişi ara (name = #1001 gibi)
    const searchResult = await shopifyRequest(
      `orders.json?name=%23${cleanOrderNumber}&status=any&fields=id,name,email,created_at,fulfillment_status,fulfillments,line_items,total_price,currency,financial_status`,
      'GET'
    );

    const orders = searchResult.orders || [];

    if (orders.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Sipariş bulunamadı. Lütfen sipariş numaranızı kontrol ediniz.' })
      };
    }

    // Email eşleşmesi kontrol et
    const matchedOrder = orders.find(
      o => o.email && o.email.toLowerCase() === cleanEmail
    );

    if (!matchedOrder) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Sipariş numarası ve e-posta adresi eşleşmiyor. Lütfen bilgilerinizi kontrol ediniz.' })
      };
    }

    // Fulfillment bilgisini al (varsa ilk fulfillment)
    const fulfillment = (matchedOrder.fulfillments && matchedOrder.fulfillments.length > 0)
      ? matchedOrder.fulfillments[0]
      : null;

    // Timeline hesapla
    const timeline = calculateTimeline(matchedOrder.created_at, fulfillment);

    // Ürün görselleri — line_items'da image yok, product'lardan çekiyoruz
    const lineItems = matchedOrder.line_items || [];
    const uniqueProductIds = [...new Set(lineItems.map(i => i.product_id).filter(Boolean))];

    const productImages = {};
    await Promise.all(uniqueProductIds.map(async (pid) => {
      try {
        const prod = await shopifyRequest(`products/${pid}.json?fields=id,images`, 'GET');
        if (prod.product?.images?.[0]?.src) {
          productImages[pid] = prod.product.images[0].src;
        }
      } catch (e) {
        // Ürün silinmiş olabilir — görselsiz devam et
      }
    }));

    // Ürün listesi (müşteriye gösterilecek)
    const items = lineItems.map(item => ({
      title: item.title,
      variant: item.variant_title || null,
      quantity: item.quantity,
      price: item.price,
      image: productImages[item.product_id] || null
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        order: {
          name: matchedOrder.name,
          created_at: matchedOrder.created_at,
          total_price: matchedOrder.total_price,
          currency: matchedOrder.currency,
          fulfillment_status: matchedOrder.fulfillment_status,
          financial_status: matchedOrder.financial_status,
          items: items
        },
        timeline: timeline
      })
    };

  } catch (err) {
    console.error('Order tracking error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Bir hata oluştu. Lütfen daha sonra tekrar deneyiniz.' })
    };
  }
};
