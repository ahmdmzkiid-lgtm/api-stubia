const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// Create a new battle match
router.post('/create', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id;
    const { subject_id, subject_name, question_count = 5, time_per_question = 30 } = req.body;

    if (!subject_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Subject ID required' });
    }

    // Cleanup stale waiting/active matches older than 5 minutes
    await client.query(
      `UPDATE battle_matches SET status = 'completed', completed_at = NOW()
       WHERE status IN ('waiting', 'active') AND created_at < NOW() - INTERVAL '5 minutes'`
    );

    // Get battle questions first, fallback to manual questions if none exist
    let questionsRes = await client.query(
      `SELECT id FROM questions WHERE subject_id = $1 AND source = 'battle' AND workflow_status = 'approved' ORDER BY RANDOM() LIMIT $2`,
      [subject_id, question_count]
    );

    // Fallback: if no battle-specific questions, use manual questions
    if (questionsRes.rows.length === 0) {
      questionsRes = await client.query(
        `SELECT id FROM questions WHERE subject_id = $1 AND source = 'manual' AND workflow_status = 'approved' ORDER BY RANDOM() LIMIT $2`,
        [subject_id, question_count]
      );
    }

    const questionIds = questionsRes.rows.map(q => q.id);

    if (questionIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Belum ada soal untuk subtes ini.' });
    }

    // Create match
    const matchRes = await client.query(
      `INSERT INTO battle_matches (subject_id, subject_name, question_count, time_per_question, created_by, question_ids)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [subject_id, subject_name, question_count, time_per_question, userId, JSON.stringify(questionIds)]
    );
    const matchId = matchRes.rows[0].id;

    // Add creator as participant
    await client.query(
      `INSERT INTO battle_participants (match_id, user_id) VALUES ($1, $2)`,
      [matchId, userId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        match_id: matchId,
        subject_id,
        subject_name,
        question_count,
        time_per_question,
        status: 'waiting',
        question_ids: questionIds
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Battle create error:', error);
    next(error);
  } finally {
    client.release();
  }
});

// Player leaves a match (cancel waiting match or mark active match as completed)
router.post('/leave', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id;
    const { match_id } = req.body;

    if (!match_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Match ID required' });
    }

    const matchRes = await client.query(
      'SELECT id, status FROM battle_matches WHERE id = $1 FOR UPDATE',
      [match_id]
    );

    if (matchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const match = matchRes.rows[0];

    const participantsRes = await client.query(
      'SELECT id, user_id FROM battle_participants WHERE match_id = $1',
      [match_id]
    );

    const isParticipant = participantsRes.rows.some((p) => p.user_id === userId);
    if (!isParticipant) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'You are not a participant in this match' });
    }

    // If match is still waiting (typically only 1 participant), cancel it completely
    if (match.status === 'waiting') {
      await client.query('DELETE FROM battle_participants WHERE match_id = $1', [match_id]);
      await client.query('DELETE FROM battle_matches WHERE id = $1', [match_id]);
      await client.query('COMMIT');
      return res.json({ success: true, data: { status: 'cancelled' } });
    }

    // If match is active and someone leaves, mark as completed so it is no longer used
    if (match.status === 'active') {
      await client.query(
        'UPDATE battle_matches SET status = $1, completed_at = NOW() WHERE id = $2',
        ['completed', match_id]
      );
      await client.query('COMMIT');
      return res.json({ success: true, data: { status: 'completed' } });
    }

    // For already completed or other statuses, just return current status
    await client.query('COMMIT');
    return res.json({ success: true, data: { status: match.status } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Battle leave error:', error);
    next(error);
  } finally {
    client.release();
  }
});

// Join an existing battle match
router.post('/join', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id;
    const { match_id, code } = req.body;

    if (!match_id && !code) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Match ID or code required' });
    }

    let matchRes;
    if (code) {
      matchRes = await client.query(
        `SELECT id, status, subject_id, subject_name, question_count, time_per_question, question_ids
         FROM battle_matches WHERE id::text LIKE $1 AND status = 'waiting' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [code.trim().toLowerCase() + '%']
      );
    } else {
      matchRes = await client.query(
        `SELECT id, status, subject_id, subject_name, question_count, time_per_question, question_ids
         FROM battle_matches WHERE id = $1 FOR UPDATE`,
        [match_id]
      );
    }

    if (matchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Pertandingan tidak ditemukan atau sudah dimulai' });
    }

    const match = matchRes.rows[0];
    const actual_match_id = match.id;

    if (match.status !== 'waiting') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Pertandingan sudah dimulai atau selesai' });
    }

    // Check if already joined
    const participantRes = await client.query(
      'SELECT id FROM battle_participants WHERE match_id = $1 AND user_id = $2',
      [actual_match_id, userId]
    );

    if (participantRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Kamu sudah bergabung di pertandingan ini' });
    }

    // Add participant
    await client.query(
      `INSERT INTO battle_participants (match_id, user_id) VALUES ($1, $2)`,
      [actual_match_id, userId]
    );

    // Check if match is now full (2 players) and start it
    const countRes = await client.query(
      'SELECT COUNT(*) as count FROM battle_participants WHERE match_id = $1',
      [actual_match_id]
    );
    const participantCount = parseInt(countRes.rows[0].count);

    if (participantCount >= 2) {
      // Start the match: set status, started_at, and init per-question timer
      await client.query(
        `UPDATE battle_matches SET status = 'active', started_at = NOW(), current_question_index = 0, question_started_at = NOW() WHERE id = $1`,
        [actual_match_id]
      );
    }

    await client.query('COMMIT');

    // Parse question_ids
    let questionIds = match.question_ids;
    if (typeof questionIds === 'string') {
      try { questionIds = JSON.parse(questionIds); } catch (e) { questionIds = []; }
    }

    res.json({
      success: true,
      data: {
        match_id: actual_match_id,
        status: participantCount >= 2 ? 'active' : 'waiting',
        subject_id: match.subject_id,
        subject_name: match.subject_name,
        question_count: match.question_count,
        time_per_question: match.time_per_question,
        question_ids: questionIds
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Battle join error:', error);
    next(error);
  } finally {
    client.release();
  }
});

