const { pool } = require('../config/db');
const { generateQuestionHash } = require('./questionHashUtil');

/**
 * Automatically computes and populates content_hash values for all
 * existing questions and um_questions in the database.
 */
async function populateQuestionHashes() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. UTBK questions
    const questionsRes = await client.query(`
      SELECT q.id, q.content, q.image_url, 
             COALESCE(
               json_agg(
                 json_build_object('content', ac.content)
               ) FILTER (WHERE ac.id IS NOT NULL),
               '[]'::json
             ) as choices
      FROM questions q
      LEFT JOIN answer_choices ac ON ac.question_id = q.id
      WHERE q.content_hash IS NULL
      GROUP BY q.id
    `);

    if (questionsRes.rows.length > 0) {
      console.log(`🔄 Hashing ${questionsRes.rows.length} existing UTBK questions...`);
      for (const q of questionsRes.rows) {
        const hash = generateQuestionHash(q.content, q.choices, q.image_url);
        await client.query(
          'UPDATE questions SET content_hash = $1 WHERE id = $2',
          [hash, q.id]
        );
      }
    }

    // 2. Ujian Mandiri questions
    const umQuestionsRes = await client.query(`
      SELECT q.id, q.content, q.image_url, 
             COALESCE(
               json_agg(
                 json_build_object('content', ac.content)
               ) FILTER (WHERE ac.id IS NOT NULL),
               '[]'::json
             ) as choices
      FROM um_questions q
      LEFT JOIN um_answer_choices ac ON ac.question_id = q.id
      WHERE q.content_hash IS NULL
      GROUP BY q.id
    `);

    if (umQuestionsRes.rows.length > 0) {
      console.log(`🔄 Hashing ${umQuestionsRes.rows.length} existing Ujian Mandiri questions...`);
      for (const q of umQuestionsRes.rows) {
        const hash = generateQuestionHash(q.content, q.choices, q.image_url);
        await client.query(
          'UPDATE um_questions SET content_hash = $1 WHERE id = $2',
          [hash, q.id]
        );
      }
    }

    await client.query('COMMIT');
    if (questionsRes.rows.length > 0 || umQuestionsRes.rows.length > 0) {
      console.log('✅ Existing questions successfully hashed and updated.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error populating question content hashes:', err);
  } finally {
    client.release();
  }
}

module.exports = { populateQuestionHashes };
