const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { verifyToken } = require("../middleware/auth");
const { calculateIRTScore, batchUpdateItemStats, getItemStatsForQuestions } = require("../services/irtScoringService");
const {
  checkLatihanAccess,
  assertUtbkGratisContentAccess,
  assertUmGratisContentAccess,
  hasActiveUtbkSubscription,
  hasActiveUmSubscription,
  isAdminUser,
  SOCIAL_VERIFY_MSG,
} = require("../utils/latihanAccessUtil");

// Submit latihan (practice) result with IRT scoring
router.post("/latihan/submit", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      subject_id,
      subject_name,
      topic_id,
      latihan_id,
      questions,
      answers,
    } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Questions data required" });
    }

    if (!(await isAdminUser(userId, req.user.role))) {
      if (latihan_id) {
        const hasUm = await hasActiveUmSubscription(userId);
        if (!hasUm) {
          const planBlock = await assertUmGratisContentAccess(latihan_id);
          if (planBlock)
            return res.status(403).json({ success: false, ...planBlock });

          const latihanCountRes = await pool.query(
            "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1 AND latihan_id = $2 AND submitted_at IS NOT NULL",
            [userId, latihan_id],
          );
          if (parseInt(latihanCountRes.rows[0].count, 10) >= 1) {
            return res.status(403).json({
              success: false,
              error:
                "Akun gratis hanya dapat mengerjakan setiap latihan soal sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
              code: "FREE_LIMIT_REACHED",
            });
          }

          const access = await checkLatihanAccess(userId);
          if (!access.allowed) {
            return res.status(403).json({
              success: false,
              error: SOCIAL_VERIFY_MSG,
              code: access.code || "FREE_LIMIT_REQUIRE_SOCIAL",
            });
          }
        }
      } else {
        // Check if global UTBK Latihan Soal is active
        const settingsRes = await pool.query("SELECT value FROM site_settings WHERE key = 'latihan_utbk_active'");
        const isLatihanActive = settingsRes.rows.length === 0 || settingsRes.rows[0].value !== 'false';
        if (!isLatihanActive) {
          return res.status(403).json({
            success: false,
            error: "Latihan Soal UTBK sedang tidak aktif untuk sementara.",
            code: "LATIHAN_UTBK_INACTIVE"
          });
        }

        const hasUtbk = await hasActiveUtbkSubscription(userId);
        if (!hasUtbk) {
          const planBlock = await assertUtbkGratisContentAccess(
            subject_id,
            topic_id,
          );
          if (planBlock)
            return res.status(403).json({ success: false, ...planBlock });

          let completed = 0;
          if (topic_id) {
            const r = await pool.query(
              "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1 AND topic_id = $2 AND submitted_at IS NOT NULL",
              [userId, topic_id],
            );
            completed = parseInt(r.rows[0].count, 10);
          } else if (subject_id) {
            const r = await pool.query(
              "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1 AND subject_id = $2 AND submitted_at IS NOT NULL",
              [userId, subject_id],
            );
            completed = parseInt(r.rows[0].count, 10);
          }
          if (completed >= 1) {
            return res.status(403).json({
              success: false,
              error:
                "Akun gratis hanya dapat mengerjakan setiap latihan soal sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
              code: "FREE_LIMIT_REACHED",
            });
          }

          const access = await checkLatihanAccess(userId);
          if (!access.allowed) {
            return res.status(403).json({
              success: false,
              error: SOCIAL_VERIFY_MSG,
              code: access.code || "FREE_LIMIT_REQUIRE_SOCIAL",
            });
          }
        }
      }
    }

    // Fetch true question data and choices securely from database
    const questionIds = questions.map((q) => q.id).filter(Boolean);
    let dbQuestionsMap = new Map();

    if (questionIds.length > 0) {
      if (latihan_id) {
        const dbRes = await pool.query(
          `SELECT q.id, q.difficulty, q.question_type,
                  COALESCE(json_agg(json_build_object(
                    'id', ac.id, 'label', ac.label, 'content', ac.content,
                    'is_correct', ac.is_correct
                  ) ORDER BY ac.label) FILTER (WHERE ac.id IS NOT NULL), '[]') as choices
           FROM um_questions q
           LEFT JOIN um_answer_choices ac ON ac.question_id = q.id
           WHERE q.id = ANY($1::uuid[])
           GROUP BY q.id`,
          [questionIds]
        );
        dbRes.rows.forEach((r) => dbQuestionsMap.set(r.id, r));
      } else {
        const dbRes = await pool.query(
          `SELECT q.id, q.difficulty, q.question_type, s.name as subject_name,
                  COALESCE(json_agg(json_build_object(
                    'id', ac.id, 'label', ac.label, 'content', ac.content,
                    'is_correct', ac.is_correct
                  ) ORDER BY ac.label) FILTER (WHERE ac.id IS NOT NULL), '[]') as choices
           FROM questions q
           LEFT JOIN subjects s ON q.subject_id = s.id
           LEFT JOIN answer_choices ac ON ac.question_id = q.id
           WHERE q.id = ANY($1::uuid[])
           GROUP BY q.id, s.name`,
          [questionIds]
        );
        dbRes.rows.forEach((r) => dbQuestionsMap.set(r.id, r));
      }
    }

    // Build IRT answer objects securely verified from DB
    const irtAnswers = questions.map((q, idx) => {
      const dbQ = dbQuestionsMap.get(q.id);
      const dbChoices = dbQ ? (Array.isArray(dbQ.choices) ? dbQ.choices : []) : [];
      const questionType = dbQ?.question_type || q.question_type || "multiple_choice";
      const difficulty = dbQ?.difficulty || q.difficulty || "medium";
      const resolvedSubject = dbQ?.subject_name || subject_name || "Latihan";

      const chosenId = answers[idx] || answers[String(idx)] || null;
      let isCorrect = false;

      if (questionType === "short_answer") {
        const correctChoice = dbChoices.find((c) => c.is_correct === true);
        isCorrect = !!(
          correctChoice &&
          chosenId &&
          correctChoice.content.trim().toLowerCase() ===
            String(chosenId).trim().toLowerCase()
        );
      } else if (questionType === "complex_mc_tf") {
        let userAnswersObj = {};
        try {
          userAnswersObj = chosenId ? (typeof chosenId === "object" ? chosenId : JSON.parse(chosenId)) : {};
        } catch (e) {}
        isCorrect = dbChoices.length > 0 && dbChoices.every((c) => {
          const studentAns = userAnswersObj[c.label];
          return studentAns !== undefined && studentAns === (c.is_correct === true);
        });
      } else {
        const chosenChoice = chosenId
          ? dbChoices.find((c) => c.id === chosenId)
          : null;
        isCorrect = chosenChoice?.is_correct === true;
      }

      return {
        chosen_choice_id: (questionType === "short_answer" || questionType === "complex_mc_tf") ? null : chosenId,
        answer_text: (questionType === "short_answer" || questionType === "complex_mc_tf") ? chosenId : null,
        is_correct: isCorrect,
        question_id: q.id,
        question_type: questionType,
        difficulty: difficulty,
        subject_name: resolvedSubject,
        time_spent_sec: 0,
      };
    });

    const totalQuestions = questions.length;

    // If latihan_id is provided, use custom scoring from um_latihan_soal
    let irtResult;
    let customScoring = null;
    if (latihan_id) {
      const latihanRes = await pool.query(
        "SELECT points_correct, points_incorrect, points_unanswered FROM um_latihan_soal WHERE id = $1",
        [latihan_id],
      );
      const ptCorrect = latihanRes.rows[0]?.points_correct ?? 4;
      const ptIncorrect = latihanRes.rows[0]?.points_incorrect ?? -1;
      const ptUnanswered = latihanRes.rows[0]?.points_unanswered ?? 0;

      const correctCount = irtAnswers.filter((a) => a.is_correct).length;
      const unansweredCount = irtAnswers.filter((a) => {
        const isTextBased = a.question_type === "short_answer" || a.question_type === "complex_mc_tf";
        return isTextBased
          ? (!a.answer_text || String(a.answer_text).trim() === '')
          : !a.chosen_choice_id;
      }).length;
      const incorrectCount = totalQuestions - correctCount - unansweredCount;
      const customScore =
        correctCount * ptCorrect +
        incorrectCount * ptIncorrect +
        unansweredCount * ptUnanswered;

      customScoring = { ptCorrect, ptIncorrect, ptUnanswered };

      // Build a compatible irtResult object for storage
      irtResult = {
        benar: correctCount,
        salah: incorrectCount,
        kosong: unansweredCount,
        total: totalQuestions,
        totalScore: customScore,
        theta: 0,
        percentile: 0,
        mastery:
          totalQuestions > 0
            ? Math.round((correctCount / totalQuestions) * 100)
            : 0,
        pointsCorrect: ptCorrect,
        pointsIncorrect: ptIncorrect,
        pointsUnanswered: ptUnanswered,
        scoringMethod: `Custom (Benar: ${ptCorrect > 0 ? "+" : ""}${ptCorrect}, Salah: ${ptIncorrect > 0 ? "+" : ""}${ptIncorrect}, Kosong: ${ptUnanswered > 0 ? "+" : ""}${ptUnanswered})`,
        itemAnalysis: irtAnswers.map((a, idx) => ({
          questionIndex: idx,
          questionId: a.question_id,
          difficulty: a.difficulty || "medium",
          isCorrect: a.is_correct,
          chosenChoiceId: a.chosen_choice_id,
          answerText: a.answer_text || null,
          subjectName: a.subject_name || "Latihan",
        })),
      };
    } else {
      // Fetch calibrated IRT parameters from empirical data
      const questionIds = irtAnswers.map(a => a.question_id).filter(Boolean);
      const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);

      // Inject calibrated params into each answer
      const calibratedAnswers = irtAnswers.map(a => ({
        ...a,
        irtParams: itemStatsMap[a.question_id] || undefined,
      }));

      // Calculate IRT score with calibrated parameters
      irtResult = calculateIRTScore(calibratedAnswers);
      // Add calibration metadata
      irtResult.calibrationInfo = {
        totalCalibrated: questionIds.filter(id => itemStatsMap[id]?.calibrated).length,
        totalPartial: questionIds.filter(id => itemStatsMap[id]?.calibrated === 'partial').length,
        totalDefault: questionIds.filter(id => !itemStatsMap[id] || !itemStatsMap[id].calibrated).length,
      };
    }

    // Update item statistics for all answered questions (non-blocking)
    batchUpdateItemStats(pool, irtAnswers).catch(err =>
      console.error('[LATIHAN] Error updating item stats:', err.message)
    );

    const correctCount = irtResult.benar;
    const incorrectCount = irtResult.salah;
    const unansweredCount = irtResult.kosong;

    // Save to latihan_sessions
    const insertRes = await pool.query(
      `
      INSERT INTO latihan_sessions
        (user_id, subject_id, topic_id, latihan_id, subject_name, total_questions, correct_count, incorrect_count, unanswered_count, irt_score, theta, percentile, score_breakdown)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `,
      [
        userId,
        subject_id,
        topic_id || null,
        latihan_id || null,
        subject_name,
        totalQuestions,
        correctCount,
        incorrectCount,
        unansweredCount,
        irtResult.totalScore,
        irtResult.theta || 0,
        irtResult.percentile || 0,
        JSON.stringify(irtResult),
      ],
    );

    res.json({
      success: true,
      data: {
        sessionId: insertRes.rows[0].id,
        irtScore: irtResult.totalScore,
        theta: irtResult.theta || 0,
        percentile: irtResult.percentile || 0,
        correct: correctCount,
        incorrect: incorrectCount,
        unanswered: unansweredCount,
        total: totalQuestions,
        mastery: irtResult.mastery,
        ...(customScoring
          ? {
              pointsCorrect: customScoring.ptCorrect,
              pointsIncorrect: customScoring.ptIncorrect,
              pointsUnanswered: customScoring.ptUnanswered,
              scoringMethod: irtResult.scoringMethod,
            }
          : {}),
      },
    });
  } catch (error) {
    console.error("Error submitting latihan:", error);
    next(error);
  }
});

