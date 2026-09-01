const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
const { logAdminActivity } = require("../utils/activityLogger");
const {
  generateQuestionHash,
  updateQuestionHash,
} = require("../utils/questionHashUtil");
const {
  checkLatihanAccess,
  assertUtbkGratisContentAccess,
  hasActiveUtbkSubscription,
  isAdminUser,
  SOCIAL_VERIFY_MSG,
} = require("../utils/latihanAccessUtil");
const { reviewQuestion, fixQuestion } = require("../services/nineRouterService");

// List Soal
router.get("/", verifyToken, async (req, res, next) => {
  try {
    const {
      id,
      subject_id,
      topic_id,
      subject_name,
      difficulty,
      tryout_package_id,
      source,
      exclude_completed,
      workflow_status,
      page = 1,
      limit = 100,
    } = req.query;

    const isUserAdmin = await isAdminUser(req.user.id, req.user.role);

    // Siswa tidak boleh mengambil soal tryout lewat endpoint latihan (harus lewat sesi tryout resmi)
    if (tryout_package_id && !isUserAdmin) {
      return res.status(403).json({
        success: false,
        error: "Akses soal tryout harus melalui sesi tryout resmi.",
        code: "TRYOUT_SESSION_REQUIRED",
      });
    }

    // Free plan practice limit check (skip untuk admin, termasuk admin baru dipromosikan)
    if (!tryout_package_id && !isUserAdmin) {
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

      const hasUtbkUnlimited = await hasActiveUtbkSubscription(req.user.id);

      if (!hasUtbkUnlimited) {
        const planBlock = await assertUtbkGratisContentAccess(
          subject_id,
          topic_id,
        );
        if (planBlock) {
          return res.status(403).json({ success: false, ...planBlock });
        }

        // 1. One-time check per exercise: Free users cannot repeat completed topics/subjects
        let completed = 0;
        if (topic_id) {
          const res = await pool.query(
            "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1 AND topic_id = $2 AND submitted_at IS NOT NULL",
            [req.user.id, topic_id],
          );
          completed = parseInt(res.rows[0].count);
        } else if (subject_id) {
          const res = await pool.query(
            "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1 AND subject_id = $2 AND submitted_at IS NOT NULL",
            [req.user.id, subject_id],
          );
          completed = parseInt(res.rows[0].count);
        } else if (subject_name) {
          const res = await pool.query(
            `SELECT COUNT(*) as count FROM latihan_sessions
             WHERE user_id = $1 AND submitted_at IS NOT NULL AND (
               LOWER(subject_name) = LOWER($2)
               OR subject_id = (SELECT id FROM subjects WHERE LOWER(name) = LOWER($2) OR LOWER(title) = LOWER($2) LIMIT 1)
             )`,
            [req.user.id, subject_name],
          );
          completed = parseInt(res.rows[0].count);
        }

        if (completed >= 1) {
          return res.status(403).json({
            success: false,
            error:
              "Akun gratis hanya dapat mengerjakan setiap latihan soal sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
            code: "FREE_LIMIT_REACHED",
          });
        }

        // 2. Global total sessions check
        const access = await checkLatihanAccess(req.user.id);
        if (!access.allowed) {
          return res.status(403).json({
            success: false,
            error: SOCIAL_VERIFY_MSG,
            code: access.code || "FREE_LIMIT_REQUIRE_SOCIAL",
            total_sessions: access.totalSessions,
            verified: access.verified,
          });
        }
      }
    }

    let query =
      "SELECT id, subject_id, topic_id, content, image_url, image_position, difficulty, source, display_order, tryout_package_id, question_type, options_config, stimulus, workflow_status, review_note, created_at FROM questions WHERE 1=1";
    const values = [];

    // Filter out completed questions by content_hash if exclude_completed is true
    if (exclude_completed === "true") {
      const userId = req.user.id;
      // Get all content_hashes of questions completed by this user (UTBK Tryouts + Latihan)
      const completedRes = await pool.query(
        `WITH completed_hashes AS (
          SELECT q.content_hash FROM user_answers ua
          JOIN tryout_sessions ts ON ua.session_id = ts.id
          JOIN questions q ON ua.question_id = q.id
          WHERE ts.user_id = $1 AND q.content_hash IS NOT NULL
          UNION
          SELECT q.content_hash FROM latihan_sessions ls,
          jsonb_array_elements(ls.score_breakdown->'itemAnalysis') AS item
          JOIN questions q ON (item->>'questionId')::uuid = q.id
          WHERE ls.user_id = $1 AND q.content_hash IS NOT NULL
        )
        SELECT content_hash FROM completed_hashes WHERE content_hash IS NOT NULL`,
        [userId],
      );

      const completedHashes = completedRes.rows.map((r) => r.content_hash);
      if (completedHashes.length > 0) {
        values.push(completedHashes);
        query += ` AND (content_hash IS NULL OR NOT (content_hash = ANY($${values.length}::varchar[])))`;
      }
    }

    if (id) {
      values.push(id);
      query += ` AND id = $${values.length}`;
    }

    if (subject_id) {
      values.push(subject_id);
      query += ` AND subject_id = $${values.length}`;
    } else if (subject_name) {
      // Find subject UUID first by name
      const subjectResult = await pool.query(
        "SELECT id FROM subjects WHERE LOWER(name) = LOWER($1) OR LOWER(title) = LOWER($1) LIMIT 1",
        [subject_name],
      );
      if (subjectResult.rows.length > 0) {
        values.push(subjectResult.rows[0].id);
        query += ` AND subject_id = $${values.length}`;
      } else {
        // Subject not found, return empty
        return res.json({
          success: true,
          data: [],
          message: "Questions retrieved",
        });
      }
    }

    if (topic_id) {
      values.push(topic_id);
      query += ` AND topic_id = $${values.length}`;
    }

    if (difficulty) {
      values.push(difficulty);
      query += ` AND difficulty = $${values.length}`;
    }

    if (tryout_package_id) {
      values.push(tryout_package_id);
      query += ` AND tryout_package_id = $${values.length}`;
    } else if (!id) {
      // Jika tidak ada tryout_package_id (mode latihan), hanya tampilkan soal latihan (bukan soal tryout)
      query += " AND tryout_package_id IS NULL";
      if (source) {
        values.push(source);
        query += ` AND source = $${values.length}`;
      } else {
        query += " AND (source IS NULL OR source != 'battle')";
      }
    }

    if (workflow_status) {
      values.push(workflow_status);
      query += ` AND workflow_status = $${values.length}`;
    } else if (!isUserAdmin) {
      // Students only see approved questions
      query += " AND workflow_status = 'approved'";
    }

    query += " ORDER BY display_order ASC, created_at ASC, id ASC";

    query +=
      " LIMIT $" + (values.length + 1) + " OFFSET $" + (values.length + 2);

    const questionsResult = await pool.query(query, [
      ...values,
      limit,
      (page - 1) * limit,
    ]);

    // Fetch choices for these questions (hanya sertakan is_correct & explanation jika staf/admin)
    if (questionsResult.rows.length > 0) {
      const questionIds = questionsResult.rows.map((q) => q.id);
      const placeholders = questionIds.map((_, i) => `$${i + 1}`).join(",");

      const choicesQuery = isUserAdmin
        ? `SELECT * FROM answer_choices WHERE question_id IN (${placeholders}) ORDER BY label ASC`
        : `SELECT id, question_id, label, content FROM answer_choices WHERE question_id IN (${placeholders}) ORDER BY label ASC`;

      const choicesResult = await pool.query(choicesQuery, questionIds);

      // Map choices to questions
      for (const question of questionsResult.rows) {
        question.choices = choicesResult.rows.filter(
          (c) => c.question_id === question.id,
        );
      }
    }

    res.json({
      success: true,
      data: questionsResult.rows,
      message: "Questions retrieved",
    });
  } catch (error) {
    console.error("Error fetching questions:", error);
    next(error);
  }
});

