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
      const json = atob(decoded);
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
            sourceUrl: window.location.href
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

})();
