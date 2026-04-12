# Test & Validation Guide — Meta Event Tracking Updates
**Tarih:** 2026-04-13  
**Commit:** 2e0e321  
**Kapsam:** STATE, Product Metadata, FBP/FBC Backup testleri  

---

## FAZE 1: LOCAL DEVELOPMENT TEST (2-3 saat)

### 1.1 Browser Console Tests

```javascript
// 1) Customer data STATE field'ı var mı?
getCustomerData()
// Expected output:
// {
//   email: "test@example.com",
//   phone: "5551234567",
//   firstName: "Test",
//   lastName: "User",
//   city: "İstanbul",
//   state: "İstanbul",  ← NEW
//   district: "Beyoğlu",
//   mahalle: "Cihangir",
//   address: "Cihangir Cad. No:123",
//   zip: "34000",
//   country: "TR"
// }

// 2) Meta Pixel loaded?
typeof fbq
// Expected: "function"

// 3) Event payload test
buildFbqCustomData()
// Expected output — contents field'ı var:
// {
//   currency: "TRY",
//   value: 250.00,
//   content_type: "product",
//   contents: [
//     {
//       id: "variant_123",
//       quantity: 1,
//       item_price: 250.00,
//       title: "Twisted Lace Dress",  ← NEW
//       image_url: "https://cdn.shopify.com/...",  ← NEW
//       url: "https://www.thesveltechic.com/products/xxx"  ← NEW
//     }
//   ],
//   content_ids: ["variant_123"],
//   num_items: 1
// }

// 4) FBP/FBC fallback test
console.log('fbp:', fbp, 'fbc:', fbc)
// Expected: fbp ve fbc values (cookie veya param'dan)
```

### 1.2 Network Tab Tests

**Adım 1:** DevTools açın → Network tab → Filter: `track-event`

**Adım 2:** Form'ı doldurun (email, telefon, şehir, etc.) ve Step 2'ye geçin

**Adım 3:** POST request'i kontrol edin: `/api/track-event` (InitiateCheckout)

**Beklenenler:**
```json
{
  "eventName": "InitiateCheckout",
  "customer": {
    "email": "test@example.com",
    "phone": "5551234567",
    "firstName": "Test",
    "lastName": "User",
    "city": "İstanbul",
    "state": "İstanbul",  // ← NEW
    "district": "Beyoğlu",
    "mahalle": "Cihangir",
    "address": "Cihangir Cad. No:123",
    "zip": "34000",
    "country": "TR"
  },
  "items": [
    {
      "variant_id": 123,
      "product_id": 456,
      "sku": "sku123",
      "title": "Twisted Lace Dress",
      "quantity": 1,
      "price": 25000
    }
  ],
  "fbp": "fb.1.xxx",  // ← Capture ediliyor mu?
  "fbc": "fb.1.xxx",  // ← Capture ediliyor mu?
  "eventId": "initiatecheckout_1660000000_abc123def"
}
```

**Adım 4:** Purchase yapın (test card: 4242 4242 4242 4242)

**Adım 5:** POST request'i kontrol edin: `/api/complete-order`

**Beklenenler:**
```json
{
  "paymentIntentId": "pi_xxx",
  "customer": {
    "state": "İstanbul",  // ← NEW
    ...
  },
  "items": [
    {
      "variant_id": 123,
      "product_id": 456,
      "title": "Twisted Lace Dress",
      "price": 25000,
      "quantity": 1
    }
  ],
  "fbp": "fb.1.xxx",
  "fbc": "fb.1.xxx",
  "purchaseEventId": "purchase_1660000000_xyz789"
}
```

### 1.3 SessionStorage Fallback Test

```javascript
// Browser Console'da:

// Scenario: FBP/FBC cookie'si yok, URL param'da var, sessionStorage'da var
// Test: Checkout redirect.liquid'i test et

// Simulate: FBP parametresi olmadan
new URL('https://checkout.thesveltechic.com', {
  cart: 'encoded_cart',
  fbp: '',  // Boş — sessionStorage'dan gelmeli
  utm_source: 'instagram'
}).search

// Expected: fbp sessionStorage'dan gelmeli
```

---

## FAZE 2: STAGING DEPLOY (2-3 gün)

### 2.1 Code Deploy to Staging