// Create Soal (Admin Only)
router.post("/", verifyToken, verifyAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      subject_id,
      topic_id,
      content,
      difficulty,
      choices,
      image_url,
      image_position,
      question_type,
      options_config,
      correct_answer_text,
      stimulus,
      tryout_package_id,
    } = req.body;
    const qType = question_type || "multiple_choice";

    // Calculate content hash and check for duplicates
    const hash = generateQuestionHash(content, choices, image_url, stimulus);
    const existingRes = await client.query(
      `SELECT q.id, s.name as subject_name FROM questions q
       LEFT JOIN subjects s ON q.subject_id = s.id
       WHERE q.content_hash = $1 LIMIT 1`,
      [hash],
    );
    let duplicateWarning = null;
    if (existingRes.rows.length > 0) {
      duplicateWarning = `Soal ini terdeteksi duplikat dengan soal ID ${existingRes.rows[0].id} di subtes ${existingRes.rows[0].subject_name || "tidak diketahui"}`;
    }

    // Get max display_order for this subject
    let maxOrderRes;
    if (tryout_package_id) {
      maxOrderRes = await client.query(
        "SELECT COALESCE(MAX(display_order), 0) as max_order FROM questions WHERE subject_id = $1 AND tryout_package_id = $2",
        [subject_id, tryout_package_id],
      );
    } else if (topic_id) {
      maxOrderRes = await client.query(
        "SELECT COALESCE(MAX(display_order), 0) as max_order FROM questions WHERE subject_id = $1 AND topic_id = $2",
        [subject_id, topic_id],
      );
    } else {
      maxOrderRes = await client.query(
        "SELECT COALESCE(MAX(display_order), 0) as max_order FROM questions WHERE subject_id = $1 AND tryout_package_id IS NULL AND topic_id IS NULL",
        [subject_id],
      );
    }
    const nextDisplayOrder = (maxOrderRes.rows[0]?.max_order || 0) + 1;

    const qRes = await client.query(
      "INSERT INTO questions (subject_id, topic_id, content, difficulty, display_order, image_url, image_position, question_type, options_config, content_hash, stimulus, tryout_package_id, workflow_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *",
      [
        subject_id,
        topic_id || null,
        content,
        difficulty || "medium",
        nextDisplayOrder,
        image_url || null,
        image_position || "after",
        qType,
        JSON.stringify(options_config || {}),
        hash,
        stimulus || null,
        tryout_package_id || null,
        'under_review',
        req.user.id
      ],
    );
    const question = qRes.rows[0];

    if (qType === "short_answer") {
      // For short answer: store correct answer as single choice with label 'A'
      const answerText = correct_answer_text || "";
      const explanation = choices?.[0]?.explanation || null;
      await client.query(
        "INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)",
        [question.id, "A", answerText, true, explanation],
      );
    } else if (Array.isArray(choices) && choices.length > 0) {
      const choicePromises = choices.map((c) =>
        client.query(
          "INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)",
          [question.id, c.label || 'A', c.content ?? '', c.is_correct ?? false, c.explanation ?? null],
        ),
      );
      await Promise.all(choicePromises);
    }
    await client.query("COMMIT");
    logAdminActivity(req, 'CREATE', 'SOAL', question.content?.substring(0, 60) || 'Soal Baru', `Membuat soal UTBK baru (ID: ${question.id})`);

    res
      .status(201)
      .json({
        success: true,
        data: question,
        duplicateWarning,
        message: "Question created",
      });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// Shuffle choices for a question (Admin Only)