// Submit an answer
router.post('/submit-answer', verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { match_id, question_id, choice_id } = req.body;

    if (!match_id || !question_id || !choice_id) {
      return res.status(400).json({ success: false, error: 'match_id, question_id, and choice_id required' });
    }

    // Get correct answer
    const questionRes = await pool.query(
      `SELECT ac.is_correct FROM answer_choices ac WHERE ac.question_id = $1 AND ac.id = $2`,
      [question_id, choice_id]
    );

    if (questionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invalid question or choice' });
    }

    const isCorrect = questionRes.rows[0].is_correct;

    // Save answer
    await pool.query(
      `UPDATE battle_participants
       SET answers = jsonb_set(COALESCE(answers, '{}'::jsonb), $1, $2::jsonb)
       WHERE match_id = $3 AND user_id = $4`,
      [`{${question_id}}`, JSON.stringify(choice_id), match_id, userId]
    );

    if (isCorrect) {
      await pool.query(
        `UPDATE battle_participants SET correct_count = correct_count + 1 WHERE match_id = $1 AND user_id = $2`,
        [match_id, userId]
      );
    }

    res.json({ success: true, data: { is_correct: isCorrect } });
  } catch (error) {
    console.error('Battle submit answer error:', error);
    next(error);
  }
});

// Complete match and calculate final scores
router.post('/complete', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { match_id } = req.body;

    if (!match_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Match ID required' });
    }

    const matchRes = await client.query(
      `SELECT id, subject_id, subject_name, status, question_ids FROM battle_matches WHERE id = $1 FOR UPDATE`,
      [match_id]
    );

    if (matchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const match = matchRes.rows[0];

    // If already completed, just return scores
    if (match.status === 'completed') {
      const pRes = await client.query(
        `SELECT bp.user_id, bp.score FROM battle_participants bp WHERE bp.match_id = $1`,
        [match_id]
      );
      await client.query('ROLLBACK');
      const scores = pRes.rows;
      const maxScore = Math.max(...scores.map(s => s.score));
      return res.json({
        success: true,
        data: {
          match_id,
          participants: scores.map(p => ({ user_id: p.user_id, score: p.score, win: p.score === maxScore && p.score > 0 }))
        }
      });
    }

    const participantsRes = await client.query(
      `SELECT id, user_id, answers FROM battle_participants WHERE match_id = $1`,
      [match_id]
    );

    if (participantsRes.rows.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Match needs at least 2 participants' });
    }

    const p1 = participantsRes.rows[0];
    const p2 = participantsRes.rows[1];
    const answers1 = p1.answers || {};
    const answers2 = p2.answers || {};

    let questionIds = match.question_ids || [];
    if (typeof questionIds === 'string') {
      try { questionIds = JSON.parse(questionIds); } catch (e) { questionIds = []; }
    }

    let score1 = 0, score2 = 0;

    for (const qId of questionIds) {
      const correctRes = await client.query(
        'SELECT id FROM answer_choices WHERE question_id = $1 AND is_correct = true LIMIT 1',
        [qId]
      );
      if (correctRes.rows.length === 0) continue;

      const correctId = correctRes.rows[0].id;
      const p1Ok = answers1[qId] === correctId;
      const p2Ok = answers2[qId] === correctId;

      if (p1Ok && !p2Ok) { score1 += 200; }
      else if (p2Ok && !p1Ok) { score2 += 200; }
      else if (p1Ok && p2Ok) { score1 += 100; score2 += 100; }
    }

    await client.query('UPDATE battle_participants SET score = $1 WHERE id = $2', [score1, p1.id]);
    await client.query('UPDATE battle_participants SET score = $1 WHERE id = $2', [score2, p2.id]);
    await client.query(`UPDATE battle_matches SET status = 'completed', completed_at = NOW() WHERE id = $1`, [match_id]);

    // Determine match result
    const isDraw = score1 === score2;
    const p1Wins = score1 > score2;
    const p2Wins = score2 > score1;

    // Update leaderboard with Win=20, Lose=0, Draw=10
    for (const p of [p1, p2]) {
      const isP1 = p.id === p1.id;
      const isWin = isP1 ? p1Wins : p2Wins;
      const isLoss = isP1 ? p2Wins : p1Wins;
      const leaderboardPoints = isDraw ? 10 : (isWin ? 20 : 0);

      await client.query(
        `INSERT INTO battle_leaderboard (user_id, subject_id, subject_name, total_matches, wins, losses, total_points)
         VALUES ($1, $2, $3, 1, $4, $5, $6)
         ON CONFLICT (user_id, subject_id)
         DO UPDATE SET
           total_matches = battle_leaderboard.total_matches + 1,
           wins = battle_leaderboard.wins + $4,
           losses = battle_leaderboard.losses + $5,
           total_points = battle_leaderboard.total_points + $6,
           updated_at = NOW()`,
        [p.user_id, match.subject_id, match.subject_name, isWin ? 1 : 0, isLoss ? 1 : 0, leaderboardPoints]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        match_id,
        participants: [
          { user_id: p1.user_id, score: score1, win: p1Wins, draw: isDraw },
          { user_id: p2.user_id, score: score2, win: p2Wins, draw: isDraw }
        ]
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Battle complete error:', error);
    next(error);
  } finally {
    client.release();
  }
});

// =============================================
// GET routes — specific paths BEFORE /:matchId
// =============================================

// Find random waiting match
router.get('/random-match/:subjectId', verifyToken, async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const userId = req.user.id;

    const matchRes = await pool.query(
      `SELECT bm.id, bm.subject_id, bm.subject_name, bm.question_count, bm.time_per_question, bm.question_ids
       FROM battle_matches bm
       WHERE bm.status = 'waiting' AND bm.subject_id = $1
       AND bm.created_at > NOW() - INTERVAL '5 minutes'
       AND bm.id NOT IN (SELECT bp.match_id FROM battle_participants bp WHERE bp.user_id = $2)
       ORDER BY bm.created_at DESC LIMIT 1`,
      [subjectId, userId]
    );

    if (matchRes.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    let questionIds = matchRes.rows[0].question_ids;
    if (typeof questionIds === 'string') {
      try { questionIds = JSON.parse(questionIds); } catch (e) { questionIds = []; }
    }

    res.json({ success: true, data: { ...matchRes.rows[0], question_ids: questionIds } });
  } catch (error) {
    console.error('Battle random match error:', error);
    next(error);
  }
});

