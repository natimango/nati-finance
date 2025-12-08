const express = require('express');
const router = express.Router();
const {
  login,
  logout,
  me,
  listUsers,
  createUser,
  deleteUser
} = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/auth');

router.post('/login', login);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);
router.get('/users', authenticate, authorize('admin'), listUsers);
router.post('/users', authenticate, authorize('admin'), createUser);
router.delete('/users/:id', authenticate, authorize('admin'), deleteUser);

module.exports = router;
