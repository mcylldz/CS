# Meta Event Tracking — Eylem Planı & Düzeltme Kodları
**Tarih:** 2026-04-13  
**Priority:** P0 (STATE), P1 (Product Metadata + FBP/FBC), P2 (Polish)  
**Tahmini Süre:** 3-5 gün  

---

## EYLEM 1: STATE (İl) ALANINI EKLEYIN [P0]

### Neden?
- EMQ (Email Matching Quality) score'u düşük
- Meta müşteri tanımlama başarısı ~60% (should be 85%+)
- CustomerID matching'in temel bileşeni

### Koşu Zamanı
**HEMEN yapmalı** — bu tek başına EMQ score'u %15-20 artırır.

---

### 1.1 Form HTML'de State Field'ı Var mı?

**Dosya:** `index.html`

Kontrol et: `<select id="city">` ve `<select id="district">` var mı?

Varsa, aşağıdaki adımlar:

---

### 1.2 Checkout.js'te Customer Data Capture

**Dosya:** `js/checkout.js`

**Bul:** `function getCustomerData()` (satır ~670)

**Değiştir:**
```javascript
function getCustomerData() {
  var val = function(id) {
    return (document.getElementById(id)?.value || '').trim();
  };
  
  return {
    email: val('email'),
    phone: val('phone'),
    firstName: val('firstName'),
    lastName: val('lastName'),
    address: val('address'),
    city: val('city'),           // ← İl
    district: val('district'),   // ← İlçe
    state: val('city'),          // ← STATE = İL (Türkiye'de il = state)
    mahalle: val('mahalle'),     // ← Mahalle (opsiyonel)
    zip: val('zip'),             // ← Posta kodu
    country: val('country') || 'TR'
  };
}
```

