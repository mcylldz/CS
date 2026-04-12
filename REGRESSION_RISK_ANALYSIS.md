# Regression Risk Analizi — P0/P1/P2 Değişiklikleri
**Tarih:** 2026-04-13  
**Kapsamı:** STATE eklemesi, product metadata, FBP/FBC backup'ı diğer sistemlerle çakışması

---

## ÖZET: YÜKSEKRİSK UYARISI

**🔴 KRITIK SORUNU BULDUM:** STATE field'ı eklenirse, Shopify API'ye yanlış şekilde gönderilecek.

- Şu anda: `province: customer.city` (doğru, il gönderiliyor)
- İstenen change: STATE field ekle
- **PROBLEM:** Shopify address API'de STATE field'ı yok! `province` field'ı var.
- **Sonuç:** `customer.state` eklenirse, bunu Shopify'a gönderirken nereye yazacaksınız?

---

## I. STATE FIELD EKLENMESININ RİSKLERİ

### 1.1 Customer Object Shape Değişimi

**Şu anda:**
```javascript
getCustomerData() → {
  email, phone, firstName, lastName, address,
  mahalle, district, city, zip, country
}
```

**Sonrasında:**
```javascript
getCustomerData() → {
  email, phone, firstName, lastName, address,
  mahalle, district, city, state, zip, country  // ← state eklendi
}
```

### ✅ GÜVEN: Backward Compatibility

Tüm field'lar **optional** (truthy check yapılıyor).

```javascript
// track-event.js
...(customer.state ? { st: [sha256(customer.state)] } : {}),

// complete-order.js
...(customer.state ? { st: [sha256(customer.state)] } : {}),
```

**Result:** Eğer `customer.state` undefined olursa, field gönderilmez. ✅ Safe.

### ❌ SORUNU: Shopify Address API'de STATE Field Yok

**Dosya:** `netlify/functions/complete-order.js`, satır 185, 206, 277, 283

```javascript
// Shopify customer address
addresses: [{
  first_name: customer.firstName,
  last_name: customer.lastName,
  address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
  address2: customer.district || '',      // ← District (İlçe)
  city: customer.city,                    // ← City (İl)
  province: customer.city,                // ← Province = City (Shopify'da "province" = İl)
  zip: customer.zip,
  country: 'TR'
}]
```

**Shopify API Spec:**
- `province` — il/province (text field, ~50 char)
- `province_code` — il kodu (2 char, optional)
- Ek field: `state` ❌ **YOK**

**Sorun:** İstediğiniz STATE field'ını nereye yazacaksınız?

### Seçenek A: District'i STATE olarak yeniden adlandır (YAPMAYINIZ)

```javascript
// YANLIŞ — semantik olarak yanlış
province: customer.state,  // Bu zaten district!
```

### Seçenek B: STATE field'ını yok say (doğru)

**Meta'ya:** STATE gönder (EMQ matching için) ✓  
**Shopify'ya:** STATE gönderme (field yok, Shopify ignore eder) ✓

Bu **doğru yaklaşım** ama açık olmalı. Complete-order.js'te:

```javascript
// SHOPIFY ADDRESS — STATE EKLEMİN
const shippingAddress = {
  first_name: customer.firstName,
  last_name: customer.lastName,
  address1: (customer.mahalle ? customer.mahalle + ', ' : '') + customer.address,
  address2: customer.district || '',
  city: customer.city,
  province: customer.city,  // ← Still "il", not state
  zip: customer.zip,
  country: 'TR'
};
// NOT: customer.state (Meta EMQ için) Shopify'ya gönderilmez
```

### ✅ SONUÇ: STATE Güvenli

- Meta'ya STATE gönderilecek ✓
- Shopify'ya STATE gönderilmeyecek (field yok, zaten) ✓
- Existing Shopify logic (province = city) değişmeyecek ✓

---

## II. PRODUCT METADATA EKLENMESININ RİSKLERİ

### 2.1 Item Object Shape Değişimi

**Şu anda:**
```javascript
items = [{
  variant_id, product_id, sku, title, price, quantity,
  image, original_price, final_price, original_line_price, final_line_price,
  line_price, variant_title
}]
```