// Labels A,B,C,D,E stay fixed — only CONTENT + IS_CORRECT + EXPLANATION are shuffled
router.post(
  "/shuffle/:questionId",
  verifyToken,
  verifyAdmin,
  async (req, res, next) => {
    const { questionId } = req.params;

    if (!questionId) {
      return res
        .status(400)
        .json({ success: false, error: "questionId diperlukan" });
    }

    try {
      // Get all choices ordered by label (A,B,C,D,E) — order stays intact
      const choicesResult = await pool.query(
        "SELECT * FROM answer_choices WHERE question_id = $1 ORDER BY label ASC",
        [questionId],
      );

      if (choicesResult.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Tidak ada pilihan jawaban" });
      }

      const choices = choicesResult.rows;

      // Extract only the DATA fields (content, is_correct, explanation) — NOT the labels
      let dataSlots = choices.map((c) => ({
        content: c.content,
        is_correct: c.is_correct,
        explanation: c.explanation,
      }));

      // Fisher-Yates shuffle on the data slots only
      for (let i = dataSlots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dataSlots[i], dataSlots[j]] = [dataSlots[j], dataSlots[i]];
      }

      // Write shuffled data back — each choice KEEPS its original id & label,
      // but gets the new content/is_correct/explanation
      for (let i = 0; i < choices.length; i++) {
        await pool.query(
          "UPDATE answer_choices SET content = $1, is_correct = $2, explanation = $3 WHERE id = $4",
          [
            dataSlots[i].content,
            dataSlots[i].is_correct,
            dataSlots[i].explanation,
            choices[i].id,
          ],
        );
      }

      res.json({
        success: true,
        message:
          "Jawaban berhasil diacak. Urutan A-E tetap, isi jawaban yang berpindah.",
      });
    } catch (error) {
      console.error("Error shuffling choices:", error);
      next(error);
    }
  },
);

