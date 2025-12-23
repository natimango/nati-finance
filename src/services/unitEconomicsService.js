const pool = require('../config/database');

const COST_TYPES_LANDED = ['manufacturing', 'packaging', 'inbound_freight', 'other_variable'];

async function getSettings() {
  const bufferResult = await pool.query(
    `SELECT setting_value FROM finance_settings WHERE setting_key = 'target_net_margin_buffer' LIMIT 1`
  );
  const targetNetMarginBuffer = parseFloat(bufferResult.rows[0]?.setting_value) || 0.2;
  return { targetNetMarginBuffer };
}

async function fetchSkuSnapshots(dropId = null) {
  const params = [COST_TYPES_LANDED];
  let whereClause = '';
  if (Number.isFinite(dropId)) {
    whereClause = 'WHERE sm.drop_id = $2';
    params.push(dropId);
  }

  const priceRows = await pool.query(
    `
    SELECT sm.sku_id,
           sm.sku_code,
           sm.sku_name,
           sm.drop_id,
           price.selling_price,
           price.mrp,
           cost.total_cost
    FROM sku_master sm
    LEFT JOIN (
      SELECT DISTINCT ON (sku_id) sku_id, selling_price, mrp
      FROM sku_price_history
      WHERE effective_from <= CURRENT_DATE
      ORDER BY sku_id, effective_from DESC
    ) price ON price.sku_id = sm.sku_id
    LEFT JOIN (
      SELECT sku_id, SUM(amount_per_unit) AS total_cost
      FROM sku_cost_layers
      WHERE effective_from <= CURRENT_DATE
        AND cost_type = ANY($1::text[])
      GROUP BY sku_id
    ) cost ON cost.sku_id = sm.sku_id
    ${whereClause}
    ORDER BY sm.sku_code
    `,
    params
  );

  const assumptionsRows = await pool.query(
    `SELECT * FROM sku_assumptions`
  );
  const assumptionsMap = new Map();
  for (const row of assumptionsRows.rows) {
    assumptionsMap.set(row.sku_id, row);
  }

  const sizeRows = await pool.query(
    `SELECT * FROM size_sellthrough`
  );
  const sizeMap = new Map();
  for (const row of sizeRows.rows) {
    if (!sizeMap.has(row.sku_id)) sizeMap.set(row.sku_id, []);
    sizeMap.get(row.sku_id).push(row);
  }

  return priceRows.rows.map(row => ({
    ...row,
    assumptions: assumptionsMap.get(row.sku_id) || null,
    sizes: sizeMap.get(row.sku_id) || []
  }));
}

function computeSizeMultiplier(sizeRow = null) {
  if (!sizeRow) return 1;
  const sold = Number(sizeRow.units_sold || 0);
  const available = Number(sizeRow.units_available || 0);
  if (!available) return 0;
  const sellthrough = available > 0 ? (sold / available) * 100 : 0;
  let multiplier = 1;
  if (sellthrough >= 75 && available < 10) {
    multiplier = 1.15;
  } else if (sellthrough < 40) {
    multiplier = 0.7;
  }
  if (sizeRow.bottleneck_flag) {
    multiplier = Math.min(1.2, multiplier * 1.1);
  }
  return Math.max(0, multiplier);
}

function computeSkuMetrics(row, settings) {
  const assumptions = row.assumptions || {};
  const price = Number(row.selling_price || row.mrp || 0);
  const landedCost = Number(row.total_cost || 0);
  const shipping = Number(assumptions.shipping_subsidy_avg || 0);
  const gatewayPct = Number(assumptions.gateway_fee_pct || 0);
  const gatewayFixed = Number(assumptions.gateway_fee_fixed || 0);
  const returnsRate = Number(assumptions.returns_rate || 0);
  const returnShipping = Number(assumptions.return_shipping_avg || 0);
  const reconditioning = Number(assumptions.reconditioning_cost_avg || 0);
  const resaleDiscountPct = Number(assumptions.expected_resale_discount_pct || 0);
  const bufferOverride = Number.isFinite(Number(assumptions.cm_buffer))
    ? Number(assumptions.cm_buffer)
    : null;

  const missingPrice = price <= 0;
  const missingCost = !Number.isFinite(landedCost) || landedCost <= 0;
  const missingAssumptions = !row.assumptions;
  const baseGateway = gatewayPct * price + gatewayFixed;
  const baseCM = price - landedCost - shipping - baseGateway;
  const returnsAllowance = returnsRate * (returnShipping + reconditioning + price * resaleDiscountPct);
  const cmAfterReturns = baseCM - returnsAllowance;
  const bufferPerUnit = bufferOverride !== null ? bufferOverride : settings.targetNetMarginBuffer * price;
  const maxCac = Math.max(0, cmAfterReturns - bufferPerUnit);
  const negativeCm = cmAfterReturns < 0;
  const missingReturnsInputs = returnsRate > 0 && (returnShipping === 0 && reconditioning === 0);

  return {
    sku_id: row.sku_id,
    sku_code: row.sku_code,
    sku_name: row.sku_name,
    drop_id: row.drop_id,
    price,
    landed_cost: landedCost,
    shipping_subsidy_avg: shipping,
    gateway_fee_pct: gatewayPct,
    gateway_fee_fixed: gatewayFixed,
    returns_rate: returnsRate,
    return_shipping_avg: returnShipping,
    reconditioning_cost_avg: reconditioning,
    expected_resale_discount_pct: resaleDiscountPct,
    cm_buffer: bufferPerUnit,
    cm_before_returns: baseCM,
    cm_after_returns: cmAfterReturns,
    max_cac: maxCac,
    flags: {
      missing_price: missingPrice,
      missing_cost: missingCost,
      missing_assumptions: missingAssumptions,
      negative_cm: negativeCm,
      missing_returns_inputs: missingReturnsInputs
    }
  };
}