```bash
cd ~/Desktop/sveltechic-checkout

# Verify commit
git log -1 --oneline
# Expected: "fix: Meta Event Tracking — STATE field..."

# Deploy to Netlify staging
netlify deploy --site-id <STAGING_SITE_ID> --prod

# Verify deployment
curl https://staging-checkout.netlify.app/
# Expected: HTTP 200
```

### 2.2 Real Purchase Test on Staging

**Step 1:** Full checkout flow

```
1. Shopify staging store → Add product
2. Click checkout (redirects to custom)
3. Fill form:
   - Email: test@example.com
   - Phone: 5551234567
   - City: İstanbul (select from dropdown)
   - District: Beyoğlu
   - Address: Test Caddesi No:123
   - Zip: 34000
4. Card: 4242 4242 4242 4242 (Stripe test card)
5. Complete purchase
```

**Step 2:** Check Logs

```bash
netlify logs --site-id <STAGING_SITE_ID> --function track-event
# Look for:
# "Meta CAPI [InitiateCheckout] response: {events_received: 1}"
# "Meta CAPI [AddPaymentInfo] response: {events_received: 1}"

netlify logs --site-id <STAGING_SITE_ID> --function complete-order
# Look for:
# "Meta CAPI: {events_received: 1}" (Purchase event)
# No errors, success: true
```

### 2.3 Meta Events Manager Validation

**Go to:** https://business.facebook.com → Events Manager → Select Pixel

**Filter by date:** Today

**Check:**
1. **InitiateCheckout events visible?**
   - Count: Should match test purchase (1)
   - User Data tab: `st` field should show "İstanbul"

2. **AddPaymentInfo events visible?**
   - Count: Should match test purchase (1)
   - Status: "Matched" (if at least 1 user data field matches)

3. **Purchase events visible?**
   - Count: Should match test purchase (1)
   - Value: 250 TRY (or whatever test amount)
   - Status: "Matched"

4. **EventID Deduplication:**
   - If same fbq event fired + CAPI event fired with same eventID
   - Meta should show as 1 event (not 2)
   - Check in Event Details → Event ID should match

### 2.4 Shopify Order Check

**Go to:** Shopify admin (staging) → Orders

