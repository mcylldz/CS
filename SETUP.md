# Svelte Chic — Custom Checkout Kurulum Rehberi

## 1. GitHub Repo Oluştur
1. GitHub'da yeni bir repo oluştur: `sveltechic-checkout`
2. Bu klasördeki tüm dosyaları repo'ya push et

## 2. Netlify Deploy
1. Netlify'da "New site from Git" → GitHub repo'nu seç
2. Build settings:
   - Build command: `npm install`
   - Publish directory: `.`
   - Functions directory: `netlify/functions`

## 3. Netlify Environment Variables
Site Settings → Environment Variables → Şu değişkenleri ekle:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
SHOPIFY_CLIENT_ID=...           ← Dev Dashboard → Apps → Settings
SHOPIFY_CLIENT_SECRET=...       ← Dev Dashboard → Apps → Settings
SHOPIFY_STORE_DOMAIN=thesveltechic.myshopify.com
META_PIXEL_ID=...
META_ACCESS_TOKEN=...
```

## 4. Custom Domain
1. Netlify → Domain Settings → Add custom domain → `checkout.thesveltechic.com`
2. DNS'inde CNAME kaydı ekle:
   - Host: `checkout`
   - Value: `[netlify-site-name].netlify.app`
3. Netlify SSL otomatik aktif olacak

## 5. Shopify App (Dev Dashboard — Yeni Sistem)
Eski "Custom App" sistemi Ocak 2026'da kapandı. Yeni yol:

1. https://dev.shopify.com adresine git
2. "Apps" → "Create App" ile yeni uygulama oluştur
3. Access Scopes ayarla:
   - `write_orders`, `read_orders`
   - `write_customers`, `read_customers`
   - `read_price_rules`, `read_discounts`
4. App'i mağazana Install et
5. Settings sayfasından **Client ID** ve **Client Secret** değerlerini kopyala
6. Bunları Netlify env variables'a `SHOPIFY_CLIENT_ID` ve `SHOPIFY_CLIENT_SECRET` olarak ekle

NOT: Artık sabit Access Token yok. Kod otomatik olarak Client Credentials Grant
ile geçici token alıyor (24 saat geçerli, otomatik yenileniyor).

## 6. Shopify Cart Redirect (Mağazaya Eklenmesi Gereken)
`shopify-snippet/sc-checkout-redirect.liquid` dosyasını Shopify temanıza ekleyin:

1. Shopify Admin → Online Store → Themes → Edit code
2. Snippets → Add new snippet → `sc-checkout-redirect`
3. Dosya içeriğini yapıştır
4. `sections/main-cart.liquid` dosyasını aç
5. Dosyanın sonuna (closing `</section>` etiketinden hemen önce) şunu ekle:
   ```
   {% render 'sc-checkout-redirect' %}
   ```

## 7. Meta Conversions API Token
1. Meta Events Manager → Settings → Conversions API
2. "Generate access token" ile token oluştur
3. Pixel ID'yi de aynı sayfadan al

## 8. Test
1. Test modunda Stripe test kartı kullan: `4242 4242 4242 4242`
2. Meta CAPI test etmek için `complete-order.js` içindeki `test_event_code` satırını aktif et
3. Netlify Functions loglarını kontrol et: Functions → Logs

## Dosya Yapısı
```
sveltechic-checkout/
├── index.html                          ← Checkout sayfası
├── success.html                        ← Sipariş onay sayfası
├── css/checkout.css                    ← Stiller
├── js/checkout.js                      ← Frontend logic + Stripe Elements
├── netlify.toml                        ← Netlify config
├── package.json                        ← Dependencies
├── netlify/functions/
│   ├── shopify-auth.js                 ← Shopify Client Credentials token yönetimi
│   ├── create-payment.js              ← Stripe Customer + PaymentIntent
│   ├── validate-coupon.js             ← Shopify kupon doğrulama
│   └── complete-order.js              ← Shopify order + Meta CAPI
├── shopify-snippet/
│   └── sc-checkout-redirect.liquid    ← Sepet sayfası redirect scripti
└── SETUP.md                           ← Bu dosya
```
