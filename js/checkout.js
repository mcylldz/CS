/* ========================================
   SVELTE CHIC — Checkout JS
   ======================================== */

(function () {
  'use strict';

  // ---- State ----
  let cartItems = [];
  let subtotal = 0;       // in kuruş (Shopify cents)
  let discountAmount = 0;  // in kuruş
  let appliedCoupon = null;
  let stripeInstance = null;
  let cardElement = null;
  let isProcessing = false;

  // ---- URL Params ----
  const params = new URLSearchParams(window.location.search);
  const fbp = params.get('fbp') || '';
  const fbc = params.get('fbc') || '';
  const utmSource = params.get('utm_source') || '';
  const utmMedium = params.get('utm_medium') || '';
  const utmCampaign = params.get('utm_campaign') || '';
  const utmTerm = params.get('utm_term') || '';
  const utmContent = params.get('utm_content') || '';

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    parseCart();
    renderItems();
    updateTotals();
    initStripe();
    bindEvents();
  }

  // ---- Parse Cart from URL ----
  function parseCart() {
    const cartParam = params.get('cart');
    if (!cartParam) {
      showGlobalError('Sepet bilgisi bulunamadı. Lütfen mağazaya geri dönün.');
      return;
    }
    try {
      const decoded = decodeURIComponent(cartParam);
      const json = decodeURIComponent(escape(atob(decoded)));
      const data = JSON.parse(json);
      if (Array.isArray(data) && data.length > 0) {
        cartItems = data;
        subtotal = cartItems.reduce((sum, item) => sum + item.line_price, 0);
      } else {
        showGlobalError('Sepetiniz boş görünüyor.');
      }
    } catch (e) {
      showGlobalError('Sepet verisi okunamadı. Lütfen tekrar deneyin.');
      console.error('Cart parse error:', e);
    }
  }

  // ---- Render Cart Items ----
  function renderItems() {
    const container = document.getElementById('summaryItems');
    if (!container || cartItems.length === 0) return;

    container.innerHTML = cartItems.map(item => {
      const priceFormatted = formatMoney(item.line_price);
      const variantParts = [];
      if (item.variant_title && item.variant_title !== 'Default Title') {
        variantParts.push(item.variant_title);
      }
      const variantStr = variantParts.join(' / ');

      return `
        <div class="sc-item">
          <div class="sc-item-img-wrap">
            <img src="${item.image}" alt="${escapeHtml(item.title)}" loading="lazy">
            ${item.quantity > 1 ? `<span class="sc-item-badge">${item.quantity}</span>` : ''}
          </div>
          <div class="sc-item-info">
            <div class="sc-item-name">${escapeHtml(item.title)}</div>
            ${variantStr ? `<div class="sc-item-variant">${escapeHtml(variantStr)}</div>` : ''}
          </div>
          <div class="sc-item-price">${priceFormatted}</div>
        </div>
      `;
    }).join('');
  }

  // ---- Update Totals ----
  function updateTotals() {
    const total = subtotal - discountAmount;
    document.getElementById('subtotalPrice').textContent = formatMoney(subtotal);
    document.getElementById('totalPrice').textContent = formatMoney(total);
    document.getElementById('togglePrice').textContent = formatMoney(total);

    const discountLine = document.getElementById('discountLine');
    if (discountAmount > 0 && appliedCoupon) {
      discountLine.style.display = 'flex';
      document.getElementById('discountLabel').textContent = `İndirim (${appliedCoupon})`;
      document.getElementById('discountAmount').textContent = '-' + formatMoney(discountAmount);
    } else {
      discountLine.style.display = 'none';
    }
  }

  // ---- Stripe Init ----
  function initStripe() {
    // Stripe publishable key is loaded from a meta tag or hardcoded
    // For security, we fetch it from the server
    fetch('/api/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_key' })
    })
    .then(r => r.json())
    .then(data => {
      if (data.publishableKey) {
        stripeInstance = Stripe(data.publishableKey);
        const elements = stripeInstance.elements({
          locale: 'tr'
        });
        cardElement = elements.create('card', {
          style: {
            base: {
              fontFamily: "'Inter', sans-serif",
              fontSize: '15px',
              color: '#333',
              '::placeholder': { color: '#999' }
            },
            invalid: { color: '#c00' }
          },
          hidePostalCode: true
        });
        cardElement.mount('#card-element');

        cardElement.on('change', function (event) {
          const errEl = document.getElementById('card-errors');
          if (event.error) {
            errEl.textContent = event.error.message;
            errEl.style.display = 'block';
          } else {
            errEl.textContent = '';
            errEl.style.display = 'none';
          }
          updateSubmitState();
        });

        // Enable submit button
        document.getElementById('submitBtn').disabled = false;
      }
    })
    .catch(err => {
      console.error('Stripe init error:', err);
      showGlobalError('Ödeme sistemi yüklenemedi. Lütfen sayfayı yenileyin.');
    });
  }

  // ---- Bind Events ----
  function bindEvents() {
    // Summary toggle (mobile)
    const toggleBtn = document.getElementById('summaryToggle');
    const summaryContent = document.getElementById('summaryContent');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        toggleBtn.classList.toggle('sc-open');
        summaryContent.classList.toggle('sc-open');
      });
    }

    // Coupon
    document.getElementById('couponBtn').addEventListener('click', applyCoupon);
    document.getElementById('couponCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); }
    });

    // Submit
    document.getElementById('submitBtn').addEventListener('click', handleSubmit);

    // Form validation on change
    const inputs = document.querySelectorAll('.sc-input[required]');
    inputs.forEach(input => {
      input.addEventListener('blur', function () {
        validateField(this);
      });
    });

    // Legal agreement links
    document.getElementById('openAgreement').addEventListener('click', function(e) {
      e.preventDefault();
      document.getElementById('agreementBody').innerHTML = generateAgreementHtml();
      document.getElementById('agreementOverlay').classList.add('sc-open');
    });
    document.getElementById('openMarketing').addEventListener('click', function(e) {
      e.preventDefault();
      document.getElementById('marketingBody').innerHTML = generateMarketingHtml();
      document.getElementById('marketingOverlay').classList.add('sc-open');
    });

    // Close modals on overlay click
    ['agreementOverlay', 'marketingOverlay'].forEach(function(id) {
      document.getElementById(id).addEventListener('click', function(e) {
        if (e.target === this) this.classList.remove('sc-open');
      });
    });
  }

  // ---- Coupon Validation ----
  async function applyCoupon() {
    const codeInput = document.getElementById('couponCode');
    const msgEl = document.getElementById('couponMsg');
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;

    msgEl.textContent = 'Kontrol ediliyor...';
    msgEl.className = 'sc-coupon-msg';

    try {
      const resp = await fetch('/api/validate-coupon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code,
          subtotal: subtotal,
          items: cartItems.map(i => ({
            product_id: i.product_id,
            variant_id: i.variant_id,
            quantity: i.quantity,
            line_price: i.line_price
          }))
        })
      });
      const data = await resp.json();
      if (data.valid) {
        appliedCoupon = code;
        discountAmount = data.discount_amount; // in kuruş
        msgEl.textContent = `✓ "${code}" uygulandı`;
        msgEl.className = 'sc-coupon-msg sc-success';
        codeInput.disabled = true;
        document.getElementById('couponBtn').textContent = '✓';
        document.getElementById('couponBtn').disabled = true;
        updateTotals();
      } else {
        msgEl.textContent = data.message || 'Geçersiz kupon kodu.';
        msgEl.className = 'sc-coupon-msg sc-error-msg';
      }
    } catch (e) {
      msgEl.textContent = 'Kupon doğrulanamadı. Tekrar deneyin.';
      msgEl.className = 'sc-coupon-msg sc-error-msg';
    }
  }

  // ---- Form Validation ----
  function validateField(el) {
    if (el.required && !el.value.trim()) {
      el.classList.add('sc-error');
      return false;
    }
    if (el.id === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim())) {
      el.classList.add('sc-error');
      return false;
    }
    el.classList.remove('sc-error');
    return true;
  }

  function validateAllFields() {
    const required = document.querySelectorAll('.sc-input[required]');
    let allValid = true;
    required.forEach(el => {
      if (!validateField(el)) allValid = false;
    });
    return allValid;
  }

  function updateSubmitState() {
    // Just ensure stripe is ready
  }

  // ---- Handle Submit ----
  async function handleSubmit() {
    if (isProcessing) return;
    if (!document.getElementById('agreementCheck').checked) {
      showGlobalError('Mesafeli Satış Sözleşmesi\'ni onaylamanız gerekmektedir.');
      return;
    }
    if (!validateAllFields()) {
      showGlobalError('Lütfen tüm zorunlu alanları doldurun.');
      return;
    }
    if (cartItems.length === 0) {
      showGlobalError('Sepetiniz boş.');
      return;
    }

    isProcessing = true;
    setLoading(true);
    hideGlobalError();

    const customerInfo = {
      email: val('email'),
      phone: val('phone'),
      firstName: val('firstName'),
      lastName: val('lastName'),
      address: val('address'),
      apartment: val('apartment'),
      city: val('city'),
      district: val('district'),
      zip: val('zip'),
      country: val('country')
    };

    try {
      // Step 1: Create PaymentIntent
      const total = subtotal - discountAmount;
      const piResp = await fetch('/api/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_intent',
          amount: total,
          currency: 'try',
          customer: customerInfo,
          items: cartItems.map(i => ({
            title: i.title,
            sku: i.sku,
            quantity: i.quantity,
            price: i.price,
            line_price: i.line_price
          }))
        })
      });
      const piData = await piResp.json();
      if (piData.error) throw new Error(piData.error);

      // Step 2: Confirm payment with Stripe Elements
      const { error, paymentIntent } = await stripeInstance.confirmCardPayment(
        piData.clientSecret,
        {
          payment_method: {
            card: cardElement,
            billing_details: {
              name: customerInfo.firstName + ' ' + customerInfo.lastName,
              email: customerInfo.email,
              phone: customerInfo.phone,
              address: {
                line1: customerInfo.address,
                line2: customerInfo.apartment,
                city: customerInfo.city,
                postal_code: customerInfo.zip,
                country: customerInfo.country
              }
            }
          }
        }
      );

      if (error) {
        throw new Error(error.message);
      }

      if (paymentIntent.status === 'succeeded') {
        // Step 3: Complete order (Shopify + Meta CAPI)
        const orderResp = await fetch('/api/complete-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId: paymentIntent.id,
            stripeCustomerId: piData.stripeCustomerId,
            customer: customerInfo,
            items: cartItems,
            subtotal: subtotal,
            discountAmount: discountAmount,
            couponCode: appliedCoupon,
            total: subtotal - discountAmount,
            // Meta & tracking
            fbp: fbp,
            fbc: fbc,
            utm_source: utmSource,
            utm_medium: utmMedium,
            utm_campaign: utmCampaign,
            utm_term: utmTerm,
            utm_content: utmContent,
            userAgent: navigator.userAgent,
            sourceUrl: window.location.href,
            agreementHtml: generateAgreementHtml(),
            marketingConsent: document.getElementById('marketingCheck').checked
          })
        });
        const orderData = await orderResp.json();

        if (orderData.error) {
          // Payment succeeded but order creation had an issue — still redirect
          console.error('Order creation issue:', orderData.error);
        }

        // Step 4: Redirect to success
        const successParams = new URLSearchParams({
          order: orderData.shopifyOrderName || '',
          email: customerInfo.email,
          total: formatMoney(subtotal - discountAmount)
        });
        window.location.href = '/success.html?' + successParams.toString();

      } else {
        throw new Error('Ödeme tamamlanamadı. Durum: ' + paymentIntent.status);
      }

    } catch (err) {
      showGlobalError(err.message || 'Bir hata oluştu. Lütfen tekrar deneyin.');
      isProcessing = false;
      setLoading(false);
    }
  }

  // ---- Helpers ----
  function val(id) {
    return (document.getElementById(id)?.value || '').trim();
  }

  function formatMoney(cents) {
    // Shopify cents → TRY format: 528820 → "5.288,20TL"
    const amount = (cents / 100).toFixed(2);
    const parts = amount.split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return intPart + ',' + parts[1] + 'TL';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function setLoading(loading) {
    const btn = document.getElementById('submitBtn');
    const text = document.getElementById('btnText');
    const spinner = document.getElementById('btnSpinner');
    btn.disabled = loading;
    text.textContent = loading ? 'İşleniyor...' : 'Siparişi Tamamla';
    spinner.style.display = loading ? 'inline-block' : 'none';
  }

  function showGlobalError(msg) {
    const el = document.getElementById('globalError');
    el.textContent = msg;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hideGlobalError() {
    document.getElementById('globalError').style.display = 'none';
  }

  // ---- Agreement Text Generators ----
  function generateAgreementHtml() {
    var ci = {
      firstName: val('firstName') || '___',
      lastName: val('lastName') || '___',
      email: val('email') || '___',
      phone: val('phone') || '___',
      address: val('address') || '___',
      apartment: val('apartment') || '',
      city: val('city') || '___',
      district: val('district') || '___',
      zip: val('zip') || '___'
    };
    var fullAddress = ci.address + (ci.apartment ? ', ' + ci.apartment : '') + ', ' + ci.district + ', ' + ci.city + ' ' + ci.zip;
    var today = new Date();
    var dateStr = today.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    var itemsHtml = cartItems.map(function(item) {
      return '<tr><td>' + escapeHtml(item.title) + '</td><td>' + (item.variant_title || '-') + '</td><td>' + item.quantity + '</td><td>' + formatMoney(item.line_price) + '</td></tr>';
    }).join('');

    var total = subtotal - discountAmount;

    return '<h4>MADDE 1 — TARAFLAR</h4>' +
      '<p><strong>SATICI:</strong></p>' +
      '<table><tr><td>Ticaret Unvanı</td><td>MESU L.L.C-F.Z</td></tr>' +
      '<tr><td>Marka Adı</td><td>Svelte Chic</td></tr>' +
      '<tr><td>Adres</td><td>Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, BAE</td></tr>' +
      '<tr><td>Telefon</td><td>+971 56 850 8810</td></tr>' +
      '<tr><td>E-posta</td><td>destek@thesveltechic.com</td></tr>' +
      '<tr><td>Web Sitesi</td><td>www.thesveltechic.com</td></tr></table>' +
      '<p><strong>ALICI:</strong></p>' +
      '<table><tr><td>Ad Soyad</td><td>' + escapeHtml(ci.firstName + ' ' + ci.lastName) + '</td></tr>' +
      '<tr><td>E-posta</td><td>' + escapeHtml(ci.email) + '</td></tr>' +
      '<tr><td>Telefon</td><td>' + escapeHtml(ci.phone) + '</td></tr>' +
      '<tr><td>Teslimat Adresi</td><td>' + escapeHtml(fullAddress) + '</td></tr></table>' +
      '<h4>MADDE 2 — SÖZLEŞMENİN KONUSU</h4>' +
      '<p>İşbu Mesafeli Satış Sözleşmesi, SATICI\'nın www.thesveltechic.com internet sitesi üzerinden elektronik ortamda ALICI\'ya satışını yaptığı aşağıda nitelikleri ve satış fiyatı belirtilen ürün/ürünlerin satışı ve teslimi ile ilgili olarak 6502 sayılı Tüketicinin Korunması Hakkında Kanun ve Mesafele Sözleşmeler Yönetmeliği hükümleri gereğince tarafların hak ve yükümlülüklerini düzenler.</p>' +
      '<h4>MADDE 3 — SÖZLEŞME KONUSU ÜRÜN BİLGİLERİ</h4>' +
      '<table><tr><td><strong>Ürün</strong></td><td><strong>Varyant</strong></td><td><strong>Adet</strong></td><td><strong>Tutar</strong></td></tr>' + itemsHtml + '</table>' +
      '<table><tr><td>Ara Toplam</td><td>' + formatMoney(subtotal) + '</td></tr>' +
      (discountAmount > 0 ? '<tr><td>İndirim' + (appliedCoupon ? ' (' + appliedCoupon + ')' : '') + '</td><td>-' + formatMoney(discountAmount) + '</td></tr>' : '') +
      '<tr><td>Kargo</td><td>Ücretsiz</td></tr>' +
      '<tr><td><strong>Toplam</strong></td><td><strong>' + formatMoney(total) + '</strong></td></tr></table>' +
      '<h4>MADDE 4 — GENEL HÜKÜMLER</h4>' +
      '<p>4.1. ALICI, SATICI\'ya ait www.thesveltechic.com internet sitesinde sözleşme konusu ürünün temel nitelikleri, satış fiyatı ve ödeme şekli ile teslimata ilişkin ön bilgileri okuyup bilgi sahibi olduğunu ve elektronik ortamda gerekli onayı verdiğini kabul, beyan ve taahhüt eder.</p>' +
      '<p>4.2. Sözleşme konusu her bir ürün, yasal 30 günlük süreyi aşmamak koşulu ile ALICI\'nın yerleşim yeri uzaklığına bağlı olarak internet sitesindeki ön bilgiler kısmında belirtilen süre zarfında ALICI veya ALICI\'nın gösterdiği adresteki kişi ve/veya kuruluşa teslim edilir.</p>' +
      '<p>4.3. Sözleşme konusu ürün, ALICI\'dan başka bir kişi/kuruluşa teslim edilecek ise, teslim edilecek kişi/kuruluşun teslimatı kabul etmemesinden SATICI sorumlu tutulamaz.</p>' +
      '<h4>MADDE 5 — ÖDEME VE TESLİMAT</h4>' +
      '<p>5.1. Ödeme, ALICI tarafından kredi kartı/banka kartı ile gerçekleştirilir. Ödeme işlemi güvenli ödeme altyapısı (Stripe) üzerinden şifrelenerek yapılır.</p>' +
      '<p>5.2. Kargo ücreti SATICI tarafından karşılanır (Ücretsiz Kargo).</p>' +
      '<p>5.3. Teslimat, kargoya verildiği tarihten itibaren ortalama 3-7 iş günü içerisinde yapılır.</p>' +
      '<h4>MADDE 6 — CAYMA HAKKI</h4>' +
      '<p>6.1. ALICI, sözleşme konusu ürünün kendisine veya gösterdiği adresteki kişi/kuruluşa tesliminden itibaren 14 (on dört) gün içerisinde cayma hakkını kullanabilir.</p>' +
      '<p>6.2. Cayma hakkının kullanılması için bu süre içinde SATICI\'ya destek@thesveltechic.com adresinden e-posta ile veya +971 56 850 8810 numaralı telefonla bildirimde bulunulması ve ürünün kullanılmamış olması şarttır.</p>' +
      '<p>6.3. Cayma hakkı kapsamında iade edilen ürünlerin kargo bedeli ALICI tarafından karşılanır.</p>' +
      '<h4>MADDE 7 — UYUŞMAZLIK ÇÖZÜMÜ</h4>' +
      '<p>İşbu sözleşmeden doğan uyuşmazlıklarda Dubai mahkemeleri ve icra daireleri yetkilidir.</p>' +
      '<h4>MADDE 8 — YÜRÜRLÜK</h4>' +
      '<p>ALICI, işbu sözleşmeyi elektronik ortamda onaylayarak tüm şartları kabul etmiş sayılır. Sözleşme, onay tarihinde yürürlüğe girer.</p>' +
      '<p><strong>Sözleşme Tarihi:</strong> ' + dateStr + '</p>' +
      '<p><strong>ALICI:</strong> ' + escapeHtml(ci.firstName + ' ' + ci.lastName) + '</p>';
  }

  function generateMarketingHtml() {
    var ci = {
      firstName: val('firstName') || '___',
      lastName: val('lastName') || '___',
      email: val('email') || '___',
      phone: val('phone') || '___'
    };
    var today = new Date();
    var dateStr = today.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    return '<h4>TİCARİ ELEKTRONİK İLETİ ONAYI</h4>' +
      '<p>6563 sayılı Elektronik Ticaretin Düzenlenmesi Hakkında Kanun ve ilgili mevzuat kapsamında;</p>' +
      '<p><strong>' + escapeHtml(ci.firstName + ' ' + ci.lastName) + '</strong> olarak, <strong>MESU L.L.C-F.Z (Svelte Chic)</strong> tarafından aşağıda belirtilen iletişim kanalları aracılığıyla tarafıma ticari elektronik ileti (kampanya, promosyon, indirim, yeni ürün bildirimi vb.) gönderilmesini kabul ediyorum.</p>' +
      '<table><tr><td>E-posta</td><td>' + escapeHtml(ci.email) + '</td></tr>' +
      '<tr><td>Telefon / SMS</td><td>' + escapeHtml(ci.phone) + '</td></tr></table>' +
      '<p>Bu onayımı istediğim zaman destek@thesveltechic.com adresine e-posta göndererek veya gelen iletilerdeki "abonelikten çık" bağlantısını kullanarak geri çekebileceğimi biliyorum.</p>' +
      '<p><strong>Onay Tarihi:</strong> ' + dateStr + '</p>';
  }

})();
