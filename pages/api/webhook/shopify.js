// Shopify Webhook endpoint
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { callBitrix, getBitrixWebhookBase } from '../../../src/lib/bitrix/client.js';
import { mapShopifyOrderToBitrixDeal } from '../../../src/lib/bitrix/orderMapper.js';
import { upsertBitrixContact } from '../../../src/lib/bitrix/contact.js';
import { BITRIX_CONFIG, financialStatusToStageId, financialStatusToPaymentStatus } from '../../../src/lib/bitrix/config.js';

// Configure body parser to accept raw JSON
// Increased size limit for large orders with many line items
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb', // Increased from 1mb for large orders
    },
  },
};

/**
 * Handle order created event - create deal in Bitrix
 */
async function handleOrderCreated(order) {
  console.log(`[SHOPIFY WEBHOOK] Handling order created: ${order.name || order.id}`);
  console.log(`[SHOPIFY WEBHOOK] Order data:`, {
    id: order.id,
    name: order.name,
    total_price: order.total_price,
    current_total_price: order.current_total_price,
    financial_status: order.financial_status,
    line_items_count: order.line_items?.length || 0
  });

  // Map order to Bitrix deal
  const { dealFields, productRows } = mapShopifyOrderToBitrixDeal(order);
  
  console.log(`[SHOPIFY WEBHOOK] Mapped dealFields:`, JSON.stringify(dealFields, null, 2));
  console.log(`[SHOPIFY WEBHOOK] Mapped productRows count:`, productRows.length);
  if (productRows.length > 0) {
    console.log(`[SHOPIFY WEBHOOK] First product row:`, JSON.stringify(productRows[0], null, 2));
  }

  // Upsert contact (non-blocking)
  let contactId = null;
  try {
    const bitrixBase = getBitrixWebhookBase();
    contactId = await upsertBitrixContact(bitrixBase, order);
    if (contactId) {
      dealFields.CONTACT_ID = contactId;
    }
  } catch (contactError) {
    console.error('[SHOPIFY WEBHOOK] Contact upsert failed (non-blocking):', contactError);
  }

  // 1. Create deal
  console.log(`[SHOPIFY WEBHOOK] Sending deal to Bitrix with fields:`, Object.keys(dealFields));
  const dealAddResp = await callBitrix('/crm.deal.add.json', {
    fields: dealFields,
  });

  console.log(`[SHOPIFY WEBHOOK] Bitrix response:`, JSON.stringify(dealAddResp, null, 2));

  if (!dealAddResp.result) {
    console.error(`[SHOPIFY WEBHOOK] ❌ Failed to create deal. Response:`, dealAddResp);
    throw new Error(`Failed to create deal: ${JSON.stringify(dealAddResp)}`);
  }

  const dealId = dealAddResp.result;
  console.log(`[SHOPIFY WEBHOOK] ✅ Deal created: ${dealId}`);

  // 2. Set product rows
  if (productRows.length > 0) {
    try {
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows,
      });
      console.log(`[SHOPIFY WEBHOOK] Product rows set for deal ${dealId}: ${productRows.length} rows`);
    } catch (productRowsError) {
      console.error(`[SHOPIFY WEBHOOK] Product rows error (non-blocking):`, productRowsError);
      // Don't throw - deal is already created
    }
  }

  return dealId;
}

/**
 * Handle order updated event - update deal in Bitrix
 * This is the MAIN TRIGGER for:
 * - Updating product rows in deal
 * - Recalculating totals/discounts/taxes
 * - Updating payment status and stage
 * - Handling partial/full refunds
 */
