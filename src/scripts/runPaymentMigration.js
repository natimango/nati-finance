require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'nati_accounting',
    user: process.env.USER || 'postgres'
  });
  
  try {
    await client.connect();
    console.log('✓ Connected to database\n');
    
    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/003_payment_tracking.sql'),
      'utf8'
    );
    
    await client.query(sql);
    console.log('✓ Payment tracking tables created\n');
    
    // Verify tables
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('payment_terms', 'payment_schedule', 'payments', 'vendor_payment_summary')
      ORDER BY table_name
    `);
    
    console.log('📋 Tables created:');
    tables.rows.forEach(row => console.log(`   - ${row.table_name}`));
    
    await client.end();
    console.log('\n✅ Migration complete!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

runMigration();
