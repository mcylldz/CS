/* ========================================
   Netlify Function: process-order-agreement

   Shopify webhook handler: orders/create
   - Reads cart attributes (mesafeli_sozlesme_kabul, sozlesme_zaman_damgasi, sozlesme_no)
     from order.note_attributes
   - Generates the full Mesafeli Satış Sözleşmesi HTML using order data
   - Saves to order metafield: namespace=checkout, key=mesafeli_satis_sozlesmesi
   - Idempotent: if metafield already exists, skips

   Shopify webhook setup:
   - Settings → Notifications → Webhooks
   - Event: Order creation
   - Format: JSON
   - URL: https://checkout.thesveltechic.com/api/process-order-agreement
   - Webhook signing secret → SHOPIFY_WEBHOOK_SECRET in Netlify env
   ======================================== */

const crypto = require('crypto');
const { shopifyRequest } = require('./shopify-auth');

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoneyTRY(amountStr) {
  // Shopify sends prices as strings like "1299.00"
  var n = parseFloat(amountStr);
  if (isNaN(n)) return '0,00 TL';
  return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
}

function getNoteAttr(order, name) {
  if (!order || !order.note_attributes) return '';
  var na = order.note_attributes.find(function(a) { return a.name === name; });
  return na ? na.value : '';
}

function verifyWebhook(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  if (!hmacHeader) return false;
  var generated = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmacHeader));
  } catch (e) {
    return false;
  }
}