async function handleOrderUpdated(order) {
  console.log(`[SHOPIFY WEBHOOK] Handling order updated: ${order.name || order.id}`);
  console.log(`[SHOPIFY WEBHOOK] Order data:`, {
    id: order.id,
    name: order.name,
    financial_status: order.financial_status,
    total_price: order.total_price,
    current_total_price: order.current_total_price,
    line_items_count: order.line_items?.length || 0
  });

  const shopifyOrderId = String(order.id);

  // 1. Find existing deal by UF_SHOPIFY_ORDER_ID
  // Optionally filter by CATEGORY_ID: 2 to avoid hitting other funnels
  const listResp = await callBitrix('/crm.deal.list.json', {
    filter: { 
      'UF_SHOPIFY_ORDER_ID': shopifyOrderId,
      // 'CATEGORY_ID': 2  // Uncomment if needed to filter only Stock category
    },
    select: ['ID', 'OPPORTUNITY', 'STAGE_ID', 'CATEGORY_ID', 'DATE_CREATE'],
    order: { 'DATE_CREATE': 'DESC' }, // Sort by creation date descending
  });

  const deals = listResp.result || [];
  const dealsCount = deals.length;

  console.log(`[SHOPIFY WEBHOOK] Found ${dealsCount} deal(s) for order ${shopifyOrderId}`);

  let dealId = null;
  let deal = null;

  if (dealsCount === 0) {
    // No deal found - CREATE NEW DEAL
    console.log(`[SHOPIFY WEBHOOK] ⚠️ No deal found for order ${shopifyOrderId}. Creating new deal...`);
    
    // Determine category based on order tags
    const orderTags = Array.isArray(order.tags) 
      ? order.tags 
      : (order.tags ? String(order.tags).split(',').map(t => t.trim()) : []);
    
    const preorderTags = ['pre-order', 'preorder-product-added'];
    const hasPreorderTag = orderTags.some(tag => 
      preorderTags.some(preorderTag => tag.toLowerCase() === preorderTag.toLowerCase())
    );
    
    const categoryId = hasPreorderTag ? BITRIX_CONFIG.CATEGORY_PREORDER : BITRIX_CONFIG.CATEGORY_STOCK;

    // Map order to Bitrix deal
    const { dealFields, productRows } = mapShopifyOrderToBitrixDeal(order);
    
    // Ensure CATEGORY_ID and UF_SHOPIFY_ORDER_ID are set
    dealFields.CATEGORY_ID = categoryId;
    dealFields.UF_SHOPIFY_ORDER_ID = shopifyOrderId;

    // Upsert contact (non-blocking)
    let contactId = null;
    try {
      const bitrixBase = getBitrixWebhookBase();
      contactId = await upsertBitrixContact(bitrixBase, order);
      if (contactId) {
        dealFields.CONTACT_ID = contactId;
      }
    } catch (contactError) {
      console.error('[SHOPIFY WEBHOOK] Contact upsert failed (non-blocking):', contactError);
    }

    // Create new deal
    console.log(`[SHOPIFY WEBHOOK] Creating new deal with CATEGORY_ID=${categoryId}, UF_SHOPIFY_ORDER_ID=${shopifyOrderId}`);
    const dealAddResp = await callBitrix('/crm.deal.add.json', {
      fields: dealFields,
    });

    if (!dealAddResp.result) {
      console.error(`[SHOPIFY WEBHOOK] ❌ Failed to create deal. Response:`, dealAddResp);
      throw new Error(`Failed to create deal: ${JSON.stringify(dealAddResp)}`);
    }

    dealId = dealAddResp.result;
    console.log(`[SHOPIFY WEBHOOK] ✅ New deal created: ${dealId}`);

    // Set product rows for new deal
    if (productRows && productRows.length > 0) {
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows,
      });
      console.log(`[SHOPIFY WEBHOOK] Product rows set for new deal ${dealId}: ${productRows.length} rows`);
    }

    return dealId;

  } else if (dealsCount === 1) {
    // Exactly one deal found - UPDATE IT
    deal = deals[0];
    dealId = deal.ID;
    const currentCategoryId = Number(deal.CATEGORY_ID) || 2;
    console.log(`[SHOPIFY WEBHOOK] ✅ Found exactly one deal ${dealId} for order ${shopifyOrderId}, category: ${currentCategoryId}`);

  } else {
    // Multiple deals found - ERROR, but update the most recent one
    console.error(`[SHOPIFY WEBHOOK] ⚠️ DATA ERROR: Found ${dealsCount} deals for order ${shopifyOrderId}!`);
    console.error(`[SHOPIFY WEBHOOK] Deal IDs:`, deals.map(d => d.ID).join(', '));
    console.error(`[SHOPIFY WEBHOOK] Will update the most recent deal (sorted by DATE_CREATE DESC)`);
    
    // Use the most recent deal (already sorted by DATE_CREATE DESC)
    deal = deals[0];
    dealId = deal.ID;
    const currentCategoryId = Number(deal.CATEGORY_ID) || 2;
    console.log(`[SHOPIFY WEBHOOK] Updating deal ${dealId} (most recent), category: ${currentCategoryId}`);
  }

  // 2. UPDATE EXISTING DEAL
  const currentCategoryId = Number(deal.CATEGORY_ID) || 2;

  // Determine category based on order tags (pre-order tags → cat_8, otherwise cat_2)
  const orderTags = Array.isArray(order.tags) 
    ? order.tags 
    : (order.tags ? String(order.tags).split(',').map(t => t.trim()) : []);
  
  const preorderTags = ['pre-order', 'preorder-product-added'];
  const hasPreorderTag = orderTags.some(tag => 
    preorderTags.some(preorderTag => tag.toLowerCase() === preorderTag.toLowerCase())
  );
  
  const categoryId = hasPreorderTag ? BITRIX_CONFIG.CATEGORY_PREORDER : BITRIX_CONFIG.CATEGORY_STOCK;

  // Prepare update fields - ALWAYS UPDATE
  const { dealFields: mappedFields } = mapShopifyOrderToBitrixDeal(order);
  
  const fields = {
    // Always update amount, discounts, taxes, shipping
    OPPORTUNITY: mappedFields.OPPORTUNITY,
    UF_SHOPIFY_TOTAL_DISCOUNT: mappedFields.UF_SHOPIFY_TOTAL_DISCOUNT || 0,
    UF_SHOPIFY_TOTAL_TAX: mappedFields.UF_SHOPIFY_TOTAL_TAX || 0,
    UF_SHOPIFY_SHIPPING_PRICE: mappedFields.UF_SHOPIFY_SHIPPING_PRICE || 0,
  };

  // Update category if changed
  if (categoryId !== currentCategoryId) {
    fields.CATEGORY_ID = categoryId;
    console.log(`[SHOPIFY WEBHOOK] Category changed from ${currentCategoryId} to ${categoryId}`);
  }

  // Map financial status to stage ID (based on category)
  // For partially_refunded: keep current stage (don't move to LOSE)
  const currentStageId = deal.STAGE_ID;
  const stageId = financialStatusToStageId(order.financial_status, categoryId, currentStageId);
  
  // Only update stage if it's different AND not a partial refund (partial refund keeps current stage)
  if (order.financial_status?.toLowerCase() === 'partially_refunded') {
    // Keep current stage for partial refunds - don't change to LOSE
    console.log(`[SHOPIFY WEBHOOK] Partial refund detected - keeping current stage: "${currentStageId}"`);
    // Don't update STAGE_ID field - keep it as is
  } else {
    // For other statuses, update stage normally
    fields.STAGE_ID = stageId;
    if (stageId !== currentStageId) {
      console.log(`[SHOPIFY WEBHOOK] Stage updated: "${currentStageId}" → "${stageId}"`);
    }
  }

  // Payment status synchronization - ALWAYS UPDATE
  const paymentStatusEnumId = financialStatusToPaymentStatus(order.financial_status);
  fields.UF_CRM_1739183959976 = paymentStatusEnumId;
  console.log(`[SHOPIFY WEBHOOK] Payment status: "${paymentStatusEnumId}" (financial_status: ${order.financial_status})`);

  // Update order type and delivery method if present
  if (mappedFields.UF_CRM_1739183268662) {
    fields.UF_CRM_1739183268662 = mappedFields.UF_CRM_1739183268662; // Order type
  }
  if (mappedFields.UF_CRM_1739183302609) {
    fields.UF_CRM_1739183302609 = mappedFields.UF_CRM_1739183302609; // Delivery method
  }

  // 3. Update deal fields
  console.log(`[SHOPIFY WEBHOOK] Updating deal ${dealId} with fields:`, Object.keys(fields));
  await callBitrix('/crm.deal.update.json', {
    id: dealId,
    fields,
  });
  console.log(`[SHOPIFY WEBHOOK] ✅ Deal ${dealId} updated successfully`);

  // 4. ALWAYS UPDATE PRODUCT ROWS - full replacement from line_items
  try {
    const { productRows } = mapShopifyOrderToBitrixDeal(order);
    console.log(`[SHOPIFY WEBHOOK] Updating product rows for deal ${dealId}: ${productRows?.length || 0} rows`);
    
    // Always call productrows.set - even if empty array (to clear removed items)
    await callBitrix('/crm.deal.productrows.set.json', {
      id: dealId,
      rows: productRows || [],
    });
    console.log(`[SHOPIFY WEBHOOK] ✅ Product rows updated for deal ${dealId}: ${productRows?.length || 0} rows`);
  } catch (productRowsError) {
    console.error(`[SHOPIFY WEBHOOK] ❌ Product rows update error:`, productRowsError);
    // Don't throw - deal fields are already updated
  }

  return dealId;
}