async function getUnitEconomicsData(dropId = null) {
  const settings = await getSettings();
  const snapshots = await fetchSkuSnapshots(dropId);
  const perSku = snapshots.map(row => computeSkuMetrics(row, settings));

  const valid = perSku.filter(p => !p.flags.missing_price && !p.flags.missing_cost);
  const blendedMethod = 'equal_weight';
  const blendedCm =
    valid.length > 0
      ? valid.reduce((sum, v) => sum + v.cm_after_returns, 0) / valid.length
      : 0;
  const blendedPrice =
    valid.length > 0 ? valid.reduce((sum, v) => sum + v.price, 0) / valid.length : 0;
  const blendedMaxCac = Math.max(0, blendedCm - settings.targetNetMarginBuffer * blendedPrice);

  return {
    per_sku: perSku,
    blended_cm: Number(blendedCm.toFixed(2)),
    blended_price: Number(blendedPrice.toFixed(2)),
    blended_max_cac: Number(blendedMaxCac.toFixed(2)),
    blended_method: blendedMethod,
    target_net_margin_buffer: settings.targetNetMarginBuffer
  };
}

async function getMaxCacByTier(dropId = null) {
  const data = await getUnitEconomicsData(dropId);
  const tiers = {};
  for (const sku of data.per_sku) {
    const price = Number(sku.price || 0);
    const tier =
      price <= 1500 ? 'budget' : price <= 3000 ? 'core' : 'premium';
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push(sku);
  }
  const result = Object.entries(tiers).map(([tier, skus]) => {
    const valid = skus.filter(s => !s.flags.missing_price && !s.flags.missing_cost);
    const cm =
      valid.length > 0
        ? valid.reduce((sum, v) => sum + v.cm_after_returns, 0) / valid.length
        : 0;
    const price =
      valid.length > 0 ? valid.reduce((sum, v) => sum + v.price, 0) / valid.length : 0;
    const maxCac = Math.max(0, cm - data.target_net_margin_buffer * price);
    return {
      tier,
      sku_count: skus.length,
      cm_after_returns: Number(cm.toFixed(2)),
      avg_price: Number(price.toFixed(2)),
      max_cac: Number(maxCac.toFixed(2))
    };
  });
  return { target_net_margin_buffer: data.target_net_margin_buffer, tiers: result };
}

async function getMaxCacBySize(skuId) {
  if (!skuId) return { sku_id: null, sizes: [] };
  const settings = await getSettings();
  const snapshots = await fetchSkuSnapshots(null);
  const found = snapshots.find(s => Number(s.sku_id) === Number(skuId));
  if (!found) return { sku_id: skuId, sizes: [] };
  const baseMetrics = computeSkuMetrics(found, settings);
  const sizes = (found.sizes || []).map(row => {
    const multiplier = computeSizeMultiplier(row);
    return {
      size: row.size,
      units_available: row.units_available,
      units_sold: row.units_sold,
      bottleneck_flag: row.bottleneck_flag,
      multiplier,
      max_cac: Number((baseMetrics.max_cac * multiplier).toFixed(2))
    };
  });
  return {
    sku_id: skuId,
    base_max_cac: baseMetrics.max_cac,
    sizes
  };
}

module.exports = {
  getUnitEconomicsData,
  getMaxCacByTier,
  getMaxCacBySize
};
