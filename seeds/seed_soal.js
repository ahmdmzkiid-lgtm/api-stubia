const { pool } = require('../src/config/db');
const bcrypt = require('bcrypt');

async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Seeding subjects...');
    const subjects = await client.query(`
      INSERT INTO subjects (name, category) VALUES
      ('Penalaran Umum', 'TPS'),
      ('Pengetahuan Kuantitatif', 'TPS'),
      ('Literasi Bahasa Indonesia', 'TPS'),
      ('Matematika', 'TKA_SAINTEK'),
      ('Fisika', 'TKA_SAINTEK')
      ON CONFLICT DO NOTHING
      RETURNING id, name;
    `);

    // If subjects already existed, fetch them
    let finalSubjects = subjects.rows;
    if (finalSubjects.length === 0) {
      const existing = await client.query('SELECT id, name FROM subjects LIMIT 5');
      finalSubjects = existing.rows;
    }

    console.log('Seeding admin user...');
    const hash = await bcrypt.hash('Admin123!', 12);
    await client.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      ['admin@utbk.dev', hash, 'Admin Utama', 'admin']
    );

    console.log('Seeding basic questions...');
    const questionIds = [];
    for (const sub of finalSubjects) {
      const q = await client.query(
        `INSERT INTO questions (subject_id, content) VALUES ($1, $2) RETURNING id`,
        [sub.id, `Contoh soal untuk ${sub.name}`]
      );
      questionIds.push(q.rows[0].id);
      
      await client.query(`
        INSERT INTO answer_choices (question_id, label, content, is_correct) VALUES
        ($1, 'A', 'Pilihan A', true),
        ($1, 'B', 'Pilihan B', false),
        ($1, 'C', 'Pilihan C', false),
        ($1, 'D', 'Pilihan D', false),
        ($1, 'E', 'Pilihan E', false)
      `, [q.rows[0].id]);
    }

    console.log('Seeding default tryout package...');
    await client.query(`
      INSERT INTO tryout_packages (title, subject_config, is_public) VALUES
      ($1, $2, $3)
      ON CONFLICT (title) DO NOTHING
    `, [
      'Simulasi SNBT 2026 - Batch 1',
      JSON.stringify({
        total_questions: questionIds.length,
        time_limit_minutes: 90
      }),
      true
    ]);

    await client.query('COMMIT');
    console.log('Seed completed successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', error);
  } finally {
    client.release();
    pool.end();
  }
}

runSeed();