/**
 * Handle product updated event - update internal product catalog only
 * This handler updates SKU/handle → PRODUCT_ID mapping, Brand, Size, etc.
 * DOES NOT touch deals - only internal product reference data
 */
async function handleProductUpdated(product) {
  console.log(`[SHOPIFY WEBHOOK] Handling product updated: ${product.id || product.title}`);
  console.log(`[SHOPIFY WEBHOOK] Product data:`, {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    variants: product.variants?.length || 0
  });

  // TODO: Update internal product catalog (SKU/handle → PRODUCT_ID mapping)
  // This could update a database, file, or configuration
  // For now, just log the update
  // Example structure:
  // - Update SKU_TO_PRODUCT_ID mapping in config or external storage
  // - Store product metadata (Brand, Size, Model, etc.)
  // - Do NOT modify any deals
  
  if (product.variants && Array.isArray(product.variants)) {
    product.variants.forEach((variant, index) => {
      console.log(`[SHOPIFY WEBHOOK] Product variant ${index + 1}:`, {
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        price: variant.price,
        inventory_quantity: variant.inventory_quantity
      });
      // TODO: Update SKU mapping here
      // Example: updateProductMapping(variant.sku, { productId, brand, size, etc. })
    });
  }

  console.log(`[SHOPIFY WEBHOOK] ✅ Product catalog update processed (no deals affected)`);
  return true;
}

