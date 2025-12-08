const express = require('express');
const router = express.Router();
const brainController = require('../controllers/brainController');
const { authorize } = require('../middleware/auth');

router.use(authorize('uploader', 'manager', 'admin'));

router.get('/summary', brainController.getFinanceSummary);
router.get('/drop/:dropName', brainController.getDropOverview);
router.get('/drop/:dropName/cost', brainController.getDropCostOverview);
router.get('/sku/:skuCode', brainController.getSkuOverview);
router.get('/watchdog', authorize('manager', 'admin'), brainController.getWatchdog);
router.get('/alerts', authorize('manager', 'admin'), brainController.getAlerts);
router.post('/alerts/run', authorize('admin'), brainController.runBudgetAlerts);

module.exports = router;
