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
  assertUmGratisContentAccess,
  hasActiveUmSubscription,
  isAdminUser,
  SOCIAL_VERIFY_MSG,
} = require("../utils/latihanAccessUtil");
const {
  isPackageCompleted,
  markPackageCompleted,
} = require("../utils/tryoutCompletionUtil");
const multer = require("multer");
const XLSX = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });

// ========== BANNER ==========
router.get("/banner", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT value FROM site_settings WHERE key = 'um_banner'",
    );
    const banner =
      result.rows.length > 0 ? JSON.parse(result.rows[0].value) : {};
    res.json({ success: true, data: banner });
  } catch (error) {
    next(error);
  }
});

router.patch("/banner", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const value = JSON.stringify(req.body);
    await pool.query(
      "INSERT INTO site_settings (key, value, updated_at) VALUES ('um_banner', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [value],
    );
    res.json({ success: true, data: req.body });
  } catch (error) {
    next(error);
  }
});

// ========== QUESTIONS (must be BEFORE /:id to avoid catch-all) ==========

// Get questions for a tryout package or latihan
router.get("/questions", verifyToken, async (req, res, next) => {
  try {
    const { tryout_package_id, latihan_id, parent_type, parent_id } = req.query;

    // Free plan practice limit check (global, not per-latihan)
    if (
      !tryout_package_id &&
      (latihan_id || parent_type === "latihan_soal") &&
      !(await isAdminUser(req.user.id, req.user.role))
    ) {
      const hasUmUnlimited = await hasActiveUmSubscription(req.user.id);

      if (!hasUmUnlimited) {
        const targetLatihanId = latihan_id || parent_id;

        const planBlock = await assertUmGratisContentAccess(targetLatihanId);
        if (planBlock) {
          return res.status(403).json({ success: false, ...planBlock });
        }

        if (targetLatihanId) {
          const latihanCountRes = await pool.query(
            "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1 AND latihan_id = $2 AND submitted_at IS NOT NULL",
            [req.user.id, targetLatihanId],
          );
          const totalLatihan = parseInt(latihanCountRes.rows[0].count, 10);
          if (totalLatihan >= 1) {
            return res.status(403).json({
              success: false,
              error:
                "Akun gratis hanya dapat mengerjakan setiap latihan soal sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
              code: "FREE_LIMIT_REACHED",
            });
          }
        }

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

    console.log("GET questions params:", {
      tryout_package_id,
      latihan_id,
      parent_type,
      parent_id,
    });

    let where, params;
    if (tryout_package_id || (parent_type === "tryout_package" && parent_id)) {
      where = "q.tryout_package_id = $1";
      params = [tryout_package_id || parent_id];
    } else if (latihan_id || (parent_type === "latihan_soal" && parent_id)) {
      where = "q.latihan_id = $1";
      params = [latihan_id || parent_id];
    } else {
      return res
        .status(400)
        .json({
          success: false,
          error: "Provide tryout_package_id or latihan_id",
        });
    }
    const result = await pool.query(
      `SELECT q.*,
       COALESCE(json_agg(json_build_object(
         'id', ac.id, 'label', ac.label, 'content', ac.content,
         'is_correct', ac.is_correct, 'explanation', ac.explanation
       ) ORDER BY ac.label) FILTER (WHERE ac.id IS NOT NULL), '[]') as choices
       FROM um_questions q
       LEFT JOIN um_answer_choices ac ON ac.question_id = q.id
       WHERE ${where}
       GROUP BY q.id
       ORDER BY q.display_order ASC, q.created_at ASC`,
      params,
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("GET questions error:", error.message);
    next(error);
  }
});

// Excel import (must be BEFORE /questions/:id)
router.post(
  "/questions/import",
  [verifyToken, verifyAdmin, upload.single("file")],
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      console.log("Import request body:", req.body);
      console.log("Import file:", req.file ? req.file.originalname : "No file");

      if (!req.file)
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded" });
      const { difficulty, parent_type, parent_id } = req.body;
      let { tryout_package_id, latihan_id } = req.body;
      if (parent_type === "tryout_package" && parent_id)
        tryout_package_id = parent_id;
      if (parent_type === "latihan_soal" && parent_id) latihan_id = parent_id;

      console.log("Resolved IDs:", { tryout_package_id, latihan_id });

      if (!tryout_package_id && !latihan_id) {
        return res
          .status(400)
          .json({
            success: false,
            error: "Provide tryout_package_id or latihan_id",
          });
      }

      // Verify the parent exists
      if (tryout_package_id) {
        const check = await pool.query(
          "SELECT id FROM um_tryout_packages WHERE id = $1",
          [tryout_package_id],
        );
        if (check.rows.length === 0) {
          return res
            .status(404)
            .json({ success: false, error: "Tryout package not found" });
        }
      }
      if (latihan_id) {
        const check = await pool.query(
          "SELECT id FROM um_latihan_soal WHERE id = $1",
          [latihan_id],
        );
        if (check.rows.length === 0) {
          return res
            .status(404)
            .json({ success: false, error: "Latihan not found" });
        }
      }

      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      const resolve = (row, aliases) => {
        for (const a of aliases) {
          if (row[a] !== undefined && row[a] !== "") return String(row[a]);
        }
        return "";
      };

      const ALIASES = {
        stimulus: [
          "STIMULUS",
          "stimulus",
          "Stimulus",
          "wacana",
          "Wacana",
          "bacaan",
          "Bacaan",
          "stimulus/wacana",
        ],
        soal: [
          "SOAL",
          "soal",
          "Soal",
          "content",
          "pertanyaan",
          "Pertanyaan",
          "PERTANYAAN",
        ],
        opsiA: ["OPSI A", "opsi a", "Opsi A", "A", "a", "Jawaban A"],
        opsiB: ["OPSI B", "opsi b", "Opsi B", "B", "b", "Jawaban B"],
        opsiC: ["OPSI C", "opsi c", "Opsi C", "C", "c", "Jawaban C"],
        opsiD: ["OPSI D", "opsi d", "Opsi D", "D", "d", "Jawaban D"],
        opsiE: ["OPSI E", "opsi e", "Opsi E", "E", "e", "Jawaban E"],
        kunci: [
          "KUNCI JAWABAN",
          "kunci jawaban",
          "Kunci Jawaban",
          "Kunci",
          "kunci",
          "KUNCI",
          "JAWABAN",
          "jawaban",
          "Jawaban",
          "key",
          "answer",
        ],
        pembahasan: [
          "PEMBAHASAN",
          "pembahasan",
          "Pembahasan",
          "PENJELASAN",
          "penjelasan",
          "explanation",
        ],
      };

      await client.query("BEGIN");

      // Get the current max display_order for this tryout package or latihan
      let maxOrderRes;
      if (tryout_package_id) {
        maxOrderRes = await client.query(
          "SELECT COALESCE(MAX(display_order), -1) as max_order FROM um_questions WHERE tryout_package_id = $1",
          [tryout_package_id],
        );
      } else if (latihan_id) {
        maxOrderRes = await client.query(
          "SELECT COALESCE(MAX(display_order), -1) as max_order FROM um_questions WHERE latihan_id = $1",
          [latihan_id],
        );
      } else {
        maxOrderRes = { rows: [{ max_order: -1 }] };
      }

      let nextDisplayOrder = (maxOrderRes.rows[0]?.max_order || -1) + 1;
      let imported = 0;

      // Parse all valid rows first (no DB calls yet)
      const parsedRows = [];
      for (const row of rows) {
        const stimulus = resolve(row, ALIASES.stimulus);
        const soal = resolve(row, ALIASES.soal);
        const opsiA = resolve(row, ALIASES.opsiA);
        const opsiB = resolve(row, ALIASES.opsiB);
        const opsiC = resolve(row, ALIASES.opsiC);
        const opsiD = resolve(row, ALIASES.opsiD);
        const opsiE = resolve(row, ALIASES.opsiE);
        const kunci = resolve(row, ALIASES.kunci).toUpperCase().trim();
        const pembahasan = resolve(row, ALIASES.pembahasan);

        if (!soal || !opsiA || !opsiB) continue;
        if (!["A", "B", "C", "D", "E"].includes(kunci)) continue;

        const options = [
          { label: "A", content: opsiA },
          { label: "B", content: opsiB },
        ];
        if (opsiC) options.push({ label: "C", content: opsiC });
        if (opsiD) options.push({ label: "D", content: opsiD });
        if (opsiE) options.push({ label: "E", content: opsiE });

        const hash = generateQuestionHash(soal, options, null, stimulus);
        parsedRows.push({
          soal,
          difficulty: difficulty || "medium",
          displayOrder: nextDisplayOrder,
          kunci,
          pembahasan,
          options,
          hash,
          stimulus: stimulus || null,
        });
        nextDisplayOrder++;
      }

      // Batch insert questions (50 at a time)
      const BATCH_SIZE = 50;
      for (let i = 0; i < parsedRows.length; i += BATCH_SIZE) {
        const batch = parsedRows.slice(i, i + BATCH_SIZE);
        const values = [];
        const params = [];
        batch.forEach((r, idx) => {
          const offset = idx * 7;
          values.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
          );
          params.push(
            tryout_package_id || null,
            latihan_id || null,
            r.soal,
            r.difficulty,
            r.displayOrder,
            r.hash,
            r.stimulus,
          );
        });

        const qRes = await client.query(
          `INSERT INTO um_questions (tryout_package_id, latihan_id, content, difficulty, display_order, content_hash, stimulus)
         VALUES ${values.join(", ")} RETURNING id, display_order`,
          params,
        );

        // Map returned IDs back to parsed rows by display_order
        const idMap = {};
        for (const row of qRes.rows) {
          idMap[row.display_order] = row.id;
        }

        // Batch insert all answer choices for this batch of questions
        const choiceValues = [];
        const choiceParams = [];
        let choiceIdx = 0;
        for (const r of batch) {
          const qId = idMap[r.displayOrder];
          if (!qId) continue;
          for (const opt of r.options) {
            const offset = choiceIdx * 5;
            choiceValues.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
            );
            choiceParams.push(
              qId,
              opt.label,
              opt.content,
              opt.label === r.kunci,
              opt.label === r.kunci ? r.pembahasan : null,
            );
            choiceIdx++;
          }
        }

        if (choiceValues.length > 0) {
          await client.query(
            `INSERT INTO um_answer_choices (question_id, label, content, is_correct, explanation)
           VALUES ${choiceValues.join(", ")}`,
            choiceParams,
          );
        }

        imported += batch.length;
      }

      await client.query("COMMIT");
      console.log("Import successful:", { imported, total_rows: rows.length });
      res.json({ success: true, imported, total_rows: rows.length });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Import error:", error.message, error.stack);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  },
);

// Delete all questions for a tryout package or latihan (must be BEFORE /questions/:id)
router.delete(
  "/questions/bulk",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const { tryout_package_id, latihan_id } = req.body;
      let result;
      if (tryout_package_id) {
        result = await pool.query(
          "DELETE FROM um_questions WHERE tryout_package_id = $1",
          [tryout_package_id],
        );
      } else if (latihan_id) {
        result = await pool.query(
          "DELETE FROM um_questions WHERE latihan_id = $1",
          [latihan_id],
        );
      } else {
        return res
          .status(400)
          .json({
            success: false,
            error: "Provide tryout_package_id or latihan_id",
          });
      }
      res.json({ success: true, deleted: result.rowCount });
    } catch (error) {
      next(error);
    }
  },
);

