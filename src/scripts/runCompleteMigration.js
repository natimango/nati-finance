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
      path.join(__dirname, '../migrations/004_complete_accounting_schema.sql'),
      'utf8'
    );
    
    await client.query(sql);
    console.log('✓ Complete accounting schema created\n');
    
    // Verify tables
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('products', 'inventory_transactions', 'sales_orders', 'sales_order_items', 'monthly_summary', 'budgets')
      ORDER BY table_name
    `);
    
    console.log('📋 New tables created:');
    tables.rows.forEach(row => console.log(`   - ${row.table_name}`));
    
    // Check accounts count
    const accountsCount = await client.query('SELECT COUNT(*) FROM accounts');
    console.log(`\n📊 Chart of Accounts: ${accountsCount.rows[0].count} accounts loaded\n`);
    
    await client.end();
    console.log('✅ Migration complete!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

runMigration();