**Sonrasında (track-event.js contents):**
```javascript
contents: items.map(item => ({
  id: String(item.variant_id),
  quantity: item.quantity,
  item_price: item.price / 100,
  title: item.title,          // ← var zaten!
  image_url: item.image,      // ← var zaten!
  url: `https://...products/${item.product_id}`  // ← derive ediliyor
}))
```

### ✅ GÜVEN: Tüm Fields Mevcut

- `item.title` → **VAR** (Shopify cart'tan geliyor) ✓
- `item.image` → **VAR** (Shopify cart'tan geliyor) ✓
- `item.product_id` → **VAR** (Shopify cart'tan geliyor) ✓

**Dosya:** `shopify-snippet/sc-checkout-redirect.liquid`, satır 49-63

```javascript
var cartItems = cart.items.map(function(item) {
  return {
    title: item.title,              // ✓
    variant_title: item.variant_title,
    variant_id: item.variant_id,
    product_id: item.product_id,    // ✓
    sku: item.sku,
    quantity: item.quantity,
    price: item.final_price,
    line_price: item.final_line_price,
    original_price: item.original_price,
    original_line_price: item.original_line_price,
    image: item.image ? item.image.replace(/(\.[^.]+)$/, '_180x$1') : ''  // ✓
  };
});
```

### ⚠️ RİSK: Image URL Format Değişebilir

**Mevcut:** `item.image` → `'https://cdn.shopify.com/s/files/.../image_180x.jpg'`

**Meta expects:** `https://` ile başlayan valid image URL

**Kontrol:**
```javascript
// Safe?
image_url: item.image || ''  // Eğer image null/undefined, empty string
```

**Sorun:** Empty string → Meta bu field'ı ignore ediyor, problem yok.

**Başka sorun:** Image URL'nin format değişmesi?

Shopify Liquid'te:
```liquid
image.src  → "https://cdn.shopify.com/s/files/1/0123/4567/8901/products/image.jpg"
```

Meta CAPI expects:
```
https://... (valid URL)
```

✅ **Uyumlu.** Shopify CDN image'ler Meta tarafından yüklenebilir.

### ✅ SONUÇ: Product Metadata Güvenli

- Tüm fields mevcut
- Format uyumlu
- Backward compatible (empty string fallback)

---

## III. FBP/FBC SESSIONSSTORAGE BACKUP'NIN RİSKLERİ

### 3.1 SessionStorage Namespacing

**Mevcut (sc-checkout-redirect.liquid, satır 25-27):**
```javascript
sessionStorage.setItem('sc_' + key, val);  // sc_utm_source, sc_fbp, sc_fbc...
sessionStorage.setItem('sc_gclid', val);
sessionStorage.setItem('sc_gbraid', val);
sessionStorage.setItem('sc_wbraid', val);
```

**Planned (sessionStorage addition):**
```javascript
// FBP/FBC için ayrıca sakla
if (key === 'fbp' || key === 'fbc') {
  sessionStorage.setItem('_fbp', fbp);  // ← Cookie adıyla aynı
  sessionStorage.setItem('_fbc', fbc);
}
```

### ❌ RİSK 1: SessionStorage vs Cookie İsim Çatışması

```javascript
// Cookie
document.cookie = '_fbp=' + fbp;

// SessionStorage (planned)
sessionStorage.setItem('_fbp', fbp);  // ← Aynı key!
```

**Sorun:** Cookie ve sessionStorage **ayrı namespace'ler**, çatışma yok.

```javascript
getCookie('_fbp')           // → Cookie'den oku
sessionStorage.getItem('_fbp')  // → SessionStorage'den oku
```

✅ **Güvenli.** Ayrı storage mekanizmaları.

### ✅ GÜVEN: Fallback Logic

**Checkout.js'te (satır 29-40):**
```javascript
const fbp = getCookie('_fbp') || params.get('fbp') || (function() { 
  try { return sessionStorage.getItem('sc_fbp') || ''; } catch(e) { return ''; } 
}());
```

**Cascade:**
1. Cookie'den oku
2. URL param'dan oku
3. SessionStorage'dan oku (backup)

✅ **Güvenli.** Multiple fallback'ler.

### ⚠️ RİSK 2: SessionStorage Quote Limit

