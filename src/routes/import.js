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
 *   - topic_id          : UUID of topic (optional, can be auto-resolved from MATERI column)
 *   - difficulty        : 'easy' | 'medium' | 'hard'  (default: 'medium')
 *   - destination       : 'latihan' | 'tryout' | 'battle' (default: 'latihan')
 *   - tryout_package_id : UUID of tryout package (required if destination is 'tryout')
 *
 * Excel columns (header row required, case-insensitive):
 *   MATERI | STIMULUS | SOAL | OPSI A | OPSI B | OPSI C | OPSI D | OPSI E | LABEL KOLOM | KUNCI JAWABAN | PEMBAHASAN | TIPE SOAL | GAMBAR | POSISI GAMBAR | TINGKAT KESULITAN
 *
 * Supports 4 Question Types:
 *   1. multiple_choice (Pilihan Ganda Tunggal, 1 kunci A-E)
 *   2. complex_mc_multi (Pilihan Ganda Lebih dari 1 Jawaban, e.g. A, C)
 *   3. complex_mc_tf (PG Kompleks Benar/Salah & Custom Label, e.g. A:Benar, B:Salah atau A:Tepat, B:Tidak Tepat)
 *   4. short_answer (Jawaban Singkat / Isian)
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
    materi: [
      'materi', 'topik', 'topic', 'judul materi', 'bab', 'materi pokok',
      'nama materi', 'subtes materi', 'materi/topik', 'materi / topik',
      'materi soal', 'bab/materi', 'bab materi'
    ],
    tingkat_kesulitan: [
      'tingkat kesulitan', 'tingkat_kesulitan', 'kesulitan', 'difficulty',
      'level kesulitan', 'level', 'tingkat', 'kesulitan soal',
      'kategori kesulitan', 'derajat kesulitan', 'tingkat kesukaran'
    ],
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
    label_kolom:   ['label_kolom', 'label kolom', 'kolom_pilihan', 'tf_label', 'label_benar_salah', 'opsi_label', 'label_opsi', 'label', 'format label', 'format_label'],
    image_position:['posisi gambar', 'posisi_gambar', 'image_position', 'image position'],
  };

  const resolve = (row, key) => {
    const aliases = ALIASES[key];
    if (!aliases) return '';
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

  const resolveWithPositionalFallback = (row, key, pos) => {
    const directVal = resolve(row, key);
    if (directVal) return directVal;

    const keys = Object.keys(row);
    if (keys.length === 0) return '';
    const knownStandardCols = [
      'soal', 'content', 'stimulus', 'wacana', 'bacaan', 'opsi a', 'a', 'opsi b', 'b',
      'opsi c', 'c', 'opsi d', 'd', 'opsi e', 'e', 'kunci', 'kunci jawaban',
      'pembahasan', 'explanation', 'penjelasan', 'gambar', 'image', 'url gambar', 'foto', 'no', 'nomor', '#', 'id'
    ];
    if (pos === 'start') {
      const firstKey = keys[0];
      const cleanKey = firstKey.replace(/^\uFEFF/, '').trim().toLowerCase();
      if (!knownStandardCols.includes(cleanKey)) {
        const val = row[firstKey];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          return String(val).trim();
        }
      }
    } else if (pos === 'end') {
      const lastKey = keys[keys.length - 1];
      const cleanKey = lastKey.replace(/^\uFEFF/, '').trim().toLowerCase();
      if (!knownStandardCols.includes(cleanKey)) {
        const val = row[lastKey];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          return String(val).trim();
        }
      }
    }
    return '';
  };

  // Helper to evaluate true/false boolean safely (handles "Tidak Tepat", "Tidak Sesuai", etc.)
  const isValueTrue = (val) => {
    const v = String(val).trim().toUpperCase();
    if (v.startsWith('TIDAK') || v.startsWith('BUKAN') || v === 'S' || v === 'SALAH' || v === 'FALSE' || v === '0') {
      return false;
    }
    if (v === 'B' || v === 'T' || v === '1' || v === 'YA' || v === 'BENAR' || v === 'TRUE' || v === 'TEPAT' || v === 'SESUAI' || v.startsWith('BENAR') || v.startsWith('TRUE') || v.startsWith('TEPAT') || v.startsWith('SESUAI')) {
      return true;
    }
    return false;
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
  const topicCache = {};

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
    let nextDisplayOrder = (parseInt(maxOrderRes.rows[0]?.max_order, 10) || 0) + 1;

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const rowNum = i + 2; // row 1 = header

      // UTBK: Only resolve materi if explicit column exists; do not guess via positional fallback
      const rawMateri = resolve(row, 'materi');
      let rawDifficulty = resolve(row, 'tingkat_kesulitan');

      if (!rawDifficulty) {
        const candidateStart = resolveWithPositionalFallback(row, 'tingkat_kesulitan', 'start');
        const candidateEnd = resolveWithPositionalFallback(row, 'tingkat_kesulitan', 'end');
        const diffKeywords = ['mudah', 'easy', 'sedang', 'medium', 'sulit', 'hard', 'dasar', 'menengah', 'sukar', 'hots'];
        if (candidateEnd && diffKeywords.includes(candidateEnd.toLowerCase())) {
          rawDifficulty = candidateEnd;
        } else if (candidateStart && diffKeywords.includes(candidateStart.toLowerCase())) {
          rawDifficulty = candidateStart;
        }
      }

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
      const rawLabelKolom = resolve(row, 'label_kolom');
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
      const cleanTipe = rawTipe.replace(/[\s\-_]+/g, ' ').trim();

      if (
        cleanTipe === 'multiple choice' ||
        cleanTipe === 'single' ||
        cleanTipe === 'pg tunggal' ||
        cleanTipe === 'pilihan ganda tunggal' ||
        cleanTipe === 'pilihan ganda' ||
        cleanTipe === 'pg'
      ) {
        questionType = 'multiple_choice';
      } else if (
        cleanTipe.includes('complex mc multi') ||
        cleanTipe.includes('multi jawaban') ||
        cleanTipe.includes('multi opsi') ||
        cleanTipe.includes('lebih dari 1') ||
        cleanTipe.includes('lebih dari satu') ||
        cleanTipe.includes('banyak jawaban') ||
        cleanTipe.includes('centang') ||
        (cleanTipe.includes('multi') && !cleanTipe.includes('multiple choice'))
      ) {
        questionType = 'complex_mc_multi';
      } else if (
        cleanTipe.includes('short') ||
        cleanTipe.includes('isian') ||
        cleanTipe.includes('singkat')
      ) {
        questionType = 'short_answer';
      } else if (
        cleanTipe.includes('complex mc tf') ||
        cleanTipe.includes('kompleks') ||
        cleanTipe.includes('complex') ||
        cleanTipe.includes('benar') ||
        cleanTipe.includes('salah') ||
        cleanTipe.includes('tf') ||
        cleanTipe.includes('tepat') ||
        cleanTipe.includes('true')
      ) {
        questionType = 'complex_mc_tf';
      } else if (!opsiA && !opsiB && !opsiC && !opsiD && !opsiE) {
        questionType = 'short_answer';
      }

      let choices = [];
      let correctnessMap = { A: false, B: false, C: false, D: false, E: false };
      let optionsConfig = {};

      if (questionType === 'short_answer') {
        // Short answer validation
        if (!kunci) {
          errors.push(`Baris ${rowNum}: Soal isian singkat harus memiliki KUNCI JAWABAN`);
          rejectedCount++;
          continue;
        }
      } else if (questionType === 'complex_mc_multi') {
        if (!opsiA || !opsiB) {
          errors.push(`Baris ${rowNum}: Soal pilihan ganda multi minimal harus memiliki OPSI A dan OPSI B`);
          rejectedCount++;
          continue;
        }
        if (!kunci) {
          errors.push(`Baris ${rowNum}: Soal pilihan ganda multi harus memiliki KUNCI JAWABAN`);
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

        const matchedLetters = (kunci || '').toUpperCase().match(/[A-E]/g) || [];
        const correctLetters = Array.from(new Set(matchedLetters));
        if (correctLetters.length === 0) {
          errors.push(`Baris ${rowNum}: Kunci jawaban tidak valid untuk pilihan multi (harus berisi A/B/C/D/E)`);
          rejectedCount++;
          continue;
        }
        for (const l of correctLetters) {
          correctnessMap[l] = true;
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

        const cleanKunci = (kunci || '').toUpperCase().trim();
        if (rawLabelKolom) {
          const parts = rawLabelKolom.split(/[\/,;|\-]+/).map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            optionsConfig = { true_label: parts[0], false_label: parts[1] };
          }
        } else if (cleanKunci.includes('TRUE') || cleanKunci.includes('FALSE')) {
          optionsConfig = { true_label: 'TRUE', false_label: 'FALSE' };
        } else if (cleanKunci.includes('TEPAT')) {
          optionsConfig = { true_label: 'Tepat', false_label: 'Tidak Tepat' };
        } else if (cleanKunci.includes('SESUAI')) {
          optionsConfig = { true_label: 'Sesuai', false_label: 'Tidak Sesuai' };
        } else if (cleanKunci.includes('YA') || cleanKunci.includes('TIDAK')) {
          optionsConfig = { true_label: 'Ya', false_label: 'Tidak' };
        } else {
          optionsConfig = { true_label: 'Benar', false_label: 'Salah' };
        }

        if (cleanKunci.includes(':')) {
          // Format "A:Benar, B:Salah" or "A:Tepat, B:Tidak Tepat"
          const pairs = cleanKunci.split(/[,;\n\r]+/);
          for (const pair of pairs) {
            const colonIdx = pair.indexOf(':');
            if (colonIdx !== -1) {
              const lbl = pair.substring(0, colonIdx).trim().toUpperCase();
              const val = pair.substring(colonIdx + 1).trim();
              if (lbl && val) {
                correctnessMap[lbl] = isValueTrue(val);
              }
            }
          }
        } else {
          // Format "Benar, Salah, Benar" or "B, S, B"
          const parts = cleanKunci.split(/[,;\n\r]+/).map(s => s.trim()).filter(Boolean);
          const labels = ['A', 'B', 'C', 'D', 'E'];
          parts.forEach((part, idx) => {
            if (idx < labels.length) {
              correctnessMap[labels[idx]] = isValueTrue(part);
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
        const upperKunci = (kunci || '').toUpperCase().trim();
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

      // Resolve difficulty per question
      let resolvedDifficulty = difficulty || 'medium';
      if (rawDifficulty) {
        const dLower = rawDifficulty.toLowerCase().trim();
        if (dLower.includes('mudah') || dLower.includes('easy') || dLower.includes('dasar') || dLower === '1') {
          resolvedDifficulty = 'easy';
        } else if (dLower.includes('sulit') || dLower.includes('hard') || dLower.includes('sukar') || dLower.includes('hots') || dLower.includes('tinggi') || dLower === '3') {
          resolvedDifficulty = 'hard';
        } else if (dLower.includes('sedang') || dLower.includes('medium') || dLower.includes('menengah') || dLower === '2') {
          resolvedDifficulty = 'medium';
        }
      }

      // Resolve topic/materi per question (auto-link or auto-create topic if explicitly named)
      let resolvedTopicId = topic_id || null;
      if (rawMateri && rawMateri.trim()) {
        const cleanMateri = rawMateri.trim().substring(0, 255);
        const materiKey = cleanMateri.toLowerCase();
        if (!topicCache[materiKey]) {
          const tRes = await client.query(
            `SELECT id FROM topics WHERE subject_id = $1 AND LOWER(TRIM(title)) = LOWER(TRIM($2)) LIMIT 1`,
            [subject_id, cleanMateri]
          );
          if (tRes.rows.length > 0) {
            topicCache[materiKey] = tRes.rows[0].id;
          } else {
            const newTopicRes = await client.query(
              `INSERT INTO topics (subject_id, title, difficulty_level, card_type)
               VALUES ($1, $2, 'Dasar', 'standard') RETURNING id`,
              [subject_id, cleanMateri]
            );
            topicCache[materiKey] = newTopicRes.rows[0].id;
          }
        }
        resolvedTopicId = topicCache[materiKey];
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
        `INSERT INTO questions (subject_id, topic_id, content, difficulty, tryout_package_id, display_order, source, image_url, image_position, question_type, options_config, content_hash, stimulus, workflow_status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          subject_id,
          resolvedTopicId,
          soal,
          resolvedDifficulty,
          pkgId,
          nextDisplayOrder,
          qSource,
          imageUrl || null,
          imagePosition,
          questionType,
          JSON.stringify(optionsConfig),
          hash,
          stimulus || null,
          'under_review',
          req.user.id
        ]
      );
      const questionId = qRes.rows[0].id;
      nextDisplayOrder++;

      // ── Insert choices ───────────────────────────────────────────
      if (questionType === 'short_answer') {
        await client.query(
          'INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)',
          [questionId, 'A', kunci, true, pembahasan || null]
        );
      } else if (questionType === 'complex_mc_tf' || questionType === 'complex_mc_multi') {
        for (const choice of choices) {
          const isCorrect = correctnessMap[choice.label] === true;
          await client.query(
            'INSERT INTO answer_choices (question_id, label, content, is_correct, explanation) VALUES ($1, $2, $3, $4, $5)',
            [questionId, choice.label, choice.content, isCorrect, pembahasan || null]
          );
        }
      } else {
        const upperKunci = (kunci || '').toUpperCase().trim();
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