// Delete all questions by subject (Admin Only)
router.delete(
  "/all/by-subject/:subjectId",
  verifyToken,
  verifyAdmin,
  async (req, res, next) => {
    const { subjectId } = req.params;
    const { source, tryout_package_id } = req.query;

    if (!subjectId) {
      return res
        .status(400)
        .json({ success: false, error: "subjectId diperlukan" });
    }

    try {
      let filter = "";
      let qFilter = "";
      const values = [subjectId];
      if (source) {
        values.push(source);
        filter += ` AND source = $${values.length}`;
        qFilter += ` AND q.source = $${values.length}`;
      }
      if (tryout_package_id) {
        if (tryout_package_id === 'null') {
          filter += ` AND tryout_package_id IS NULL`;
          qFilter += ` AND q.tryout_package_id IS NULL`;
        } else {
          values.push(tryout_package_id);
          filter += ` AND tryout_package_id = $${values.length}`;
          qFilter += ` AND q.tryout_package_id = $${values.length}`;
        }
      }

      // 0. Delete bookmarks referencing questions in this subject
      await pool.query(
        `DELETE FROM bookmarks WHERE question_id IN (
        SELECT id FROM questions WHERE subject_id = $1${filter}
      )`,
        values,
      );

      // 1. Delete user_answers that reference questions in this subject (via question_id)
      await pool.query(
        `DELETE FROM user_answers WHERE question_id IN (
        SELECT id FROM questions WHERE subject_id = $1${filter}
      )`,
        values,
      );

      // 2. Delete user_answers that reference answer_choices of questions in this subject (via chosen_choice_id)
      await pool.query(
        `DELETE FROM user_answers WHERE chosen_choice_id IN (
        SELECT ac.id FROM answer_choices ac
        JOIN questions q ON ac.question_id = q.id
        WHERE q.subject_id = $1${qFilter}
      )`,
        values,
      );

      // 3. Delete all answer_choices for questions in this subject
      await pool.query(
        `DELETE FROM answer_choices WHERE question_id IN (
        SELECT id FROM questions WHERE subject_id = $1${filter}
      )`,
        values,
      );

      // 4. Delete all questions
      const deleteResult = await pool.query(
        `DELETE FROM questions WHERE subject_id = $1${filter}`,
        values,
      );

      res.json({
        success: true,
        message: `${deleteResult.rowCount} soal berhasil dihapus`,
        deletedCount: deleteResult.rowCount,
      });
    } catch (error) {
      console.error("Error deleting all questions by subject:", error);
      next(error);
    }
  },
);

