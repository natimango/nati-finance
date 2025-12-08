const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({ connectionString })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'nati_accounting',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD
    });

pool.on('connect', () => {
  console.log('✓ Connected to PostgreSQL database: nati_accounting');
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

module.exports = pool;
