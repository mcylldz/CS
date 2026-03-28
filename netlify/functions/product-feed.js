/**
 * Google Shopping XML Product Feed Generator
 * Fetches products from Shopify's public products.json API
 * and generates a Google Merchant Center compatible XML feed.
 *
 * URL: https://checkout.thesveltechic.com/api/product-feed
 */

const SHOPIFY_STORE_URL = 'https://thesveltechic.com';
const STORE_NAME = 'Svelte Chic';
const STORE_DESCRIPTION = 'Svelte Chic - Şık ve Zarif Kadın Giyim';
const CURRENCY = 'TRY';
const TARGET_COUNTRY = 'TR';
const LANGUAGE = 'tr';

// Google product category mappings based on product tags/collections
const CATEGORY_MAP = {
  'dresses': 'Giyim ve Aksesuar > Giyim > Elbiseler',
  'blouses': 'Giyim ve Aksesuar > Giyim > Üstler > Bluzlar',
  'tops': 'Giyim ve Aksesuar > Giyim > Üstler',
  'scarves': 'Giyim ve Aksesuar > Giyim Aksesuarları > Atkılar ve Şallar',
  'accessories': 'Giyim ve Aksesuar > Giyim Aksesuarları',
  'skirts': 'Giyim ve Aksesuar > Giyim > Etekler',
  'jackets': 'Giyim ve Aksesuar > Giyim > Dış Giyim > Ceketler',
  'coats': 'Giyim ve Aksesuar > Giyim > Dış Giyim > Montlar ve Kabanlar',
  'pants': 'Giyim ve Aksesuar > Giyim > Pantolonlar',
  'knitwear': 'Giyim ve Aksesuar > Giyim > Üstler > Kazaklar',
  'jewelry': 'Giyim ve Aksesuar > Takı',
  'rings': 'Giyim ve Aksesuar > Takı > Yüzükler',
  'necklaces': 'Giyim ve Aksesuar > Takı > Kolyeler',
  'bags': 'Giyim ve Aksesuar > Çantalar ve Bavullar > El Çantaları',
};

// Google product category IDs (numeric)
const CATEGORY_ID_MAP = {
  'dresses': '2271',
  'blouses': '212',
  'tops': '212',
  'scarves': '179',
  'accessories': '167',
  'skirts': '3455',
  'jackets': '3066',
  'coats': '5598',
  'pants': '204',
  'knitwear': '212',
  'jewelry': '188',
  'rings': '200',
  'necklaces': '196',
  'bags': '6551',
};

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCategory(product) {
  const tags = (product.tags || []).map(t => t.toLowerCase());
  const title = (product.title || '').toLowerCase();
  const collections = tags.filter(t => t.startsWith('coll:')).map(t => t.replace('coll:', ''));

  // Check tags and title for category matches
  if (tags.includes('rings') || title.includes('yüzük')) return 'rings';
  if (tags.includes('necklaces') || title.includes('kolye')) return 'necklaces';
  if (tags.includes('jewelry') || title.includes('takı')) return 'jewelry';
  if (tags.includes('scarves') || title.includes('şal') || title.includes('atkı')) return 'scarves';
  if (tags.includes('bags') || title.includes('çanta')) return 'bags';
  if (collections.includes('blouses_shirts') || tags.includes('blouses') || title.includes('bluz')) return 'blouses';
  if (collections.includes('knitwear') || title.includes('kazak') || title.includes('hırka') || title.includes('örgü')) return 'knitwear';
  if (title.includes('elbise') || title.includes('abiye') || title.includes('tulum') || title.includes('sabahlık')) return 'dresses';
  if (title.includes('etek')) return 'skirts';
  if (title.includes('ceket') || title.includes('mont')) return 'jackets';
  if (title.includes('kürk') || title.includes('palto') || title.includes('kaban')) return 'coats';
  if (title.includes('pantolon')) return 'pants';
  if (collections.includes('tops') || tags.includes('tops')) return 'tops';
  if (tags.includes('accessories') || collections.includes('accessories')) return 'accessories';

  // Default
  return 'accessories';
}

function getGender(product) {
  const tags = (product.tags || []).map(t => t.toLowerCase());
  if (tags.includes('women') || tags.includes('kadın')) return 'female';
  if (tags.includes('men') || tags.includes('erkek')) return 'male';
  return 'female'; // Default for this store
}

function getCondition() {
  return 'new';
}

function getAvailability(variant) {
  return variant.available ? 'in_stock' : 'out_of_stock';
}

async function fetchAllProducts() {
  let allProducts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${SHOPIFY_STORE_URL}/products.json?limit=250&page=${page}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'SvelteChic-GMC-Feed/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch products: ${response.status}`);
    }

    const data = await response.json();
    const products = data.products || [];

    if (products.length === 0) {
      hasMore = false;
    } else {
      allProducts = allProducts.concat(products);
      page++;
    }

    // Safety: max 10 pages (2500 products)
    if (page > 10) break;
  }

  return allProducts;
}

