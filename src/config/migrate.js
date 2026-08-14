// Simple migration runner using initializeDatabase
const { initializeDatabase } = require('./db');

initializeDatabase()
  .then(() => {
    console.log('Migrations completed');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