// Get full riwayat (history) with real-time data
router.get("/riwayat", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get all submitted tryout sessions WITH the dominant subject of each session
    // (a session typically covers one subtest — we identify it via the most common subject)
    const tryoutRes = await pool.query(
      `
      SELECT
        ts.id,
        ts.package_id,
        tp.title as name,
        tp.subject_config,
        ts.started_at,
        ts.submitted_at,
        ts.total_score as score,
        ts.score_breakdown,
        (
          SELECT s.name
          FROM user_answers ua
          JOIN questions q ON ua.question_id = q.id
          LEFT JOIN subjects s ON q.subject_id = s.id
          WHERE ua.session_id = ts.id AND s.name IS NOT NULL
          GROUP BY s.name
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) AS subtest_name
      FROM tryout_sessions ts
      JOIN tryout_packages tp ON tp.id = ts.package_id
      WHERE ts.user_id = $1 AND ts.submitted_at IS NOT NULL
      ORDER BY ts.started_at ASC
    `,
      [userId],
    );

    // Get all latihan sessions
    const latihanRes = await pool.query(
      `
      SELECT
        id,
        'latihan' as type,
        subject_name as name,
        subject_id,
        topic_id,
        latihan_id,
        total_questions,
        correct_count,
        irt_score as score,
        theta,
        percentile,
        score_breakdown,
        started_at,
        submitted_at
      FROM latihan_sessions
      WHERE user_id = $1
      ORDER BY submitted_at DESC
    `,
      [userId],
    );

    // Get all Ujian Mandiri tryout sessions
    const umTryoutRes = await pool.query(
      `
      SELECT
        ts.id,
        ts.package_id,
        tp.title as name,
        um.nama_ujian as ujian_name,
        tp.ujian_id,
        ts.started_at,
        ts.submitted_at,
        ts.total_score as score,
        ts.score_breakdown
      FROM um_tryout_sessions ts
      JOIN um_tryout_packages tp ON ts.package_id = tp.id
      JOIN ujian_mandiri um ON tp.ujian_id = um.id
      WHERE ts.user_id = $1 AND ts.submitted_at IS NOT NULL
      ORDER BY ts.submitted_at DESC
    `,
      [userId],
    );

    // Get all TKA tryout sessions
    const tkaTryoutRes = await pool.query(
      `
      SELECT
        ts.id,
        ts.package_id,
        ts.education_level,
        tp.title as name,
        ts.started_at,
        ts.submitted_at,
        ts.total_score as score,
        ts.score_breakdown
      FROM tka_tryout_sessions ts
      JOIN tka_tryout_packages tp ON ts.package_id = tp.id
      WHERE ts.user_id = $1 AND ts.submitted_at IS NOT NULL
      ORDER BY ts.submitted_at DESC
    `,
      [userId],
    );

    // Get all TKA latihan sessions
    const tkaLatihanRes = await pool.query(
      `
      SELECT
        l.id,
        l.education_level,
        sub.name as name,
        l.subject_id,
        l.topic_id,
        l.total_questions,
        l.correct_count,
        l.total_score as score,
        l.started_at,
        l.submitted_at
      FROM tka_latihan_sessions l
      LEFT JOIN tka_subjects sub ON l.subject_id = sub.id
      WHERE l.user_id = $1 AND l.submitted_at IS NOT NULL
      ORDER BY l.submitted_at DESC
    `,
      [userId],
    );

    // Group tryout sessions into ATTEMPTS: per package, sessions are walked chronologically;
    // a new attempt starts when we encounter a subtest already present in the current group,
    // OR when more than 12 hours has passed since the last session in the group.
    // This correctly handles repeated attempts of the same subtest.
    const openGroupByPackage = new Map(); // package_id -> current open group
    const allGroups = [];

    tryoutRes.rows.forEach((row) => {
      const subtest = row.subtest_name || "Unknown";
      const startedAt = new Date(row.started_at);
      let group = openGroupByPackage.get(row.package_id);

      let subjectConfig = row.subject_config;
      if (typeof subjectConfig === "string") {
        try {
          subjectConfig = JSON.parse(subjectConfig);
        } catch {
          subjectConfig = [];
        }
      }
      const totalSubtests = Array.isArray(subjectConfig) && subjectConfig.length > 0 ? subjectConfig.length : 7;

      const timeSinceLast = group
        ? (startedAt - new Date(group.latestStartedAt)) / 3600000
        : Infinity; // hours
      const subtestAlreadyUsed = group && group.subtestSet.has(subtest);

      if (!group || subtestAlreadyUsed || timeSinceLast > 12) {
        // Start a new attempt
        group = {
          package_id: row.package_id,
          name: row.name,
          totalSubtests: totalSubtests,
          sessions: [],
          subtestSet: new Set(),
          earliestStartedAt: row.started_at,
          latestStartedAt: row.started_at,
          latestSubmittedAt: row.submitted_at,
        };
        openGroupByPackage.set(row.package_id, group);
        allGroups.push(group);
      }

      group.sessions.push(row);
      group.subtestSet.add(subtest);
      if (startedAt > new Date(group.latestStartedAt))
        group.latestStartedAt = row.started_at;
      if (
        row.submitted_at &&
        (!group.latestSubmittedAt ||
          new Date(row.submitted_at) > new Date(group.latestSubmittedAt))
      ) {
        group.latestSubmittedAt = row.submitted_at;
      }
    });

    const allSessionIds = tryoutRes.rows.map((r) => r.id);
    const groupAnswersMap = new Map();
    if (allSessionIds.length > 0) {
      try {
        const ansRes = await pool.query(
          `SELECT
             ua.session_id,
             ua.question_id,
             ua.chosen_choice_id,
             ua.is_correct,
             ua.time_spent_sec,
             ua.answer_text,
             q.difficulty,
             q.question_type,
             s.name AS subject_name
           FROM user_answers ua
           JOIN questions q ON ua.question_id = q.id
           LEFT JOIN subjects s ON q.subject_id = s.id
           WHERE ua.session_id = ANY($1)
           ORDER BY ua.session_id, q.id`,
          [allSessionIds]
        );
        ansRes.rows.forEach((row) => {
          if (!groupAnswersMap.has(row.session_id)) groupAnswersMap.set(row.session_id, []);
          groupAnswersMap.get(row.session_id).push(row);
        });
      } catch (err) {
        console.error("[ACTIVITY] Failed to fetch session answers:", err.message);
      }
    }

    const tryoutGroups = { values: () => allGroups };

    // Build aggregated tryout history: one entry per group, score = live IRT of completed attempt
    const tryoutHistory = await Promise.all(Array.from(tryoutGroups.values()).map(async (group) => {
      const breakdowns = group.sessions.map((s) => {
        try {
          return typeof s.score_breakdown === "string"
            ? JSON.parse(s.score_breakdown)
            : s.score_breakdown || {};
        } catch {
          return {};
        }
      });

      // Aggregate subjectScores from all sessions in this group
      const aggregatedSubjects = {};
      breakdowns.forEach((b) => {
        if (b.subjectScores) {
          Object.entries(b.subjectScores).forEach(([subjName, subjData]) => {
            if (
              !aggregatedSubjects[subjName] ||
              (subjData.score || 0) > (aggregatedSubjects[subjName].score || 0)
            ) {
              aggregatedSubjects[subjName] = subjData;
            }
          });
        }
      });

      const totalSubtests = group.totalSubtests || 7;
      const isCompleted = group.sessions.length >= totalSubtests;

      // Compute full combined IRT score across all subtests for completed attempts
      let fullTryoutScore = null;
      let calculatedTheta = null;
      let calculatedPercentile = null;

      if (isCompleted) {
        const groupSessionIds = group.sessions.map((s) => s.id);
        const allGroupAnswers = [];
        groupSessionIds.forEach((sId) => {
          const ansList = groupAnswersMap.get(sId) || [];
          allGroupAnswers.push(...ansList);
        });

        if (allGroupAnswers.length > 0) {
          try {
            const questionIds = allGroupAnswers.map((a) => a.question_id);
            const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);
            const irtAnswers = allGroupAnswers.map((ans) => ({
              chosen_choice_id: ans.chosen_choice_id,
              is_correct: ans.is_correct === true,
              question_id: ans.question_id,
              difficulty: ans.difficulty || "medium",
              subject_name: ans.subject_name,
              time_spent_sec: ans.time_spent_sec || 0,
              question_type: ans.question_type,
              answer_text: ans.answer_text,
              irtParams: itemStatsMap[ans.question_id] || undefined,
            }));
            const computedIRT = calculateIRTScore(irtAnswers);
            if (typeof computedIRT.totalScore === "number" && !isNaN(computedIRT.totalScore)) {
              fullTryoutScore = Math.round(computedIRT.totalScore);
              calculatedTheta = computedIRT.theta;
              calculatedPercentile = computedIRT.percentile;
              // Persist to all sessions in group
              pool.query(
                `UPDATE tryout_sessions SET total_score = $1, score_breakdown = $2 WHERE id = ANY($3)`,
                [computedIRT.totalScore, JSON.stringify(computedIRT), groupSessionIds]
              ).catch(() => {});
            }
          } catch (err) {
            console.error("[ACTIVITY] IRT calculation error:", err.message);
          }
        }
      }

      // Check if any breakdown in this attempt has combined totalScore
      if (fullTryoutScore === null) {
        for (const b of breakdowns) {
          if (typeof b.totalScore === "number" && !isNaN(b.totalScore) && b.totalScore > 0) {
            fullTryoutScore = Math.round(b.totalScore);
            break;
          }
        }
      }

      // Check if sessions have consistent combined score
      if (fullTryoutScore === null) {
        const scores = group.sessions
          .map((s) => Number(s.score))
          .filter((s) => !isNaN(s) && s > 0);
        if (scores.length > 0) {
          const allSame = scores.every((sc) => sc === scores[0]);
          if (allSame) {
            fullTryoutScore = Math.round(scores[0]);
          }
        }
      }

      // Total = full combined tryout score, or breakdown totalScore, or latest session score
      const subjScores = Object.values(aggregatedSubjects).map(
        (s) => s.score || 0,
      );
      const aggregatedScore =
        fullTryoutScore !== null
          ? fullTryoutScore
          : (breakdowns[0]?.totalScore ||
             (subjScores.length > 0 ? Math.round(subjScores.reduce((a, b) => a + b, 0) / subjScores.length) : (group.sessions[0]?.score || 0)));

      // Average theta + percentile across sessions
      const thetas = breakdowns
        .map((b) => b.theta)
        .filter((t) => typeof t === "number");
      const percentiles = breakdowns
        .map((b) => b.percentile)
        .filter((p) => typeof p === "number");
      const masteries = breakdowns
        .map((b) => b.mastery)
        .filter((m) => typeof m === "number");

      return {
        id: group.sessions[0].id, // use first session id as representative
        sessionIds: group.sessions.map((s) => s.id),
        packageId: group.package_id,
        type: "tryout",
        name: group.name,
        score: aggregatedScore,
        theta:
          thetas.length > 0
            ? thetas.reduce((a, b) => a + b, 0) / thetas.length
            : 0,
        percentile:
          percentiles.length > 0
            ? Math.round(
                percentiles.reduce((a, b) => a + b, 0) / percentiles.length,
              )
            : 0,
        mastery:
          masteries.length > 0
            ? Math.round(
                masteries.reduce((a, b) => a + b, 0) / masteries.length,
              )
            : 0,
        subtestCount: group.sessions.length,
        totalSubtests: totalSubtests,
        isCompleted: isCompleted,
        date: group.latestSubmittedAt || group.earliestStartedAt,
      };
    }));

    // Format Ujian Mandiri tryout entries
    const umTryoutHistory = umTryoutRes.rows.map((row) => {
      let b = {};
      try {
        b =
          typeof row.score_breakdown === "string"
            ? JSON.parse(row.score_breakdown)
            : row.score_breakdown || {};
      } catch {
        b = {};
      }

      return {
        id: row.id,
        packageId: row.package_id,
        ujianId: row.ujian_id,
        type: "ujian_mandiri_tryout",
        name: `${row.ujian_name} - ${row.name}`,
        score: row.score || 0,
        theta: 0,
        percentile: 0,
        mastery: b.total && b.benar ? Math.round((b.benar / b.total) * 100) : 0,
        date: row.submitted_at || row.started_at,
        correct: b.benar || 0,
        total: b.total || 0,
      };
    });

    // Format latihan entries
    const latihanHistory = latihanRes.rows.map((row) => ({
      id: row.id,
      type: row.latihan_id ? "ujian_mandiri_latihan" : "latihan",
      name: row.name || "Latihan",
      subject_id: row.subject_id,
      topic_id: row.topic_id,
      score: row.score || 0,
      theta: row.theta || 0,
      percentile: row.percentile || 0,
      mastery:
        row.correct_count && row.total_questions
          ? Math.round((row.correct_count / row.total_questions) * 100)
          : 0,
      date: row.submitted_at || row.started_at,
      correct: row.correct_count,
      total: row.total_questions,
    }));

    // Format TKA tryout entries
    const tkaTryoutHistory = tkaTryoutRes.rows.map((row) => ({
      id: row.id,
      packageId: row.package_id,
      education_level: row.education_level,
      type: "tka_tryout",
      name: `Tryout TKA ${row.education_level} - ${row.name}`,
      score: row.score || 0,
      theta: 0,
      percentile: 0,
      mastery: 0,
      date: row.submitted_at || row.started_at,
    }));

    // Format TKA latihan entries
    const tkaLatihanHistory = tkaLatihanRes.rows.map((row) => ({
      id: row.id,
      education_level: row.education_level,
      type: "tka_latihan",
      name: `Latihan TKA ${row.education_level} - ${row.name || 'TKA'}`,
      subject_id: row.subject_id,
      topic_id: row.topic_id,
      score: row.score || 0,
      theta: 0,
      percentile: 0,
      mastery: row.correct_count && row.total_questions ? Math.round((row.correct_count / row.total_questions) * 100) : 0,
      date: row.submitted_at || row.started_at,
      correct: row.correct_count,
      total: row.total_questions,
    }));

    // Filter tryoutHistory to ONLY include completed tryout attempts (where all 7 subtests were finished)
    // Single-subtest / in-progress attempts must not enter riwayat or result until all 7 subtests are completed
    const completedTryouts = tryoutHistory.filter((h) => h.isCompleted);

    // Combine and sort by date (only completed tryouts appear in riwayat history)
    const allHistory = [
      ...completedTryouts,
      ...latihanHistory,
      ...umTryoutHistory,
      ...tkaTryoutHistory,
      ...tkaLatihanHistory,
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate summary stats using completed tryouts
    const statsHistory = [
      ...completedTryouts,
      ...latihanHistory,
      ...umTryoutHistory,
      ...tkaTryoutHistory,
      ...tkaLatihanHistory,
    ];

    const allScores = statsHistory.filter((h) => h.score > 0).map((h) => h.score);
    const avgScore =
      allScores.length > 0
        ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
        : 0;
    const totalTryouts = tryoutHistory.length + umTryoutHistory.length;
    const totalLatihan = latihanHistory.length;

    // Best percentile from the latest entry
    const latestPercentile =
      allHistory.find((h) => h.percentile > 0)?.percentile || 0;

    // Score trend (last 10 entries with scores, chronological)
    const scoreTrend = allHistory
      .filter((h) => h.score > 0)
      .slice(0, 10)
      .reverse()
      .map((h) => ({
        date: h.date,
        score: h.score,
        type: h.type,
        name: h.name,
      }));

    // Score change from previous month
    const now = new Date();
    const oneMonthAgo = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      now.getDate(),
    );
    const thisMonthScores = allScores.filter(
      (_, i) => new Date(allHistory[i]?.date) >= oneMonthAgo,
    );
    const prevMonthScores = allScores.filter((_, i) => {
      const d = new Date(allHistory[i]?.date);
      return d < oneMonthAgo;
    });
    const thisMonthAvg =
      thisMonthScores.length > 0
        ? thisMonthScores.reduce((a, b) => a + b, 0) / thisMonthScores.length
        : 0;
    const prevMonthAvg =
      prevMonthScores.length > 0
        ? prevMonthScores.reduce((a, b) => a + b, 0) / prevMonthScores.length
        : 0;
    const scoreChange =
      prevMonthAvg > 0
        ? Math.round(
            ((thisMonthAvg - prevMonthAvg) / prevMonthAvg) * 100 * 10,
          ) / 10
        : 0;

    // Subject strength breakdown (from latihan data)
    const subjectMap = {};
    latihanHistory.forEach((h) => {
      if (!subjectMap[h.name]) {
        subjectMap[h.name] = { scores: [], correct: 0, total: 0 };
      }
      subjectMap[h.name].scores.push(h.score);
      subjectMap[h.name].correct += h.correct || 0;
      subjectMap[h.name].total += h.total || 0;
    });
    const subjectStrength = Object.entries(subjectMap)
      .map(([name, data]) => ({
        name,
        avgScore: Math.round(
          data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
        ),
        mastery:
          data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0,
        attempts: data.scores.length,
      }))
      .sort((a, b) => b.avgScore - a.avgScore);

    res.json({
      success: true,
      data: {
        summary: {
          avgScore,
          totalExams: totalTryouts + totalLatihan,
          totalTryouts,
          totalLatihan,
          percentile: latestPercentile,
          scoreChange,
        },
        scoreTrend,
        history: allHistory,
        subjectStrength,
      },
    });
  } catch (error) {
    console.error("Riwayat error:", error);
    next(error);
  }
});

