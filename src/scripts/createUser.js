require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

async function createUser() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  const email = 'admin@nati.com';
  const password = 'nati2025';
  const fullName = 'NATI Admin';
  
  try {
    await client.connect();
    
    // Check if user exists
    const existing = await client.query('SELECT email FROM users WHERE email = $1', [email]);
    
    if (existing.rows.length > 0) {
      console.log('\n⚠️  User already exists!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📧 Email:', email);
      console.log('🔑 Password: nati2025');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      await client.end();
      return;
    }
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Insert user
    const result = await client.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING user_id, email, full_name',
      [email, passwordHash, fullName, 'admin']
    );
    
    console.log('\n✅ User created successfully!\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 Email:', email);
    console.log('🔑 Password:', password);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('👤 User ID:', result.rows[0].user_id);
    console.log('👤 Name:', result.rows[0].full_name);
    console.log('\n');
    
    await client.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

createUser();