/**
 * Handle refund created event - update deal in Bitrix
 * Note: Shopify refund webhook sends refund object, not order object
 */
async function handleRefundCreated(refundData) {
  console.log(`[SHOPIFY WEBHOOK] Handling refund created`);
  console.log(`[SHOPIFY WEBHOOK] Refund data:`, {
    order_id: refundData.order_id,
    refund_id: refundData.id,
    amount: refundData.amount,
    currency: refundData.currency,
    refund_line_items: refundData.refund_line_items?.length || 0
  });

  const shopifyOrderId = String(refundData.order_id);
  
  // 1. Find deal by UF_SHOPIFY_ORDER_ID
  const listResp = await callBitrix('/crm.deal.list.json', {
    filter: { 'UF_SHOPIFY_ORDER_ID': shopifyOrderId },
    select: ['ID', 'OPPORTUNITY', 'STAGE_ID', 'CATEGORY_ID'],
  });

  const deal = listResp.result?.[0];
  if (!deal) {
    console.log(`[SHOPIFY WEBHOOK] Deal not found for Shopify order ${shopifyOrderId}`);
    return;
  }

  const dealId = deal.ID;
  const currentCategoryId = Number(deal.CATEGORY_ID) || 2;
  console.log(`[SHOPIFY WEBHOOK] Found deal ${dealId} for refund on order ${shopifyOrderId}`);

  // 2. Get full order from Shopify to recalculate totals
  try {
    const { getOrder } = await import('../../../src/lib/shopify/adminClient.js');
    const shopifyOrder = await getOrder(shopifyOrderId);
    
    if (!shopifyOrder) {
      console.error(`[SHOPIFY WEBHOOK] Order ${shopifyOrderId} not found in Shopify`);
      return;
    }

    // 3. Recalculate deal amount and product rows based on current order state (after refund)
    const { dealFields, productRows } = mapShopifyOrderToBitrixDeal(shopifyOrder);
    
    // 4. Update deal with new amount and product rows
    const fields = {
      OPPORTUNITY: dealFields.OPPORTUNITY,
      UF_SHOPIFY_TOTAL_DISCOUNT: dealFields.UF_SHOPIFY_TOTAL_DISCOUNT,
      UF_SHOPIFY_SHIPPING_PRICE: dealFields.UF_SHOPIFY_SHIPPING_PRICE,
      UF_SHOPIFY_TOTAL_TAX: dealFields.UF_SHOPIFY_TOTAL_TAX,
    };

    // Update payment status based on refund
    const refundAmount = Number(refundData.amount || 0);
    const orderTotal = Number(shopifyOrder.total_price || 0);
    const remainingAmount = orderTotal - refundAmount;
    
    if (remainingAmount <= 0) {
      // Full refund
      fields.UF_CRM_1739183959976 = '58'; // Unpaid
      fields.STAGE_ID = financialStatusToStageId('refunded', currentCategoryId);
    } else if (refundAmount > 0) {
      // Partial refund
      fields.UF_CRM_1739183959976 = '58'; // Unpaid (or could be '60' for partial)
    }

    await callBitrix('/crm.deal.update.json', {
      id: dealId,
      fields,
    });
    console.log(`[SHOPIFY WEBHOOK] Deal ${dealId} updated after refund`);

    // 5. Update product rows to reflect refunded quantities
    if (productRows && productRows.length > 0) {
      await callBitrix('/crm.deal.productrows.set.json', {
        id: dealId,
        rows: productRows,
      });
      console.log(`[SHOPIFY WEBHOOK] Product rows updated for deal ${dealId} after refund: ${productRows.length} rows`);
    }

  } catch (error) {
    console.error(`[SHOPIFY WEBHOOK] Error processing refund:`, error);
    // Don't throw - refund is already processed in Shopify
  }

  return dealId;
}

