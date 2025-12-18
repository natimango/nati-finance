const express = require('express');
const router = express.Router();
const { listCoaAccounts, listDepartments, listDrops } = require('../controllers/metaController');

router.get('/meta/coa_accounts', listCoaAccounts);
router.get('/meta/departments', listDepartments);
router.get('/meta/drops', listDrops);

module.exports = router;