// Get leaderboard
router.get('/leaderboard/:subjectId', verifyToken, async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const leaderboardRes = await pool.query(
      `SELECT bl.user_id, u.name as username, u.name as full_name, bl.subject_name,
              bl.total_matches, bl.wins, bl.losses, bl.total_points,
              CASE WHEN bl.total_matches > 0 THEN ROUND((bl.wins::numeric / bl.total_matches) * 100, 1) ELSE 0 END as win_rate
       FROM battle_leaderboard bl JOIN users u ON u.id = bl.user_id
       WHERE bl.subject_id = $1 ORDER BY bl.total_points DESC, bl.wins DESC LIMIT 50`,
      [subjectId]
    );
    res.json({ success: true, data: leaderboardRes.rows });
  } catch (error) {
    console.error('Battle leaderboard error:', error);
    next(error);
  }
});

// Get questions by IDs (for battle game)
router.get('/questions', verifyToken, async (req, res, next) => {
  try {
    let { ids } = req.query;
    if (!ids) return res.json({ success: true, data: [] });

    let questionIds;
    if (typeof ids === 'string') {
      try { questionIds = JSON.parse(ids); } catch (e) { questionIds = ids.split(',').map(s => s.trim()).filter(Boolean); }
    } else if (Array.isArray(ids)) {
      questionIds = ids;
    } else {
      return res.json({ success: true, data: [] });
    }

    if (questionIds.length === 0) return res.json({ success: true, data: [] });

    const placeholders = questionIds.map((_, i) => `$${i + 1}`).join(',');
    const questionsResult = await pool.query(`SELECT * FROM questions WHERE id IN (${placeholders})`, questionIds);

    if (questionsResult.rows.length > 0) {
      const qIds = questionsResult.rows.map(q => q.id);
      const cPlaceholders = qIds.map((_, i) => `$${i + 1}`).join(',');
      const choicesResult = await pool.query(
        `SELECT * FROM answer_choices WHERE question_id IN (${cPlaceholders}) ORDER BY label ASC`, qIds
      );
      for (const question of questionsResult.rows) {
        question.choices = choicesResult.rows.filter(c => c.question_id === question.id);
      }
    }

    const ordered = questionIds.map(id => questionsResult.rows.find(q => q.id === id)).filter(Boolean);
    res.json({ success: true, data: ordered });
  } catch (error) {
    console.error('Battle get questions error:', error);
    next(error);
  }
});