**Önemli:** `state = city` (Türkiye'de eyalet/state = il)

---

### 1.3 Track-Event.js'te STATE Gönderimi

**Dosya:** `netlify/functions/track-event.js`, satır 96-115

**Değiştir:**
```javascript
const userData = {
  client_ip_address: clientIp,
  client_user_agent: clientUserAgent,
  ...(fbp ? { fbp } : {}),
  ...(fbc ? { fbc } : {}),
  
  // EMQ Fields
  ...(customer.email ? { em: [sha256(customer.email)] } : {}),
  ...(customer.phone ? { ph: [sha256(normalizePhone(customer.phone))] } : {}),
  ...(customer.firstName ? { fn: [sha256(customer.firstName)] } : {}),
  ...(customer.lastName ? { ln: [sha256(customer.lastName)] } : {}),
  ...(customer.city ? { ct: [sha256(customer.city)] } : {}),
  ...(customer.state ? { st: [sha256(customer.state)] } : {}),  // ← ADD
  ...(customer.zip ? { zp: [sha256(customer.zip)] } : {}),
  ...(customer.district ? { st: [sha256(customer.district)] } : {}),  // ← REMOVE
  country: [sha256('tr')]
};
```

---

### 1.4 Complete-Order.js'te STATE Gönderimi

**Dosya:** `netlify/functions/complete-order.js`, satır 443-456

**Değiştir:**
```javascript
user_data: {
  client_ip_address: clientIp,
  client_user_agent: clientUserAgent,
  ...(fbp ? { fbp } : {}),
  ...(fbc ? { fbc } : {}),
  
  // EMQ
  ...(customer.email ? { em: [sha256(customer.email)] } : {}),
  ...(customer.phone ? { ph: [sha256(normalizePhone(customer.phone))] } : {}),
  ...(customer.firstName ? { fn: [sha256(customer.firstName)] } : {}),
  ...(customer.lastName ? { ln: [sha256(customer.lastName)] } : {}),
  ...(customer.city ? { ct: [sha256(customer.city)] } : {}),
  ...(customer.state ? { st: [sha256(customer.state)] } : {}),  // ← ADD
  ...(customer.zip ? { zp: [sha256(customer.zip)] } : {}),
  country: [sha256('tr')],
  ...(shopifyCustomerId ? { external_id: [sha256(shopifyCustomerId.toString())] } : customer.email ? { external_id: [sha256(customer.email)] } : {})
},
```

---

### 1.5 Checkout.js'te Complete-Order Body'ye STATE Ekle

**Dosya:** `js/checkout.js`, satır 1253-1281

**Değiştir:**
```javascript
var completeOrderBody = JSON.stringify({
  paymentIntentId: paymentIntent.id,
  stripeCustomerId: piData.stripeCustomerId,
  customer: customerInfo,  // ← customerInfo'de state var mı kontrol et
  // ...
});
```

**Eğer customerInfo'de state yoksa:**
```javascript
var customerInfo = getCustomerData();
customerInfo.state = customerInfo.city;  // ← Ensure state field
```

---

## EYLEM 2: PRODUCT METADATA EKLEYIN (Title + Image) [P1]

### 2.1 Track-Event.js'te Contents Update

**Dosya:** `netlify/functions/track-event.js`, satır 123-132

**Değiştir:**
```javascript
customData.contents = items.map(item => ({
  id: String(item.variant_id),
  quantity: item.quantity,
  item_price: parseFloat((item.price / 100).toFixed(2)),
  title: item.title || '',          // ← ADD
  image_url: item.image || '',      // ← ADD
  url: `https://www.thesveltechic.com/products/${item.product_id}`  // ← ADD
}));
```

---

### 2.2 Complete-Order.js'te Contents Update

**Dosya:** `netlify/functions/complete-order.js`, satır 462-466

**Değiştir:**
```javascript
contents: items.map(item => ({
  id: String(item.variant_id),
  quantity: item.quantity,
  item_price: parseFloat((item.price / 100).toFixed(2)),
  title: item.title || '',          // ← ADD
  image_url: item.image || '',      // ← ADD
  url: `https://www.thesveltechic.com/products/${item.product_id}`  // ← ADD
})),
```

---

### 2.3 Browser Pixel'de Contents (opsiyonel)

**Dosya:** `js/checkout.js`, satır 593-615 (`buildFbqCustomData()`)

**Değiştir:**
```javascript
function buildFbqCustomData() {
  var total = subtotal - discountAmount - autoDiscountAmount;
  var data = {
    currency: 'TRY',
    value: parseFloat((total / 100).toFixed(2)),
    content_type: 'product',
    contents: cartItems.map(function(item) {
      return {
        id: String(item.variant_id),
        quantity: item.quantity,
        item_price: parseFloat((item.price / 100).toFixed(2)),
        title: item.title || '',          // ← ADD
        image_url: item.image || '',      // ← ADD
        url: `https://www.thesveltechic.com/products/${item.product_id}`  // ← ADD
      };
    }),
    content_ids: cartItems.map(function(i) { return String(i.variant_id); }),
    num_items: cartItems.reduce(function(s, i) { return s + i.quantity; }, 0)
  };
  // ...discount handling...
  return data;
}
```

---

## EYLEM 3: FBP/FBC BACKUP (SessionStorage) [P1]

### 3.1 Checkout Redirect Snippet'inde SessionStorage Fallback

**Dosya:** `shopify-snippet/sc-checkout-redirect.liquid`, satır 17-31

**Değiştir:**
```js
function getUTMs() {
  var params = new URLSearchParams(window.location.search);
  var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbp', 'fbc'];
  var utms = {};
  
  keys.forEach(function(key) {
    var val = params.get(key);
    if (val) {
      utms[key] = val;
      try { 
        sessionStorage.setItem('sc_' + key, val); 
        // FBP/FBC için ayrıca cookie'ye de yaz (opsiyonel)
        if (key === 'fbp' || key === 'fbc') {
          document.cookie = '_' + key + '=' + val + '; path=/; max-age=7776000; SameSite=Lax';
        }
      } catch(e) {}
    } else {
      try { 
        utms[key] = sessionStorage.getItem('sc_' + key) || ''; 
      } catch(e) { 
        utms[key] = ''; 
      }
    }
  });
  
  return utms;
}
```

---

### 3.2 Checkout.js'te SessionStorage'dan FBP/FBC Fallback

**Dosya:** `js/checkout.js`, satır 29-40

**Değiştir:**
```javascript
function getCookie(name) {
  var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : '';
}

// Try cookie first, then URL params, then sessionStorage
var fbp = getCookie('_fbp') || params.get('fbp') || (function() { 
  try { return sessionStorage.getItem('sc_fbp') || ''; } catch(e) { return ''; } 
}());