function buildAgreementHtml(order, agreementMeta) {
  var billing = order.billing_address || order.shipping_address || {};
  var shipping = order.shipping_address || order.billing_address || {};
  var firstName = order.customer && order.customer.first_name || shipping.first_name || '___';
  var lastName = order.customer && order.customer.last_name || shipping.last_name || '___';
  var email = order.email || (order.customer && order.customer.email) || '___';
  var phone = order.phone || shipping.phone || (order.customer && order.customer.phone) || '___';

  var fullName = escapeHtml(firstName + ' ' + lastName);
  var fullAddress = [shipping.address1, shipping.address2, shipping.city, shipping.province, shipping.zip, shipping.country]
    .filter(function(p) { return p; }).join(', ');
  var fullAddressEsc = escapeHtml(fullAddress);

  var ts = agreementMeta.timestamp || order.created_at || new Date().toISOString();
  var d = new Date(ts);
  var dateStr = d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  var timeStr = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  var agreementId = agreementMeta.id || ('MSS-' + d.getFullYear() +
    '-' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
    '-' + Date.now().toString(36).toUpperCase());

  var lineItems = order.line_items || [];
  var itemsHtml = lineItems.map(function(li) {
    var variant = li.variant_title || '-';
    var lineTotal = parseFloat(li.price) * li.quantity;
    return '<tr><td>' + escapeHtml(li.title) + '</td><td>' + escapeHtml(variant) +
      '</td><td>' + li.quantity + '</td><td>' + formatMoneyTRY(lineTotal.toFixed(2)) + '</td></tr>';
  }).join('');

  var subtotal = parseFloat(order.subtotal_price || '0');
  var totalDiscount = parseFloat(order.total_discounts || '0');
  var totalShipping = (order.shipping_lines || []).reduce(function(acc, sl) {
    return acc + parseFloat(sl.price || '0');
  }, 0);
  var grandTotal = parseFloat(order.total_price || '0');

  var discountCodes = (order.discount_codes || []).map(function(d) { return d.code; }).filter(Boolean).join(', ');

  return '<h3 style="text-align:center;margin-bottom:4px;">MESAFELİ SATIŞ SÖZLEŞMESİ</h3>' +
    '<p style="text-align:center;font-size:11px;color:#888;margin-bottom:16px;">Son Güncelleme Tarihi: 27 Mart 2026</p>' +
    '<p>İşbu Mesafeli Satış Sözleşmesi ("Sözleşme"), 6502 sayılı Tüketicinin Korunması Hakkında Kanun ve Mesafeli Sözleşmeler Yönetmeliği hükümleri çerçevesinde, aşağıda bilgileri yer alan SATICI ile ALICI arasında, elektronik ortamda kurulmuştur.</p>' +

    '<h4>MADDE 1 — TARAFLAR</h4>' +
    '<p><strong>1.1 SATICI BİLGİLERİ</strong></p>' +
    '<table>' +
    '<tr><td>Ticaret Unvanı</td><td>MESU L.L.C-F.Z</td></tr>' +
    '<tr><td>Marka Adı</td><td>Thesveltechic / Svelte Chic</td></tr>' +
    '<tr><td>Adres</td><td>Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, BAE</td></tr>' +
    '<tr><td>Telefon</td><td>+971 56 850 8810</td></tr>' +
    '<tr><td>E-posta</td><td>destek@thesveltechic.com</td></tr>' +
    '<tr><td>Web Sitesi</td><td>www.thesveltechic.com</td></tr>' +
    '</table>' +
    '<p>(Bundan böyle "SATICI", "İŞLETME", "Thesveltechic" veya "Şirket" olarak anılacaktır.)</p>' +

    '<p><strong>1.2 ALICI BİLGİLERİ</strong></p>' +
    '<table>' +
    '<tr><td>Ad Soyad</td><td>' + fullName + '</td></tr>' +
    '<tr><td>E-posta</td><td>' + escapeHtml(email) + '</td></tr>' +
    '<tr><td>Telefon</td><td>' + escapeHtml(phone) + '</td></tr>' +
    '<tr><td>Teslimat Adresi</td><td>' + fullAddressEsc + '</td></tr>' +
    '</table>' +
    '<p>(Bundan böyle "ALICI", "MÜŞTERİ" veya "TÜKETİCİ" olarak anılacaktır.)</p>' +

    '<h4>MADDE 2 — SÖZLEŞMENİN KONUSU</h4>' +
    '<p>2.1. İşbu Sözleşme\'nin konusu, ALICI\'nın www.thesveltechic.com internet sitesi üzerinden elektronik ortamda siparişini verdiği, aşağıda nitelikleri ve satış fiyatı belirtilen ürün(ler)in satışı ve teslimi ile ilgili olarak 6502 sayılı Tüketicinin Korunması Hakkında Kanun ve Mesafeli Sözleşmeler Yönetmeliği hükümleri gereğince tarafların hak ve yükümlülüklerinin saptanmasıdır.</p>' +
    '<p>2.2. ALICI, işbu Sözleşme\'yi onaylayarak; sipariş konusu ürünün temel nitelikleri, satış fiyatı, ödeme şekli, teslimat koşulları ve cayma hakkı ile ilgili tüm ön bilgilendirmeyi okuyup anladığını ve elektronik ortamda gerekli onayı verdiğini kabul, beyan ve taahhüt eder.</p>' +
    '<p>2.3. İşbu Sözleşme, ALICI tarafından sepet sayfasında yer alan "Mesafeli Satış Sözleşmesi\'ni, Kullanım Şartları\'nı, İade ve Değişim Politikası\'nı, Kargo Politikası\'nı, Gizlilik Politikası\'nı ve KVKK Aydınlatma Metni\'ni okudum, anladım ve kabul ediyorum" ibaresinin onaylanması (checkbox işaretlenmesi) ile birlikte kurulmuş sayılır.</p>' +

    '<h4>MADDE 3 — ÜRÜN BİLGİLERİ</h4>' +
    '<p>3.1. Sipariş konusu ürün(ler)in bilgileri:</p>' +
    '<table><tr><td><strong>Ürün</strong></td><td><strong>Varyant</strong></td><td><strong>Adet</strong></td><td><strong>Tutar</strong></td></tr>' + itemsHtml + '</table>' +
    '<table>' +
    '<tr><td>Ara Toplam</td><td>' + formatMoneyTRY(subtotal.toFixed(2)) + '</td></tr>' +
    (totalDiscount > 0 ? '<tr><td>İndirim' + (discountCodes ? ' (' + escapeHtml(discountCodes) + ')' : '') + '</td><td>-' + formatMoneyTRY(totalDiscount.toFixed(2)) + '</td></tr>' : '') +
    '<tr><td>Kargo</td><td>' + (totalShipping > 0 ? formatMoneyTRY(totalShipping.toFixed(2)) : 'Ücretsiz') + '</td></tr>' +
    '<tr><td><strong>Toplam</strong></td><td><strong>' + formatMoneyTRY(grandTotal.toFixed(2)) + '</strong></td></tr>' +
    '</table>' +
    '<p>3.2. Sipariş onay sayfasında ve e-postasında belirtilen bilgiler işbu Sözleşme\'nin ayrılmaz parçasıdır.</p>' +
    '<p>3.3. Ürün fiyatlarına KDV ve sair vergiler dahildir. Kargo ücreti ayrıca belirtilmedikçe SATICI tarafından karşılanır.</p>' +

    '<h4>MADDE 4 — SİPARİŞ VE ÖDEME</h4>' +
    '<p>4.1. ALICI, www.thesveltechic.com üzerinden sipariş vererek işbu Sözleşme\'nin tüm hükümlerini kabul etmiş sayılır.</p>' +
    '<p>4.2. Ödemeler, Stripe ödeme altyapısı aracılığıyla kredi kartı/banka kartı ile gerçekleştirilir.</p>' +
    '<p>4.3. SATICI, güvenlik gerekçesiyle siparişlerde ek doğrulama talep etme hakkını saklı tutar. Doğrulama tamamlanmayan siparişler askıya alınabilir veya iptal edilebilir.</p>' +
    '<p>4.4. Sipariş onayı, ödemenin başarılı şekilde tamamlanması ve SATICI tarafından siparişin kabul edilmesi ile gerçekleşir. SATICI, herhangi bir siparişi kabul etmeme hakkını saklı tutar.</p>' +

    '<h4>MADDE 5 — TESLİMAT KOŞULLARI</h4>' +
    '<p>5.1. Siparişler, ödemenin onaylanmasını takiben 2 (iki) ila 4 (dört) iş günü içerisinde kargoya verilir.</p>' +
    '<p>5.2. Tahmini teslimat süresi, kargoya verilme tarihinden itibaren 15 (on beş) ila 20 (yirmi) iş günüdür.</p>' +
    '<p>5.3. Kampanya dönemleri, bayram ve tatil dönemleri, sezonluk yoğunluklar ve benzeri olağanüstü durumlarda, teslimat süresine ek 5 (beş) iş günü eklenebilir.</p>' +
    '<p>5.4. Kontrolümüz dışında gerçekleşen durumlar (doğal afetler, pandemi, gümrük işlemleri, tatiller, hava koşulları, kargo şirketinden kaynaklanan gecikmeler vb.) nedeniyle teslimat süresi uzayabilir.</p>' +
    '<p>5.5. Kargo şirketine teslim edilen ürünlerin mülkiyet ve hasar riski, ürünün kargo şirketine teslimi ile birlikte ALICI\'ya geçer.</p>' +
    '<p>5.6. Teslimat, ALICI\'nın sipariş sırasında bildirdiği adrese yapılır. Adres bilgilerinin hatalı veya eksik girilmesinden kaynaklanan sorumluluk tamamen ALICI\'ya aittir.</p>' +

    '<h4>MADDE 6 — CAYMA HAKKI</h4>' +
    '<p><strong>6.1. İndirimsiz (Tam Fiyatlı) Ürünlerde Cayma Hakkı</strong></p>' +
    '<p>6.1.1. ALICI, indirimsiz (tam fiyatlı) ürünlerde, ürünün teslim tarihinden itibaren 14 (on dört) gün içerisinde herhangi bir gerekçe göstermeksizin ve cezai şart ödemeksizin cayma hakkını kullanabilir.</p>' +
    '<p>6.1.2. Cayma hakkının kullanılabilmesi için ürünün; kullanılmamış, yıkanmamış, deforme olmamış, etiketleri sökülmemiş ve orijinal ambalajında iade edilmesi zorunludur.</p>' +
    '<p>6.1.3. Cayma hakkının kullanılması halinde ALICI, ürünü destek@thesveltechic.com adresine yazılı olarak bildirimde bulunduktan sonra SATICI tarafından belirtilen adrese gönderir. İade kargo ücreti ALICI\'ya aittir.</p>' +
    '<p>6.1.4. İade edilen ürünün SATICI\'ya ulaşması ve ürünün iade şartlarını karşıladığının tespit edilmesini takiben, ürün bedeli 14 (on dört) gün içerisinde ALICI\'nın ödeme yaptığı ödeme aracına iade edilir.</p>' +

    '<p><strong>6.2. İndirimli / Kampanyalı Ürünlerde Cayma Hakkı Kısıtlaması</strong></p>' +
    '<p>6.2.1. İndirimli, kampanyalı, promosyonlu veya özel fiyatlı ürünlerde para iadesi yapılmaz. ALICI, bu ürünlerde yalnızca 1 (bir) defaya mahsus değişim hakkına sahiptir.</p>' +
    '<p>6.2.2. ALICI, işbu maddeyi özellikle okuyup anladığını, indirimli ürün satın alırken bu koşulu bilerek ve isteyerek kabul ettiğini beyan ve taahhüt eder.</p>' +
    '<p>6.2.3. Değişim hakkının kullanılması halinde:</p>' +
    '<p>(a) Değişim talep edilen yeni ürünün bedeli, iade edilen ürünün bedelinden düşükse: Aradaki fark ALICI\'ya nakit olarak iade edilmez; fark tutarı, ALICI adına İŞLETME bünyesinde bakiye olarak tanımlanır. Bu bakiye, 12 (on iki) ay süreyle geçerlidir.</p>' +
    '<p>(b) Değişim talep edilen yeni ürünün bedeli, iade edilen ürünün bedelinden yüksekse: ALICI, aradaki farkı SATICI\'ya öder.</p>' +
    '<p>(c) Değişim talep edilen yeni ürünün bedeli, iade edilen ürünün bedeline eşitse: Herhangi bir ek ödeme veya bakiye söz konusu olmaz.</p>' +
    '<p>6.2.4. Değişim hakkı, ürünün teslim tarihinden itibaren 14 (on dört) gün içerisinde kullanılmalıdır.</p>' +

    '<p><strong>6.3. Cayma Hakkının Kullanılamayacağı Haller</strong></p>' +
    '<p>6.3.1. Mesafeli Sözleşmeler Yönetmeliği m.15 gereğince, aşağıdaki hallerde cayma hakkı kullanılamaz:</p>' +
    '<p>(a) Fiyatı finansal piyasalardaki dalgalanmalara bağlı olarak değişen ve SATICI\'nın kontrolünde olmayan ürünler.</p>' +
    '<p>(b) Tüketicinin istekleri veya kişisel ihtiyaçları doğrultusunda hazırlanan, kişiye özel üretilen ürünler.</p>' +
    '<p>(c) Çabuk bozulabilen veya son kullanma tarihi geçebilecek ürünler.</p>' +
    '<p>(d) Tesliminden sonra ambalajı açılmış olan; sağlık ve hijyen açısından iade edilemeyecek ürünler (iç giyim, mayo, bikini, çorap vb.).</p>' +
    '<p>(e) Tesliminden sonra başka ürünlerle karışan ve doğası gereği ayrıştırılması mümkün olmayan ürünler.</p>' +

    '<h4>MADDE 7 — STOK DURUMU VE ALTERNATİF ÜRÜN</h4>' +
    '<p>7.1. SATICI\'nın sunduğu ürünlerin stokları sınırlı olup, stok durumu hızla değişkenlik gösterebilir.</p>' +
    '<p>7.2. Sipariş verilen ürünün stoklarının tükenmesi halinde, SATICI en kısa sürede ALICI\'yı bilgilendirir ve ALICI\'ya şu seçenekleri sunar: (a) ALICI, sipariş tutarı dahilinde veya fark ödeyerek başka bir ürün seçebilir. (b) ALICI\'nın yeni ürün seçmemesi halinde, sipariş tutarı İŞLETME bünyesinde ALICI adına bakiye olarak tanımlanır (12 ay geçerli).</p>' +
    '<p>7.3. Bu senaryoda nakit para iadesi yapılmaz.</p>' +

    '<h4>MADDE 8 — GARANTİ VE AYIPLI ÜRÜN</h4>' +
    '<p>8.1. ALICI\'ya teslim edilen ürünün ayıplı (kusurlu, hasarlı, hatalı) olması halinde, ayıplı ürün için para iadesi yapılmaz; yalnızca değişim uygulanır.</p>' +
    '<p>8.2. ALICI, sipariş vererek ve işbu Sözleşme\'yi onaylayarak, ayıplı ürün halinde yalnızca değişim hakkının bulunduğunu, para iadesi talep edemeyeceğini açıkça kabul ve beyan eder.</p>' +
    '<p>8.3. Ayıplı ürün bildirimi, ürünün teslim tarihinden itibaren 3 (üç) gün içerisinde, ürünün fotoğrafları ile birlikte destek@thesveltechic.com adresine yazılı olarak yapılmalıdır.</p>' +
    '<p>8.4. SATICI, ayıbın teyit edilmesi halinde, ALICI\'ya aynı ürünün yenisi veya ALICI\'nın onayıyla eşdeğer bir ürün gönderilir. Değişim kargo ücreti İŞLETME tarafından karşılanır.</p>' +

    '<h4>MADDE 9 — ÖDEME İADESİ KOŞULLARI</h4>' +
    '<p>9.1. Para iadesi hakkı doğan hallerde (Madde 6.1 kapsamında cayma hakkının usulüne uygun kullanılması), iade edilen ürünün SATICI\'ya ulaşmasını ve kontrol edilmesini takiben, ürün bedeli 14 (on dört) iş günü içerisinde ALICI\'nın ödeme yaptığı ödeme aracına iade edilir.</p>' +
    '<p>9.2. Ödeme kuruluşunun iade işlemini ALICI\'nın hesabına yansıtma süresi SATICI\'nın kontrolünde değildir.</p>' +
    '<p>9.3. Para iadesine hak kazanılmayan hallerde (indirimli ürünler, stok tükenmesi vb.) ALICI\'ya bakiye tanımlanır; nakit iade yapılmaz.</p>' +

    '<h4>MADDE 10 — TERS İBRAZ (CHARGEBACK / DISPUTE) POLİTİKASI</h4>' +
    '<p>10.1. ALICI, işbu Sözleşme kapsamında bir uyuşmazlık yaşaması halinde, öncelikle SATICI ile doğrudan iletişime geçerek (destek@thesveltechic.com) sorunu çözmeyi kabul ve taahhüt eder.</p>' +
    '<p>10.2. ALICI\'nın, SATICI ile iletişime geçmeksizin doğrudan ödeme kuruluşuna başvurarak ters ibraz başlatması halinde, SATICI bu işleme itiraz etme hakkını saklı tutar.</p>' +
    '<p>10.3. Haksız veya kötü niyetli ters ibraz işlemi başlatan ALICI, SATICI\'nın bu sebeple uğradığı doğrudan ve dolaylı tüm zararları tazmin etmeyi kabul ve taahhüt eder.</p>' +

    '<h4>MADDE 11 — FİKRİ MÜLKİYET VE MARKA KORUMA</h4>' +
    '<p>11.1. www.thesveltechic.com internet sitesinde yer alan tüm içerik SATICI\'nın münhasır mülkiyetindedir ve fikri mülkiyet hakları kapsamında korunmaktadır.</p>' +
    '<p>11.2. ALICI, SATICI\'nın yazılı izni olmaksızın site içeriğini kopyalayamaz, çoğaltamaz, dağıtamaz, yayınlayamaz veya ticari amaçlarla kullanamaz.</p>' +

    '<h4>MADDE 12 — GİZLİLİK, İTİBAR KORUMA VE SOSYAL MEDYA HÜKÜMLERİ</h4>' +
    '<p>12.1.1. ALICI, SATICI ile arasındaki ticari ilişki kapsamında edindiği bilgileri üçüncü kişilerle paylaşmamayı kabul ve taahhüt eder.</p>' +
    '<p>12.2.1. ALICI, SATICI, markası, ürünleri, hizmetleri hakkında; gerçeğe aykırı, yanıltıcı, karalayacı, aşağılayıcı, iftira niteliğinde veya ticari itibarı zedeleyici nitelikte beyanda bulunmamayı kabul ve taahhüt eder.</p>' +
    '<p>12.2.4. ALICI, şikayetini öncelikle ve münhasıran SATICI\'nın müşteri hizmetlerine (destek@thesveltechic.com veya +971 56 850 8810) ileteceğini, sorununun çözümü için SATICI\'ya makul süre (en az 15 iş günü) tanıyacağını kabul ve taahhüt eder.</p>' +

    '<h4>MADDE 13 — CEZAİ ŞART VE TAZMİNAT</h4>' +
    '<p>13.1.1. ALICI\'nın, Madde 12 hükümlerini ihlal etmesi halinde, SATICI\'nın uğradığı maddi ve manevi zarardan bağımsız olarak, sipariş tutarının 20 (yirmi) katı tutarında cezai şart ödemeyi kabul ve taahhüt eder.</p>' +
    '<p>13.1.2. Cezai şart, SATICI\'nın ayrıca tazminat talep etme hakkını ortadan kaldırmaz.</p>' +

    '<h4>MADDE 14 — KİŞİSEL VERİLERİN KORUNMASI</h4>' +
    '<p>14.1. SATICI, ALICI\'nın kişisel verilerini 6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) ve ilgili mevzuat hükümlerine uygun olarak işler.</p>' +
    '<p>14.2. ALICI\'nın kişisel verilerinin işlenmesine ilişkin detaylı bilgi, www.thesveltechic.com adresinde yayınlanan Gizlilik Politikası ve KVKK Aydınlatma Metni\'nde yer almaktadır.</p>' +

    '<h4>MADDE 15 — MÜCBİR SEBEP</h4>' +
    '<p>15.1. Tarafların kontrolünde olmayan; doğal afet, savaş, terör, salgın hastalık, grev, lokavt, hükümet kararları, gümrük uygulamaları, ulaşım aksaklıkları, enerji kesintisi ve benzeri öngörülemez ve önlenemez olaylar mücbir sebep sayılır.</p>' +
    '<p>15.2. Mücbir sebep durumunda tarafların sözleşmeden doğan yükümlülükleri, mücbir sebebin devamı süresince askıya alınır. Mücbir sebebin 60 (altmış) günden fazla sürmesi halinde, taraflardan her biri Sözleşme\'yi tazminatsız olarak feshedebilir.</p>' +

    '<h4>MADDE 16 — UYUŞMAZLIK ÇÖZÜMÜ</h4>' +
    '<p>16.1. İşbu Sözleşme\'den doğan uyuşmazlıklarda Türk Hukuku uygulanır.</p>' +
    '<p>16.2. Uyuşmazlıkların çözümünde İstanbul Mahkemeleri ve İstanbul İcra Daireleri münhasıran yetkilidir.</p>' +
    '<p>16.3. ALICI, 6502 sayılı Kanun\'un 68. maddesi kapsamındaki parasal sınırlar dahilinde Tüketici Hakem Heyetleri\'ne, bu sınırları aşan uyuşmazlıklarda ise Tüketici Mahkemeleri\'ne başvurma hakkına sahiptir.</p>' +

    '<h4>MADDE 17 — SÖZLEŞMENİN BÜTÜNLÜĞÜ VE EKLERİ</h4>' +
    '<p>17.1. İşbu Sözleşme, aşağıdaki belgelerin tamamı ile birlikte bir bütün teşkil eder:</p>' +
    '<p>Ek-1: Kullanım Şartları &bull; Ek-2: İade ve Değişim Politikası &bull; Ek-3: Kargo Politikası &bull; Ek-4: Gizlilik Politikası ve KVKK Aydınlatma Metni &bull; Ek-5: KVKK Açık Rıza Metni &bull; Ek-6: Çerez Politikası</p>' +
    '<p>17.2. ALICI, sepet sayfasında yer alan onay kutucuğunu işaretleyerek, işbu Sözleşme\'yi ve tüm eklerini okuduğunu, anladığını ve kabul ettiğini elektronik ortamda beyan ve taahhüt eder.</p>' +

    '<h4>MADDE 18 — YÜRÜRLÜK</h4>' +
    '<p>18.1. İşbu Sözleşme, ALICI tarafından elektronik ortamda onaylandığı tarihte yürürlüğe girer.</p>' +
    '<p>18.2. SATICI, işbu Sözleşme\'yi tek taraflı olarak güncelleme hakkını saklı tutar.</p>' +
    '<p>18.3. İşbu Sözleşme, 18 (on sekiz) maddeden oluşmakta olup, taraflarca okunarak kabul edilmiştir.</p>' +

    '<hr style="margin:16px 0;">' +
    '<div style="background:#fafaf8;border:1px solid #e8e4dc;border-radius:6px;padding:16px;margin:16px 0;">' +
    '<h4 style="margin:0 0 12px;font-size:14px;">ELEKTRONİK ONAY KAYDI</h4>' +
    '<table style="width:100%;font-size:13px;">' +
    '<tr><td style="padding:4px 8px;color:#666;width:180px;"><strong>SATICI</strong></td><td style="padding:4px 8px;">MESU L.L.C-F.Z &mdash; Meydan Grandstand, 6th Floor, Dubai, BAE</td></tr>' +
    '<tr><td style="padding:4px 8px;color:#666;"><strong>ALICI</strong></td><td style="padding:4px 8px;">' + fullName + ' &mdash; ' + fullAddressEsc + '</td></tr>' +
    '<tr><td style="padding:4px 8px;color:#666;"><strong>E-posta</strong></td><td style="padding:4px 8px;">' + escapeHtml(email) + '</td></tr>' +
    '<tr><td style="padding:4px 8px;color:#666;"><strong>Sipariş No</strong></td><td style="padding:4px 8px;">' + escapeHtml(order.name || '') + '</td></tr>' +
    '<tr><td style="padding:4px 8px;color:#666;"><strong>Onay Tarihi ve Saati</strong></td><td style="padding:4px 8px;">' + dateStr + ' ' + timeStr + '</td></tr>' +
    '<tr><td style="padding:4px 8px;color:#666;"><strong>Sözleşme No</strong></td><td style="padding:4px 8px;">' + escapeHtml(agreementId) + '</td></tr>' +
    '</table>' +
    '<p style="font-size:11px;color:#999;margin-top:12px;margin-bottom:0;">Bu sözleşme, ALICI tarafından elektronik ortamda (www.thesveltechic.com sepet sayfası) onay kutucuğu işaretlenerek ve sipariş tamamlanarak kabul edilmiştir. 6098 sayılı Türk Borçlar Kanunu m.15 ve 6102 sayılı Türk Ticaret Kanunu m.18/3 uyarınca elektronik ortamda kurulan bu sözleşme geçerli ve bağlayıcıdır.</p>' +
    '</div>';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';
  const hmacHeader = event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'];

  if (!verifyWebhook(rawBody, hmacHeader)) {
    console.error('[process-order-agreement] Webhook signature verification failed');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!order || !order.id) {
    return { statusCode: 400, body: 'Missing order id' };
  }

  // Read agreement attributes from order.note_attributes
  const accepted = getNoteAttr(order, 'mesafeli_sozlesme_kabul');
  if (accepted !== 'evet') {
    console.log(`[process-order-agreement] Order ${order.name}: agreement not accepted, skipping`);
    return { statusCode: 200, body: JSON.stringify({ skipped: 'not_accepted' }) };
  }

  const agreementMeta = {
    timestamp: getNoteAttr(order, 'sozlesme_zaman_damgasi'),
    id: getNoteAttr(order, 'sozlesme_no'),
    userAgent: getNoteAttr(order, 'sozlesme_user_agent')
  };

  try {
    // Idempotency: if metafield already exists, skip
    const existingResp = await shopifyRequest(
      `orders/${order.id}/metafields.json?namespace=checkout&key=mesafeli_satis_sozlesmesi`
    );
    if (existingResp.metafields && existingResp.metafields.length > 0) {
      console.log(`[process-order-agreement] Order ${order.name}: agreement metafield already exists, skipping`);
      return { statusCode: 200, body: JSON.stringify({ skipped: 'already_exists' }) };
    }

    const agreementHtml = buildAgreementHtml(order, agreementMeta);

    // Save metafield
    await shopifyRequest(`orders/${order.id}/metafields.json`, 'POST', {
      metafield: {
        namespace: 'checkout',
        key: 'mesafeli_satis_sozlesmesi',
        value: agreementHtml,
        type: 'multi_line_text_field'
      }
    });

    // Add link to note_attributes for easy retrieval
    const agreementUrl = `https://checkout.thesveltechic.com/api/get-agreement?order=${encodeURIComponent(order.name)}&email=${encodeURIComponent(order.email || '')}`;
    const existingAttrs = order.note_attributes || [];
    if (!existingAttrs.find(a => a.name === 'sozlesme_linki')) {
      existingAttrs.push({ name: 'sozlesme_linki', value: agreementUrl });
      await shopifyRequest(`orders/${order.id}.json`, 'PUT', {
        order: { id: order.id, note_attributes: existingAttrs }
      }).catch(err => console.warn('[process-order-agreement] note_attributes update failed:', err.message));
    }

    console.log(`[process-order-agreement] Order ${order.name}: agreement saved (id=${agreementMeta.id || 'auto'})`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, orderName: order.name, agreementUrl })
    };

  } catch (err) {
    console.error(`[process-order-agreement] Order ${order.name} ERROR:`, err.message);
    // Return 500 so Shopify retries
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