// Reorder Questions (Admin Only) - Update display_order for multiple questions
router.patch(
  "/reorder/batch",
  verifyToken,
  verifyAdmin,
  async (req, res, next) => {
    try {
      const { questionIds } = req.body;

      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: "questionIds harus berupa array dan tidak kosong",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Update display_order for each question based on position in array
        for (let i = 0; i < questionIds.length; i++) {
          await client.query(
            "UPDATE questions SET display_order = $1 WHERE id = $2",
            [i + 1, questionIds[i]],
          );
        }

        await client.query("COMMIT");
        res.json({
          success: true,
          message: "Urutan soal berhasil diperbarui",
          updatedCount: questionIds.length,
        });
      } catch (dbError) {
        await client.query("ROLLBACK");
        throw dbError;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Error reordering questions:", error);
      next(error);
    }
  },
);

// Update Soal (Admin Only)
const updateSoalHandler = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = req.params;
    const {
      content,
      difficulty,
      image_url,
      image_position,
      stimulus,
      question_type,
      options_config,
      choices,
      correct_answer_text,
    } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 0;

    if (content !== undefined) {
      paramCount++;
      updates.push(`content = $${paramCount}`);
      values.push(content);
    }
    if (difficulty !== undefined) {
      paramCount++;
      updates.push(`difficulty = $${paramCount}`);
      values.push(difficulty);
    }
    if (image_url !== undefined) {
      paramCount++;
      updates.push(`image_url = $${paramCount}`);
      values.push(image_url === "" ? null : image_url);
    }
    if (image_position !== undefined) {
      paramCount++;
      updates.push(`image_position = $${paramCount}`);
      values.push(image_position);
    }
    if (stimulus !== undefined) {
      paramCount++;
      updates.push(`stimulus = $${paramCount}`);
      values.push(stimulus === "" ? null : stimulus);
    }
    if (question_type !== undefined) {
      paramCount++;
      updates.push(`question_type = $${paramCount}`);
      values.push(question_type);
    }
    if (options_config !== undefined) {
      paramCount++;
      updates.push(`options_config = $${paramCount}`);
      values.push(JSON.stringify(options_config || {}));
    }

    if (updates.length > 0) {
      values.push(id);
      const result = await client.query(
        `UPDATE questions SET ${updates.join(", ")} WHERE id = $${paramCount + 1} RETURNING *`,
        values,
      );
      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ success: false, error: "Soal tidak ditemukan" });
      }
    }

    // Get current question details to determine type
    const qDetailsRes = await client.query("SELECT question_type FROM questions WHERE id = $1", [id]);
    if (qDetailsRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, error: "Soal tidak ditemukan" });
    }
    const qType = question_type || qDetailsRes.rows[0].question_type || "multiple_choice";

    if (qType === "short_answer") {
      if (correct_answer_text !== undefined) {
        const explanation = choices?.[0]?.explanation || null;
        // Check if there is an existing choice
        const existingChoiceRes = await client.query("SELECT id FROM answer_choices WHERE question_id = $1 LIMIT 1", [id]);
        if (existingChoiceRes.rows.length > 0) {
          await client.query(
            "UPDATE answer_choices SET content = $1, is_correct = true, explanation = $2 WHERE id = $3",
            [correct_answer_text, explanation, existingChoiceRes.rows[0].id]
          );
        } else {
          await client.query(
            "INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)",
            [id, "A", correct_answer_text, true, explanation]
          );
        }
      }
    } else if (choices !== undefined && Array.isArray(choices)) {
      // Multiple choice updating
      const isValidUUID = (val) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      const clientChoiceIds = choices.filter(c => c.id && isValidUUID(c.id)).map(c => c.id);

      // 1. Delete choices not in request list
      if (clientChoiceIds.length > 0) {
        await client.query(
          "DELETE FROM answer_choices WHERE question_id = $1 AND id NOT IN (SELECT unnest($2::uuid[]))",
          [id, clientChoiceIds]
        );
      } else {
        await client.query(
          "DELETE FROM answer_choices WHERE question_id = $1",
          [id]
        );
      }

      // 2. Insert or update choices
      for (const choice of choices) {
        if (choice.id && isValidUUID(choice.id)) {
          await client.query(
            "UPDATE answer_choices SET label = $1, content = $2, is_correct = $3, explanation = $4 WHERE id = $5 AND question_id = $6",
            [choice.label || 'A', choice.content ?? '', choice.is_correct ?? false, choice.explanation ?? null, choice.id, id]
          );
        } else {
          await client.query(
            "INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)",
            [id, choice.label || 'A', choice.content ?? '', choice.is_correct ?? false, choice.explanation ?? null]
          );
        }
      }
    }

    await client.query("COMMIT");

    // Recalculate content hash
    await updateQuestionHash(pool, id, false);
    const updatedRes = await pool.query(
      "SELECT * FROM questions WHERE id = $1",
      [id]
    );

    res.json({
      success: true,
      data: updatedRes.rows[0],
      message: "Soal berhasil diperbarui",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating question:", error);
    next(error);
  } finally {
    client.release();
  }
};