// Create a single question
router.post(
  "/questions",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const {
        tryout_package_id,
        latihan_id,
        content,
        image_url,
        image_position,
        difficulty,
        choices,
        stimulus,
      } = req.body;

      // Calculate content hash and check for duplicates
      const hash = generateQuestionHash(content, choices, image_url, stimulus);
      const existingRes = await client.query(
        `SELECT q.id, tp.title as package_title, ls.title as latihan_title
       FROM um_questions q
       LEFT JOIN um_tryout_packages tp ON q.tryout_package_id = tp.id
       LEFT JOIN um_latihan_soal ls ON q.latihan_id = ls.id
       WHERE q.content_hash = $1 LIMIT 1`,
        [hash],
      );
      let duplicateWarning = null;
      if (existingRes.rows.length > 0) {
        const location = existingRes.rows[0].package_title
          ? `Tryout: ${existingRes.rows[0].package_title}`
          : existingRes.rows[0].latihan_title
            ? `Latihan: ${existingRes.rows[0].latihan_title}`
            : "tidak diketahui";
        duplicateWarning = `Soal ini terdeteksi duplikat dengan soal ID ${existingRes.rows[0].id} di ${location}`;
      }

      const qResult = await client.query(
        `INSERT INTO um_questions (tryout_package_id, latihan_id, content, image_url, image_position, difficulty, content_hash, stimulus)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          tryout_package_id || null,
          latihan_id || null,
          content,
          image_url || null,
          image_position || "after",
          difficulty || "medium",
          hash,
          stimulus || null,
        ],
      );
      const question = qResult.rows[0];

      if (choices && choices.length > 0) {
        for (const c of choices) {
          await client.query(
            `INSERT INTO um_answer_choices (question_id, label, content, is_correct, explanation)
           VALUES ($1, $2, $3, $4, $5)`,
            [
              question.id,
              c.label,
              c.content,
              c.is_correct || false,
              c.explanation || null,
            ],
          );
        }
      }
      await client.query("COMMIT");

      // Re-fetch with choices
      const full = await pool.query(
        `SELECT q.*, json_agg(json_build_object(
         'id', ac.id, 'label', ac.label, 'content', ac.content,
         'is_correct', ac.is_correct, 'explanation', ac.explanation
       ) ORDER BY ac.label) as choices
       FROM um_questions q
       LEFT JOIN um_answer_choices ac ON ac.question_id = q.id
       WHERE q.id = $1 GROUP BY q.id`,
        [question.id],
      );
      res
        .status(201)
        .json({ success: true, data: full.rows[0], duplicateWarning });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

// Update a question
router.patch(
  "/questions/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { content, image_url, image_position, difficulty, choices, stimulus } =
        req.body;

      await client.query(
        `UPDATE um_questions SET content = COALESCE($1, content), image_url = $2,
       image_position = COALESCE($3, image_position), difficulty = COALESCE($4, difficulty),
       stimulus = CASE WHEN $5::boolean THEN $6 ELSE stimulus END WHERE id = $7`,
        [
          content,
          image_url !== undefined ? image_url : null,
          image_position,
          difficulty,
          stimulus !== undefined,
          stimulus !== undefined ? stimulus : null,
          req.params.id,
        ],
      );

      if (choices && choices.length > 0) {
        await client.query(
          "DELETE FROM um_answer_choices WHERE question_id = $1",
          [req.params.id],
        );
        for (const c of choices) {
          await client.query(
            `INSERT INTO um_answer_choices (question_id, label, content, is_correct, explanation)
           VALUES ($1, $2, $3, $4, $5)`,
            [
              req.params.id,
              c.label,
              c.content,
              c.is_correct || false,
              c.explanation || null,
            ],
          );
        }
      }

      // Recalculate content hash
      await updateQuestionHash(client, req.params.id, true);
      await client.query("COMMIT");

      const full = await pool.query(
        `SELECT q.*, json_agg(json_build_object(
         'id', ac.id, 'label', ac.label, 'content', ac.content,
         'is_correct', ac.is_correct, 'explanation', ac.explanation
       ) ORDER BY ac.label) as choices
       FROM um_questions q
       LEFT JOIN um_answer_choices ac ON ac.question_id = q.id
       WHERE q.id = $1 GROUP BY q.id`,
        [req.params.id],
      );
      res.json({ success: true, data: full.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

// Shuffle choices for a question (Admin Only)
// Labels A,B,C,D,E stay fixed — only CONTENT + IS_CORRECT + EXPLANATION are shuffled
router.post(
  "/questions/shuffle/:questionId",
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
        "SELECT * FROM um_answer_choices WHERE question_id = $1 ORDER BY label ASC",
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
          "UPDATE um_answer_choices SET content = $1, is_correct = $2, explanation = $3 WHERE id = $4",
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

// Delete a question
router.delete(
  "/questions/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        "DELETE FROM um_questions WHERE id = $1 RETURNING id",
        [req.params.id],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ success: false, error: "Not found" });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// ========== TRYOUT PACKAGES (specific routes before /:id) ==========
router.patch(
  "/tryout-packages/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const {
        title,
        description,
        icon,
        icon_color,
        duration,
        peserta,
        points_correct,
        points_incorrect,
        points_unanswered,
        is_active,
        required_plan,
        package_number,
      } = req.body;
      const result = await pool.query(
        `UPDATE um_tryout_packages SET title = COALESCE($1, title), description = COALESCE($2, description),
       icon = COALESCE($3, icon), icon_color = COALESCE($4, icon_color), duration = COALESCE($5, duration),
       peserta = COALESCE($6, peserta),
       points_correct = COALESCE($7, points_correct), points_incorrect = COALESCE($8, points_incorrect),
       points_unanswered = COALESCE($9, points_unanswered),
       is_active = COALESCE($10, is_active), required_plan = COALESCE($11, required_plan),
       package_number = COALESCE($12, package_number)
       WHERE id = $13 RETURNING *`,
        [
          title,
          description,
          icon,
          icon_color,
          duration,
          peserta,
          points_correct,
          points_incorrect,
          points_unanswered,
          is_active,
          required_plan,
          package_number,
          req.params.id,
        ],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ success: false, error: "Not found" });
      logAdminActivity(req, 'UPDATE', 'PAKET_TRYOUT', result.rows[0].title, `Memperbarui paket Ujian Mandiri Tryout: ${result.rows[0].title}`);
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/tryout-packages/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        "DELETE FROM um_tryout_packages WHERE id = $1 RETURNING id, title",
        [req.params.id],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ success: false, error: "Not found" });
      logAdminActivity(req, 'DELETE', 'PAKET_TRYOUT', result.rows[0].title, `Menghapus paket Ujian Mandiri Tryout: ${result.rows[0].title}`);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// ========== LATIHAN SOAL (specific routes before /:id) ==========
router.patch(
  "/latihan/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const {
        title,
        description,
        category,
        icon,
        icon_bg_color,
        category_color,
        button_style,
        points_correct,
        points_incorrect,
        points_unanswered,
        is_active,
        required_plan,
        package_name,
      } = req.body;
      const result = await pool.query(
        `UPDATE um_latihan_soal SET title = COALESCE($1, title), description = COALESCE($2, description),
       category = COALESCE($3, category), icon = COALESCE($4, icon), icon_bg_color = COALESCE($5, icon_bg_color),
       category_color = COALESCE($6, category_color), button_style = COALESCE($7, button_style),
       points_correct = COALESCE($8, points_correct), points_incorrect = COALESCE($9, points_incorrect),
       points_unanswered = COALESCE($10, points_unanswered),
       is_active = COALESCE($11, is_active), required_plan = COALESCE($12, required_plan),
       package_name = COALESCE($13, package_name)
       WHERE id = $14 RETURNING *`,
        [
          title,
          description,
          category,
          icon,
          icon_bg_color,
          category_color,
          button_style,
          points_correct,
          points_incorrect,
          points_unanswered,
          is_active,
          required_plan,
          package_name,
          req.params.id,
        ],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ success: false, error: "Not found" });
      logAdminActivity(req, 'UPDATE', 'PAKET_LATIHAN', result.rows[0].title, `Memperbarui paket Ujian Mandiri Latihan: ${result.rows[0].title}`);
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/latihan/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        "DELETE FROM um_latihan_soal WHERE id = $1 RETURNING id, title",
        [req.params.id],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ success: false, error: "Not found" });
      logAdminActivity(req, 'DELETE', 'PAKET_LATIHAN', result.rows[0].title, `Menghapus paket Ujian Mandiri Latihan: ${result.rows[0].title}`);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// ========== UJIAN MANDIRI CRUD ==========
router.get("/", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM ujian_mandiri ORDER BY display_order ASC, created_at DESC",
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// NOTE: /:id MUST be AFTER all specific routes like /questions, /banner, /tryout-packages, /latihan
// otherwise it will catch those requests and treat the path segment as an ID
router.get("/:id", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM ujian_mandiri WHERE id = $1",
      [req.params.id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const {
      universitas,
      nama_ujian,
      status,
      deadline,
      lokasi,
      image,
      logo,
      detail_link,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO ujian_mandiri (universitas, nama_ujian, status, deadline, lokasi, image, logo, detail_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        universitas,
        nama_ujian,
        status || "open",
        deadline,
        lokasi,
        image,
        logo,
        detail_link,
      ],
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const {
      universitas,
      nama_ujian,
      status,
      deadline,
      lokasi,
      image,
      logo,
      detail_link,
    } = req.body;
    const result = await pool.query(
      `UPDATE ujian_mandiri SET universitas = COALESCE($1, universitas), nama_ujian = COALESCE($2, nama_ujian),
       status = COALESCE($3, status), deadline = COALESCE($4, deadline), lokasi = COALESCE($5, lokasi),
       image = COALESCE($6, image), logo = COALESCE($7, logo), detail_link = COALESCE($8, detail_link),
       updated_at = NOW() WHERE id = $9 RETURNING *`,
      [
        universitas,
        nama_ujian,
        status,
        deadline,
        lokasi,
        image,
        logo,
        detail_link,
        req.params.id,
      ],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const result = await pool.query(
      "DELETE FROM ujian_mandiri WHERE id = $1 RETURNING id",
      [req.params.id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ========== PARAMETERIZED SUB-ROUTES (these use :ujianId which won't conflict) ==========
router.get("/:ujianId/tryout-packages", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT tp.*,
        (SELECT COUNT(*) FROM um_questions q WHERE q.tryout_package_id = tp.id) as soal_count,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', ts.id,
              'score', ts.total_score,
              'submitted_at', ts.submitted_at,
              'score_breakdown', ts.score_breakdown
            ) ORDER BY ts.submitted_at DESC)
            FROM um_tryout_sessions ts
            WHERE ts.package_id = tp.id AND ts.user_id = $2 AND ts.submitted_at IS NOT NULL
          ),
          '[]'
        ) as user_history
       FROM um_tryout_packages tp
       WHERE tp.ujian_id = $1
       ORDER BY tp.display_order ASC, tp.created_at ASC`,
      [req.params.ujianId, req.user.id],
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/:ujianId/tryout-packages",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const {
        title,
        description,
        icon,
        icon_color,
        duration,
        peserta,
        points_correct,
        points_incorrect,
        points_unanswered,
        is_active,
        required_plan,
      } = req.body;
      console.log("Creating tryout package:", {
        ujianId: req.params.ujianId,
        title,
        description,
        icon,
        icon_color,
        duration,
        peserta,
      });
      const result = await pool.query(
        `INSERT INTO um_tryout_packages (ujian_id, title, description, icon, icon_color, duration, peserta, points_correct, points_incorrect, points_unanswered, is_active, required_plan, package_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, TRUE), COALESCE($12, 'gratis'), $13) RETURNING *`,
        [
          req.params.ujianId,
          title,
          description,
          icon || "auto_stories",
          icon_color || "#0050cb",
          duration || 120,
          peserta || 0,
          points_correct !== undefined ? points_correct : 4,
          points_incorrect !== undefined ? points_incorrect : -1,
          points_unanswered !== undefined ? points_unanswered : 0,
          is_active,
          required_plan,
          package_number || null,
        ],
      );
      logAdminActivity(req, 'CREATE', 'PAKET_TRYOUT', result.rows[0].title, `Membuat paket Ujian Mandiri Tryout: ${result.rows[0].title}`);
      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error("Error creating tryout package:", error);
      next(error);
    }
  },
);

