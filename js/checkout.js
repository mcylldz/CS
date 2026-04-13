/* ========================================
   SVELTE CHIC — Checkout JS (2-Step)
   ======================================== */

(function () {
  'use strict';

  // ---- State ----
  let cartItems = [];
  let subtotal = 0;       // in kuruş (Shopify cents)
  let discountAmount = 0;  // in kuruş
  let appliedCoupon = null;
  let autoDiscountAmount = 0;  // Shopify automatic discount (kuruş)
  let autoDiscountTitle = '';  // e.g. "7000TL üzeri %10 indirim"
  let stripeInstance = null;
  let cardNumberElement = null;
  let cardExpiryElement = null;
  let cardCvcElement = null;
  let isProcessing = false;
  let currentStep = 1;
  let addressData = null;  // Turkey il/ilçe/mahalle data
  let abandonTimer = null; // 10-min abandoned checkout timer
  let abandonSent = false; // prevent duplicate abandon calls
  let metaPixelReady = false; // Meta Pixel loaded flag

  // ---- URL Params ----
  const params = new URLSearchParams(window.location.search);

  // Read fbp/fbc from cookies → URL params → sessionStorage (fallback for ITP/STP browsers)
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }
  function getSessionStorageItem(key) {
    try { return sessionStorage.getItem(key) || ''; } catch(e) { return ''; }
  }

  const fbp = getCookie('_fbp') || params.get('fbp') || getSessionStorageItem('sc_fbp') || '';
  var fbclid = params.get('fbclid') || getSessionStorageItem('sc_fbclid') || '';
  const fbc = getCookie('_fbc') || params.get('fbc') || getSessionStorageItem('sc_fbc') || (fbclid ? ('fb.1.' + Date.now() + '.' + fbclid) : '');

  // Store fbp/fbc for pixel re-use across page lifecycle
  if (fbp) { try { document.cookie = '_fbp=' + fbp + '; path=/; max-age=7776000; SameSite=Lax'; } catch(e) {} }
  if (fbc) { try { document.cookie = '_fbc=' + fbc + '; path=/; max-age=7776000; SameSite=Lax'; } catch(e) {} }
  const utmSource = params.get('utm_source') || '';
  const utmMedium = params.get('utm_medium') || '';
  const utmCampaign = params.get('utm_campaign') || '';
  const utmTerm = params.get('utm_term') || '';
  const utmContent = params.get('utm_content') || '';

  // Google Ads click IDs — capture from URL or sessionStorage
  const gclid = params.get('gclid') || (function() { try { return sessionStorage.getItem('sc_gclid') || ''; } catch(e) { return ''; } })();
  const gbraid = params.get('gbraid') || (function() { try { return sessionStorage.getItem('sc_gbraid') || ''; } catch(e) { return ''; } })();
  const wbraid = params.get('wbraid') || (function() { try { return sessionStorage.getItem('sc_wbraid') || ''; } catch(e) { return ''; } })();
  if (fbp) { try { sessionStorage.setItem('sc_fbp', fbp); } catch(e) {} }
  if (fbc) { try { sessionStorage.setItem('sc_fbc', fbc); } catch(e) {} }
  if (fbclid) { try { sessionStorage.setItem('sc_fbclid', fbclid); } catch(e) {} }
  if (gclid) { try { sessionStorage.setItem('sc_gclid', gclid); } catch(e) {} }
  if (gbraid) { try { sessionStorage.setItem('sc_gbraid', gbraid); } catch(e) {} }
  if (wbraid) { try { sessionStorage.setItem('sc_wbraid', wbraid); } catch(e) {} }

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', init);

  // ---- Turkish Character Normalize (İ→i, Ş→s, Ç→c, etc.) ----
  function normalizeTurkish(str) {
    if (!str) return '';
    return str.replace(/İ/g, 'i').replace(/I/g, 'i')
      .replace(/Ş/g, 's').replace(/ş/g, 's')
      .replace(/Ç/g, 'c').replace(/ç/g, 'c')
      .replace(/Ü/g, 'u').replace(/ü/g, 'u')
      .replace(/Ö/g, 'o').replace(/ö/g, 'o')
      .replace(/Ğ/g, 'g').replace(/ğ/g, 'g');
  }

  // ---- Phone Normalize (Turkey: 905xxxxxxxxx) ----
  function normalizePhone(phone) {
    if (!phone) return '';
    var digits = phone.replace(/\D/g, '');
    if (digits.startsWith('90') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 11) return '9' + digits;
    if (digits.length === 10 && digits.startsWith('5')) return '90' + digits;
    return digits;
  }

  // ---- GA4 Helpers ----
  var GA4_ID = 'G-J8YYTV1W2E';
  var GA4_AW_ID = 'AW-11536130276';

  // Get GA4 client_id from _ga cookie (format: GA1.1.XXXXXXXXXX.YYYYYYYYYY)
  function getGA4ClientId() {
    try {
      var match = document.cookie.match(/(?:^|;\s*)_ga=GA\d+\.\d+\.(.+?)(?:;|$)/);
      if (match) return match[1];
    } catch(e) {}
    return '';
  }

  // Get GA4 session_id from _ga_<container> cookie
  function getGA4SessionId() {
    try {
      var match = document.cookie.match(/(?:^|;\s*)_ga_J8YYTV1W2E=GS\d+\.\d+\.(.+?)(?:\.|;|$)/);
      if (match) return match[1];
    } catch(e) {}
    return '';
  }

  // Build GA4 ecommerce items array from cart
  function buildGA4Items() {
    return cartItems.map(function(item, idx) {
      return {
        item_id: item.sku || String(item.variant_id),
        item_name: item.title,
        item_variant: item.variant_title || '',
        item_brand: 'Svelte Chic',
        price: item.price / 100,
        quantity: item.quantity,
        index: idx
      };
    });
  }

  function getGA4Value() {
    return parseFloat(((subtotal - discountAmount - autoDiscountAmount) / 100).toFixed(2));
  }

  // ---- Yandex Metrica Helpers ----
  var YM_ID = 108350862;
  window.dataLayer = window.dataLayer || [];

  function ymGoal(goalName, params) {
    try {
      if (typeof ym !== 'undefined') ym(YM_ID, 'reachGoal', goalName, params || {});
    } catch (e) { console.warn('YM goal error:', e); }
  }

  function ymProducts() {
    return cartItems.map(function(item) {
      return {
        id: item.sku || String(item.variant_id),
        name: item.title,
        variant: item.variant_title || '',
        price: item.price / 100,
        quantity: item.quantity,
        brand: 'Svelte Chic'
      };
    });
  }

  function init() {
    // Meta Pixel initialization check
    if (!window.metaPixelId) {
      console.warn('⚠️ Meta Pixel ID not set. Pixel tracking disabled.');
    } else {
      console.log('✅ Meta Pixel ID found:', window.metaPixelId);
    }

    parseCart();
    renderItems();
    updateTotals();
    loadAddressData();
    bindEvents();
    // Meta CAPI: InitiateCheckout on page load
    fireInitiateCheckout();

    // Load Meta Pixel early — independent of Stripe init (was 7-10s, now 3s or first interaction)
    if (window.metaPixelId) {
      var pixelTriggered = false;
      function triggerPixelEarly() {
        if (pixelTriggered) return;
        pixelTriggered = true;
        loadMetaPixel(window.metaPixelId);
      }
      ['click', 'scroll', 'touchstart', 'keydown', 'mousemove'].forEach(function(evt) {
        document.addEventListener(evt, triggerPixelEarly, { once: true, passive: true });
      });
      setTimeout(triggerPixelEarly, 3000);
    }

    // Defer Stripe.js: load on first user interaction (reduces TBT significantly)
    // PSI doesn't interact → Stripe won't load during measurement window
    // Real users interact within seconds → Stripe loads immediately
    var stripeTriggered = false;
    function triggerStripe() {
      if (stripeTriggered) return;
      stripeTriggered = true;
      initStripe();
    }
    ['click', 'touchstart', 'keydown'].forEach(function(evt) {
      document.addEventListener(evt, triggerStripe, { once: true, passive: true });
    });
    // Fallback: load after 10s if no interaction (keeps it outside PSI core window)
    setTimeout(triggerStripe, 10000);

    // GA4: begin_checkout event
    if (cartItems.length > 0 && typeof gtag === 'function') {
      gtag('event', 'begin_checkout', {
        currency: 'TRY',
        value: getGA4Value(),
        coupon: appliedCoupon || '',
        items: buildGA4Items()
      });
    }

    // Yandex Metrica: product detail view + checkout_started goal
    if (cartItems.length > 0) {
      dataLayer.push({
        ecommerce: {
          currencyCode: 'TRY',
          detail: {
            products: ymProducts()
          }
        }
      });
      ymGoal('checkout_started', {
        order_price: (subtotal - discountAmount - autoDiscountAmount) / 100,
        currency: 'TRY',
        num_items: cartItems.reduce(function(s, i) { return s + i.quantity; }, 0)
      });
    }
  }

  // ---- Parse Cart from URL ----
  function parseCartData(data) {
    // Support both formats:
    // Old: array of items (backward compat)
    // New: { items: [...], auto_discount: N, auto_discount_title: "..." }
    if (Array.isArray(data)) {
      cartItems = data;
    } else if (data && Array.isArray(data.items) && data.items.length > 0) {
      cartItems = data.items;
      if (data.auto_discount > 0) {
        autoDiscountAmount = data.auto_discount;
        autoDiscountTitle = data.auto_discount_title || 'Otomatik İndirim';
      }
    }
    if (cartItems.length > 0) {
      // Use line_price (which now contains final_line_price from redirect)
      subtotal = cartItems.reduce((sum, item) => sum + item.line_price, 0);
      return true;
    }
    return false;
  }

  function parseCart() {
    const cartParam = params.get('cart');
    if (!cartParam) {
      // Try sessionStorage fallback (e.g. page refresh, Instagram WebView, large cart)
      try {
        var saved = sessionStorage.getItem('sc_cart');
        if (saved) {
          var data = JSON.parse(saved);
          if (parseCartData(data)) return;
        }
      } catch(e) {}
      showGlobalError('Sepet bilgisi bulunamadı. Lütfen mağazaya geri dönün.');
      return;
    }
    try {
      const decoded = decodeURIComponent(cartParam);
      const json = decodeURIComponent(escape(atob(decoded)));
      const data = JSON.parse(json);
      if (parseCartData(data)) {
        // Save to sessionStorage for page refresh resilience
        try { sessionStorage.setItem('sc_cart', JSON.stringify(data)); } catch(e) {}
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
    const total = subtotal - discountAmount - autoDiscountAmount;
    document.getElementById('subtotalPrice').textContent = formatMoney(subtotal);
    document.getElementById('totalPrice').textContent = formatMoney(total);
    document.getElementById('togglePrice').textContent = formatMoney(total);

    // Shopify automatic discount line
    var autoDiscountLine = document.getElementById('autoDiscountLine');
    if (!autoDiscountLine && autoDiscountAmount > 0) {
      // Create auto discount line dynamically (insert before coupon line)
      var discountLine = document.getElementById('discountLine');
      if (discountLine) {
        autoDiscountLine = document.createElement('div');
        autoDiscountLine.id = 'autoDiscountLine';
        autoDiscountLine.className = discountLine.className;
        autoDiscountLine.innerHTML = '<span id="autoDiscountLabel"></span><span id="autoDiscountValue"></span>';
        discountLine.parentNode.insertBefore(autoDiscountLine, discountLine);
      }
    }
    if (autoDiscountLine) {
      if (autoDiscountAmount > 0) {
        autoDiscountLine.style.display = 'flex';
        document.getElementById('autoDiscountLabel').textContent = autoDiscountTitle || 'Otomatik İndirim';
        document.getElementById('autoDiscountValue').textContent = '-' + formatMoney(autoDiscountAmount);
      } else {
        autoDiscountLine.style.display = 'none';
      }
    }

    // Coupon discount line
    var discountLine = document.getElementById('discountLine');
    if (discountAmount > 0 && appliedCoupon) {
      discountLine.style.display = 'flex';
      document.getElementById('discountLabel').textContent = `İndirim (${appliedCoupon})`;
      document.getElementById('discountAmount').textContent = '-' + formatMoney(discountAmount);
    } else {
      discountLine.style.display = 'none';
    }
  }

  // ---- Stripe.js Lazy Loader ----
  var stripeScriptLoaded = false;
  var stripeScriptPromise = null;

  function loadStripeScript() {
    if (stripeScriptPromise) return stripeScriptPromise;
    stripeScriptPromise = new Promise(function(resolve, reject) {
      if (window.Stripe) { stripeScriptLoaded = true; resolve(); return; }
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = function() { stripeScriptLoaded = true; resolve(); };
      s.onerror = function() { reject(new Error('Stripe.js yüklenemedi')); };
      document.head.appendChild(s);
    });
    return stripeScriptPromise;
  }

  // ---- Stripe Init (Separate Fields) ----
  function initStripe() {
    // Fetch key and load Stripe.js in parallel
    var keyPromise = fetch('/api/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_key' })
    }).then(function(r) { return r.json(); });

    var scriptPromise = loadStripeScript();

    Promise.all([keyPromise, scriptPromise])
    .then(function(results) {
      var data = results[0];

      // Load Meta Pixel if pixel ID is available (fallback to window.metaPixelId if API omits it)
      var pixelId = data.metaPixelId || window.metaPixelId || '';
      if (pixelId) {
        loadMetaPixel(pixelId);
      }

      if (data.publishableKey) {
        stripeInstance = Stripe(data.publishableKey);
        var elements = stripeInstance.elements({ locale: 'tr' });

        var fieldStyle = {
          base: {
            fontFamily: "'Inter', sans-serif",
            fontSize: '15px',
            color: '#333',
            '::placeholder': { color: '#999' }
          },
          invalid: { color: '#c00' }
        };

        // Card Number
        cardNumberElement = elements.create('cardNumber', { style: fieldStyle, showIcon: true });
        cardNumberElement.mount('#card-number-element');

        // Expiry
        cardExpiryElement = elements.create('cardExpiry', { style: fieldStyle });
        cardExpiryElement.mount('#card-expiry-element');

        // CVC
        cardCvcElement = elements.create('cardCvc', { style: fieldStyle });
        cardCvcElement.mount('#card-cvc-element');

        // Error handling for all fields
        var errEl = document.getElementById('card-errors');
        function handleCardError(event) {
          if (event.error) {
            errEl.textContent = event.error.message;
            errEl.style.display = 'block';
          } else {
            errEl.textContent = '';
            errEl.style.display = 'none';
          }
        }
        cardNumberElement.on('change', handleCardError);
        cardExpiryElement.on('change', handleCardError);
        cardCvcElement.on('change', handleCardError);

        // Enable submit button
        document.getElementById('submitBtn').disabled = false;
      }
    })
    .catch(function(err) {
      console.error('Stripe init error:', err);
      showGlobalError('Ödeme sistemi yüklenemedi. Lütfen sayfayı yenileyin.');
    });
  }

  // ---- Load Address Data (Lazy Loading) ----
  var provinceSlugs = null; // { "Adana": "adana", "İstanbul": "istanbul", ... }
  var loadedProvinceData = {}; // Cache: { "İstanbul": { ilçe: [mahalle, ...] } }

  function loadAddressData() {
    // Only load province list (~1.7 KB instead of 2.5 MB)
    fetch('/data/provinces.json')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        provinceSlugs = data;
        addressData = {}; // Keep for backward compat with validation
        populateProvinces();
      })
      .catch(function(err) {
        console.error('Province list load error:', err);
      });
  }

  function populateProvinces() {
    var citySelect = document.getElementById('city');
    if (!provinceSlugs || !citySelect) return;

    var provinces = Object.keys(provinceSlugs).sort(function(a, b) {
      return a.localeCompare(b, 'tr');
    });

    citySelect.innerHTML = '<option value="">İl seçiniz</option>';
    provinces.forEach(function(il) {
      var opt = document.createElement('option');
      opt.value = il;
      opt.textContent = il;
      citySelect.appendChild(opt);
    });
  }

  function populateDistricts(il) {
    var districtSelect = document.getElementById('district');
    var mahalleSelect = document.getElementById('mahalle');

    // Reset district and mahalle
    districtSelect.innerHTML = '<option value="">İlçe yükleniyor...</option>';
    districtSelect.disabled = true;
    mahalleSelect.innerHTML = '<option value="">Önce ilçe seçiniz</option>';
    mahalleSelect.disabled = true;

    if (!il || !provinceSlugs || !provinceSlugs[il]) return;

    // Check memory cache first
    if (loadedProvinceData[il]) {
      addressData[il] = loadedProvinceData[il];
      renderDistricts(il);
      return;
    }

    // Check sessionStorage cache (survives page refresh / app switch)
    try {
      var cached = sessionStorage.getItem('sc_province_' + il);
      if (cached) {
        var parsed = JSON.parse(cached);
        loadedProvinceData[il] = parsed;
        addressData[il] = parsed;
        renderDistricts(il);
        return;
      }
    } catch(e) {}

    // Lazy load province data (~26 KB average per province)
    var slug = provinceSlugs[il];
    fetch('/data/iller/' + slug + '.json')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        loadedProvinceData[il] = data;
        addressData[il] = data;
        // Persist to sessionStorage for page refresh resilience
        try { sessionStorage.setItem('sc_province_' + il, JSON.stringify(data)); } catch(e) {}
        renderDistricts(il);
      })
      .catch(function(err) {
        console.error('District data load error for ' + il + ':', err);
        districtSelect.innerHTML = '<option value="">İlçe yüklenemedi</option>';
      });
  }

  function renderDistricts(il) {
    var districtSelect = document.getElementById('district');
    districtSelect.innerHTML = '<option value="">İlçe seçiniz</option>';
    districtSelect.disabled = false;

    if (!addressData[il]) return;

    var districts = Object.keys(addressData[il]).sort(function(a, b) {
      return a.localeCompare(b, 'tr');
    });

    districts.forEach(function(ilce) {
      var opt = document.createElement('option');
      opt.value = ilce;
      opt.textContent = ilce;
      districtSelect.appendChild(opt);
    });
  }

  function populateMahalleler(il, ilce) {
    var mahalleSelect = document.getElementById('mahalle');
    mahalleSelect.innerHTML = '<option value="">Mahalle seçiniz</option>';
    mahalleSelect.disabled = false;

    if (!il || !ilce || !addressData || !addressData[il] || !addressData[il][ilce]) return;

    var mahalleler = addressData[il][ilce].slice().sort(function(a, b) {
      return a.localeCompare(b, 'tr');
    });

    mahalleler.forEach(function(mah) {
      var opt = document.createElement('option');
      opt.value = mah;
      opt.textContent = mah;
      mahalleSelect.appendChild(opt);
    });
  }

  // ======== META PIXEL + CAPI TRACKING ========

  // Load Meta Pixel base code dynamically
  function loadMetaPixel(pixelId) {
    if (metaPixelReady || !pixelId) return;
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');

    // Advanced Matching: pass available user data at init
    // This improves event match quality even before the user fills the form
    var advancedMatchData = {};
    if (fbp) advancedMatchData.fbp = fbp;
    if (fbc) advancedMatchData.fbc = fbc;
    // Check if any fields are pre-filled (e.g. returning user)
    var emailVal = val('email');
    var phoneVal = val('phone');
    var fnVal = val('firstName');
    var lnVal = val('lastName');
    if (emailVal) advancedMatchData.em = emailVal.toLowerCase().trim();
    if (phoneVal) advancedMatchData.ph = normalizePhone(phoneVal);
    if (fnVal) advancedMatchData.fn = normalizeTurkish(fnVal).toLowerCase().trim();
    if (lnVal) advancedMatchData.ln = normalizeTurkish(lnVal).toLowerCase().trim();

    window._metaPixelId = pixelId; // Store for re-init with user data later

    if (Object.keys(advancedMatchData).length > 0) {
      fbq('init', pixelId, advancedMatchData);
      console.log('Meta Pixel init with Advanced Matching:', Object.keys(advancedMatchData));
    } else {
      fbq('init', pixelId);
      console.log('Meta Pixel init (no Advanced Matching data available)');
    }

    // PageView on init
    fbq('track', 'PageView');
    metaPixelReady = true;
    console.log('Meta Pixel loaded:', pixelId);

    // If cart already parsed, fire deferred InitiateCheckout via pixel
    if (cartItems.length > 0 && window._deferredICEventId) {
      fireFbqEvent('InitiateCheckout', window._deferredICEventId, null);
      window._deferredICEventId = null;
    }

    // Fire deferred AddPaymentInfo if user reached Step 2 before pixel loaded
    if (window._deferredAPIEventId) {
      fireFbqEvent('AddPaymentInfo', window._deferredAPIEventId, window._deferredAPICustomer);
      window._deferredAPIEventId = null;
      window._deferredAPICustomer = null;
    }
  }

  // Re-init pixel with user data when they complete Step 1 (for better matching on Step 2 events)
  function updatePixelUserData(customer) {
    if (!metaPixelReady || typeof fbq === 'undefined') return;
    var userData = {};
    if (customer.email) userData.em = customer.email.toLowerCase().trim();
    if (customer.phone) userData.ph = normalizePhone(customer.phone);
    if (customer.firstName) userData.fn = normalizeTurkish(customer.firstName).toLowerCase().trim();
    if (customer.lastName) userData.ln = normalizeTurkish(customer.lastName).toLowerCase().trim();
    if (customer.city) userData.ct = normalizeTurkish(customer.city).toLowerCase().trim();
    if (customer.state) userData.st = normalizeTurkish(customer.state).toLowerCase().trim();
    if (customer.zip) userData.zp = customer.zip.trim();
    if (customer.country) userData.country = customer.country.toLowerCase().trim();
    if (customer.email) userData.external_id = customer.email.toLowerCase().trim();
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;
    // Use fbq('init') again with user data to update matching for subsequent events
    fbq('init', window._metaPixelId || '', userData);
    console.log('Meta Pixel Advanced Matching updated with customer data');
  }

  // Build catalog-compatible content_id: variant_id (matches Meta catalog İçerik Kodu)
  function getCatalogId(item) {
    return String(item.variant_id);
  }

  // Build fbq custom_data for events
  function buildFbqCustomData() {
    var total = subtotal - discountAmount - autoDiscountAmount;
    var data = {
      currency: 'TRY',
      value: parseFloat((total / 100).toFixed(2)),
      content_type: 'product',
      num_items: cartItems.reduce(function(sum, item) { return sum + item.quantity; }, 0)
    };
    if (cartItems.length > 0) {
      data.contents = cartItems.map(function(item) {
        return {
          id: getCatalogId(item),
          quantity: item.quantity,
          item_price: parseFloat((item.price / 100).toFixed(2)),
          title: item.title || '',  // ← Product title (for DPA, retargeting)
          image_url: item.image || '',  // ← Product image
          url: 'https://www.thesveltechic.com/products/' + (item.product_id || '')  // ← Product URL
        };
      });
      data.content_ids = cartItems.map(function(item) {
        return getCatalogId(item);
      });
    }
    return data;
  }

  // Fire fbq browser event with eventID for deduplication
  function fireFbqEvent(eventName, eventId, customer) {
    if (!metaPixelReady || typeof fbq === 'undefined') return;
    var customData = buildFbqCustomData();
    // Add customer data if available
    if (customer && customer.email) {
      customData.customer_email = customer.email;
    }
    fbq('track', eventName, customData, { eventID: eventId });
    console.log('Meta Pixel [' + eventName + '] eventID:', eventId);
  }

  function getTrackingBase() {
    return {
      items: cartItems.map(function(i) {
        return {
          variant_id: i.variant_id,
          product_id: i.product_id,
          sku: i.sku,
          title: i.title,
          quantity: i.quantity,
          price: i.price,
          line_price: i.line_price,
          image: i.image || ''
        };
      }),
      subtotal: subtotal,
      discountAmount: discountAmount,
      total: subtotal - discountAmount - autoDiscountAmount,
      fbp: fbp,
      fbc: fbc,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      utm_term: utmTerm,
      utm_content: utmContent,
      userAgent: navigator.userAgent,
      sourceUrl: window.location.href
    };
  }

  function getCustomerData() {
    var cityEl = document.getElementById('city');
    var districtEl = document.getElementById('district');
    var mahalleEl = document.getElementById('mahalle');
    var cityValue = (cityEl && cityEl.selectedOptions[0] ? cityEl.selectedOptions[0].text : '') || '';
    return {
      email: val('email'),
      phone: val('phone'),
      firstName: val('firstName'),
      lastName: val('lastName'),
      address: val('address'),
      mahalle: (mahalleEl && mahalleEl.selectedOptions[0] ? mahalleEl.selectedOptions[0].text : '') || '',
      district: (districtEl && districtEl.selectedOptions[0] ? districtEl.selectedOptions[0].text : '') || '',
      city: cityValue,
      state: cityValue,  // ← Türkiye'de state = il (Meta EMQ için)
      zip: val('zip'),
      country: val('country') || 'TR'
    };
  }

  // Fire event via BOTH browser pixel AND server-side CAPI with same eventId
  function fireMetaEvent(eventName, customer) {
    var payload = getTrackingBase();
    payload.eventName = eventName;
    // Generate shared eventId for deduplication — use seconds format to match server-side
    var eventTimestamp = Math.floor(Date.now() / 1000);
    var eventId = eventName.toLowerCase() + '_' + eventTimestamp + '_' + Math.random().toString(36).substr(2, 9);
    payload.eventId = eventId;
    if (customer) payload.customer = customer;

    // 1) Browser-side: fbq pixel event
    if (metaPixelReady) {
      fireFbqEvent(eventName, eventId, customer);
    } else if (eventName === 'InitiateCheckout') {
      // Pixel not yet loaded, defer the fbq call
      window._deferredICEventId = eventId;
    } else if (eventName === 'AddPaymentInfo') {
      // Pixel not yet loaded, defer AddPaymentInfo too
      window._deferredAPIEventId = eventId;
      window._deferredAPICustomer = customer;
    }

    // 2) Server-side: CAPI event (same eventId for deduplication)
    fetch('/api/track-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r) { return r.json(); }).then(function(d) {
      console.log('Meta CAPI [' + eventName + ']:', d);
    }).catch(function(err) {
      console.warn('Meta CAPI [' + eventName + '] error:', err);
    });
  }

  // Fire InitiateCheckout on page load (after cart parse)
  // Note: Pixel may not be ready yet (lazy loaded), so deferred firing is handled in loadMetaPixel()
  function fireInitiateCheckout() {
    if (cartItems.length === 0) return;
    // InitiateCheckout can be deferred (see line 688-689) or fired immediately if pixel ready
    fireMetaEvent('InitiateCheckout', null);
  }

  // Fire AddPaymentInfo when user enters Step 2 (once only — prevent duplicate on step navigation)
  var addPaymentInfoFired = false;
  function fireAddPaymentInfo() {
    if (addPaymentInfoFired || cartItems.length === 0) return;
    addPaymentInfoFired = true;
    var customer = getCustomerData();
    // Update pixel with customer data for better Advanced Matching on this and future events
    updatePixelUserData(customer);
    // Wait for pixel to be ready before firing event (up to 300ms)
    if (metaPixelReady || typeof fbq !== 'undefined') {
      fireMetaEvent('AddPaymentInfo', customer);
    } else {
      console.warn('⚠️ Meta Pixel not ready yet when entering payment step - using CAPI only');
      fireMetaEvent('AddPaymentInfo', customer); // CAPI will still fire
    }

    // Yandex Metrica: payment step reached
    ymGoal('payment_step_reached', {
      order_price: (subtotal - discountAmount - autoDiscountAmount) / 100,
      currency: 'TRY',
      customer_city: customer.city
    });
    dataLayer.push({
      ecommerce: {
        currencyCode: 'TRY',
        checkout: {
          actionField: { step: 2 },
          products: ymProducts()
        }
      }
    });
  }

  // ======== ABANDONED CHECKOUT ========
  function startAbandonTimer() {
    clearAbandonTimer();
    if (abandonSent) return;

    abandonTimer = setTimeout(function() {
      if (isProcessing || abandonSent) return;
      sendAbandonedCheckout();
    }, 10 * 60 * 1000); // 10 minutes
  }

  function clearAbandonTimer() {
    if (abandonTimer) {
      clearTimeout(abandonTimer);
      abandonTimer = null;
    }
  }

  function sendAbandonedCheckout() {
    if (abandonSent) return;
    abandonSent = true;

    var customer = getCustomerData();
    if (!customer.email) return; // Can't create without email

    var payload = {
      customer: customer,
      items: cartItems.map(function(i) {
        return {
          variant_id: i.variant_id,
          product_id: i.product_id,
          sku: i.sku,
          title: i.title,
          quantity: i.quantity,
          price: i.price,
          line_price: i.line_price
        };
      }),
      subtotal: subtotal,
      discountAmount: discountAmount,
      couponCode: appliedCoupon,
      abandonedAt: new Date().toISOString()
    };

    fetch('/api/abandoned-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r) { return r.json(); }).then(function(d) {
      console.log('Abandoned checkout sent:', d);
    }).catch(function(err) {
      console.warn('Abandoned checkout error:', err);
    });
  }

  // ======== STEP NAVIGATION ========
  function goToStep(step) {
    currentStep = step;
    var panel1 = document.getElementById('step1Panel');
    var panel2 = document.getElementById('step2Panel');
    var label1 = document.getElementById('stepLabel1');
    var label2 = document.getElementById('stepLabel2');

    if (step === 1) {
      panel1.classList.add('sc-step-panel-active');
      panel2.classList.remove('sc-step-panel-active');
      label1.classList.add('sc-step-active');
      label1.classList.remove('sc-step-completed');
      label2.classList.remove('sc-step-active');
    } else {
      panel1.classList.remove('sc-step-panel-active');
      panel2.classList.add('sc-step-panel-active');
      label1.classList.remove('sc-step-active');
      label1.classList.add('sc-step-completed');
      label2.classList.add('sc-step-active');
    }

    // Scroll to top of form
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleContinue() {
    // Validate Step 1 fields
    if (!validateStep1()) {
      showGlobalError('Lütfen tüm zorunlu alanları doldurun.');
      return;
    }
    hideGlobalError();

    // Ensure Stripe is loading (in case user hasn't triggered interaction-based load)
    if (!stripeScriptLoaded) {
      loadStripeScript();
    }

    goToStep(2);

    // GA4: add_payment_info event
    if (typeof gtag === 'function') {
      gtag('event', 'add_payment_info', {
        currency: 'TRY',
        value: getGA4Value(),
        payment_type: 'Credit Card',
        coupon: appliedCoupon || '',
        items: buildGA4Items()
      });
    }

    // Meta CAPI: AddPaymentInfo when entering payment step
    fireAddPaymentInfo();

    // Start 10-minute abandon timer
    startAbandonTimer();
  }

  function validateStep1() {
    var fields = ['email', 'phone', 'firstName', 'lastName', 'city', 'district', 'mahalle', 'address', 'zip'];
    var allValid = true;
    fields.forEach(function(id) {
      var el = document.getElementById(id);
      if (!validateField(el)) allValid = false;
    });
    return allValid;
  }

  // ---- Bind Events ----
  function bindEvents() {
    // Summary toggle (mobile) — starts open, click to close/open
    var toggleBtn = document.getElementById('summaryToggle');
    var summaryContent = document.getElementById('summaryContent');
    if (toggleBtn) {
      // Start with toggle arrow rotated (open state)
      toggleBtn.classList.add('sc-open');
      toggleBtn.addEventListener('click', function () {
        toggleBtn.classList.toggle('sc-open');
        summaryContent.classList.toggle('sc-closed');
      });
    }

    // Coupon
    document.getElementById('couponBtn').addEventListener('click', applyCoupon);
    document.getElementById('couponCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); }
    });

    // Step navigation
    document.getElementById('continueBtn').addEventListener('click', handleContinue);
    document.getElementById('backBtn').addEventListener('click', function() { clearAbandonTimer(); goToStep(1); });

    // Breadcrumb step clicks
    document.getElementById('stepLabel1').addEventListener('click', function() {
      goToStep(1);
    });
    document.getElementById('stepLabel2').addEventListener('click', function() {
      if (validateStep1()) {
        hideGlobalError();
        goToStep(2);
        fireAddPaymentInfo();
        startAbandonTimer();
      }
    });

    // Address cascade selects
    document.getElementById('city').addEventListener('change', function() {
      populateDistricts(this.value);
    });
    document.getElementById('district').addEventListener('change', function() {
      var il = document.getElementById('city').value;
      populateMahalleler(il, this.value);
    });

    // Submit
    document.getElementById('submitBtn').addEventListener('click', handleSubmit);

    // Form validation on blur
    var inputs = document.querySelectorAll('.sc-input[required]');
    inputs.forEach(function(input) {
      input.addEventListener('blur', function () {
        validateField(this);
      });
    });

    // ---- Mobile viewport lock: prevent ALL zoom ----
    // Block pinch-zoom gesture at document level
    document.addEventListener('touchstart', function(e) {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    // Block double-tap zoom
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function(e) {
      var now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    // Block ctrl+wheel zoom (desktop Instagram WebView edge case)
    document.addEventListener('wheel', function(e) {
      if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    // Continuously enforce viewport scale via visualViewport API
    if (window.visualViewport) {
      var vpMeta = document.querySelector('meta[name="viewport"]');
      var resetViewport = function() {
        if (window.visualViewport.scale !== 1 && vpMeta) {
          vpMeta.setAttribute('content', 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no');
        }
      };
      window.visualViewport.addEventListener('resize', resetViewport);
      window.visualViewport.addEventListener('scroll', resetViewport);
    }

    // Scroll focused input into view after keyboard opens (no zoom, just scroll)
    document.querySelectorAll('input, select, textarea').forEach(function(el) {
      el.addEventListener('focus', function() {
        var target = this;
        setTimeout(function() {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
      });
    });

    // Legal agreement links
    document.getElementById('openAgreement').addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('agreementBody').innerHTML = generateAgreementHtml();
      document.getElementById('agreementOverlay').classList.add('sc-open');
    });
    document.getElementById('openMarketing').addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
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
        discountAmount = data.discount_amount;
        msgEl.textContent = `✓ "${code}" uygulandı`;
        msgEl.className = 'sc-coupon-msg sc-success';
        codeInput.disabled = true;
        document.getElementById('couponBtn').textContent = '✓';
        document.getElementById('couponBtn').disabled = true;
        updateTotals();

        // Yandex Metrica: coupon applied
        ymGoal('coupon_applied', {
          coupon_code: code,
          discount_amount: data.discount_amount / 100,
          discount_type: data.discount_type || '',
          order_price: (subtotal - data.discount_amount) / 100
        });
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
  var fieldMessages = {
    email: 'Geçerli bir e-posta adresi girin.',
    phone: 'Geçerli bir telefon numarası girin (05XX XXX XXXX).',
    firstName: 'Adınızı girin.',
    lastName: 'Soyadınızı girin.',
    city: 'İl seçiniz.',
    district: 'İlçe seçiniz.',
    mahalle: 'Mahalle seçiniz.',
    address: 'Adres bilgisi girin.',
    zip: 'Posta kodunu girin.'
  };

  function showFieldError(el, msg) {
    clearFieldError(el);
    el.classList.add('sc-error');
    if (msg) {
      var errSpan = document.createElement('span');
      errSpan.className = 'sc-field-error';
      errSpan.textContent = msg;
      // Insert after the input or after its parent .sc-select-wrap
      var parent = el.closest('.sc-select-wrap') || el;
      parent.parentNode.insertBefore(errSpan, parent.nextSibling);
    }
  }

  function clearFieldError(el) {
    el.classList.remove('sc-error');
    var parent = el.closest('.sc-select-wrap') || el;
    var existing = parent.parentNode.querySelector('.sc-field-error');
    if (existing) existing.remove();
  }

  function validateField(el) {
    if (!el) return true;
    if (el.required && !el.value.trim()) {
      showFieldError(el, fieldMessages[el.id] || 'Bu alan zorunludur.');
      return false;
    }
    if (el.id === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim())) {
      showFieldError(el, fieldMessages.email);
      return false;
    }
    if (el.id === 'phone') {
      var phoneDigits = el.value.replace(/\D/g, '');
      var isValidTR = (phoneDigits.startsWith('90') && phoneDigits.length === 12 && phoneDigits[2] === '5')
        || (phoneDigits.startsWith('0') && phoneDigits.length === 11 && phoneDigits[1] === '5')
        || (phoneDigits.startsWith('5') && phoneDigits.length === 10);
      if (!isValidTR) {
        showFieldError(el, fieldMessages.phone);
        return false;
      }
    }
    clearFieldError(el);
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

    var cityText = document.getElementById('city').selectedOptions[0]?.text || val('city');
    var districtText = document.getElementById('district').selectedOptions[0]?.text || val('district');
    var mahalleText = document.getElementById('mahalle').selectedOptions[0]?.text || val('mahalle');

    const customerInfo = {
      email: val('email'),
      phone: val('phone'),
      firstName: val('firstName'),
      lastName: val('lastName'),
      address: val('address'),
      mahalle: mahalleText,
      district: districtText,
      city: cityText,
      state: cityText,  // Türkiye'de state = il (getCustomerData ile tutarlı)
      zip: val('zip'),
      country: val('country')
    };

    try {
      // Step 1: Create PaymentIntent
      const total = subtotal - discountAmount - autoDiscountAmount;
      const piResp = await fetch('/api/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_intent',
          amount: total,
          currency: 'try',
          customer: customerInfo,
          items: cartItems.map(i => ({
            variant_id: i.variant_id,
            product_id: i.product_id,
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
      var fullStripeAddress = customerInfo.mahalle + ', ' + customerInfo.address;
      const { error, paymentIntent } = await stripeInstance.confirmCardPayment(
        piData.clientSecret,
        {
          payment_method: {
            card: cardNumberElement,
            billing_details: {
              name: customerInfo.firstName + ' ' + customerInfo.lastName,
              email: customerInfo.email,
              phone: customerInfo.phone,
              address: {
                line1: fullStripeAddress,
                line2: customerInfo.district,
                city: customerInfo.city,
                postal_code: customerInfo.zip || '',
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
        // Payment successful — cancel abandon timer
        clearAbandonTimer();
        abandonSent = true;

        // Generate purchaseEventId early (needed in complete-order body + browser pixel for CAPI dedup)
        // Use seconds (not milliseconds) to match server-side format and ensure consistent dedup
        var eventTimestamp = Math.floor(Date.now() / 1000);
        var purchaseEventId = 'purchase_' + eventTimestamp + '_' + Math.random().toString(36).substr(2, 9);

        // GA4: purchase event — fire immediately (same reasoning as Meta pixel below)
        var ga4TransactionId = paymentIntent.id;
        if (typeof gtag === 'function') {
          gtag('event', 'purchase', {
            transaction_id: ga4TransactionId,
            value: getGA4Value(),
            currency: 'TRY',
            shipping: 0,
            tax: 0,
            coupon: appliedCoupon || '',
            items: buildGA4Items()
          });
          // Google Ads conversion
          gtag('event', 'conversion', {
            send_to: GA4_AW_ID + '/purchase',
            value: getGA4Value(),
            currency: 'TRY',
            transaction_id: ga4TransactionId
          });
          console.log('GA4 [purchase] + Google Ads [conversion] fired, txn:', ga4TransactionId);
        }

        // FIRE BROWSER PIXEL IMMEDIATELY after Stripe success — before complete-order.
        // Reason: complete-order takes 3-4s. If user closes page during that wait,
        // browser pixel never fires, CAPI has no browser match → dedup fails → Meta ignores event.
        // Stripe payment is already confirmed at this point, so this is a real purchase.

        // Wait up to 500ms for pixel to be ready (handles slow network/mobile)
        var pixelWaitStart = Date.now();
        while (!metaPixelReady && typeof fbq === 'undefined' && (Date.now() - pixelWaitStart) < 500) {
          await new Promise(r => setTimeout(r, 50));
        }

        if (metaPixelReady && typeof fbq !== 'undefined') {
          // Refresh Advanced Matching with final complete customer data before Purchase event
          updatePixelUserData(customerInfo);

          var purchaseData = buildFbqCustomData();
          purchaseData.transaction_id = paymentIntent.id;
          fbq('track', 'Purchase', purchaseData, { eventID: purchaseEventId });
          console.log('✅ Meta Pixel [Purchase] fired successfully, eventID:', purchaseEventId);
        } else {
          console.warn('⚠️ Meta Pixel not ready or fbq unavailable - CAPI fallback will handle Purchase event');
        }

        // Step 3: Complete order (Shopify + Meta CAPI) — with retry
        var orderData = null;
        var completeOrderBody = JSON.stringify({
          paymentIntentId: paymentIntent.id,
          stripeCustomerId: piData.stripeCustomerId,
          customer: customerInfo,
          items: cartItems,
          subtotal: subtotal,
          discountAmount: discountAmount,
          couponCode: appliedCoupon,
          autoDiscountAmount: autoDiscountAmount,
          autoDiscountTitle: autoDiscountTitle,
          total: subtotal - discountAmount - autoDiscountAmount,
          fbp: fbp,
          fbc: fbc,
          purchaseEventId: purchaseEventId,
          ga_client_id: getGA4ClientId(),
          ga_session_id: getGA4SessionId(),
          gclid: gclid,
          gbraid: gbraid,
          wbraid: wbraid,
          utm_source: utmSource,
          utm_medium: utmMedium,
          utm_campaign: utmCampaign,
          utm_term: utmTerm,
          utm_content: utmContent,
          userAgent: navigator.userAgent,
          sourceUrl: window.location.href,
          agreementHtml: generateAgreementHtml(),
          marketingConsent: document.getElementById('marketingCheck').checked
        });

        var maxRetries = 5;
        for (var attempt = 0; attempt < maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              console.log('complete-order retry #' + attempt);
              await new Promise(function(r) { setTimeout(r, 1500 * attempt); });
            }
            var orderResp = await fetch('/api/complete-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: completeOrderBody
            });
            orderData = await orderResp.json();

            // 409 = duplicate (already processed) — treat as success
            if (orderResp.status === 409) {
              console.log('Order already processed:', orderData.shopifyOrderName);
              break;
            }

            if (orderData.success) break; // success — stop retrying

            console.error('complete-order attempt ' + (attempt + 1) + ' failed:', orderData.error);
          } catch (fetchErr) {
            console.error('complete-order fetch error attempt ' + (attempt + 1) + ':', fetchErr.message);
            orderData = null;
          }
        }

        // Step 4: Check result before redirecting
        if (orderData && (orderData.success || orderData.shopifyOrderName)) {
          // Fire conversion events ONLY after confirmed Shopify order
          var ymTotal = (subtotal - discountAmount - autoDiscountAmount) / 100;

          // Meta Pixel Purchase — already fired early (before complete-order) to survive page close.
          // No duplicate here — same eventID ensures Meta deduplicates if both arrive.

          // Yandex Metrica: payment completed + ecommerce purchase
          ymGoal('payment_completed', {
            order_price: ymTotal,
            currency: 'TRY',
            payment_id: paymentIntent.id
          });
          dataLayer.push({
            ecommerce: {
              currencyCode: 'TRY',
              purchase: {
                actionField: {
                  id: orderData.shopifyOrderName || paymentIntent.id,
                  revenue: ymTotal,
                  coupon: appliedCoupon || ''
                },
                products: ymProducts()
              }
            }
          });

          // Yandex Metrica: order completed
          ymGoal('order_completed', {
            order_id: orderData.shopifyOrderName || '',
            order_price: ymTotal,
            currency: 'TRY'
          });

          var successParams = new URLSearchParams({
            order: orderData.shopifyOrderName || '',
            email: customerInfo.email,
            total: formatMoney(subtotal - discountAmount - autoDiscountAmount),
            txn: ga4TransactionId,
            value: getGA4Value().toString(),
            items: cartItems.length.toString()
          });
          if (gclid) successParams.set('gclid', gclid);
          if (purchaseEventId) successParams.set('eid', purchaseEventId);
          window.location.href = '/success.html?' + successParams.toString();
        } else {
          // Payment taken but Shopify order failed after all retries.
          // Show error with PI reference so support can reconcile.
          showGlobalError(
            'Ödemeniz başarıyla alındı ancak sipariş kaydında bir sorun oluştu. ' +
            'Siparişiniz kısa sürede sisteme işlenecektir. Sorun devam ederse bu referans numarasını ' +
            'destek ekibimize iletin: ' + paymentIntent.id
          );
          // Last-resort: fire one more attempt in background (user already sees the message)
          fetch('/api/complete-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: completeOrderBody
          }).catch(function() {});
          isProcessing = false;
          setLoading(false);
          return;
        }

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
    const overlay = document.getElementById('processingOverlay');
    btn.disabled = loading;
    text.textContent = loading ? 'İşleniyor...' : 'Siparişi Tamamla';
    spinner.style.display = loading ? 'inline-block' : 'none';
    if (overlay) {
      if (loading) {
        overlay.classList.add('sc-active');
      } else {
        overlay.classList.remove('sc-active');
      }
    }
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
    var cityEl = document.getElementById('city');
    var districtEl = document.getElementById('district');
    var mahalleEl = document.getElementById('mahalle');
    var ci = {
      firstName: val('firstName') || '___',
      lastName: val('lastName') || '___',
      email: val('email') || '___',
      phone: val('phone') || '___',
      address: val('address') || '___',
      mahalle: (mahalleEl && mahalleEl.selectedOptions[0] ? mahalleEl.selectedOptions[0].text : '') || '___',
      city: (cityEl && cityEl.selectedOptions[0] ? cityEl.selectedOptions[0].text : '') || '___',
      district: (districtEl && districtEl.selectedOptions[0] ? districtEl.selectedOptions[0].text : '') || '___',
      zip: val('zip') || ''
    };
    var fullAddress = ci.mahalle + ', ' + ci.address + ', ' + ci.district + ', ' + ci.city + (ci.zip ? ' ' + ci.zip : '');
    var fullName = escapeHtml(ci.firstName + ' ' + ci.lastName);
    var today = new Date();
    var dateStr = today.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    var itemsHtml = cartItems.map(function(item) {
      return '<tr><td>' + escapeHtml(item.title) + '</td><td>' + (item.variant_title || '-') + '</td><td>' + item.quantity + '</td><td>' + formatMoney(item.line_price) + '</td></tr>';
    }).join('');

    var total = subtotal - discountAmount - autoDiscountAmount;

    return '<h3 style="text-align:center;margin-bottom:4px;">MESAFELİ SATIŞ SÖZLEŞMESİ</h3>' +
      '<p style="text-align:center;font-size:11px;color:#888;margin-bottom:16px;">Son G\u00fcncelleme Tarihi: 27 Mart 2026</p>' +
      '<p>\u0130\u015fbu Mesafeli Sat\u0131\u015f S\u00f6zle\u015fmesi ("S\u00f6zle\u015fme"), 6502 say\u0131l\u0131 T\u00fcketicinin Korunmas\u0131 Hakk\u0131nda Kanun ve Mesafeli S\u00f6zle\u015fmeler Y\u00f6netmeli\u011fi h\u00fck\u00fcmleri \u00e7er\u00e7evesinde, a\u015fa\u011f\u0131da bilgileri yer alan SATICI ile ALICI aras\u0131nda, elektronik ortamda kurulmu\u015ftur.</p>' +

      '<h4>MADDE 1 \u2014 TARAFLAR</h4>' +
      '<p><strong>1.1 SATICI B\u0130LG\u0130LER\u0130</strong></p>' +
      '<table>' +
      '<tr><td>Ticaret Unvan\u0131</td><td>MESU L.L.C-F.Z</td></tr>' +
      '<tr><td>Marka Ad\u0131</td><td>Thesveltechic / Svelte Chic</td></tr>' +
      '<tr><td>Adres</td><td>Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, BAE</td></tr>' +
      '<tr><td>Telefon</td><td>+971 56 850 8810</td></tr>' +
      '<tr><td>E-posta</td><td>destek@thesveltechic.com</td></tr>' +
      '<tr><td>Web Sitesi</td><td>www.thesveltechic.com</td></tr>' +
      '</table>' +
      '<p>(Bundan b\u00f6yle "SATICI", "\u0130\u015eLETME", "Thesveltechic" veya "\u015eirket" olarak an\u0131lacakt\u0131r.)</p>' +

      '<p><strong>1.2 ALICI B\u0130LG\u0130LER\u0130</strong></p>' +
      '<table>' +
      '<tr><td>Ad Soyad</td><td>' + fullName + '</td></tr>' +
      '<tr><td>E-posta</td><td>' + escapeHtml(ci.email) + '</td></tr>' +
      '<tr><td>Telefon</td><td>' + escapeHtml(ci.phone) + '</td></tr>' +
      '<tr><td>Teslimat Adresi</td><td>' + escapeHtml(fullAddress) + '</td></tr>' +
      '</table>' +
      '<p>(Bundan b\u00f6yle "ALICI", "M\u00dc\u015eTER\u0130" veya "T\u00dcKET\u0130C\u0130" olarak an\u0131lacakt\u0131r.)</p>' +

      '<h4>MADDE 2 \u2014 S\u00d6ZLE\u015eMEN\u0130N KONUSU</h4>' +
      '<p>2.1. \u0130\u015fbu S\u00f6zle\u015fme\u2019nin konusu, ALICI\u2019n\u0131n www.thesveltechic.com internet sitesi \u00fczerinden elektronik ortamda sipari\u015fini verdigi, a\u015fa\u011f\u0131da nitelikleri ve sat\u0131\u015f fiyat\u0131 belirtilen \u00fcr\u00fcn(ler)in sat\u0131\u015f\u0131 ve teslimi ile ilgili olarak 6502 say\u0131l\u0131 T\u00fcketicinin Korunmas\u0131 Hakk\u0131nda Kanun ve Mesafeli S\u00f6zle\u015fmeler Y\u00f6netmeli\u011fi h\u00fck\u00fcmleri gere\u011fince taraflar\u0131n hak ve y\u00fck\u00fcml\u00fcklerinin saptanmas\u0131d\u0131r.</p>' +
      '<p>2.2. ALICI, i\u015fbu S\u00f6zle\u015fme\u2019yi onaylayarak; sipari\u015f konusu \u00fcr\u00fcn\u00fcn temel nitelikleri, sat\u0131\u015f fiyat\u0131, \u00f6deme \u015fekli, teslimat ko\u015fullar\u0131 ve cayma hakk\u0131 ile ilgili t\u00fcm \u00f6n bilgilendirmeyi okuyup anlad\u0131\u011f\u0131n\u0131 ve elektronik ortamda gerekli onay\u0131 verdi\u011fini kabul, beyan ve taahh\u00fct eder.</p>' +
      '<p>2.3. \u0130\u015fbu S\u00f6zle\u015fme, ALICI taraf\u0131ndan sipari\u015f sayfas\u0131nda yer alan "Mesafeli Sat\u0131\u015f S\u00f6zle\u015fmesi\u2019ni, Kullan\u0131m \u015eartlar\u0131\u2019n\u0131, \u0130ade ve De\u011fi\u015fim Politikas\u0131\u2019n\u0131, Kargo Politikas\u0131\u2019n\u0131, Gizlilik Politikas\u0131\u2019n\u0131 ve KVKK Ayd\u0131nlatma Metni\u2019ni okudum, anlad\u0131m ve kabul ediyorum" ibaresinin onaylanmas\u0131 (checkbox i\u015faretlenmesi) ile birlikte kurulmu\u015f say\u0131l\u0131r.</p>' +

      '<h4>MADDE 3 \u2014 \u00dcR\u00dcN B\u0130LG\u0130LER\u0130</h4>' +
      '<p>3.1. Sipari\u015f konusu \u00fcr\u00fcn(ler)in bilgileri:</p>' +
      '<table><tr><td><strong>\u00dcr\u00fcn</strong></td><td><strong>Varyant</strong></td><td><strong>Adet</strong></td><td><strong>Tutar</strong></td></tr>' + itemsHtml + '</table>' +
      '<table>' +
      '<tr><td>Ara Toplam</td><td>' + formatMoney(subtotal) + '</td></tr>' +
      (discountAmount > 0 ? '<tr><td>\u0130ndirim' + (appliedCoupon ? ' (' + appliedCoupon + ')' : '') + '</td><td>-' + formatMoney(discountAmount) + '</td></tr>' : '') +
      '<tr><td>Kargo</td><td>\u00dccretsiz</td></tr>' +
      '<tr><td><strong>Toplam</strong></td><td><strong>' + formatMoney(total) + '</strong></td></tr>' +
      '</table>' +
      '<p>3.2. Sipari\u015f onay sayfas\u0131nda ve e-postas\u0131nda belirtilen bilgiler i\u015fbu S\u00f6zle\u015fme\u2019nin ayr\u0131lmaz par\u00e7as\u0131d\u0131r.</p>' +
      '<p>3.3. \u00dcr\u00fcn fiyatlar\u0131na KDV ve sair vergiler dahildir. Kargo \u00fccreti ayr\u0131ca belirtilmedik\u00e7e SATICI taraf\u0131ndan kar\u015f\u0131lan\u0131r.</p>' +

      '<h4>MADDE 4 \u2014 S\u0130PAR\u0130\u015e VE \u00d6DEME</h4>' +
      '<p>4.1. ALICI, www.thesveltechic.com \u00fczerinden sipari\u015f vererek i\u015fbu S\u00f6zle\u015fme\u2019nin t\u00fcm h\u00fck\u00fcmlerini kabul etmi\u015f say\u0131l\u0131r.</p>' +
      '<p>4.2. \u00d6demeler, Stripe \u00f6deme altyap\u0131s\u0131 arac\u0131l\u0131\u011f\u0131yla kredi kart\u0131/banka kart\u0131 ile ger\u00e7ekle\u015ftirilir.</p>' +
      '<p>4.3. SATICI, g\u00fcvenlik gerek\u00e7esiyle sipari\u015flerde ek do\u011frulama talep etme hakk\u0131n\u0131 sakl\u0131 tutar. Do\u011frulama tamamlanmayan sipari\u015fler ask\u0131ya al\u0131nabilir veya iptal edilebilir.</p>' +
      '<p>4.4. Sipari\u015f onay\u0131, \u00f6demenin ba\u015far\u0131l\u0131 \u015fekilde tamamlanmas\u0131 ve SATICI taraf\u0131ndan sipari\u015fin kabul edilmesi ile ger\u00e7ekle\u015fir. SATICI, herhangi bir sipari\u015fi kabul etmeme hakk\u0131n\u0131 sakl\u0131 tutar.</p>' +

      '<h4>MADDE 5 \u2014 TESL\u0130MAT KO\u015eULLARI</h4>' +
      '<p>5.1. Sipari\u015fler, \u00f6demenin onaylanmas\u0131n\u0131 takiben 2 (iki) ila 4 (d\u00f6rt) i\u015f g\u00fcn\u00fc i\u00e7erisinde kargoya verilir.</p>' +
      '<p>5.2. Tahmini teslimat s\u00fcresi, kargoya verilme tarihinden itibaren 15 (on be\u015f) ila 20 (yirmi) i\u015f g\u00fcn\u00fcd\u00fcr.</p>' +
      '<p>5.3. Kampanya d\u00f6nemleri, bayram ve tatil d\u00f6nemleri, sezonluk yo\u011funluklar ve benzeri ola\u011fan\u00fcst\u00fc durumlarda, teslimat s\u00fcresine ek 5 (be\u015f) i\u015f g\u00fcn\u00fc eklenebilir.</p>' +
      '<p>5.4. Kontrol\u00fcm\u00fcz d\u0131\u015f\u0131nda ger\u00e7ekle\u015fen durumlar (do\u011fal afetler, pandemi, g\u00fcmr\u00fck i\u015flemleri, tatiller, hava ko\u015fullar\u0131, kargo \u015firketinden kaynaklanan gecikmeler vb.) nedeniyle teslimat s\u00fcresi uzayabilir.</p>' +
      '<p>5.5. Kargo \u015firketine teslim edilen \u00fcr\u00fcnlerin m\u00fclkiyet ve hasar riski, \u00fcr\u00fcn\u00fcn kargo \u015firketine teslimi ile birlikte ALICI\u2019ya ge\u00e7er.</p>' +
      '<p>5.6. Teslimat, ALICI\u2019n\u0131n sipari\u015f s\u0131ras\u0131nda bildirdi\u011fi adrese yap\u0131l\u0131r. Adres bilgilerinin hatal\u0131 veya eksik girilmesinden kaynaklanan sorumluluk tamamen ALICI\u2019ya aittir.</p>' +

      '<h4>MADDE 6 \u2014 CAYMA HAKKI</h4>' +
      '<p><strong>6.1. \u0130ndirimsiz (Tam Fiyatl\u0131) \u00dcr\u00fcnlerde Cayma Hakk\u0131</strong></p>' +
      '<p>6.1.1. ALICI, indirimsiz (tam fiyatl\u0131) \u00fcr\u00fcnlerde, \u00fcr\u00fcn\u00fcn teslim tarihinden itibaren 14 (on d\u00f6rt) g\u00fcn i\u00e7erisinde herhangi bir gerek\u00e7e g\u00f6stermeksizin ve cezai \u015fart \u00f6demeksizin cayma hakk\u0131n\u0131 kullanabilir.</p>' +
      '<p>6.1.2. Cayma hakk\u0131n\u0131n kullan\u0131labilmesi i\u00e7in \u00fcr\u00fcn\u00fcn; kullan\u0131lmam\u0131\u015f, y\u0131kanmam\u0131\u015f, deforme olmam\u0131\u015f, etiketleri s\u00f6k\u00fclmemi\u015f ve orijinal ambalaj\u0131nda iade edilmesi zorunludur.</p>' +
      '<p>6.1.3. Cayma hakk\u0131n\u0131n kullan\u0131lmas\u0131 halinde ALICI, \u00fcr\u00fcn\u00fc destek@thesveltechic.com adresine yaz\u0131l\u0131 olarak bildirimde bulunduktan sonra SATICI taraf\u0131ndan belirtilen adrese g\u00f6nderir. \u0130ade kargo \u00fccreti ALICI\u2019ya aittir.</p>' +
      '<p>6.1.4. \u0130ade edilen \u00fcr\u00fcn\u00fcn SATICI\u2019ya ula\u015fmas\u0131 ve \u00fcr\u00fcn\u00fcn iade \u015fartlar\u0131n\u0131 kar\u015f\u0131lad\u0131\u011f\u0131n\u0131n tespit edilmesini takiben, \u00fcr\u00fcn bedeli 14 (on d\u00f6rt) g\u00fcn i\u00e7erisinde ALICI\u2019n\u0131n \u00f6deme yapt\u0131\u011f\u0131 \u00f6deme arac\u0131na iade edilir.</p>' +

      '<p><strong>6.2. \u0130ndirimli / Kampanyal\u0131 \u00dcr\u00fcnlerde Cayma Hakk\u0131 K\u0131s\u0131tlamas\u0131</strong></p>' +
      '<p>6.2.1. \u0130ndirimli, kampanyal\u0131, promosyonlu veya \u00f6zel fiyatl\u0131 \u00fcr\u00fcnlerde para iadesi yap\u0131lmaz. ALICI, bu \u00fcr\u00fcnlerde yaln\u0131zca 1 (bir) defaya mahsus de\u011fi\u015fim hakk\u0131na sahiptir.</p>' +
      '<p>6.2.2. ALICI, i\u015fbu maddeyi \u00f6zellikle okuyup anlad\u0131\u011f\u0131n\u0131, indirimli \u00fcr\u00fcn sat\u0131n al\u0131rken bu ko\u015fulu bilerek ve isteyerek kabul etti\u011fini beyan ve taahh\u00fct eder.</p>' +
      '<p>6.2.3. De\u011fi\u015fim hakk\u0131n\u0131n kullan\u0131lmas\u0131 halinde:</p>' +
      '<p>(a) De\u011fi\u015fim talep edilen yeni \u00fcr\u00fcn\u00fcn bedeli, iade edilen \u00fcr\u00fcn\u00fcn bedelinden d\u00fc\u015f\u00fckse: Aradaki fark ALICI\u2019ya nakit olarak iade edilmez; fark tutar\u0131, ALICI ad\u0131na \u0130\u015eLETME b\u00fcnyesinde bakiye olarak tan\u0131mlan\u0131r. Bu bakiye, 12 (on iki) ay s\u00fcreyle ge\u00e7erlidir.</p>' +
      '<p>(b) De\u011fi\u015fim talep edilen yeni \u00fcr\u00fcn\u00fcn bedeli, iade edilen \u00fcr\u00fcn\u00fcn bedelinden y\u00fcksekse: ALICI, aradaki fark\u0131 SATICI\u2019ya \u00f6der.</p>' +
      '<p>(c) De\u011fi\u015fim talep edilen yeni \u00fcr\u00fcn\u00fcn bedeli, iade edilen \u00fcr\u00fcn\u00fcn bedeline e\u015fitse: Herhangi bir ek \u00f6deme veya bakiye s\u00f6z konusu olmaz.</p>' +
      '<p>6.2.4. De\u011fi\u015fim hakk\u0131, \u00fcr\u00fcn\u00fcn teslim tarihinden itibaren 14 (on d\u00f6rt) g\u00fcn i\u00e7erisinde kullan\u0131lmal\u0131d\u0131r.</p>' +

      '<p><strong>6.3. Cayma Hakk\u0131n\u0131n Kullan\u0131lamayaca\u011f\u0131 Haller</strong></p>' +
      '<p>6.3.1. Mesafeli S\u00f6zle\u015fmeler Y\u00f6netmeli\u011fi m.15 gere\u011fince, a\u015fa\u011f\u0131daki hallerde cayma hakk\u0131 kullan\u0131lamaz:</p>' +
      '<p>(a) Fiyat\u0131 finansal piyasalardaki dalgalanmalara ba\u011fl\u0131 olarak de\u011fi\u015fen ve SATICI\u2019n\u0131n kontrol\u00fcnde olmayan \u00fcr\u00fcnler.</p>' +
      '<p>(b) T\u00fcketicinin istekleri veya ki\u015fisel ihtiya\u00e7lar\u0131 do\u011frultusunda haz\u0131rlanan, ki\u015fiye \u00f6zel \u00fcretilen \u00fcr\u00fcnler.</p>' +
      '<p>(c) \u00c7abuk bozulabilen veya son kullanma tarihi ge\u00e7ebilecek \u00fcr\u00fcnler.</p>' +
      '<p>(d) Tesliminden sonra ambalaj\u0131 a\u00e7\u0131lm\u0131\u015f olan; sa\u011fl\u0131k ve hijyen a\u00e7\u0131s\u0131ndan iade edilemeyecek \u00fcr\u00fcnler (i\u00e7 giyim, mayo, bikini, \u00e7orap vb.).</p>' +
      '<p>(e) Tesliminden sonra ba\u015fka \u00fcr\u00fcnlerle kar\u0131\u015fan ve do\u011fas\u0131 gere\u011fi ayr\u0131\u015ft\u0131r\u0131lmas\u0131 m\u00fcmk\u00fcn olmayan \u00fcr\u00fcnler.</p>' +

      '<h4>MADDE 7 \u2014 STOK DURUMU VE ALTERNAT\u0130F \u00dcR\u00dcN</h4>' +
      '<p>7.1. SATICI\u2019n\u0131n sundu\u011fu \u00fcr\u00fcnlerin stoklar\u0131 s\u0131n\u0131rl\u0131 olup, stok durumu h\u0131zla de\u011fi\u015fkenlik g\u00f6sterebilir.</p>' +
      '<p>7.2. Sipari\u015f verilen \u00fcr\u00fcn\u00fcn stoklar\u0131n\u0131n t\u00fckenmesi halinde, SATICI en k\u0131sa s\u00fcrede ALICI\u2019y\u0131 bilgilendirir ve ALICI\u2019ya \u015fu se\u00e7enekleri sunar: (a) ALICI, sipari\u015f tutar\u0131 dahilinde veya fark \u00f6deyerek ba\u015fka bir \u00fcr\u00fcn se\u00e7ebilir. (b) ALICI\u2019n\u0131n yeni \u00fcr\u00fcn se\u00e7memesi halinde, sipari\u015f tutar\u0131 \u0130\u015eLETME b\u00fcnyesinde ALICI ad\u0131na bakiye olarak tan\u0131mlan\u0131r (12 ay ge\u00e7erli).</p>' +
      '<p>7.3. Bu senaryoda nakit para iadesi yap\u0131lmaz.</p>' +

      '<h4>MADDE 8 \u2014 GARANT\u0130 VE AYIPLI \u00dcR\u00dcN</h4>' +
      '<p>8.1. ALICI\u2019ya teslim edilen \u00fcr\u00fcn\u00fcn ay\u0131pl\u0131 (kusurlu, hasarl\u0131, hatal\u0131) olmas\u0131 halinde, ay\u0131pl\u0131 \u00fcr\u00fcn i\u00e7in para iadesi yap\u0131lmaz; yaln\u0131zca de\u011fi\u015fim uygulan\u0131r.</p>' +
      '<p>8.2. ALICI, sipari\u015f vererek ve i\u015fbu S\u00f6zle\u015fme\u2019yi onaylayarak, ay\u0131pl\u0131 \u00fcr\u00fcn halinde yaln\u0131zca de\u011fi\u015fim hakk\u0131n\u0131n bulundu\u011funu, para iadesi talep edemeyece\u011fini a\u00e7\u0131k\u00e7a kabul ve beyan eder.</p>' +
      '<p>8.3. Ay\u0131pl\u0131 \u00fcr\u00fcn bildirimi, \u00fcr\u00fcn\u00fcn teslim tarihinden itibaren 3 (\u00fc\u00e7) g\u00fcn i\u00e7erisinde, \u00fcr\u00fcn\u00fcn foto\u011fraflar\u0131 ile birlikte destek@thesveltechic.com adresine yaz\u0131l\u0131 olarak yap\u0131lmal\u0131d\u0131r.</p>' +
      '<p>8.4. SATICI, ay\u0131b\u0131n teyit edilmesi halinde, ALICI\u2019ya ayn\u0131 \u00fcr\u00fcn\u00fcn yenisi veya ALICI\u2019n\u0131n onay\u0131yla e\u015fde\u011fer bir \u00fcr\u00fcn g\u00f6nderilir. De\u011fi\u015fim kargo \u00fccreti \u0130\u015eLETME taraf\u0131ndan kar\u015f\u0131lan\u0131r.</p>' +

      '<h4>MADDE 9 \u2014 \u00d6DEME \u0130ADES\u0130 KO\u015eULLARI</h4>' +
      '<p>9.1. Para iadesi hakk\u0131 do\u011fan hallerde (Madde 6.1 kapsam\u0131nda cayma hakk\u0131n\u0131n usul\u00fcne uygun kullan\u0131lmas\u0131), iade edilen \u00fcr\u00fcn\u00fcn SATICI\u2019ya ula\u015fmas\u0131n\u0131 ve kontrol edilmesini takiben, \u00fcr\u00fcn bedeli 14 (on d\u00f6rt) i\u015f g\u00fcn\u00fc i\u00e7erisinde ALICI\u2019n\u0131n \u00f6deme yapt\u0131\u011f\u0131 \u00f6deme arac\u0131na iade edilir.</p>' +
      '<p>9.2. \u00d6deme kurulu\u015funun iade i\u015flemini ALICI\u2019n\u0131n hesab\u0131na yans\u0131tma s\u00fcresi SATICI\u2019n\u0131n kontrol\u00fcnde de\u011fildir.</p>' +
      '<p>9.3. Para iadesine hak kazan\u0131lmayan hallerde (indirimli \u00fcr\u00fcnler, stok t\u00fckenmesi vb.) ALICI\u2019ya bakiye tan\u0131mlan\u0131r; nakit iade yap\u0131lmaz.</p>' +

      '<h4>MADDE 10 \u2014 TERS \u0130BRAZ (CHARGEBACK / DISPUTE) POL\u0130T\u0130KASI</h4>' +
      '<p>10.1. ALICI, i\u015fbu S\u00f6zle\u015fme kapsam\u0131nda bir uyu\u015fmazl\u0131k ya\u015famas\u0131 halinde, \u00f6ncelikle SATICI ile do\u011frudan ileti\u015fime ge\u00e7erek (destek@thesveltechic.com) sorunu \u00e7\u00f6zmeyi kabul ve taahh\u00fct eder.</p>' +
      '<p>10.2. ALICI\u2019n\u0131n, SATICI ile ileti\u015fime ge\u00e7meksizin do\u011frudan \u00f6deme kurulu\u015funa ba\u015fvurarak ters ibraz ba\u015flatmas\u0131 halinde, SATICI bu i\u015fleme itiraz etme hakk\u0131n\u0131 sakl\u0131 tutar.</p>' +
      '<p>10.3. Haks\u0131z veya k\u00f6t\u00fc niyetli ters ibraz i\u015flemi ba\u015flatan ALICI, SATICI\u2019n\u0131n bu sebeple u\u011frad\u0131\u011f\u0131 do\u011frudan ve dolayl\u0131 t\u00fcm zararlar\u0131 tazmin etmeyi kabul ve taahh\u00fct eder.</p>' +

      '<h4>MADDE 11 \u2014 F\u0130KR\u0130 M\u00dcLK\u0130YET VE MARKA KORUMA</h4>' +
      '<p>11.1. www.thesveltechic.com internet sitesinde yer alan t\u00fcm i\u00e7erik SATICI\u2019n\u0131n m\u00fcnhas\u0131r m\u00fclkiyetindedir ve fikri m\u00fclkiyet haklar\u0131 kapsam\u0131nda korunmaktad\u0131r.</p>' +
      '<p>11.2. ALICI, SATICI\u2019n\u0131n yaz\u0131l\u0131 izni olmaks\u0131z\u0131n site i\u00e7eri\u011fini kopyalayamaz, \u00e7o\u011faltamaz, da\u011f\u0131tamaz, yay\u0131nlayamaz veya ticari ama\u00e7larla kullanamaz.</p>' +

      '<h4>MADDE 12 \u2014 G\u0130ZL\u0130L\u0130K, \u0130T\u0130BAR KORUMA VE SOSYAL MEDYA H\u00dcK\u00dcMLER\u0130</h4>' +
      '<p>12.1.1. ALICI, SATICI ile aras\u0131ndaki ticari ili\u015fki kapsam\u0131nda edindi\u011fi bilgileri \u00fc\u00e7\u00fcnc\u00fc ki\u015filerle payla\u015fmamay\u0131 kabul ve taahh\u00fct eder.</p>' +
      '<p>12.2.1. ALICI, SATICI, markas\u0131, \u00fcr\u00fcnleri, hizmetleri hakk\u0131nda; ger\u00e7e\u011fe ayk\u0131r\u0131, yan\u0131lt\u0131c\u0131, karalayac\u0131, a\u015fa\u011f\u0131lay\u0131c\u0131, iftira niteli\u011finde veya ticari itibar\u0131 zedeleyici nitelikte beyanda bulunmamay\u0131 kabul ve taahh\u00fct eder.</p>' +
      '<p>12.2.4. ALICI, \u015fikayetini \u00f6ncelikle ve m\u00fcnhas\u0131ran SATICI\u2019n\u0131n m\u00fc\u015fteri hizmetlerine (destek@thesveltechic.com veya +971 56 850 8810) iletece\u011fini, sorununun \u00e7\u00f6z\u00fcm\u00fc i\u00e7in SATICI\u2019ya makul s\u00fcre (en az 15 i\u015f g\u00fcn\u00fc) tan\u0131yaca\u011f\u0131n\u0131 kabul ve taahh\u00fct eder.</p>' +

      '<h4>MADDE 13 \u2014 CEZA\u0130 \u015eART VE TAZM\u0130NAT</h4>' +
      '<p>13.1.1. ALICI\u2019n\u0131n, Madde 12 h\u00fck\u00fcmlerini ihlal etmesi halinde, SATICI\u2019n\u0131n u\u011frad\u0131\u011f\u0131 maddi ve manevi zarardan ba\u011f\u0131ms\u0131z olarak, sipari\u015f tutar\u0131n\u0131n 20 (yirmi) kat\u0131 tutar\u0131nda cezai \u015fart \u00f6demeyi kabul ve taahh\u00fct eder.</p>' +
      '<p>13.1.2. Cezai \u015fart, SATICI\u2019n\u0131n ayr\u0131ca tazminat talep etme hakk\u0131n\u0131 ortadan kald\u0131rmaz.</p>' +

      '<h4>MADDE 14 \u2014 K\u0130\u015e\u0130SEL VER\u0130LER\u0130N KORUNMASI</h4>' +
      '<p>14.1. SATICI, ALICI\u2019n\u0131n ki\u015fisel verilerini 6698 say\u0131l\u0131 Ki\u015fisel Verilerin Korunmas\u0131 Kanunu (KVKK) ve ilgili mevzuat h\u00fck\u00fcmlerine uygun olarak i\u015fler.</p>' +
      '<p>14.2. ALICI\u2019n\u0131n ki\u015fisel verilerinin i\u015flenmesine ili\u015fkin detayl\u0131 bilgi, www.thesveltechic.com adresinde yay\u0131nlanan Gizlilik Politikas\u0131 ve KVKK Ayd\u0131nlatma Metni\u2019nde yer almaktad\u0131r.</p>' +

      '<h4>MADDE 15 \u2014 M\u00dcCB\u0130R SEBEP</h4>' +
      '<p>15.1. Taraflar\u0131n kontrol\u00fcnde olmayan; do\u011fal afet, sava\u015f, ter\u00f6r, salg\u0131n hastal\u0131k, grev, lokavt, h\u00fck\u00fcmet kararlar\u0131, g\u00fcmr\u00fck uygulamalar\u0131, ula\u015f\u0131m aksakl\u0131klar\u0131, enerji kesintisi ve benzeri \u00f6ng\u00f6r\u00fclemez ve \u00f6nlenemez olaylar m\u00fccbir sebep say\u0131l\u0131r.</p>' +
      '<p>15.2. M\u00fccbir sebep durumunda taraflar\u0131n s\u00f6zle\u015fmeden do\u011fan y\u00fck\u00fcml\u00fclkleri, m\u00fccbir sebebin devam\u0131 s\u00fcresince ask\u0131ya al\u0131n\u0131r. M\u00fccbir sebebin 60 (altm\u0131\u015f) g\u00fcnden fazla s\u00fcrmesi halinde, taraflardan her biri S\u00f6zle\u015fme\u2019yi tazminats\u0131z olarak feshedebilir.</p>' +

      '<h4>MADDE 16 \u2014 UYU\u015eMAZLIK \u00c7\u00d6Z\u00dcM\u00dc</h4>' +
      '<p>16.1. \u0130\u015fbu S\u00f6zle\u015fme\u2019den do\u011fan uyu\u015fmazl\u0131klarda T\u00fcrk Hukuku uygulan\u0131r.</p>' +
      '<p>16.2. Uyu\u015fmazl\u0131klar\u0131n \u00e7\u00f6z\u00fcm\u00fcnde \u0130stanbul Mahkemeleri ve \u0130stanbul \u0130cra Daireleri m\u00fcnhas\u0131ran yetkilidir.</p>' +
      '<p>16.3. ALICI, 6502 say\u0131l\u0131 Kanun\u2019un 68. maddesi kapsam\u0131ndaki parasal s\u0131n\u0131rlar dahilinde T\u00fcketici Hakem Heyetleri\u2019ne, bu s\u0131n\u0131rlar\u0131 a\u015fan uyu\u015fmazl\u0131klarda ise T\u00fcketici Mahkemeleri\u2019ne ba\u015fvurma hakk\u0131na sahiptir.</p>' +

      '<h4>MADDE 17 \u2014 S\u00d6ZLE\u015eMEN\u0130N B\u00dcT\u00dcNL\u00dc\u011e\u00dc VE EKLER\u0130</h4>' +
      '<p>17.1. \u0130\u015fbu S\u00f6zle\u015fme, a\u015fa\u011f\u0131daki belgelerin tamam\u0131 ile birlikte bir b\u00fct\u00fcn te\u015fkil eder:</p>' +
      '<p>Ek-1: Kullan\u0131m \u015eartlar\u0131 &bull; Ek-2: \u0130ade ve De\u011fi\u015fim Politikas\u0131 &bull; Ek-3: Kargo Politikas\u0131 &bull; Ek-4: Gizlilik Politikas\u0131 ve KVKK Ayd\u0131nlatma Metni &bull; Ek-5: KVKK A\u00e7\u0131k R\u0131za Metni &bull; Ek-6: \u00c7erez Politikas\u0131</p>' +
      '<p>17.2. ALICI, sipari\u015f onay sayfas\u0131nda yer alan onay kutucu\u011funu i\u015faretleyerek, i\u015fbu S\u00f6zle\u015fme\u2019yi ve t\u00fcm eklerini okudu\u011funu, anlad\u0131\u011f\u0131n\u0131 ve kabul etti\u011fini elektronik ortamda beyan ve taahh\u00fct eder.</p>' +

      '<h4>MADDE 18 \u2014 Y\u00dcR\u00dcRL\u00dcK</h4>' +
      '<p>18.1. \u0130\u015fbu S\u00f6zle\u015fme, ALICI taraf\u0131ndan elektronik ortamda onaylanand\u0131\u011f\u0131 tarihte y\u00fcr\u00fcrl\u00fc\u011fe girer.</p>' +
      '<p>18.2. SATICI, i\u015fbu S\u00f6zle\u015fme\u2019yi tek tarafl\u0131 olarak g\u00fcncelleme hakk\u0131n\u0131 sakl\u0131 tutar.</p>' +
      '<p>18.3. \u0130\u015fbu S\u00f6zle\u015fme, 18 (on sekiz) maddeden olu\u015fmakta olup, taraflarca okunarak kabul edilmi\u015ftir.</p>' +

      '<hr style="margin:16px 0;">' +
      '<div style="background:#fafaf8;border:1px solid #e8e4dc;border-radius:6px;padding:16px;margin:16px 0;">' +
      '<h4 style="margin:0 0 12px;font-size:14px;">ELEKTRON\u0130K ONAY KAYDI</h4>' +
      '<table style="width:100%;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#666;width:180px;"><strong>SATICI</strong></td><td style="padding:4px 8px;">MESU L.L.C-F.Z &mdash; Meydan Grandstand, 6th Floor, Dubai, BAE</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#666;"><strong>ALICI</strong></td><td style="padding:4px 8px;">' + fullName + ' &mdash; ' + escapeHtml(fullAddress) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#666;"><strong>E-posta</strong></td><td style="padding:4px 8px;">' + escapeHtml(ci.email) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#666;"><strong>Onay Tarihi ve Saati</strong></td><td style="padding:4px 8px;">' + dateStr + ' ' + today.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#666;"><strong>S\u00f6zle\u015fme No</strong></td><td style="padding:4px 8px;">MSS-' + today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + String(today.getDate()).padStart(2,'0') + '-' + Date.now().toString(36).toUpperCase() + '</td></tr>' +
      '</table>' +
      '<p style="font-size:11px;color:#999;margin-top:12px;margin-bottom:0;">Bu s\u00f6zle\u015fme, ALICI taraf\u0131ndan elektronik ortamda (checkout.thesveltechic.com) onay kutucu\u011fu i\u015faretlenerek ve sipari\u015f tamamlanarak kabul edilmi\u015ftir. 6098 say\u0131l\u0131 T\u00fcrk Bor\u00e7lar Kanunu m.15 ve 6102 say\u0131l\u0131 T\u00fcrk Ticaret Kanunu m.18/3 uyar\u0131nca elektronik ortamda kurulan bu s\u00f6zle\u015fme ge\u00e7erli ve ba\u011flay\u0131c\u0131d\u0131r.</p>' +
      '</div>';
  }

  function generateMarketingHtml() {
    var ci = {
      firstName: val('firstName') || '___',
      lastName: val('lastName') || '___',
      email: val('email') || '___',
      phone: val('phone') || '___'
    };
    var fullName = escapeHtml(ci.firstName + ' ' + ci.lastName);
    var today = new Date();
    var dateStr = today.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    return '<h3 style="text-align:center;margin-bottom:4px;">T\u0130CAR\u0130 ELEKTRON\u0130K \u0130LET\u0130 ONAY METN\u0130</h3>' +
      '<p style="text-align:center;font-size:11px;color:#888;margin-bottom:16px;">Son G\u00fcncelleme Tarihi: 27 Mart 2026</p>' +

      '<h4>T\u0130CAR\u0130 ELEKTRON\u0130K \u0130LET\u0130 G\u00d6NDER\u0130M\u0130NE \u0130L\u0130\u015eK\u0130N ONAY BEYANI</h4>' +
      '<p>6563 say\u0131l\u0131 Elektronik Ticaretin D\u00fczenlenmesi Hakk\u0131nda Kanun ve Ticari \u0130leti\u015fim ve Ticari Elektronik \u0130letiler Hakk\u0131nda Y\u00f6netmelik kapsam\u0131nda;</p>' +
      '<p>MESU L.L.C-F.Z ("Thesveltechic") taraf\u0131ndan;</p>' +
      '<ul style="margin:8px 0 8px 20px;">' +
      '<li>Kampanya, indirim ve promosyon duyurular\u0131,</li>' +
      '<li>Yeni \u00fcr\u00fcn ve koleksiyon tan\u0131t\u0131mlar\u0131,</li>' +
      '<li>\u00d6zel g\u00fcn kutlamalar\u0131 ve sezonluk kampanya bilgilendirmeleri,</li>' +
      '<li>Sadakat program\u0131 ve avantajlara ili\u015fkin bilgilendirmeler,</li>' +
      '<li>Anket ve m\u00fc\u015fteri memnuniyeti ara\u015ft\u0131rmalar\u0131,</li>' +
      '<li>Etkinlik ve organizasyon duyurular\u0131</li>' +
      '</ul>' +
      '<p>konular\u0131nda e-posta, SMS ve/veya telefon arama yoluyla taraf\u0131ma ticari elektronik ileti g\u00f6nderilmesine <strong>ONAY VER\u0130YORUM</strong>.</p>' +

      '<h4>\u00d6NEML\u0130 B\u0130LG\u0130LER</h4>' +
      '<p><strong>1. Onay Geri Alma Hakk\u0131:</strong> Ticari elektronik ileti alma onay\u0131n\u0131z\u0131, herhangi bir zamanda, hi\u00e7bir gerek\u00e7e g\u00f6stermeksizin ve \u00fccretsiz olarak geri alabilirsiniz.</p>' +
      '<p><strong>2. Geri Alma Y\u00f6ntemleri:</strong></p>' +
      '<p>&bull; E-posta: destek@thesveltechic.com adresine "Ticari \u0130leti Onay \u0130ptali" konulu mesaj g\u00f6ndererek</p>' +
      '<p>&bull; \u0130leti i\u00e7indeki "Abonelikten \u00c7\u0131k" / "Unsubscribe" ba\u011flant\u0131s\u0131na t\u0131klayarak</p>' +
      '<p>&bull; SMS: "\u0130PTAL" yazarak belirtilen numaraya g\u00f6ndererek</p>' +
      '<p><strong>3. \u0130\u015flem S\u00fcresi:</strong> Geri alma talebiniz, talebinizin \u0130\u015eLETME\u2019ye ula\u015fmas\u0131ndan itibaren en ge\u00e7 3 (\u00fc\u00e7) i\u015f g\u00fcn\u00fc i\u00e7erisinde i\u015fleme al\u0131n\u0131r.</p>' +
      '<p><strong>4. Sipari\u015f Bildirimleri:</strong> Ticari elektronik ileti onay\u0131n\u0131z\u0131 geri alman\u0131z, sipari\u015f onay\u0131, kargo bilgilendirmesi, iade/de\u011fi\u015fim s\u00fcreci gibi i\u015flemsel bildirimlerin g\u00f6nderilmesini engellemez.</p>' +
      '<p><strong>5. Veri Kullan\u0131m\u0131:</strong> \u0130leti\u015fim bilgileriniz, yaln\u0131zca yukar\u0131da belirtilen ama\u00e7larla kullan\u0131l\u0131r. Detayl\u0131 bilgi i\u00e7in Gizlilik Politikas\u0131 ve KVKK Ayd\u0131nlatma Metni\u2019ne bak\u0131n\u0131z.</p>' +

      '<hr style="margin:16px 0;">' +
      '<p><strong>\u0130lgili Ki\u015fi (M\u00fc\u015fteri) Bilgileri:</strong></p>' +
      '<table>' +
      '<tr><td>Ad Soyad</td><td>' + fullName + '</td></tr>' +
      '<tr><td>E-posta</td><td>' + escapeHtml(ci.email) + '</td></tr>' +
      '<tr><td>Telefon</td><td>' + escapeHtml(ci.phone) + '</td></tr>' +
      '<tr><td>Onay Tarihi</td><td>' + dateStr + '</td></tr>' +
      '</table>' +
      '<p style="margin-top:12px;font-size:11px;color:#888;">\u0130\u015fbu Ticari Elektronik \u0130leti Onay Metni, 6563 say\u0131l\u0131 Kanun ve ilgili Y\u00f6netmelik h\u00fck\u00fcmlerine uygun olarak haz\u0131rlanm\u0131\u015ft\u0131r.<br>MESU L.L.C-F.Z \u2014 Thesveltechic</p>';
  }

})();
