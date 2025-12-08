require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Client } = require('pg');

async function fixFileTypeColumn() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    await client.connect();
    console.log('✓ Connected to database');
    
    // Alter the column to increase size
    await client.query(`
      ALTER TABLE documents 
      ALTER COLUMN file_type TYPE VARCHAR(150);
    `);
    
    console.log('✓ file_type column updated to VARCHAR(150)');
    
    await client.end();
    console.log('\n✅ Fix complete! You can now upload Excel and Word files.\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

fixFileTypeColumn();