router.get("/:ujianId/latihan", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ls.*,
        (SELECT COUNT(*) FROM um_questions q WHERE q.latihan_id = ls.id) as soal_count,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', s.id,
              'score', s.irt_score,
              'submitted_at', s.submitted_at,
              'score_breakdown', s.score_breakdown
            ) ORDER BY s.submitted_at DESC)
            FROM latihan_sessions s
            WHERE s.latihan_id = ls.id AND s.user_id = $2 AND s.submitted_at IS NOT NULL
          ),
          '[]'
        ) as user_history
       FROM um_latihan_soal ls
       WHERE ls.ujian_id = $1
       ORDER BY ls.display_order ASC, ls.created_at ASC`,
      [req.params.ujianId, req.user.id],
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/:ujianId/latihan",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const {
        title,
        description,
        category,
        icon,
        icon_bg_color,
        category_color,
        button_style,
        points_correct,
        points_incorrect,
        points_unanswered,
        is_active,
        required_plan,
        package_name,
      } = req.body;
      const result = await pool.query(
        `INSERT INTO um_latihan_soal (ujian_id, title, description, category, icon, icon_bg_color, category_color, button_style, points_correct, points_incorrect, points_unanswered, is_active, required_plan, package_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, TRUE), COALESCE($13, 'gratis'), COALESCE($14, 'Paket 1')) RETURNING *`,
        [
          req.params.ujianId,
          title,
          description,
          category,
          icon || "auto_stories",
          icon_bg_color || "#0050cb",
          category_color || "#0050cb",
          button_style || "filled",
          points_correct !== undefined ? points_correct : 4,
          points_incorrect !== undefined ? points_incorrect : -1,
          points_unanswered !== undefined ? points_unanswered : 0,
          is_active,
          required_plan,
          package_name,
        ],
      );
      logAdminActivity(req, 'CREATE', 'PAKET_LATIHAN', result.rows[0].title, `Membuat paket Ujian Mandiri Latihan: ${result.rows[0].title}`);
      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

// ========== UJIAN MANDIRI TRYOUT SIMULATION ENDPOINTS ==========

// Start Ujian Mandiri Tryout Session
router.post("/tryout/start", verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { tryout_package_id } = req.body;
    const userId = req.user.id;

    if (!tryout_package_id) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ success: false, error: "tryout_package_id required" });
    }

    // ── Resume existing active session if available (prevents duplicate quota deduction) ──
    const existingSession = await client.query(
      `SELECT ts.id, ts.started_at, tp.duration, COUNT(ua.id) as total_questions
       FROM um_tryout_sessions ts
       JOIN um_tryout_packages tp ON tp.id = ts.package_id
       LEFT JOIN um_user_answers ua ON ua.session_id = ts.id
       WHERE ts.user_id = $1 AND ts.package_id = $2 AND ts.submitted_at IS NULL
       GROUP BY ts.id, tp.duration
       ORDER BY ts.started_at DESC LIMIT 1`,
      [userId, tryout_package_id],
    );
    if (
      existingSession.rows.length > 0 &&
      parseInt(existingSession.rows[0].total_questions) > 0
    ) {
      await client.query("COMMIT");
      return res.json({
        success: true,
        data: {
          session_id: existingSession.rows[0].id,
          total_questions: parseInt(existingSession.rows[0].total_questions),
          duration: existingSession.rows[0].duration || 60,
          resumed: true,
        },
        message: "Resumed existing session",
      });
    }

    const isStudent = !req.user.role || req.user.role === 'student';

    if (isStudent) {
      // Check if user has an active subscription/access plan for UM (unlimited access)
      const activeUmRes = await client.query(
        `SELECT 1 FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
           AND (p.target_type = 'um' OR p.target_type = 'all') AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
         LIMIT 1`,
        [userId],
      );
      const hasUmUnlimited = activeUmRes.rows.length > 0;

      if (!hasUmUnlimited) {
        // Check if user has active tryout quota for UM
        const quotaRes = await client.query(
          `SELECT s.id, s.quota_remaining FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
           WHERE s.user_id = $1 AND s.status = 'active' AND p.plan_type = 'quota' AND p.target_type = 'um' AND s.quota_remaining > 0
           ORDER BY s.expires_at ASC LIMIT 1`,
          [userId],
        );

        if (quotaRes.rows.length > 0) {
          // Deduct 1 tryout quota credit
          const quota = quotaRes.rows[0];
          await client.query(
            `UPDATE subscriptions SET quota_remaining = quota_remaining - 1 WHERE id = $1`,
            [quota.id],
          );
        } else {
          // Check if this specific package has already been completed
          const umCompleted = await isPackageCompleted(
            client,
            userId,
            "um",
            tryout_package_id,
          );
          if (!umCompleted) {
            const sessionCompleted = await client.query(
              "SELECT 1 FROM um_tryout_sessions WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NOT NULL LIMIT 1",
              [userId, tryout_package_id],
            );
            if (sessionCompleted.rows.length > 0) {
              await markPackageCompleted(client, userId, "um", tryout_package_id);
            }
          }

          const packageDone =
            umCompleted ||
            (await isPackageCompleted(client, userId, "um", tryout_package_id));

          if (packageDone) {
            await client.query("ROLLBACK");
            return res.status(403).json({
              success: false,
              error:
                "Akun gratis hanya dapat mengerjakan setiap paket tryout sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
              code: "FREE_LIMIT_REACHED",
            });
          }

          // Check if registration exists and is approved for this package
          const regRes = await client.query(
            "SELECT status FROM tryout_registrations WHERE user_id = $1 AND um_package_id = $2 AND status = 'approved'",
            [userId, tryout_package_id],
          );

          if (regRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(403).json({
              success: false,
              error: "Pendaftaran tryout belum diverifikasi admin.",
              code: "NOT_VERIFIED",
            });
          }
        }
      }
    }

    // Verify package exists
    const pkgRes = await client.query(
      "SELECT id, title, duration FROM um_tryout_packages WHERE id = $1",
      [tryout_package_id],
    );
    if (pkgRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({
          success: false,
          error: "Paket tryout Ujian Mandiri tidak ditemukan",
        });
    }
    const pkg = pkgRes.rows[0];

    // Create session
    const sessionRes = await client.query(
      "INSERT INTO um_tryout_sessions (user_id, package_id) VALUES ($1, $2) RETURNING id, started_at",
      [userId, tryout_package_id],
    );
    const sessionId = sessionRes.rows[0].id;

    // Fetch all questions for this package to copy to user answers
    const questionsRes = await client.query(
      "SELECT id FROM um_questions WHERE tryout_package_id = $1 ORDER BY display_order ASC, created_at ASC, id ASC",
      [tryout_package_id],
    );
    const questions = questionsRes.rows;

    if (questions.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error:
          "Belum ada soal untuk paket tryout ini. Admin perlu menambahkan soal terlebih dahulu.",
      });
    }

    // Insert user answers with position order
    for (let i = 0; i < questions.length; i++) {
      await client.query(
        "INSERT INTO um_user_answers (session_id, question_id, position) VALUES ($1, $2, $3)",
        [sessionId, questions[i].id, i + 1],
      );
    }

    await client.query("COMMIT");
    res.json({
      success: true,
      data: {
        session_id: sessionId,
        total_questions: questions.length,
        duration: pkg.duration || 60,
      },
      message: "Ujian Mandiri Tryout session started",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// Get Questions for Ujian Mandiri Session (Single Fetch)
router.get(
  "/tryout/session/:sessionId/questions",
  verifyToken,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user.id;

      // Verify session (include started_at for timer sync)
      const sessionRes = await pool.query(
        `SELECT ts.id, ts.package_id, ts.started_at, tp.title, tp.duration
       FROM um_tryout_sessions ts
       JOIN um_tryout_packages tp ON ts.package_id = tp.id
       WHERE ts.id = $1 AND ts.user_id = $2`,
        [sessionId, userId],
      );
      if (sessionRes.rows.length === 0) {
        return res
          .status(404)
          .json({
            success: false,
            error: "Sesi tidak ditemukan atau tidak authorized",
          });
      }
      const sessionInfo = sessionRes.rows[0];

      // Fetch questions in position order
      const result = await pool.query(
        `SELECT q.id, q.content, q.image_url, q.difficulty, q.stimulus, ua.position, ua.chosen_choice_id, ua.is_flagged
       FROM um_user_answers ua
       JOIN um_questions q ON ua.question_id = q.id
       WHERE ua.session_id = $1
       ORDER BY ua.position ASC`,
        [sessionId],
      );

      // Fetch answer choices for all questions in this session
      const choicesResult = await pool.query(
        `SELECT ac.id, ac.question_id, ac.label, ac.content
       FROM um_answer_choices ac
       JOIN um_user_answers ua ON ac.question_id = ua.question_id
       WHERE ua.session_id = $1
       ORDER BY ac.label ASC`,
        [sessionId],
      );

      // Group choices by question ID
      const choicesMap = {};
      choicesResult.rows.forEach((choice) => {
        if (!choicesMap[choice.question_id]) {
          choicesMap[choice.question_id] = [];
        }
        choicesMap[choice.question_id].push(choice);
      });

      // Attach choices to questions
      result.rows.forEach((q) => {
        q.choices = choicesMap[q.id] || [];
      });

      res.json({
        success: true,
        data: result.rows,
        package: {
          title: sessionInfo.title,
          duration: sessionInfo.duration || 60,
          started_at: sessionInfo.started_at || null,
        },
      });
    } catch (error) {
      console.error("Error fetching UM session questions:", error);
      next(error);
    }
  },
);

// Bulk Submit Answers for Ujian Mandiri Session
router.post("/tryout/submit-bulk", verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { sessionId, answers } = req.body;
    const userId = req.user.id;

    if (!sessionId || !Array.isArray(answers)) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Invalid payload. Required: sessionId, answers[]",
        });
    }

    await client.query("BEGIN");

    // Check session
    const sessionRes = await client.query(
      "SELECT id, submitted_at FROM um_tryout_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, userId],
    );
    if (sessionRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({
          success: false,
          error: "Sesi tidak ditemukan atau tidak authorized",
        });
    }

    if (sessionRes.rows[0].submitted_at) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({
          success: false,
          error: "Sesi ini sudah dikumpulkan sebelumnya",
        });
    }

    // Update answers in bulk
    for (const ans of answers) {
      const { questionId, choiceId, flagged, timeSpent } = ans;
      await client.query(
        `UPDATE um_user_answers
         SET chosen_choice_id = $1,
             is_flagged = $2,
             time_spent_sec = COALESCE($3, time_spent_sec)
         WHERE session_id = $4 AND question_id = $5`,
        [
          choiceId || null,
          flagged || false,
          timeSpent || 0,
          sessionId,
          questionId,
        ],
      );
    }

    // Fetch scoring config from the package
    const pkgScoreRes = await client.query(
      `SELECT tp.points_correct, tp.points_incorrect, tp.points_unanswered
       FROM um_tryout_sessions ts
       JOIN um_tryout_packages tp ON ts.package_id = tp.id
       WHERE ts.id = $1`,
      [sessionId],
    );
    const ptCorrect = pkgScoreRes.rows[0]?.points_correct ?? 4;
    const ptIncorrect = pkgScoreRes.rows[0]?.points_incorrect ?? -1;
    const ptUnanswered = pkgScoreRes.rows[0]?.points_unanswered ?? 0;

    // Calculate score using custom scoring points
    const correctnessRes = await client.query(
      `SELECT ua.chosen_choice_id, COALESCE(ac.is_correct, false) as is_correct, ua.question_id
       FROM um_user_answers ua
       LEFT JOIN um_answer_choices ac ON ua.chosen_choice_id = ac.id
       WHERE ua.session_id = $1`,
      [sessionId],
    );

    const totalQuestions = correctnessRes.rows.length;
    const correctCount = correctnessRes.rows.filter((r) => r.is_correct).length;
    const unansweredCount = correctnessRes.rows.filter(
      (r) => !r.chosen_choice_id,
    ).length;
    const incorrectCount = totalQuestions - correctCount - unansweredCount;

    // Calculate score using configurable points
    const score =
      correctCount * ptCorrect +
      incorrectCount * ptIncorrect +
      unansweredCount * ptUnanswered;

    const scoreBreakdown = {
      benar: correctCount,
      salah: incorrectCount,
      kosong: unansweredCount,
      total: totalQuestions,
      totalScore: score,
      pointsCorrect: ptCorrect,
      pointsIncorrect: ptIncorrect,
      pointsUnanswered: ptUnanswered,
      scoringMethod: `Custom (Benar: ${ptCorrect > 0 ? "+" : ""}${ptCorrect}, Salah: ${ptIncorrect > 0 ? "+" : ""}${ptIncorrect}, Kosong: ${ptUnanswered > 0 ? "+" : ""}${ptUnanswered})`,
    };

    // Update session
    await client.query(
      `UPDATE um_tryout_sessions
       SET submitted_at = NOW(),
           total_score = $1,
           score_breakdown = $2
       WHERE id = $3`,
      [score, JSON.stringify(scoreBreakdown), sessionId],
    );

    const pkgIdRes = await client.query(
      "SELECT package_id FROM um_tryout_sessions WHERE id = $1",
      [sessionId],
    );
    const packageId = pkgIdRes.rows[0]?.package_id;
    if (packageId) {
      await markPackageCompleted(client, userId, "um", packageId);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      data: {
        sessionId,
        totalScore: score,
        scoreBreakdown,
      },
      message: "Ujian Mandiri Tryout submitted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error submitting UM tryout bulk:", error);
    next(error);
  } finally {
    client.release();
  }
});

// Get Ujian Mandiri Latihan Session Result
router.get(
  "/latihan/result/:sessionId",
  verifyToken,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user.id;

      // Get latihan session joined with UM latihan + ujian info (if available)
      const sessionRes = await pool.query(
        `SELECT ls.*,
              um_ls.title AS latihan_name,
              um_ls.ujian_id AS ujian_id,
              um.nama_ujian AS ujian_name
       FROM latihan_sessions ls
       LEFT JOIN um_latihan_soal um_ls ON ls.latihan_id = um_ls.id
       LEFT JOIN ujian_mandiri um ON um_ls.ujian_id = um.id
       WHERE ls.id = $1 AND ls.user_id = $2`,
        [sessionId, userId],
      );

      if (sessionRes.rows.length === 0) {
        return res
          .status(404)
          .json({
            success: false,
            error: "Hasil latihan tidak ditemukan atau tidak authorized",
          });
      }

      const session = sessionRes.rows[0];

      // Parse score_breakdown JSON
      let scoreBreakdown = session.score_breakdown;
      if (typeof scoreBreakdown === "string") {
        try {
          scoreBreakdown = JSON.parse(scoreBreakdown);
        } catch {
          scoreBreakdown = {};
        }
      }

      const itemAnalysis = Array.isArray(scoreBreakdown?.itemAnalysis)
        ? scoreBreakdown.itemAnalysis
        : [];

      const analysisByQuestionId = {};
      itemAnalysis.forEach((item) => {
        if (item && item.questionId) {
          analysisByQuestionId[item.questionId] = item;
        }
      });

      // If this latihan is linked to UM latihan_soal, fetch questions & choices
      let questions = [];
      if (session.latihan_id) {
        const questionsRes = await pool.query(
          `SELECT q.id, q.content, q.image_url, q.difficulty, q.stimulus,
                (
                  SELECT json_agg(json_build_object(
                    'id', ac.id,
                    'label', ac.label,
                    'content', ac.content,
                    'is_correct', COALESCE(ac.is_correct, false),
                    'explanation', ac.explanation
                  ) ORDER BY ac.label)
                  FROM um_answer_choices ac
                  WHERE ac.question_id = q.id
                ) AS choices
         FROM um_questions q
         WHERE q.latihan_id = $1
         ORDER BY q.display_order ASC, q.created_at ASC`,
          [session.latihan_id],
        );

        questions = questionsRes.rows.map((q, index) => {
          const choices = Array.isArray(q.choices) ? q.choices : [];
          const analysis = analysisByQuestionId[q.id] || null;
          const isCorrect = analysis ? !!analysis.isCorrect : null;
          const chosenChoiceId = analysis
            ? analysis.chosenChoiceId || null
            : null;

          return {
            id: q.id,
            position: index + 1,
            content: q.content,
            image_url: q.image_url,
            difficulty: q.difficulty,
            stimulus: q.stimulus,
            choices,
            isCorrect,
            chosenChoiceId,
          };
        });
      }

      const correctCount = session.correct_count ?? scoreBreakdown?.benar ?? 0;
      const incorrectCount =
        session.incorrect_count ?? scoreBreakdown?.salah ?? 0;
      const unansweredCount =
        session.unanswered_count ?? scoreBreakdown?.kosong ?? 0;
      const totalQuestions = session.total_questions ?? questions.length;

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          latihanId: session.latihan_id,
          ujianId: session.ujian_id || null,
          latihanName:
            session.latihan_name || session.subject_name || "Latihan",
          ujianName: session.ujian_name || "",
          irtScore: session.irt_score,
          scoreBreakdown,
          correctCount,
          incorrectCount,
          unansweredCount,
          totalQuestions,
          questions,
          submittedAt: session.submitted_at,
        },
      });
    } catch (error) {
      console.error("Error fetching UM latihan result:", error);
      next(error);
    }
  },
);

// Get Ujian Mandiri Tryout Session Result
router.get("/tryout/result/:sessionId", verifyToken, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    // Get session details
    const sessionRes = await pool.query(
      `SELECT ts.*, tp.title, tp.duration, um.nama_ujian as ujian_name, um.id as ujian_id
       FROM um_tryout_sessions ts
       JOIN um_tryout_packages tp ON ts.package_id = tp.id
       JOIN ujian_mandiri um ON tp.ujian_id = um.id
       WHERE ts.id = $1 AND ts.user_id = $2`,
      [sessionId, userId],
    );

    if (sessionRes.rows.length === 0) {
      return res
        .status(404)
        .json({
          success: false,
          error: "Hasil sesi tidak ditemukan atau tidak authorized",
        });
    }

    const session = sessionRes.rows[0];
    if (!session.submitted_at) {
      return res
        .status(400)
        .json({ success: false, error: "Sesi tryout ini belum disubmit" });
    }

    // Fetch questions, choices, correctness, and user answers
    const questionsRes = await pool.query(
      `SELECT q.id, q.content, q.image_url, q.difficulty, q.stimulus,
              ua.chosen_choice_id, ua.is_flagged, ua.time_spent_sec, ua.position,
              (
                SELECT json_agg(json_build_object(
                  'id', ac.id,
                  'label', ac.label,
                  'content', ac.content,
                  'is_correct', COALESCE(ac.is_correct, false),
                  'explanation', ac.explanation
                ) ORDER BY ac.label)
                FROM um_answer_choices ac
                WHERE ac.question_id = q.id
              ) as choices
       FROM um_user_answers ua
       JOIN um_questions q ON ua.question_id = q.id
       WHERE ua.session_id = $1
       ORDER BY ua.position ASC`,
      [sessionId],
    );

    // Format questions list
    const questions = questionsRes.rows.map((q) => {
      const choices = Array.isArray(q.choices) ? q.choices : [];
      const chosenChoice =
        choices.find((c) => c.id === q.chosen_choice_id) || null;
      const correctChoice = choices.find((c) => c.is_correct) || null;

      return {
        id: q.id,
        position: q.position,
        content: q.content,
        imageUrl: q.image_url,
        difficulty: q.difficulty,
        stimulus: q.stimulus,
        chosenChoiceId: q.chosen_choice_id,
        userAnswer: chosenChoice ? chosenChoice.label : null,
        correctAnswer: correctChoice ? correctChoice.label : null,
        explanation: correctChoice ? correctChoice.explanation : null,
        isCorrect: chosenChoice ? chosenChoice.is_correct : false,
        isFlagged: q.is_flagged,
        timeSpentSec: q.time_spent_sec || 0,
        choices: choices,
      };
    });

    // Parse score breakdown
    let scoreBreakdown = session.score_breakdown;
    if (typeof scoreBreakdown === "string") {
      try {
        scoreBreakdown = JSON.parse(scoreBreakdown);
      } catch {
        scoreBreakdown = {};
      }
    }

    // Calculate time spent
    const totalTimeSpent = questions.reduce(
      (sum, q) => sum + q.timeSpentSec,
      0,
    );

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        tryoutId: session.package_id,
        ujianId: session.ujian_id,
        tryoutName: session.title,
        ujianName: session.ujian_name,
        totalScore: session.total_score,
        scoreBreakdown,
        questions,
        duration: session.duration || 60,
        timeSpent: totalTimeSpent,
        submittedAt: session.submitted_at,
      },
    });
  } catch (error) {
    console.error("Error fetching UM session result:", error);
    next(error);
  }
});

// Leaderboard for Ujian Mandiri Tryout Package
router.get(
  "/tryout/leaderboard/:packageId",
  verifyToken,
  async (req, res, next) => {
    const { packageId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    try {
      const leaderboardRes = await pool.query(
        `
      SELECT DISTINCT ON (ts.user_id)
        ts.user_id,
        u.name,
        ts.total_score,
        ts.submitted_at
      FROM um_tryout_sessions ts
      JOIN users u ON u.id = ts.user_id
      WHERE ts.package_id = $1
        AND ts.submitted_at IS NOT NULL
        AND ts.total_score IS NOT NULL
        AND u.role = 'student'
      ORDER BY ts.user_id, ts.submitted_at DESC
    `,
        [packageId],
      );

      // Sort by total_score descending and assign ranks
      const sorted = leaderboardRes.rows
        .sort((a, b) => (b.total_score || 0) - (a.total_score || 0))
        .slice(0, limit)
        .map((row, idx) => ({
          rank: idx + 1,
          user_id: row.user_id,
          name: row.name,
          score: Math.round(row.total_score || 0),
          submitted_at: row.submitted_at,
        }));

      // Find current user's rank
      const allSorted = leaderboardRes.rows.sort(
        (a, b) => (b.total_score || 0) - (a.total_score || 0),
      );
      const userIdx = allSorted.findIndex((r) => r.user_id === req.user.id);
      const userRank =
        userIdx >= 0
          ? {
              rank: userIdx + 1,
              score: Math.round(allSorted[userIdx].total_score || 0),
              total_participants: allSorted.length,
            }
          : null;

      res.json({
        success: true,
        data: {
          leaderboard: sorted,
          user_rank: userRank,
          total_participants: allSorted.length,
        },
      });
    } catch (error) {
      console.error("UM Tryout Leaderboard error:", error);
      next(error);
    }
  },
);

// Leaderboard for Ujian Mandiri Latihan Soal
router.get(
  "/latihan/leaderboard/:latihanId",
  verifyToken,
  async (req, res, next) => {
    const { latihanId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    try {
      const leaderboardRes = await pool.query(
        `
      SELECT DISTINCT ON (ls.user_id)
        ls.user_id,
        u.name,
        ls.irt_score,
        ls.submitted_at
      FROM latihan_sessions ls
      JOIN users u ON u.id = ls.user_id
      WHERE ls.latihan_id = $1
        AND ls.submitted_at IS NOT NULL
        AND ls.irt_score IS NOT NULL
        AND u.role = 'student'
      ORDER BY ls.user_id, ls.submitted_at DESC
    `,
        [latihanId],
      );

      // Sort by irt_score descending and assign ranks
      const sorted = leaderboardRes.rows
        .sort((a, b) => (b.irt_score || 0) - (a.irt_score || 0))
        .slice(0, limit)
        .map((row, idx) => ({
          rank: idx + 1,
          user_id: row.user_id,
          name: row.name,
          score: Math.round(row.irt_score || 0),
          submitted_at: row.submitted_at,
        }));

      // Find current user's rank
      const allSorted = leaderboardRes.rows.sort(
        (a, b) => (b.irt_score || 0) - (a.irt_score || 0),
      );
      const userIdx = allSorted.findIndex((r) => r.user_id === req.user.id);
      const userRank =
        userIdx >= 0
          ? {
              rank: userIdx + 1,
              score: Math.round(allSorted[userIdx].irt_score || 0),
              total_participants: allSorted.length,
            }
          : null;

      res.json({
        success: true,
        data: {
          leaderboard: sorted,
          user_rank: userRank,
          total_participants: allSorted.length,
        },
      });
    } catch (error) {
      console.error("UM Latihan Leaderboard error:", error);
      next(error);
    }
  },
);

module.exports = router;
