const { Pool, types } = require('pg');
// Override default TIMESTAMP parser (OID 1114) to parse timestamp without timezone as UTC
types.setTypeParser(1114, function(stringValue) {
  return new Date(stringValue + 'Z');
});
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? true 
    : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('🔗 Connected to Neon PostgreSQL');

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_run (
        filename VARCHAR(255) PRIMARY KEY,
        executed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const alreadyRun = await client.query(
        'SELECT 1 FROM migrations_run WHERE filename = $1',
        [file]
      );
      if (alreadyRun.rows.length > 0) {
        console.log(`⏭️  Skipping already-run migration: ${file}`);
        continue;
      }

      console.log(`🚀 Running migration: ${file}`);
      const migrationSQL = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query(migrationSQL);
      await client.query(
        'INSERT INTO migrations_run (filename) VALUES ($1)',
        [file]
      );
    }
    console.log('✅ Database schema initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase };
