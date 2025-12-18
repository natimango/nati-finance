const express = require('express');
const router = express.Router();
const { patchBillItem } = require('../controllers/billItemController');

router.patch('/bill-items/:id', patchBillItem);

module.exports = router;
