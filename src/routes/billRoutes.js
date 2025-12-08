const express = require('express');
const multer = require('multer');
const router = express.Router();
const {
  processBillWithAI,
  processBillManual,
  getPaymentDashboard,
  recordPayment,
  recordSimplePayment,
  deleteBill,
  updateBillMeta
} = require('../controllers/billController');
const { authorize } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });

router.use(authorize('manager', 'admin'));

// Process bill with AI
router.post('/bills/:document_id/process', processBillWithAI);

// Manually process a bill when AI fails or needs override
router.post('/bills/:document_id/manual', processBillManual);

// Get payment dashboard
router.get('/payments/dashboard', getPaymentDashboard);

// Record payment
router.post('/payments/record', recordPayment);

// Delete bill (and cascade its items/payments), reset document for reprocess
router.delete('/bills/:bill_id', deleteBill);

// Update bill/document metadata (dimensions/category)
router.patch('/bills/:bill_id/meta', updateBillMeta);

// Quick payment record against earliest pending schedule
router.post('/payments/record-simple', recordSimplePayment);

module.exports = router;
