require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function debugFiles() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'nati_accounting',
    user: process.env.USER || 'postgres'
  });
  
  try {
    await client.connect();
    console.log('✓ Connected to database: nati_accounting\n');
    
    // Get all documents
    const result = await client.query('SELECT * FROM documents ORDER BY document_id');
    
    console.log(`Found ${result.rows.length} documents in database:\n`);
    
    result.rows.forEach((doc, index) => {
      console.log(`Document ${index + 1}:`);
      console.log(`  ID: ${doc.document_id}`);
      console.log(`  Name: ${doc.file_name}`);
      console.log(`  Type: ${doc.file_type}`);
      console.log(`  Category: ${doc.document_category}`);
      console.log(`  Path: ${doc.file_path}`);
      
      // Check if file exists
      if (fs.existsSync(doc.file_path)) {
        const stats = fs.statSync(doc.file_path);
        console.log(`  ✓ File exists on disk (${stats.size} bytes)`);
      } else {
        console.log(`  ✗ FILE NOT FOUND ON DISK!`);
      }
      
      console.log(`  View URL: http://localhost:3000/api/files/${doc.document_id}`);
      console.log(`  Download URL: http://localhost:3000/api/files/${doc.document_id}/download`);
      console.log('');
    });
    
    await client.end();
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

debugFiles();
