const express = require('express');
const router = express.Router();
const {
  getProfitLoss,
  getTrialBalance,
  getBalanceSheet,
  getJournalEntries,
  getChartOfAccounts,
  getDimensionSpend,
  upsertDropBudget,
  getDropBudgets,
  getDropBudgetHistory,
  getDropVariance,
  getMetricsSummary,
  getCogsBySku,
  getContributionMargin,
  getUnitEconomics,
  ingestMarketingSpend,
  ingestShipmentCost
} = require('../controllers/reportsController');
const { authorize } = require('../middleware/auth');

router.use(authorize('uploader', 'manager', 'admin'));

router.get('/reports/profit-loss', getProfitLoss);
router.get('/reports/trial-balance', getTrialBalance);
router.get('/reports/balance-sheet', getBalanceSheet);
router.get('/reports/journal-entries', getJournalEntries);
router.get('/reports/chart-of-accounts', getChartOfAccounts);
router.get('/reports/spend-dimensions', getDimensionSpend);
router.post('/reports/drop-budgets', authorize('admin'), upsertDropBudget);
router.get('/reports/drop-budgets', getDropBudgets);
router.get('/reports/drop-budgets/history', getDropBudgetHistory);
router.get('/reports/drop-variance', getDropVariance);
router.get('/reports/contribution-margin', getContributionMargin);
router.get('/reports/unit-economics', getUnitEconomics);
router.get('/metrics/summary', getMetricsSummary);
router.get('/metrics/cogs/:sku_code', getCogsBySku);
router.post('/ingest/marketing', authorize('admin'), ingestMarketingSpend);
router.post('/ingest/shipment', authorize('admin'), ingestShipmentCost);

module.exports = router;