// Get match status (polling) — MUST be LAST (catch-all)
router.get('/:matchId', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    // Lock the match row for potential update
    const matchRes = await client.query(
      `SELECT id, status, subject_id, subject_name, question_count, time_per_question,
              question_ids, started_at, completed_at, current_question_index, question_started_at,
              EXTRACT(EPOCH FROM (NOW() - question_started_at))::numeric(10,2) as elapsed
       FROM battle_matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );

    if (matchRes.rows.length === 0) {
      client.release();
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const match = matchRes.rows[0];

    let questionIds = match.question_ids;
    if (typeof questionIds === 'string') {
      try { questionIds = JSON.parse(questionIds); } catch (e) { questionIds = []; }
    }

    // Get participants
    const participantsRes = await client.query(
      `SELECT bp.user_id, u.name, bp.score, bp.correct_count, bp.answers, bp.joined_at
       FROM battle_participants bp JOIN users u ON u.id = bp.user_id
       WHERE bp.match_id = $1`,
      [matchId]
    );

    const participants = participantsRes.rows.map(p => ({
      user_id: p.user_id,
      username: p.name,
      full_name: p.name,
      score: p.score,
      correct_count: p.correct_count,
      answers: p.answers || {},
      is_me: p.user_id === userId
    }));

    let currentQIndex = match.current_question_index || 0;
    let timeRemaining = match.time_per_question || 30;
    let effectiveStatus = match.status;

    if (match.status === 'active' && match.question_started_at) {
      const elapsed = parseFloat(match.elapsed || 0);
      const tpq = match.time_per_question || 30;
      timeRemaining = Math.max(0, Math.ceil(tpq - elapsed));

      // Check if we should advance to next question
      let shouldAdvance = false;

      // Condition 1: Time is up for this question
      if (elapsed >= tpq) {
        shouldAdvance = true;
      }

      // Condition 2: Both players have answered the current question
      if (participantsRes.rows.length >= 2 && currentQIndex < questionIds.length) {
        const currentQuestionId = questionIds[currentQIndex];
        const allAnswered = participantsRes.rows.every(p => {
          const answers = p.answers || {};
          return answers[currentQuestionId] !== undefined;
        });
        if (allAnswered) {
          shouldAdvance = true;
        }
      }

      // Advance to next question
      if (shouldAdvance) {
        const nextIndex = currentQIndex + 1;
        if (nextIndex >= match.question_count) {
          // All questions done — game over
          effectiveStatus = 'time_up';
          currentQIndex = match.question_count - 1;
          timeRemaining = 0;
        } else {
          // Move to next question and reset timer
          await client.query(
            `UPDATE battle_matches SET current_question_index = $1, question_started_at = NOW() WHERE id = $2`,
            [nextIndex, matchId]
          );
          currentQIndex = nextIndex;
          timeRemaining = tpq;
        }
      }
    }

    client.release();

    res.json({
      success: true,
      data: {
        match_id: match.id,
        status: effectiveStatus,
        subject_id: match.subject_id,
        subject_name: match.subject_name,
        question_count: match.question_count,
        time_per_question: match.time_per_question,
        question_ids: questionIds,
        started_at: match.started_at,
        completed_at: match.completed_at,
        current_question_index: currentQIndex,
        time_remaining: timeRemaining,
        participants
      }
    });
  } catch (error) {
    client.release();
    console.error('Battle get status error:', error);
    next(error);
  }
});

module.exports = router;