// Get user's recent activities (tryout & latihan)
router.get("/", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get recent tryout sessions with dominant subtest for proper attempt grouping
    const tryoutSql = `
      SELECT
        ts.id,
        ts.package_id,
        tp.title as name,
        ts.started_at as started_at,
        ts.submitted_at,
        ts.total_score as score,
        ts.score_breakdown,
        (
          SELECT s.name
          FROM user_answers ua
          JOIN questions q ON ua.question_id = q.id
          LEFT JOIN subjects s ON q.subject_id = s.id
          WHERE ua.session_id = ts.id AND s.name IS NOT NULL
          GROUP BY s.name
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) AS subtest_name
      FROM tryout_sessions ts
      JOIN tryout_packages tp ON tp.id = ts.package_id
      WHERE ts.user_id = $1
      ORDER BY ts.started_at ASC
      LIMIT 100
    `;

    // Get recent Ujian Mandiri tryouts
    const umTryoutSql = `
      SELECT
        ts.id,
        ts.package_id,
        tp.title as name,
        um.nama_ujian as ujian_name,
        tp.ujian_id,
        ts.started_at,
        ts.submitted_at,
        ts.total_score as score,
        ts.score_breakdown
      FROM um_tryout_sessions ts
      JOIN um_tryout_packages tp ON ts.package_id = tp.id
      JOIN ujian_mandiri um ON tp.ujian_id = um.id
      WHERE ts.user_id = $1
      ORDER BY ts.started_at DESC
      LIMIT 10
    `;

    // Get recent latihan sessions for this user
    const latihanSql = `
      SELECT
        ls.id,
        'latihan' as type,
        COALESCE(s.name, ls.subject_name) as name,
        s.bg_color,
        s.icon_color,
        s.icon,
        ls.created_at as started_at,
        ls.submitted_at,
        ls.irt_score as score,
        ls.score_breakdown,
        ls.correct_count,
        ls.total_questions,
        ls.subject_id,
        ls.topic_id
      FROM latihan_sessions ls
      LEFT JOIN subjects s ON s.id = ls.subject_id
      WHERE ls.user_id = $1
      ORDER BY ls.created_at DESC
      LIMIT 10
    `;

    const [tryoutResult, latihanResult, umTryoutResult] = await Promise.all([
      pool.query(tryoutSql, [userId]),
      pool.query(latihanSql, [userId]),
      pool.query(umTryoutSql, [userId]),
    ]);

    // Group recent tryout sessions into ATTEMPTS (same logic as /riwayat)
    const openByPkg = new Map();
    const recentGroupsArr = [];
    tryoutResult.rows.forEach((row) => {
      const subtest = row.subtest_name || "Unknown";
      const startedAt = new Date(row.started_at);
      let g = openByPkg.get(row.package_id);
      const timeSinceLast = g
        ? (startedAt - new Date(g.latestStartedAt)) / 3600000
        : Infinity;
      const subtestUsed = g && g.subtestSet.has(subtest);
      if (!g || subtestUsed || timeSinceLast > 12) {
        g = {
          package_id: row.package_id,
          name: row.name,
          sessions: [],
          subtestSet: new Set(),
          latestStartedAt: row.started_at,
          latestSubmittedAt: row.submitted_at,
        };
        openByPkg.set(row.package_id, g);
        recentGroupsArr.push(g);
      }
      g.sessions.push(row);
      g.subtestSet.add(subtest);
      if (startedAt > new Date(g.latestStartedAt))
        g.latestStartedAt = row.started_at;
      if (
        row.submitted_at &&
        (!g.latestSubmittedAt ||
          new Date(row.submitted_at) > new Date(g.latestSubmittedAt))
      )
        g.latestSubmittedAt = row.submitted_at;
    });

    const tryoutActivities = recentGroupsArr.map((group) => {
      const breakdowns = group.sessions.map((s) => {
        try {
          return typeof s.score_breakdown === "string"
            ? JSON.parse(s.score_breakdown)
            : s.score_breakdown || {};
        } catch {
          return {};
        }
      });
      // Aggregate subjectScores (best of)
      const aggregatedSubjects = {};
      breakdowns.forEach((b) => {
        if (b.subjectScores) {
          Object.entries(b.subjectScores).forEach(([k, v]) => {
            if (
              !aggregatedSubjects[k] ||
              (v.score || 0) > (aggregatedSubjects[k].score || 0)
            )
              aggregatedSubjects[k] = v;
          });
        }
      });
      const subjScores = Object.values(aggregatedSubjects).map(
        (s) => s.score || 0,
      );
      const score =
        subjScores.length > 0
          ? Math.round(
              subjScores.reduce((a, b) => a + b, 0) / subjScores.length,
            )
          : breakdowns[0]?.totalScore || group.sessions[0]?.score || null;
      const masteries = breakdowns
        .map((b) => b.mastery)
        .filter((m) => typeof m === "number");
      const progress =
        masteries.length > 0
          ? Math.round(masteries.reduce((a, b) => a + b, 0) / masteries.length)
          : 0;

      return {
        id: group.sessions[0].id,
        sessionIds: group.sessions.map((s) => s.id),
        packageId: group.package_id,
        type: "tryout",
        name: group.name,
        progress,
        score,
        subtestCount: group.sessions.length,
        startedAt: group.latestStartedAt,
        submittedAt: group.latestSubmittedAt,
        bgColor: "#dae1ff",
        iconColor: "#0050cb",
        icon: "quiz",
      };
    });

    // Format Ujian Mandiri tryouts
    const umActivities = umTryoutResult.rows.map((row) => {
      let b = {};
      try {
        b =
          typeof row.score_breakdown === "string"
            ? JSON.parse(row.score_breakdown)
            : row.score_breakdown || {};
      } catch {
        b = {};
      }
      const correct = b.benar || 0;
      const total = b.total || 1;
      const progress = Math.round((correct / total) * 100);

      return {
        id: row.id,
        packageId: row.package_id,
        ujianId: row.ujian_id,
        type: "ujian_mandiri_tryout",
        name: `${row.ujian_name} - ${row.name}`,
        progress,
        score: row.score,
        startedAt: row.started_at,
        submittedAt: row.submitted_at,
        bgColor: "#e8eeff",
        iconColor: "#0050cb",
        icon: "school",
      };
    });

    // Format Latihan results
    const latihanActivities = latihanResult.rows.map((row) => {
      const progress =
        row.total_questions > 0
          ? Math.round((row.correct_count / row.total_questions) * 100)
          : 0;
      return {
        id: row.id,
        type: "latihan",
        name: row.name || "Latihan Topik",
        progress,
        score: row.score,
        subjectId: row.subject_id,
        topicId: row.topic_id,
        startedAt: row.started_at,
        submittedAt: row.submitted_at,
        bgColor: row.bg_color || "#ffdbd0",
        iconColor: row.icon_color || "#a33200",
        icon: row.icon || "school",
      };
    });

    // Combine and sort by date
    const allActivities = [
      ...tryoutActivities,
      ...latihanActivities,
      ...umActivities,
    ]
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 5);

    res.json({
      success: true,
      data: allActivities,
    });
  } catch (error) {
    console.error("Activity error:", error);
    res.json({ success: true, data: [] });
  }
});

