const express = require('express');
const router = express.Router();
const { getQualitySummary } = require('../controllers/qualityController');

router.get('/quality/summary', getQualitySummary);

module.exports = router;