router.patch("/:id", verifyToken, verifyAdmin, updateSoalHandler);
router.post("/:id/update", verifyToken, verifyAdmin, updateSoalHandler);

// Bulk Update Workflow Status (Admin / QA)
router.post("/bulk-workflow", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { status, from_status = 'under_review', subject_id, question_ids, note } = req.body;
    const userRole = req.user.role;

    if (!['draft', 'under_review', 'approved'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status target tidak valid.' });
    }

    const isAdmin = userRole === 'admin';
    const isQA = userRole === 'quality_assurance';

    if (status === 'approved' && !isAdmin && !isQA) {
      return res.status(403).json({ success: false, error: 'Hanya Admin atau Quality Assurance yang dapat menyetujui soal.' });
    }

    let query = 'UPDATE questions SET workflow_status = $1, review_note = $2 WHERE 1=1';
    const values = [status, note || null];

    if (Array.isArray(question_ids) && question_ids.length > 0) {
      values.push(question_ids);
      query += ` AND id = ANY($${values.length})`;
    } else {
      if (from_status) {
        values.push(from_status);
        query += ` AND workflow_status = $${values.length}`;
      }
      if (subject_id) {
        values.push(subject_id);
        query += ` AND subject_id = $${values.length}`;
      }
    }

    const result = await pool.query(query, values);
    const updatedCount = result.rowCount || 0;

    logAdminActivity(req, 'UPDATE', 'SOAL_BULK_WORKFLOW',
      `Bulk Update Workflow`,
      `${updatedCount} soal diubah statusnya menjadi ${status}`
    );

    return res.json({
      success: true,
      message: `Berhasil menyetujui ${updatedCount} soal.`,
      updatedCount
    });
  } catch (error) {
    next(error);
  }
});