// Export handler function for reuse in other endpoints
export async function handler(req, res) {
  // Enhanced logging - log ALL incoming requests immediately
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[SHOPIFY WEBHOOK] ===== INCOMING REQUEST [${requestId}] =====`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Timestamp: ${new Date().toISOString()}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Method: ${req.method}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] URL: ${req.url}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] All headers:`, JSON.stringify(req.headers, null, 2));
  
  if (req.method !== 'POST') {
    console.log(`[SHOPIFY WEBHOOK] [${requestId}] ❌ Method not allowed: ${req.method}`);
    res.status(405).end('Method not allowed');
    return;
  }

  // Log raw body size
  const bodyString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Body size: ${bodyString?.length || 0} bytes`);
  
  const topic = req.headers['x-shopify-topic'] || req.headers['X-Shopify-Topic'];
  const shopifyShopDomain = req.headers['x-shopify-shop-domain'] || req.headers['X-Shopify-Shop-Domain'];
  const shopifyHmac = req.headers['x-shopify-hmac-sha256'] || req.headers['X-Shopify-Hmac-Sha256'];
  
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Topic: ${topic || 'MISSING!'}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Shop Domain: ${shopifyShopDomain || 'MISSING!'}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] HMAC Present: ${!!shopifyHmac}`);
  
  const order = req.body;
  
  // Try to extract order info even if structure is different
  const orderId = order?.id || order?.order_id || order?.order?.id || 'N/A';
  const orderName = order?.name || order?.order_name || order?.order?.name || 'N/A';
  
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Order ID: ${orderId}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Order Name: ${orderName}`);
  console.log(`[SHOPIFY WEBHOOK] [${requestId}] Body keys: ${Object.keys(order || {}).join(', ')}`);

  // If no topic, log full body for debugging
  if (!topic) {
    console.error(`[SHOPIFY WEBHOOK] [${requestId}] ⚠️ NO TOPIC HEADER! Full body:`, JSON.stringify(order, null, 2));
  }

  try {
    // Store event for monitoring (non-blocking)
    try {
      const storedEvent = shopifyAdapter.storeEvent(order);
      console.log(`[SHOPIFY WEBHOOK] [${requestId}] ✅ Event stored. Topic: ${topic}, Order: ${orderName || orderId}`);
    } catch (storeError) {
      console.error(`[SHOPIFY WEBHOOK] [${requestId}] ⚠️ Failed to store event:`, storeError);
    }

    // Handle different topics - SEPARATE HANDLERS
    if (topic === 'orders/create') {
      await handleOrderCreated(order);
    } else if (topic === 'orders/updated') {
      // orders/updated handles all updates including refunds and cancellations
      await handleOrderUpdated(order);
    } else if (topic === 'products/update') {
      // Product updates only affect internal catalog, not deals
      await handleProductUpdated(order);
    } else if (topic === 'refunds/create') {
      // Refunds are handled by orders/updated - this is deprecated but kept for backward compatibility
      console.log(`[SHOPIFY WEBHOOK] [${requestId}] ⚠️ refunds/create webhook received but refunds are handled by orders/updated`);
      // Optionally: fetch order and process via handleOrderUpdated
      // For now, just log and return 200
    } else {
      // For other topics just log and return 200
      console.log(`[SHOPIFY WEBHOOK] [${requestId}] Unhandled topic: ${topic || 'null/undefined'}`);
    }

    console.log(`[SHOPIFY WEBHOOK] [${requestId}] ✅ Request processed successfully`);
    res.status(200).json({ success: true, requestId, topic });
  } catch (e) {
    console.error(`[SHOPIFY WEBHOOK] [${requestId}] ❌ Error:`, e);
    console.error(`[SHOPIFY WEBHOOK] [${requestId}] Error stack:`, e.stack);
    res.status(500).json({ 
      error: 'Internal server error', 
      message: e.message,
      requestId 
    });
  }
}

// Default export for direct use
export default handler;
