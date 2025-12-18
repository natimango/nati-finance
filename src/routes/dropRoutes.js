const express = require('express');
const router = express.Router();
const { getDropGoLive } = require('../controllers/goLiveController');

router.get('/drops/:dropId/go-live', getDropGoLive);

module.exports = router;
