const pool = require('../config/database');

async function getContributionMarginData(dropId) {
  const params = [];
  let dropClause = '';
  if (Number.isFinite(dropId)) {
    dropClause = 'WHERE sm.drop_id = $1';
    params.push(dropId);
  }

  const bufferResult = await pool.query(
    `SELECT setting_value FROM finance_settings WHERE setting_key = 'target_net_margin_buffer' LIMIT 1`
  );
  const targetNetMarginBuffer = parseFloat(bufferResult.rows[0]?.setting_value) || 0.2;

  const rows = await pool.query(
    `
    SELECT
      sm.sku_id,
      sm.sku_code,
      sm.sku_name,
      COALESCE(lp.selling_price, 0) AS selling_price,
      COALESCE(lp.mrp, 0) AS mrp,
      COALESCE(cost.total_cost, 0) AS total_cost
    FROM sku_master sm
    LEFT JOIN (
      SELECT DISTINCT ON (sku_id) sku_id, selling_price, mrp
      FROM sku_price_history
      WHERE effective_from <= CURRENT_DATE
      ORDER BY sku_id, effective_from DESC
    ) lp ON lp.sku_id = sm.sku_id
    LEFT JOIN (
      SELECT sku_id, SUM(amount_per_unit) AS total_cost
      FROM sku_cost_layers
      WHERE effective_from <= CURRENT_DATE
      GROUP BY sku_id
    ) cost ON cost.sku_id = sm.sku_id
    ${dropClause}
    ORDER BY sm.sku_code
    `,
    params
  );

  const perSku = rows.rows.map(row => {
    const sellingPrice = Number(row.selling_price || 0);
    const totalCost = Number(row.total_cost || 0);
    const contributionMargin = sellingPrice - totalCost;
    const contributionMarginPct = sellingPrice > 0 ? (contributionMargin / sellingPrice) * 100 : 0;
    return {
      sku_id: row.sku_id,
      sku_code: row.sku_code,
      sku_name: row.sku_name,
      selling_price: sellingPrice,
      mrp: Number(row.mrp || 0),
      total_cost: totalCost,
      contribution_margin: contributionMargin,
      contribution_margin_pct: Number(contributionMarginPct.toFixed(2))
    };
  });

  const totalSelling = perSku.reduce((acc, sku) => acc + sku.selling_price, 0);
  const totalContribution = perSku.reduce((acc, sku) => acc + sku.contribution_margin, 0);
  const averagedContribution = perSku.length ? totalContribution / perSku.length : 0;
  const avgSellingPrice = perSku.length ? totalSelling / perSku.length : 0;
  const blendedContributionMargin = Number(averagedContribution.toFixed(2));
  const maxCac = Math.max(0, blendedContributionMargin - targetNetMarginBuffer * avgSellingPrice);

  return {
    per_sku: perSku,
    blended_contribution_margin: blendedContributionMargin,
    max_cac: Number(maxCac.toFixed(2)),
    target_net_margin_buffer: targetNetMarginBuffer
  };
}

module.exports = { getContributionMarginData };
