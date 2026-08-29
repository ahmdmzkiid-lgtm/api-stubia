/**
 * Database Migration / Cleanup Script:
 * Fix double-encoding in questions and choices where HTML entities (&amp;, &gt;, &lt;)
 * were stored inside LaTeX formulas or question content.
 */

const { pool } = require('../config/db');

function cleanHtmlEntitiesInLatex(text) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text;

  const decode = (str) => {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  };

  // 1. Clean $$...$$
  cleaned = cleaned.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => `$$${decode(latex)}$$`);

  // 2. Clean \[...\]
  cleaned = cleaned.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) => `\\[${decode(latex)}\\]`);

  // 3. Clean \(...\)
  cleaned = cleaned.replace(/\\\(([\s\S]*?)\\\)/g, (_, latex) => `\\(${decode(latex)}\\)`);

  // 4. Clean $...$
  cleaned = cleaned.replace(/(^|[^\\])\$([^\$]+?)\$/g, (match, prefix, latex) => `${prefix}$${decode(latex)}$`);

  // 5. Clean \begin{...}...\end{...}
  const envPattern = /\\begin\{(matrix|pmatrix|bmatrix|vmatrix|Vmatrix|aligned|align|gather|cases|array)\}([\s\S]*?)\\end\{\1\}/g;
  cleaned = cleaned.replace(envPattern, (match, envName, body) => `\\begin{${envName}}${decode(body)}\\end{${envName}}`);

  // 6. If whole string contains plain math inequalities without $ (e.g. p &lt; q &lt; r), clean them as well
  cleaned = cleaned.replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  return cleaned;
}

async function runCleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('[Cleanup] Scanning questions table for HTML entities...');

    const res = await client.query(
      "SELECT id, content, stimulus FROM questions WHERE content ILIKE '%&amp;%' OR content ILIKE '%&gt;%' OR content ILIKE '%&lt;%' OR stimulus ILIKE '%&amp;%' OR stimulus ILIKE '%&gt;%' OR stimulus ILIKE '%&lt;%'"
    );

    console.log(`[Cleanup] Found ${res.rows.length} affected questions.`);

    for (const row of res.rows) {
      const updatedContent = cleanHtmlEntitiesInLatex(row.content);
      const updatedStimulus = cleanHtmlEntitiesInLatex(row.stimulus);

      await client.query(
        'UPDATE questions SET content = $1, stimulus = $2 WHERE id = $3',
        [updatedContent, updatedStimulus, row.id]
      );
      console.log(`[Cleanup] Fixed question ID: ${row.id}`);
      console.log(`  Before: ${row.content}`);
      console.log(`  After:  ${updatedContent}`);
    }

    // Check answer_choices as well
    const choiceRes = await client.query(
      "SELECT id, content, explanation FROM answer_choices WHERE content ILIKE '%&amp;%' OR content ILIKE '%&gt;%' OR content ILIKE '%&lt;%' OR explanation ILIKE '%&amp;%' OR explanation ILIKE '%&gt;%' OR explanation ILIKE '%&lt;%'"
    );
    console.log(`[Cleanup] Found ${choiceRes.rows.length} affected answer choices.`);

    for (const row of choiceRes.rows) {
      const updatedContent = cleanHtmlEntitiesInLatex(row.content);
      const updatedExplanation = cleanHtmlEntitiesInLatex(row.explanation);

      await client.query(
        'UPDATE answer_choices SET content = $1, explanation = $2 WHERE id = $3',
        [updatedContent, updatedExplanation, row.id]
      );
      console.log(`[Cleanup] Fixed choice ID: ${row.id}`);
    }

    await client.query('COMMIT');
    console.log('[Cleanup] Successfully completed database cleanup!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Cleanup Error]:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runCleanup();
}

module.exports = { cleanHtmlEntitiesInLatex, runCleanup };