var fbclid = params.get('fbclid') || (function() {
  try { return sessionStorage.getItem('sc_fbclid') || ''; } catch(e) { return ''; }
}());

var fbc = getCookie('_fbc') || params.get('fbc') || (function() {
  try { return sessionStorage.getItem('sc_fbc') || ''; } catch(e) { return ''; }
}()) || (fbclid ? ('fb.1.' + Date.now() + '.' + fbclid) : '');
```

---

## EYLEM 4: CAPI PAYLOAD'A `transaction_id` EKLE [P2]

### 4.1 Complete-Order.js

**Dosya:** `netlify/functions/complete-order.js`, satır 458-471

**Değiştir:**
```javascript
custom_data: {
  currency: 'TRY',
  value: parseFloat((verifiedTotal / 100).toFixed(2)),
  content_type: 'product',
  contents: items.map(item => ({...})),
  content_ids: items.map(item => String(item.variant_id)),
  num_items: items.reduce((sum, item) => sum + item.quantity, 0),
  transaction_id: paymentIntentId,  // ← ADD (consistency)
  order_id: shopifyOrder.name
}
```

---

## EYLEM 5: BROWSER ADVANCED MATCHING HASH TUTARLILIĞI [P2]

### 5.1 Checkout.js'te updatePixelUserData() SHA256 ile

**Dosya:** `js/checkout.js`, satır 571-586

**Değiştir:**
```javascript
function updatePixelUserData(customer) {
  if (!metaPixelReady || typeof fbq === 'undefined') return;
  
  var userData = {};
  if (customer.email) userData.em = sha256(customer.email);  // ← Hash
  if (customer.phone) userData.ph = sha256(normalizePhone(customer.phone));  // ← Hash
  if (customer.firstName) userData.fn = sha256(customer.firstName);  // ← Hash
  if (customer.lastName) userData.ln = sha256(customer.lastName);  // ← Hash
  if (customer.city) userData.ct = sha256(customer.city);  // ← Hash
  if (customer.state) userData.st = sha256(customer.state);  // ← Hash (ADD)
  if (customer.zip) userData.zp = sha256(customer.zip);  // ← Hash
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  
  fbq('init', window._metaPixelId || '', userData);
  console.log('Meta Pixel Advanced Matching updated with hashed customer data');
}
```

**Gereklilik:** `sha256()` function'ı checkout.js'te import edin:
```javascript
// Top'ta
const crypto = require('crypto');  // ← Browser'da çalışmaz!
```

**Browser'da çalışması için:**
```javascript
// Alternatif: Lightweight SHA256 library (jssha, js-sha256, etc.)
// Veya: basit hash yerine plaintext gönder, Meta hash etsin
```

**Tavsiye:** Plaintext göndermeyi sakın — CAPI zaten sha256 hash yapıyor, tutarlı olması lazım. Basit çözüm:

```javascript
// Plaintext gönder, Meta hash etsin (doğru yaklaşım)
fbq('init', pixelId, {
  em: customer.email.toLowerCase().trim(),  // plaintext
  ph: normalizePhone(customer.phone),  // plaintext
  fn: customer.firstName.toLowerCase().trim(),
  ln: customer.lastName.toLowerCase().trim(),
  ...
});
```

---

## EYLEM 6: TEST & VALIDATION [Tüm Faz]

### 6.1 Local Development Testing

```bash
# 1) Checkout.js'i test et (browser console)
cd ~/Desktop/sveltechic-checkout
npm install  # (if needed)

# 2) Netlify functions'ı test et (lokal)
netlify dev
```

**Browser Console test:**
```javascript
// 1) Customer data captured?
getCustomerData()  
// should output: {email, phone, firstName, lastName, ..., state, ...}

// 2) Meta Pixel loaded?
window.fbq
window._metaPixelId

// 3) Test Purchase event
fbq('track', 'Purchase', {
  value: 100,
  currency: 'TRY',
  content_type: 'product',
  contents: [{id: 'variant_123', quantity: 1}]
}, { eventID: 'test_1234567890_abc' });
```

### 6.2 Network Tab Testing

```
1) Open DevTools → Network
2) Make test purchase
3) Look for:
   - POST /api/track-event (InitiateCheckout)
   - POST /api/track-event (AddPaymentInfo)
   - POST /api/complete-order
   - Check request payloads:
     - customer.state var mı?
     - items[0].title var mı?
     - fbp/fbc var mı?
