const crypto = require('crypto');

/**
 * Generates a SHA-256 hash for a question based on its text content, 
 * choices (sorted to ensure order-independence), and image URL.
 * 
 * @param {string} content The main text of the question
 * @param {Array|string[]} choices Array of choice objects (with .content) or raw choice strings
 * @param {string} imageUrl Optional image URL linked to the question
 * @returns {string} SHA-256 hex digest hash
 */
/**
 * Generates a SHA-256 hash for a question based on its text content, 
 * choices (sorted to ensure order-independence), image URL, and optional stimulus.
 * 
 * @param {string} content The main text of the question
 * @param {Array|string[]} choices Array of choice objects (with .content) or raw choice strings
 * @param {string} imageUrl Optional image URL linked to the question
 * @param {string} stimulus Optional stimulus text for the question
 * @returns {string} SHA-256 hex digest hash
 */
function generateQuestionHash(content, choices, imageUrl, stimulus) {
  // Normalize main question content
  const cleanContent = (content || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  
  // Normalize image URL
  const cleanImage = imageUrl ? imageUrl.trim() : '';

  // Normalize and sort choices alphabetically to ensure hash is identical
  // even if choices are shuffled or ordered differently
  const cleanChoices = Array.isArray(choices)
    ? choices
        .map(c => {
          const txt = (typeof c === 'string' ? c : (c?.content || ''));
          return txt.trim().toLowerCase().replace(/\s+/g, ' ');
        })
        .sort()
        .join('|')
    : '';

  // Normalize stimulus wacana
  const cleanStimulus = stimulus ? stimulus.trim().toLowerCase().replace(/\s+/g, ' ') : '';

  const combined = `${cleanContent}::${cleanImage}::${cleanChoices}::${cleanStimulus}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Recalculates and saves the content_hash for a specific question in the database.
 * Run this inside a transaction by passing the transaction `client`.
 * 
 * @param {object} client pg Client (inside transaction) or Pool
 * @param {string} questionId UUID of the question
 * @param {boolean} isUM True if the question is an Ujian Mandiri question, false for UTBK
 * @returns {Promise<string>} The newly computed content_hash
 */
async function updateQuestionHash(client, questionId, isUM = false) {
  const table = isUM ? 'um_questions' : 'questions';
  const choicesTable = isUM ? 'um_answer_choices' : 'answer_choices';
  const stimulusField = 'q.stimulus';

  const qRes = await client.query(`
    SELECT q.content, q.image_url, ${stimulusField},
           COALESCE(
             json_agg(
               json_build_object('content', ac.content)
             ) FILTER (WHERE ac.id IS NOT NULL),
             '[]'::json
           ) as choices
    FROM ${table} q
    LEFT JOIN ${choicesTable} ac ON ac.question_id = q.id
    WHERE q.id = $1
    GROUP BY q.id
  `, [questionId]);

  if (qRes.rows.length === 0) return null;
  const q = qRes.rows[0];
  const hash = generateQuestionHash(q.content, q.choices, q.image_url, q.stimulus);

  await client.query(`
    UPDATE ${table} SET content_hash = $1 WHERE id = $2
  `, [hash, questionId]);

  return hash;
}

module.exports = { generateQuestionHash, updateQuestionHash };