// Update Workflow Status (Admin / QA / Question Writer — role-gated transitions)
router.patch("/:id/workflow", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;
    const userRole = req.user.role;

    if (!['draft', 'under_review', 'approved'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status tidak valid. Gunakan: draft, under_review, atau approved' });
    }

    // Fetch current status
    const current = await pool.query('SELECT workflow_status FROM questions WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Soal tidak ditemukan' });
    }
    const currentStatus = current.rows[0].workflow_status;

    // Enforce role-based transition rules:
    // question_writer: draft ↔ under_review
    // quality_assurance: draft ↔ under_review
    // admin: any transition
    const isAdmin = userRole === 'admin';
    const isQA = userRole === 'quality_assurance';
    const isWriter = userRole === 'question_writer';

    const allowed = (() => {
      if (isAdmin) return true; // Admin can do anything
      if (status === 'approved') return (isQA && currentStatus === 'under_review') || isAdmin;
      if (status === 'draft' && currentStatus === 'under_review') return isQA || isAdmin;
      if (status === 'under_review' && currentStatus === 'draft') return isWriter || isQA || isAdmin;
      return false;
    })();

    if (!allowed) {
      return res.status(403).json({ success: false, error: 'Anda tidak memiliki izin untuk transisi status ini' });
    }

    await pool.query('UPDATE questions SET workflow_status = $1, review_note = $2 WHERE id = $3', [status, note || null, id]);

    const statusLabels = { draft: 'Draft', under_review: 'Under Review', approved: 'Approved' };
    logAdminActivity(req, 'UPDATE', 'SOAL_WORKFLOW',
      `Soal ID: ${id}`,
      `Status diubah: ${statusLabels[currentStatus]} → ${statusLabels[status]}${note ? ` (${note})` : ''}`
    );

    return res.json({ success: true, message: `Status soal diubah ke ${statusLabels[status]}`, status });
  } catch (error) {
    next(error);
  }
});

// AI Review Soal (Admin Only) — Analyze question quality with 9Router AI
router.post("/:id/ai-review", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fetch question with choices and subject title
    const questionRes = await pool.query(
      `SELECT q.content, q.difficulty, q.stimulus, q.question_type, q.image_url, s.title as subject_title
       FROM questions q 
       LEFT JOIN topics t ON q.topic_id = t.id
       LEFT JOIN subjects s ON t.subject_id = s.id
       WHERE q.id = $1`,
      [id]
    );

    if (questionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Soal tidak ditemukan" });
    }

    const question = questionRes.rows[0];

    const choicesRes = await pool.query(
      `SELECT label, content, is_correct, explanation
       FROM answer_choices WHERE question_id = $1
       ORDER BY label ASC`,
      [id]
    );

    const reviewResult = await reviewQuestion({
      content: question.content,
      stimulus: question.stimulus,
      difficulty: question.difficulty,
      choices: choicesRes.rows,
      questionType: question.question_type,
      subjectTitle: question.subject_title,
    });

    logAdminActivity(req, 'VIEW', 'AI_REVIEW',
      `Soal ID: ${id}`,
      `Admin melakukan AI Review pada soal`
    );

    return res.json({
      success: true,
      review: reviewResult,
    });
  } catch (error) {
    console.error('[AI Review] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal melakukan review AI. Silakan coba lagi.',
    });
  }
});

// AI Fix Soal (Admin Only) — Auto-fix question using 9Router AI
router.post("/:id/ai-fix", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reviewNotes } = req.body; // Pass the review result as context

    // Fetch question with choices and subject title
    const questionRes = await pool.query(
      `SELECT q.id, q.content, q.difficulty, q.stimulus, q.question_type, q.image_url, s.title as subject_title
       FROM questions q 
       LEFT JOIN topics t ON q.topic_id = t.id
       LEFT JOIN subjects s ON t.subject_id = s.id
       WHERE q.id = $1`,
      [id]
    );

    if (questionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Soal tidak ditemukan" });
    }

    const question = questionRes.rows[0];

    const choicesRes = await pool.query(
      `SELECT id, label, content, is_correct, explanation
       FROM answer_choices WHERE question_id = $1
       ORDER BY label ASC`,
      [id]
    );

    const fixResult = await fixQuestion({
      content: question.content,
      stimulus: question.stimulus,
      choices: choicesRes.rows,
      questionType: question.question_type,
      difficulty: question.difficulty,
      subjectTitle: question.subject_title,
    }, reviewNotes);

    // Update the question
    await pool.query(
      `UPDATE questions SET content = $1, stimulus = $2 WHERE id = $3`,
      [fixResult.content, fixResult.stimulus || null, id]
    );

    // Update the choices
    if (fixResult.choices && Array.isArray(fixResult.choices)) {
      for (const choice of fixResult.choices) {
        await pool.query(
          `UPDATE answer_choices SET content = $1, explanation = $2 WHERE id = $3`,
          [choice.content, choice.explanation || null, choice.id]
        );
      }
    }

    logAdminActivity(req, 'UPDATE', 'AI_FIX',
      `Soal ID: ${id}`,
      `Admin memperbaiki soal menggunakan AI`
    );

    return res.json({
      success: true,
      message: 'Soal berhasil diperbaiki oleh AI',
    });
  } catch (error) {
    console.error('[AI Fix] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal melakukan perbaikan AI. Silakan coba lagi.',
    });
  }
});