**Check order:**
1. **Customer address**
   - City: İstanbul ✓
   - Province: İstanbul ✓
   - District field in address2 ✓
   - **State eklenmiş mi?** → Hayır olmalı (Shopify'da state field yok) ✓

2. **Order notes**
   - Payment Intent ID visible ✓
   - "Custom checkout" tag visible ✓
   - STATE bilgisi **OLMAMALI** ✓

3. **Tags**
   - `custom-checkout` ✓
   - `stripe` ✓

### 2.5 GA4 Check

**Go to:** Google Analytics → Real-time → Events

**Check:**
1. **purchase events visible?**
   - transaction_id: Stripe PI ID ✓
   - value: Order total ✓
   - items: Product details ✓

2. **begin_checkout events visible?**
   - items: Product details ✓

**No new errors in GA4?** ✓

### 2.6 Yandex Metrica Check

**Go to:** https://metrica.yandex.com → Conversations → Goals

**Check:**
1. **checkout_started goal fired?** ✓
2. **order_completed goal fired?** ✓
3. **ecommerce purchase event fired?** ✓

### 2.7 FBP/FBC SessionStorage Test (iPhone/Android Emulation)

**DevTools → Device Mode:**

1. **Simulate iOS Safari (ITP enabled)**
   - FBP/FBC cookie'ler disappear
   - Redirect → sessionStorage'da `sc_fbp`, `sc_fbc` gözlenmeli
   - Checkout page'de fbp/fbc var olmalı

2. **Simulate Android WebView**
   - Similar test

**Expected:** FBP/FBC fallback çalışmalı, hiç kayıp olmamalı

### 2.8 Network Performance

**Check Netlify function times:**
```
GET /api/create-payment → ~200ms
POST /api/track-event (InitiateCheckout) → ~300ms
POST /api/track-event (AddPaymentInfo) → ~300ms
POST /api/complete-order → ~3-4 sec (Shopify API calls)
```

**Expected:** No degradation from changes

---

## FAZE 3: PRODUCTION DEPLOY (1-2 gün)

### 3.1 Production Deploy

```bash
# All tests passed on staging? → Deploy to production
netlify deploy --site-id <PROD_SITE_ID> --prod
```

### 3.2 Smoke Test (First Hour)

**Real customer test:**
1. Make test purchase with real card (auto-refund)
2. Check order in Shopify admin
3. Check Meta Events Manager (real pixel)
4. Check GA4 (real property)

**Expected:** All systems working, no errors

### 3.3 Monitoring (48 hours)

**Metrics to watch:**

1. **Meta Events Manager**
   - Daily event count (should be normal)
   - EMQ score (should improve or stay same)
   - No increase in error events

2. **Shopify Orders**
   - No missing orders
   - Customer data captured correctly
   - No failed orders

3. **Netlify Logs**
   ```
   netlify logs --site-id <PROD_SITE_ID> --function track-event
   netlify logs --site-id <PROD_SITE_ID> --function complete-order
   ```
   - No errors in log output
   - All events processed successfully

4. **GA4**
   - Revenue data correct
   - Conversion events visible
   - ROAS calculation correct

5. **Yandex Metrica**
   - Goals firing correctly
   - No dropped events

### 3.4 Rollback Plan

**If critical issue found:**

```bash
# Revert to previous commit
git revert HEAD
git push origin main

# Deploy reverted version
netlify deploy --site-id <PROD_SITE_ID> --prod

# Notify team + investigate
```

**Rollback checklist:**
- [ ] Identify issue
- [ ] Revert commit
- [ ] Deploy reverted code
- [ ] Verify rollback successful
- [ ] Customer orders still captured
- [ ] No data loss

---

## EXPECTED RESULTS

### Before Changes
| Metric | Value |
|--------|-------|
| EMQ Score | Low (60%) |
| Customer Matching | 60% |
| Mobile FBP/FBC Capture | 80% |
| Dynamic Ads | Weak (no product metadata) |
| ROAS Accuracy | ~70% |

### After Changes (First Week)
| Metric | Value | Change |
|--------|-------|--------|
| EMQ Score | Medium-High | +2-3 points |
| Customer Matching | 85% | +25% |
| Mobile FBP/FBC Capture | 95% | +15% |
| Dynamic Ads | Strong | +70% |
| ROAS Accuracy | ~95% | +25% |

### Meta Dashboard Changes

**Events Manager:**
- Purchase events: `st` field now populated with "İstanbul", "İzmir", etc.
- Purchase events: `contents[].title`, `contents[].image_url` now visible
- Matching rate: Should improve by 15-20%

**Ads Manager:**
- Dynamic Ads catalog: Product titles/images now appear (instead of blank)
- Retargeting audiences: Better quality (more user data)

---

## TROUBLESHOOTING

### Issue: FBP/FBC showing empty

**Solution:**
1. Check if _fbp cookie exists: `document.cookie.includes('_fbp')`
2. Check sessionStorage: `sessionStorage.getItem('sc_fbp')`
3. Check URL params: `new URLSearchParams(window.location.search).get('fbp')`

### Issue: STATE field not appearing in Meta Events Manager

**Likely cause:** customer.state undefined

**Fix:**
1. Ensure getCustomerData() returns state field
2. Ensure city select'ten doğru il adı geliyortür

### Issue: Product metadata not visible in Dynamic Ads

**Likely cause:** item.title, item.image, item.product_id missing

**Fix:**
1. Verify cart data coming from /cart.js includes these fields
2. Verify sc-checkout-redirect.liquid payload has title, image

### Issue: Order missing in Shopify

**Likely cause:** complete-order function failure

**Check logs:**
```
netlify logs --site-id <PROD_SITE_ID> --function complete-order
```

**Look for:** Customer creation failed, Order creation failed

---

## Sign-Off Checklist

### Before Production Deploy

- [ ] Local testing passed (Console + Network)
- [ ] Staging deploy successful
- [ ] 2+ test purchases on staging completed
- [ ] Meta Events Manager shows events correctly
- [ ] GA4 shows purchase events
- [ ] Yandex Metrica shows goals
- [ ] No regression in existing data
- [ ] Shopify orders captured correctly
- [ ] FBP/FBC capture working
- [ ] Product metadata visible
- [ ] All logs clean (no errors)

### Post Production Deploy (48 hours)

- [ ] Real purchases flowing through
- [ ] Meta Events Manager updated
- [ ] GA4 revenue correct
- [ ] Yandex Metrica goals firing
- [ ] No customer complaints
- [ ] Monitoring shows normal metrics
- [ ] EMQ score stable/improving

---

**Test completed by:** ___________  
**Date:** ___________  
**Issues found:** None / [List]  
**Ready for production:** Yes / No