// Get latihan session result (for UTBK Latihan)
router.get(
  "/latihan/result/:sessionId",
  verifyToken,
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;

      const sessionRes = await pool.query(
        `SELECT ls.*
       FROM latihan_sessions ls
       WHERE ls.id = $1 AND ls.user_id = $2`,
        [sessionId, userId],
      );

      if (sessionRes.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Session not found" });
      }

      const session = sessionRes.rows[0];
      const breakdown =
        typeof session.score_breakdown === "string"
          ? JSON.parse(session.score_breakdown)
          : session.score_breakdown;

      const itemAnalysis = breakdown?.itemAnalysis || [];

      if (itemAnalysis.length === 0) {
        return res.json({
          success: true,
          data: {
            subjectName: session.subject_name,
            subjectId: session.subject_id,
            topicId: session.topic_id,
            score_breakdown: breakdown,
            questions: [],
          },
        });
      }

      // Fetch questions and their choices from the questions table
      const questionIds = itemAnalysis
        .map((item) => item.questionId)
        .filter(Boolean);
      if (questionIds.length === 0) {
        return res.json({
          success: true,
          data: {
            subjectName: session.subject_name,
            subjectId: session.subject_id,
            topicId: session.topic_id,
            score_breakdown: breakdown,
            questions: [],
          },
        });
      }

      const questionsRes = await pool.query(
        `SELECT q.id, q.content, q.image_url, q.image_position, q.difficulty, q.subject_id, q.question_type, q.stimulus,
              json_agg(
                json_build_object(
                  'id', ac.id,
                  'label', ac.label,
                  'content', ac.content,
                  'is_correct', ac.is_correct,
                  'explanation', ac.explanation
                ) ORDER BY ac.label
              ) AS choices
       FROM questions q
       LEFT JOIN answer_choices ac ON ac.question_id = q.id
       WHERE q.id = ANY($1::uuid[])
       GROUP BY q.id
       ORDER BY array_position($1::uuid[], q.id)`,
        [questionIds],
      );

      const questions = questionsRes.rows.map((q) => ({
        ...q,
        choices: q.choices.filter((c) => c.id !== null),
      }));

      // Fetch empirical stats for these questions
      const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);

      // Merge itemAnalysis data into each question
      const enrichedQuestions = questions.map((q) => {
        const analysis =
          itemAnalysis.find((item) => item.questionId === q.id) || {};
        const chosenChoiceId = analysis.chosenChoiceId || null;
        const answerText = analysis.answerText || null;
        const chosenChoice = chosenChoiceId
          ? q.choices.find((c) => c.id === chosenChoiceId)
          : null;
        const correctChoice = q.choices.find((c) => c.is_correct) || null;
        return {
          ...q,
          chosenChoiceId,
          answerText,
          chosenChoice: chosenChoice || null,
          correctChoice,
          isCorrect: analysis.isCorrect === true,
          isAnswered: (q.question_type === "short_answer" || q.question_type === "complex_mc_tf") ? !!answerText : !!chosenChoiceId,
          difficulty: analysis.difficulty || q.difficulty || "medium",
          irtStats: itemStatsMap[q.id] || null,
        };
      });

      res.json({
        success: true,
        data: {
          subjectName: session.subject_name,
          subjectId: session.subject_id,
          topicId: session.topic_id,
          score_breakdown: breakdown,
          questions: enrichedQuestions,
        },
      });
    } catch (error) {
      console.error("Error fetching latihan result:", error);
      next(error);
    }
  },
);

// Get best tryout scores per subtest for PTN rationalization
router.get("/my-best-scores", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Fetch the user's tryout session with the highest score
    const bestSessionRes = await pool.query(
      `SELECT id, total_score, score_breakdown, submitted_at
       FROM tryout_sessions
       WHERE user_id = $1 AND score_breakdown IS NOT NULL AND submitted_at IS NOT NULL
       ORDER BY total_score DESC
       LIMIT 1`,
      [userId]
    );

    if (bestSessionRes.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    const session = bestSessionRes.rows[0];
    const breakdown = session.score_breakdown;

    // Extract subjectScores from breakdown
    const subjectScores = breakdown.subjectScores || {};
    const scores = {};

    // Map DB subject names to score values
    Object.keys(subjectScores).forEach((subjName) => {
      if (subjectScores[subjName]) {
        scores[subjName] = subjectScores[subjName].score || 0;
      }
    });

    res.json({
      success: true,
      data: {
        totalScore: session.total_score,
        sessionId: session.id,
        date: session.submitted_at,
        scores
      }
    });
  } catch (error) {
    console.error("Error fetching best tryout scores:", error);
    next(error);
  }
});

module.exports = router;