function generateProductXml(product, variant) {
  const category = detectCategory(product);
  const categoryId = CATEGORY_ID_MAP[category] || '167';
  const categoryName = CATEGORY_MAP[category] || 'Giyim ve Aksesuar';
  const description = stripHtml(product.body_html);
  const truncatedDesc = description.substring(0, 5000);

  // Build the variant-specific ID
  const itemId = `shopify_TR_${product.id}_${variant.id}`;

  // Product URL
  const productUrl = `${SHOPIFY_STORE_URL}/products/${product.handle}`;

  // Variant-specific URL with query params
  let variantUrl = productUrl;
  if (product.variants && product.variants.length > 1) {
    variantUrl = `${productUrl}?variant=${variant.id}`;
  }

  // Image
  let imageUrl = '';
  if (variant.featured_image && variant.featured_image.src) {
    imageUrl = variant.featured_image.src;
  } else if (product.images && product.images.length > 0) {
    imageUrl = product.images[0].src;
  }

  // Additional images
  const additionalImages = (product.images || [])
    .slice(1, 11) // max 10 additional images
    .map(img => img.src)
    .filter(src => src && src !== imageUrl);

  // Price
  const price = `${variant.price} ${CURRENCY}`;
  const salePrice = variant.compare_at_price && parseFloat(variant.compare_at_price) > parseFloat(variant.price)
    ? `${variant.price} ${CURRENCY}`
    : null;
  const regularPrice = variant.compare_at_price && parseFloat(variant.compare_at_price) > parseFloat(variant.price)
    ? `${variant.compare_at_price} ${CURRENCY}`
    : null;

  // Title with variant info
  let itemTitle = product.title;
  if (variant.option1 && variant.option1 !== 'Default Title' && variant.option1 !== 'Tek Beden') {
    itemTitle += ` - ${variant.option1}`;
  }
  if (variant.option2 && variant.option2 !== 'Default Title' && variant.option2 !== 'Tek Beden') {
    itemTitle += ` / ${variant.option2}`;
  }
  // Truncate to 150 chars
  itemTitle = itemTitle.substring(0, 150);

  // Size and color from options
  let color = '';
  let size = '';
  if (product.options) {
    for (const opt of product.options) {
      const optName = opt.name.toLowerCase();
      if (optName === 'renk' || optName === 'color' || optName === 'colour') {
        const optIndex = product.options.indexOf(opt);
        color = variant[`option${optIndex + 1}`] || '';
      }
      if (optName === 'beden' || optName === 'size') {
        const optIndex = product.options.indexOf(opt);
        size = variant[`option${optIndex + 1}`] || '';
      }
    }
  }

  // Brand
  const brand = product.vendor || STORE_NAME;

  // GTIN/MPN
  const sku = variant.sku || '';

  let xml = `    <item>\n`;
  xml += `      <g:id>${escapeXml(itemId)}</g:id>\n`;
  xml += `      <g:title>${escapeXml(itemTitle)}</g:title>\n`;
  xml += `      <g:description>${escapeXml(truncatedDesc)}</g:description>\n`;
  xml += `      <g:link>${escapeXml(variantUrl)}</g:link>\n`;

  if (imageUrl) {
    xml += `      <g:image_link>${escapeXml(imageUrl)}</g:image_link>\n`;
  }

  for (const addImg of additionalImages) {
    xml += `      <g:additional_image_link>${escapeXml(addImg)}</g:additional_image_link>\n`;
  }

  xml += `      <g:availability>${getAvailability(variant)}</g:availability>\n`;

  if (regularPrice) {
    xml += `      <g:price>${escapeXml(regularPrice)}</g:price>\n`;
    xml += `      <g:sale_price>${escapeXml(salePrice)}</g:sale_price>\n`;
  } else {
    xml += `      <g:price>${escapeXml(price)}</g:price>\n`;
  }

  xml += `      <g:brand>${escapeXml(brand)}</g:brand>\n`;

  if (sku) {
    xml += `      <g:mpn>${escapeXml(sku)}</g:mpn>\n`;
  }

  xml += `      <g:identifier_exists>false</g:identifier_exists>\n`;
  xml += `      <g:condition>${getCondition()}</g:condition>\n`;
  xml += `      <g:google_product_category>${categoryId}</g:google_product_category>\n`;
  xml += `      <g:product_type>${escapeXml(categoryName)}</g:product_type>\n`;

  if (color) {
    xml += `      <g:color>${escapeXml(color)}</g:color>\n`;
  }
  if (size && size !== 'Tek Beden') {
    xml += `      <g:size>${escapeXml(size)}</g:size>\n`;
  }

  xml += `      <g:gender>${getGender(product)}</g:gender>\n`;
  xml += `      <g:age_group>adult</g:age_group>\n`;

  // Item group for variants
  if (product.variants && product.variants.length > 1) {
    xml += `      <g:item_group_id>${product.id}</g:item_group_id>\n`;
  }

  // Shipping info
  xml += `      <g:shipping>\n`;
  xml += `        <g:country>${TARGET_COUNTRY}</g:country>\n`;
  xml += `        <g:service>Standart Kargo</g:service>\n`;
  xml += `        <g:price>0 ${CURRENCY}</g:price>\n`;
  xml += `      </g:shipping>\n`;

  xml += `    </item>\n`;

  return xml;
}

exports.handler = async (event, context) => {
  try {
    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: 'Method Not Allowed',
      };
    }

    const products = await fetchAllProducts();

    // Filter only available/active products (published_at exists)
    const activeProducts = products.filter(p => p.published_at);

    let itemsXml = '';
    let itemCount = 0;

    for (const product of activeProducts) {
      for (const variant of product.variants) {
        itemsXml += generateProductXml(product, variant);
        itemCount++;
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(STORE_NAME)}</title>
    <link>${SHOPIFY_STORE_URL}</link>
    <description>${escapeXml(STORE_DESCRIPTION)}</description>
${itemsXml}  </channel>
</rss>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600', // 1 hour cache
        'X-Product-Count': String(itemCount),
      },
      body: xml,
    };
  } catch (error) {
    console.error('Product feed error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: `Feed generation error: ${error.message}`,
    };
  }
};
