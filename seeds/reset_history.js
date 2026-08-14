const { pool } = require('../src/config/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    console.log('🔄 Loading reset user history SQL...');
    const sqlPath = path.join(__dirname, '..', '..', 'scratch', 'reset_user_history.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`SQL file not found at ${sqlPath}`);
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('🔌 Connecting to the database...');
    const client = await pool.connect();
    
    try {
      console.log('⚡ Executing reset script...');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✅ All user history, sessions, answers, and battle records cleared successfully!');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Error executing SQL script:', err);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('❌ Error running reset script:', e.message);
  } finally {
    process.exit(0);
  }
}

run();