```

### 6.3 Staging Deploy

```bash
cd ~/Desktop/sveltechic-checkout

# 1) Commit changes
git add -A
git commit -m "fix: Add state/province field, product metadata, FBP/FBC backup for Meta tracking"

# 2) Deploy to staging
netlify deploy --site-id <STAGING_SITE_ID> --prod

# 3) Test on staging
curl -X POST https://staging-checkout.netlify.app/api/track-event \
  -H "Content-Type: application/json" \
  -d '{
    "eventName": "InitiateCheckout",
    "customer": {
      "email": "test@example.com",
      "phone": "5551234567",
      "firstName": "Test",
      "lastName": "User",
      "city": "İstanbul",
      "state": "İstanbul",
      "zip": "34000"
    },
    "items": [{
      "variant_id": "123",
      "title": "Test Product",
      "image": "https://...",
      "price": 10000
    }],
    "total": 10000,
    "fbp": "fb.1.xxx",
    "fbc": "fb.1.xxx"
  }'

# Check response
```

### 6.4 Meta Events Manager Validation

```
1) https://business.facebook.com → Events Manager
2) Filter by Pixel ID
3) Check:
   - InitiateCheckout events visible?
   - Purchase events visible?
   - Event count correct? (no double counting?)
   - User data fields present?
   - EMQ score nedir?
```

### 6.5 Production Rollout

```bash
# 1) Code review seninle
# 2) Final test on staging (24 hours)
# 3) Deploy to production
netlify deploy --site-id <PROD_SITE_ID> --prod

# 4) Monitor 48 hours
#    - Meta Events Manager
#    - Google Analytics (purchase events)
#    - Yandex Metrica
#    - No errors in logs
```

---

## EYLEM ÖZETI (Checklist)

### Phase 1: Code Changes (P0) — 2 gün

- [ ] `js/checkout.js` — getCustomerData() 'state' field'ı ekle
- [ ] `netlify/functions/track-event.js` — EMQ fields (st, no district)
- [ ] `netlify/functions/complete-order.js` — EMQ fields (st, no district)
- [ ] Git commit + test locally

### Phase 2: Product Metadata (P1) — 1 gün

- [ ] `netlify/functions/track-event.js` — contents title/image/url
- [ ] `netlify/functions/complete-order.js` — contents title/image/url
- [ ] `js/checkout.js` — buildFbqCustomData() contents update
- [ ] Git commit + test locally

### Phase 3: FBP/FBC Backup (P1) — 1 gün

- [ ] `shopify-snippet/sc-checkout-redirect.liquid` — sessionStorage backup
- [ ] `js/checkout.js` — sessionStorage fallback
- [ ] Git commit + test locally

### Phase 4: Polish (P2) — 1 gün

- [ ] CAPI transaction_id ekle
- [ ] Browser hash tutarlılığı (plaintext veya sha256 decision)
- [ ] Code review + comments

### Phase 5: Staging + Production (1 hafta)

- [ ] Deploy staging → test 48 hours
- [ ] Meta Events Manager validation
- [ ] Deploy production
- [ ] Monitor 48+ hours
- [ ] Update dashboard/docs

---

## EXPECTED OUTCOMES

**Şu anda:** EMQ ~60%, matching 60%, double-count riski var  
**Sonrasında:** EMQ ~85%, matching 85%, dedup verified

| Metrik | Şimdi | Sonra | Fark |
|--------|-------|-------|------|
| Customer Matching | 60% | 85% | +25% |
| EMQ Score | Low | Medium-High | +2-3 points |
| Product Catalog Completeness | 30% | 100% | +70% |
| FBP/FBC Capture Rate (mobile) | 80% | 95% | +15% |
| ROAS Accuracy | ~70% | ~95% | +25% |

---

**Son Notlar:**
- Tüm changes backward compatible
- Deployment'tan sonra 48 saat Meta'nın aggregation'ı için bekle
- Geri dönmek istersen, eski commit'e rollback yapabilirsin