// AI Fix Preview Soal (Admin Only) — Returns proposed fixes without saving
router.post("/:id/ai-fix-preview", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reviewNotes } = req.body;

    const questionRes = await pool.query(
      `SELECT q.id, q.content, q.difficulty, q.stimulus, q.question_type, q.image_url, s.title as subject_title
       FROM questions q 
       LEFT JOIN topics t ON q.topic_id = t.id
       LEFT JOIN subjects s ON t.subject_id = s.id
       WHERE q.id = $1`,
      [id]
    );

    if (questionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Soal tidak ditemukan" });
    }

    const question = questionRes.rows[0];

    const choicesRes = await pool.query(
      `SELECT id, label, content, is_correct, explanation
       FROM answer_choices WHERE question_id = $1
       ORDER BY label ASC`,
      [id]
    );

    const original = {
      content: question.content,
      stimulus: question.stimulus,
      choices: choicesRes.rows
    };

    const fixResult = await fixQuestion({
      content: question.content,
      stimulus: question.stimulus,
      choices: choicesRes.rows,
      questionType: question.question_type,
      difficulty: question.difficulty,
      subjectTitle: question.subject_title,
    }, reviewNotes);

    return res.json({
      success: true,
      data: {
        original,
        fixed: fixResult
      }
    });
  } catch (error) {
    console.error('[AI Fix Preview] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal melakukan preview perbaikan AI.',
    });
  }
});

// AI Fix Apply (Admin Only) — Save specifically selected fixes
router.post("/:id/ai-fix-apply", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content, stimulus, choices } = req.body;

    if (content !== undefined) {
      await pool.query(`UPDATE questions SET content = $1 WHERE id = $2`, [content, id]);
    }
    if (stimulus !== undefined) {
      await pool.query(`UPDATE questions SET stimulus = $1 WHERE id = $2`, [stimulus || null, id]);
    }

    if (choices && Array.isArray(choices)) {
      for (const choice of choices) {
        if (choice.id) {
          const updates = [];
          const values = [];
          let paramIdx = 1;
          
          if (choice.content !== undefined) {
            updates.push(`content = $${paramIdx++}`);
            values.push(choice.content);
          }
          if (choice.explanation !== undefined) {
            updates.push(`explanation = $${paramIdx++}`);
            values.push(choice.explanation || null);
          }
          
          if (updates.length > 0) {
            values.push(choice.id);
            await pool.query(`UPDATE answer_choices SET ${updates.join(', ')} WHERE id = $${paramIdx}`, values);
          }
        }
      }
    }

    logAdminActivity(req, 'UPDATE', 'AI_FIX_APPLY', `Soal ID: ${id}`, `Admin menerapkan sebagian perbaikan AI ke soal`);
    
    return res.json({ success: true, message: 'Perbaikan yang dipilih berhasil diterapkan!' });
  } catch (error) {
    console.error('[AI Fix Apply] Error:', error.message);
    return res.status(500).json({ success: false, error: 'Gagal menerapkan perbaikan AI.' });
  }
});

// Delete Soal (Admin Only)
router.delete("/:id", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM questions WHERE id = $1 RETURNING id",
      [id],
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Soal tidak ditemukan" });
    }
    logAdminActivity(req, 'DELETE', 'SOAL', `Soal ID: ${id}`, `Menghapus soal UTBK (ID: ${id})`);
    res.json({ success: true, message: "Soal berhasil dihapus" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