SessionStorage limit: **~5-10MB** (browser'a göre değişir).

**İhtiyaç:**
- `fbp` → ~50 byte
- `fbc` → ~100 byte
- UTM params → ~200 byte
- **Total:** ~400 byte

🟢 **Güvenli.** Çok az yer kullanıyor.

### ✅ SONUÇ: FBP/FBC Backup Güvenli

- Cookie-sessionStorage ayrı namespace
- Fallback logic robust
- Storage limit yeterli
- No naming conflicts

---

## IV. META PAYLOAD MUTATION RİSKLERİ

### 4.1 Track-Event.js — userData Generation

**Şu anda:**
```javascript
const userData = {
  client_ip_address: clientIp,
  client_user_agent: clientUserAgent,
  fbp: fbp,
  fbc: fbc,
  em: [sha256(email)],
  ph: [sha256(phone)],
  fn: [sha256(firstName)],
  ln: [sha256(lastName)],
  ct: [sha256(city)],
  zp: [sha256(zip)],
  st: [sha256(district)],  // ← DISTRICT YOK OLACAK
  country: [sha256('tr')]
};
```

**Sonrasında:**
```javascript
const userData = {
  client_ip_address: clientIp,
  client_user_agent: clientUserAgent,
  fbp: fbp,
  fbc: fbc,
  em: [sha256(email)],
  ph: [sha256(phone)],
  fn: [sha256(firstName)],
  ln: [sha256(lastName)],
  ct: [sha256(city)],
  zp: [sha256(zip)],
  st: [sha256(state)],     // ← STATE (İl) olacak
  country: [sha256('tr')]
};
```

### ⚠️ RİSK: Existing events'teki `st` field'ı farklı olacak

**Old Events (Shopify panel'de):**
```
st: SHA256("Beyoğlu")  // District
```

**New Events (sonrasında):**
```
st: SHA256("İstanbul")  // State/Province
```

**Meta Panel'de:** Existing reports kırılmaz, çünkü `st` yeni events'te farklı value alacak. Matching score'u yeni events için düzeltilecek, eski events'te değişim yok.

**Sorun:** Yeni events ile eski events'in matching consistency'si azalacak, ama bu kaçınılmaz bir trade-off.

### ✅ SONUÇ: Acceptable Risk

- Yeni events daha iyi matching alacak (İstanbul vs Beyoğlu)
- Eski events etkilenmeyecek (historical data intact)
- Meta panel'de trend lineliği kesintiye uğrayabilir ama doğruya yaklaşır

---

## V. SHOPIFY ORDER RECONCILIATION RİSKLERİ

### 5.1 Note Attributes & Metafields

**Mevcut:**
```javascript
noteAttributes = [
  { name: 'utm_source', value: utm_source },
  { name: 'utm_medium', value: utm_medium },
  { name: 'utm_campaign', value: utm_campaign },
  { name: 'utm_term', value: utm_term },
  { name: 'utm_content', value: utm_content },
  { name: 'payment_gateway', value: 'stripe' },
  { name: 'stripe_payment_intent', value: paymentIntentId },
  { name: 'stripe_customer_id', value: stripeCustomerId },
  { name: 'marketing_consent', value: 'true' },
  { name: 'mesafeli_satis_sozlesmesi', value: 'onaylandi' }
]
```

**Planned:** STATE eklemesi → noteAttributes'a eklenir mi?

**Soru:** Shopify order'unda STATE bilgisini saklamak gerekli mi?

**Cevap:** Hayır. Address'te zaten `province: customer.city` var. STATE redundant.

### ✅ GÜVEN: STATE Shopify'ya Eklenmeyecek

- Meta'ya STATE gönderilecek (doğru)
- Shopify'ya STATE gönderilmeyecek (boşa yer tüketmekten kaçın)
- Existing noteAttributes logic değişmeyecek

---

## VI. STRIPE PAYMENT INTENT METADATA RİSKLERİ

### 6.1 PI Metadata Limiti

Stripe PI metafield'larının limit'i: **500 bytes per metadata field**.

**Mevcut metadata (complete-order.js, satır 400-405):**
```javascript
metadata: {
  ...paymentIntent.metadata,
  shopify_order_id: shopifyOrder.id.toString(),
  shopify_order_name: shopifyOrder.name
}
```

**Planned:** STATE eklemesi → PI metadata'ya eklenir mi?

**Soru:** STATE'i PI metadata'ya saklamak gerekli mi?

**Cevap:** Hayır. PI metadata customer data için optimize edilmemiş. Gereksiz.

### ✅ GÜVEN: STATE PI Metadata'ya Eklenmeyecek

- PI metadata'ya STATE eklenmeyecek
- Existing size limit'leri respekt edilecek

---

## VII. NETWORK REQUEST SIZE RİSKLERİ

### 7.1 Track-Event POST Body Size

**Şu anda:**
```json
{
  "eventName": "Purchase",
  "customer": {...},
  "items": [...],
  "fbp": "...",
  "fbc": "...",
  "eventId": "..."
  // ~ 2-5 KB typical
}
```

**Sonrasında (product metadata eklenirse):**
```json
{
  "eventName": "Purchase",
  "customer": {..., "state": "İstanbul"},  // +50 byte
  "items": [
    {
      "id": "variant_123",
      "title": "Twisted Lace Dress",
      "image_url": "https://cdn.shopify.com/...",  // +100 byte per item
      "url": "https://www.thesveltechic.com/products/123"  // +50 byte per item
    }
  ],
  // ~ 3-8 KB typical (50% increase possible)
}
```

### ⚠️ RİSK: Netlify Function POST Limit

Netlify function POST limit: **10 MB** (default).

**Worst case:** 10 item × 200 byte = 2 KB total extra → **total 10 KB**

🟢 **Güvenli.** 10 MB >> 10 KB.

### ✅ SONUÇ: Network Size Güvenli

---

## VIII. COMPLETE-ORDER FUNCTION COMPLEXITY RİSKLERİ

### 8.1 Function Timeout (10 saniye)

**Mevcut işlemler:**
1. PI retrieve (~200ms)
2. Customer search (~300ms)
3. Customer create/update (~300ms)
4. Coupon validation (~600ms)
5. Order create (~500ms)
6. Order update (~300ms)
7. PI update (~200ms)
8. Meta CAPI (~300ms)

**Total:** ~2.7 saniye

**Planned additions:**
- STATE field: **+0ms** (just a field, no extra API call)
- Product metadata: **+0ms** (already in items array)

### ✅ GÜVEN: Timeout Risk Yok

- Extra API call yok
- Processing time sabit
- 10s limit yeterli

---

## IX. BAŞKA TRACKING SISTEMLERIYLE ÇAKIŞMA

### 9.1 GA4

**Mevcut:**
```javascript
gtag('event', 'purchase', {
  transaction_id: ...,
  value: ...,
  items: buildGA4Items()
});
```

**buildGA4Items():**
```javascript
return cartItems.map(function(item) {
  return {
    item_id: item.sku || String(item.variant_id),
    item_name: item.title,  // ← title var zaten
    price: item.price / 100,
    quantity: item.quantity
  };
});
```

✅ **Güvenli.** Product metadata eklemesi GA4'ü etkilemez.

### 9.2 Yandex Metrica

**Mevcut:**
```javascript
dataLayer.push({
  ecommerce: {
    purchase: {
      products: ymProducts()
    }
  }
});
```

**ymProducts():**
```javascript
return cartItems.map(function(item) {
  return {
    id: item.sku || String(item.variant_id),
    name: item.title,  // ← title var zaten
    price: item.price / 100,
    quantity: item.quantity
  };
});
```

✅ **Güvenli.** Product metadata eklemesi Yandex'i etkilemez.

### 9.3 Shopify Order Note

**Mevcut:**
```javascript
note: `Custom checkout | Stripe PI: ${paymentIntentId}${customer.phone ? '\nTelefon (orijinal): ' + customer.phone : ''}\n\n--- MESAFELİ SATIŞ SÖZLEŞMESİ ---\nSözleşme elektronik ortamda onaylanmıştır.`
```

✅ **Güvenli.** STATE note'a eklenmeyecek, log'u clean kalır.

---

## X. ÖZETİ RİSK MATRISI

| Değişiklik | Etkilenen Sistem | Risk | Mitigation | Status |
|-----------|-----------------|------|-----------|--------|
| **STATE eklemesi** | Meta CAPI | Düşük | STATE Shopify'ya gönderilmez | ✅ Safe |
| **Product metadata** | Track-event.js | Düşük | Fields zaten mevcut, optional | ✅ Safe |
| **FBP/FBC backup** | SessionStorage | Düşük | Separate namespace, cascade fallback | ✅ Safe |
| **Request size** | Network | Düşük | +3 KB, limit 10 MB | ✅ Safe |
| **Function timeout** | complete-order.js | Düşük | No new API calls, +0ms | ✅ Safe |
| **GA4 compatibility** | Google Analytics | Düşük | Independent tracking | ✅ Safe |
| **Yandex compatibility** | Yandex Metrica | Düşük | Independent tracking | ✅ Safe |
| **Shopify order data** | Order reconciliation | Düşük | Note/metadata unchanged | ✅ Safe |
| **Existing `st` field** | Meta matching | **ORTA** | Old events unaffected, new events better | ⚠️ Trade-off |

---

## XI. DEĞİŞTİRİLMESİ GEREKEN ŞEYLER (Regression Prevent için)

### YAPMAYINIZ

❌ **STATE'i Shopify address'e eklemeyin**
```javascript
// YANLIŞ
province: customer.state,  // Bu zaten city!
```

❌ **FBP/FBC için yeni cookie key oluşturmayın**
```javascript
// YANLIŞ
sessionStorage.setItem('fbp', fbp);  // 'sc_fbp' olmalı veya '_fbp' cookie'den oku
```

❌ **Product metadata'yı incomplete göndermeyin**
```javascript
// YANLIŞ
contents: items.map(item => ({
  id: item.variant_id,
  title: item.title
  // url ve image_url eksik
}))
```

### YAPMANIZ GEREKEN ŞEY

✅ **STATE'i nur Meta CAPI'ye gönder**
```javascript
// DOĞRU
// track-event.js
st: [sha256(customer.state)],

// complete-order.js (Shopify address'te state field eklemeyin)
shipping_address: {
  city: customer.city,
  province: customer.city,  // ← Keep unchanged
}
```

✅ **FBP/FBC fallback logic kurallı**
```javascript
// DOĞRU
fbp = getCookie('_fbp') || params.get('fbp') || sessionStorage.getItem('sc_fbp');
```

✅ **Product metadata complete**
```javascript
// DOĞRU
contents: items.map(item => ({
  id: String(item.variant_id),
  quantity: item.quantity,
  item_price: item.price / 100,
  title: item.title || '',
  image_url: item.image || '',
  url: `https://www.thesveltechic.com/products/${item.product_id}`
}))
```

---

## XII. TESTING CHECKLIST

### Pre-Deploy

- [ ] getCustomerData() shape değişimi checkout.js'te test et
  - Eğer STATE undefined → Meta field skip edilmeli
  - Eğer STATE "İstanbul" → `st: [sha256("İstanbul")]` olmalı
  
- [ ] Complete-order fonksiyonu STATE olmadan çalışmalı
  - Eski cart data → STATE field yok → null graceful handle
  
- [ ] SessionStorage backup test et
  - FBP/FBC cookie'siz → sessionStorage'dan fallback yapılmalı
  
- [ ] Product metadata nil handling test et
  - Eğer item.image null → empty string gönderilmeli, error yok

### Post-Deploy (48 hours)

- [ ] Meta Events Manager
  - InitiateCheckout events → `st` field'ı var mı?
  - Purchase events → `contents.title`, `contents.image_url` var mı?
  
- [ ] Shopify Orders
  - Address'te province = city olmalı (unchanged)
  - Note'ta STATE bilgisi olmamalı
  
- [ ] Network logs
  - /api/track-event POST size normal mı?
  - /api/complete-order response time normal mı?

---

## XIII. SONUÇ

**Güvenlik Seviyesi:** 🟢 **DÜŞÜK RİSK** (with care)

### Önemli Noktalar

1. **STATE field eklemesi → GÜVENLI**, Shopify API'de state field yok diye sorun yok
2. **Product metadata eklemesi → GÜVENLI**, fields zaten mevcut
3. **FBP/FBC backup → GÜVENLI**, separate namespace, no conflicts
4. **Backward compatibility → GÜVENLI**, optional field handling mevcut
5. **Timeout/network risk → GÜVENLI**, no new API calls

### Kaçınması Gereken Hatalar

1. ❌ STATE'i Shopify address'e eklemeyin
2. ❌ SessionStorage key'lerinde çatışma oluşturmayın
3. ❌ Product metadata'yı incomplete göndermeyin

### Deploy Strateji

1. **Staging:** 48 saat test
2. **Production:** Monitoring 48+ saat
3. **Rollback plan:** Hazır (eski commit'e dön)

---

**Bottom Line:** Planlanan değişiklikleri güvenle deploy edebilirsiniz. Yeterince ihtiyatlı olduğunuz sürece regression yok.

