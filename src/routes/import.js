const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');
const upload = require('../middleware/upload');
const XLSX = require('xlsx');
const { generateQuestionHash } = require('../utils/questionHashUtil');

/**
 * POST /api/import/excel
 *
 * Expects multipart/form-data with:
 *   - file              : Excel file (.xlsx or .xls)
 *   - subject_id        : UUID of the subject
 *   - difficulty        : 'easy' | 'medium' | 'hard'  (default: 'medium')
 *   - destination       : 'latihan' | 'tryout' (default: 'latihan')
 *   - tryout_package_id : UUID of tryout package (required if destination is 'tryout')
 *
 * Excel columns (header row required, case-insensitive):
 *   SOAL | OPSI A | OPSI B | OPSI C | OPSI D | OPSI E | KUNCI JAWABAN | PEMBAHASAN
 *
 * No question limit — all rows in the file will be processed.
 */
router.post('/excel', verifyToken, verifyAdmin, upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const { subject_id, topic_id, difficulty = 'medium', destination = 'latihan', tryout_package_id } = req.body;
  if (!subject_id) {
    return res.status(400).json({ success: false, error: 'subject_id wajib diisi sebelum import' });
  }
  if (destination === 'tryout' && !tryout_package_id) {
    return res.status(400).json({ success: false, error: 'tryout_package_id wajib diisi jika destination adalah tryout' });
  }

  // Flexible column name resolver (handles BOM, extra spaces, case differences)
  const ALIASES = {
    stimulus:      ['stimulus', 'wacana', 'bacaan', 'stimulus/wacana', 'stimulus/wacana (opsional)'],
    soal:          ['soal', 'content', 'question', 'pertanyaan'],
    opsi_a:        ['opsi a', 'opsia', 'choice_a', 'pilihan a', 'a'],
    opsi_b:        ['opsi b', 'opsib', 'choice_b', 'pilihan b', 'b'],
    opsi_c:        ['opsi c', 'opsic', 'choice_c', 'pilihan c', 'c'],
    opsi_d:        ['opsi d', 'opsid', 'choice_d', 'pilihan d', 'd'],
    opsi_e:        ['opsi e', 'opsie', 'choice_e', 'pilihan e', 'e'],
    kunci:         ['kunci jawaban', 'kunci', 'correct_label', 'answer', 'jawaban', 'kunci_jawaban'],
    pembahasan:    ['pembahasan', 'explanation', 'penjelasan'],
    image_url:     ['gambar', 'image', 'image_url', 'url gambar', 'foto'],
    tipe_soal:     ['tipe soal', 'tipe', 'question_type', 'type', 'tipe_soal'],
    image_position:['posisi gambar', 'posisi_gambar', 'image_position', 'image position'],
  };

  const resolve = (row, key) => {
    const aliases = ALIASES[key];
    for (const alias of aliases) {
      for (const rowKey of Object.keys(row)) {
        const clean = rowKey.replace(/^\uFEFF/, '').trim().toLowerCase();
        if (clean === alias) {
          const val = row[rowKey];
          if (val === null || val === undefined) return '';
          return String(val).trim();
        }
      }
    }
    return '';
  };

  // Parse Excel file
  let results;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    results = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ success: false, error: `Excel parse error: ${err.message}` });
  }

  if (!results || results.length === 0) {
    return res.status(400).json({ success: false, error: 'File Excel kosong atau tidak memiliki data.' });
  }

  let importedCount = 0;
  let rejectedCount = 0;
  const errors = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the current max display_order for this subject AND tryout package (if applicable)
    let maxOrderRes;
    if (destination === 'tryout' && tryout_package_id) {
      maxOrderRes = await client.query(
        'SELECT COALESCE(MAX(display_order), 0) as max_order FROM questions WHERE subject_id = $1 AND tryout_package_id = $2',
        [subject_id, tryout_package_id]
      );
    } else {
      maxOrderRes = await client.query(
        'SELECT COALESCE(MAX(display_order), 0) as max_order FROM questions WHERE subject_id = $1 AND tryout_package_id IS NULL',
        [subject_id]
      );
    }
    let nextDisplayOrder = (maxOrderRes.rows[0]?.max_order || 0) + 1;

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const rowNum = i + 2; // row 1 = header

      const stimulus   = resolve(row, 'stimulus');
      const soal       = resolve(row, 'soal');
      const opsiA      = resolve(row, 'opsi_a');
      const opsiB      = resolve(row, 'opsi_b');
      const opsiC      = resolve(row, 'opsi_c');
      const opsiD      = resolve(row, 'opsi_d');
      const opsiE      = resolve(row, 'opsi_e');
      const kunci      = resolve(row, 'kunci');
      const pembahasan = resolve(row, 'pembahasan');
      const imageUrl   = resolve(row, 'image_url');
      const rawTipe    = resolve(row, 'tipe_soal').toLowerCase();
      const rawPos     = resolve(row, 'image_position').toLowerCase();
      const imagePosition = ['before', 'atas', 'top'].includes(rawPos) ? 'top' :
                            ['middle', 'ditengah', 'tengah'].includes(rawPos) ? 'middle' :
                            ['after', 'bawah', 'bottom'].includes(rawPos) ? 'bottom' : 'bottom';

      // ── Validation ──────────────────────────────────────────────
      if (!soal) {
        errors.push(`Baris ${rowNum}: Kolom SOAL kosong`);
        rejectedCount++;
        continue;
      }

      // Determine question type
      let questionType = 'multiple_choice';
      if (rawTipe === 'complex_mc_tf' || rawTipe === 'pilihan_ganda_kompleks' || rawTipe === 'benar_salah' || rawTipe === 'benar salah') {
        questionType = 'complex_mc_tf';
      } else if (rawTipe === 'short_answer' || rawTipe === 'isian') {
        questionType = 'short_answer';
      } else if (!opsiA && !opsiB && !opsiC && !opsiD && !opsiE) {
        questionType = 'short_answer';
      }

      let choices = [];
      let correctnessMap = { A: false, B: false, C: false, D: false, E: false };

      if (questionType === 'short_answer') {
        // Short answer validation
        if (!kunci) {
          errors.push(`Baris ${rowNum}: Soal isian singkat harus memiliki KUNCI JAWABAN`);
          rejectedCount++;
          continue;
        }
      } else if (questionType === 'complex_mc_tf') {
        // Complex MC true/false validation
        if (!opsiA || !opsiB) {
          errors.push(`Baris ${rowNum}: Soal benar/salah minimal harus memiliki OPSI A dan OPSI B`);
          rejectedCount++;
          continue;
        }
        if (!kunci) {
          errors.push(`Baris ${rowNum}: Soal benar/salah harus memiliki KUNCI JAWABAN`);
          rejectedCount++;
          continue;
        }

        choices = [
          { label: 'A', content: opsiA },
          { label: 'B', content: opsiB },
          { label: 'C', content: opsiC },
          { label: 'D', content: opsiD },
          { label: 'E', content: opsiE },
        ].filter(c => c.content !== '');

        const cleanKunci = kunci.toUpperCase().replace(/\s+/g, '');
        if (cleanKunci.includes(':')) {
          // Format "A:B,B:S"
          const pairs = cleanKunci.split(',');
          for (const pair of pairs) {
            const [lbl, val] = pair.split(':');
            if (lbl && val) {
              const isTrue = val.startsWith('B') || val.startsWith('T') || val === 'BENAR' || val === 'TRUE';
              correctnessMap[lbl] = isTrue;
            }
          }
        } else {
          // Format "B,S,B"
          const parts = cleanKunci.split(',');
          const labels = ['A', 'B', 'C', 'D', 'E'];
          parts.forEach((part, idx) => {
            if (idx < labels.length) {
              const isTrue = part.startsWith('B') || part.startsWith('T') || part === 'BENAR' || part === 'TRUE';
              correctnessMap[labels[idx]] = isTrue;
            }
          });
        }
      } else {
        // Multiple choice validation
        if (!opsiA || !opsiB) {
          errors.push(`Baris ${rowNum}: Minimal OPSI A dan OPSI B harus diisi`);
          rejectedCount++;
          continue;
        }
        const upperKunci = kunci.toUpperCase().trim();
        if (!['A', 'B', 'C', 'D', 'E'].includes(upperKunci)) {
          errors.push(`Baris ${rowNum}: KUNCI JAWABAN '${kunci}' tidak valid (harus A/B/C/D/E)`);
          rejectedCount++;
          continue;
        }

        choices = [
          { label: 'A', content: opsiA },
          { label: 'B', content: opsiB },
          { label: 'C', content: opsiC },
          { label: 'D', content: opsiD },
          { label: 'E', content: opsiE },
        ].filter(c => c.content !== '');

        const correctExists = choices.some(c => c.label === upperKunci);
        if (!correctExists) {
          errors.push(`Baris ${rowNum}: KUNCI '${upperKunci}' tidak ada di opsi yang tersedia`);
          rejectedCount++;
          continue;
        }
      }

      // Compute content hash
      const hashChoices = questionType === 'short_answer'
        ? [kunci]
        : choices;
      const hash = generateQuestionHash(soal, hashChoices, imageUrl, stimulus);

      // ── Insert question ──────────────────────────────────────────
      const pkgId = destination === 'tryout' ? tryout_package_id : null;
      const qSource = destination === 'battle' ? 'battle' : 'manual';
      const qRes = await client.query(
        'INSERT INTO questions (subject_id, topic_id, content, difficulty, tryout_package_id, display_order, source, image_url, image_position, question_type, content_hash, stimulus) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id',
        [subject_id, topic_id || null, soal, difficulty, pkgId, nextDisplayOrder, qSource, imageUrl || null, imagePosition, questionType, hash, stimulus || null]
      );
      const questionId = qRes.rows[0].id;
      nextDisplayOrder++;

      // ── Insert choices ───────────────────────────────────────────
      if (questionType === 'short_answer') {
        await client.query(
          'INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)',
          [questionId, 'A', kunci, true, pembahasan || null]
        );
      } else if (questionType === 'complex_mc_tf') {
        for (const choice of choices) {
          const isCorrect = correctnessMap[choice.label] === true;
          await client.query(
            'INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)',
            [questionId, choice.label, choice.content, isCorrect, pembahasan || null]
          );
        }
      } else {
        const upperKunci = kunci.toUpperCase().trim();
        for (const choice of choices) {
          const isCorrect = choice.label === upperKunci;
          await client.query(
            'INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)',
            [questionId, choice.label, choice.content, isCorrect, isCorrect ? (pembahasan || null) : null]
          );
        }
      }

      importedCount++;
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'CREATE', 'SOAL', `File: ${req.file?.originalname || 'Excel'}`, `Mengimpor ${importedCount} soal dari file Excel (${destination})`);

    res.json({
      success: true,
      data: { importedCount, rejectedCount, errors },
      message: `Import selesai. ${importedCount} soal berhasil diimpor, ${rejectedCount} gagal.`,
    });

  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// Keep backward compatibility — redirect old CSV endpoint to Excel
router.post('/csv', verifyToken, verifyAdmin, upload.single('file'), (req, res) => {
  res.status(410).json({ success: false, error: 'Endpoint CSV sudah tidak didukung. Gunakan /api/import/excel dengan file Excel (.xlsx).' });
});

module.exports = router;
