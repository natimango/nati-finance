require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/config/database');

async function run() {
  const [email, password, role = 'admin', fullName] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/createAdmin.js <email> <password> [role] [full_name]');
    process.exit(1);
  }
  if (!['uploader', 'manager', 'admin'].includes(role)) {
    console.error('Role must be one of uploader, manager, admin');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, role, full_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, full_name = EXCLUDED.full_name
     RETURNING user_id, email, role`,
    [email.toLowerCase(), hash, role, fullName || null]
  );
  console.log('User created/updated:', result.rows[0]);
  process.exit(0);
}

run().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});
