/**
 * Item Response Theory (IRT) Scoring Service for UTBK
 * Implements 3-Parameter Logistic (3PL) Model
 *
 * Formula: P(θ) = c + (1-c) / (1 + e^(-a(θ-b)))
 *
 * Where:
 * - θ (theta) = ability parameter
 * - a = item discrimination (how well question differentiates)
 * - b = item difficulty
 * - c = guessing parameter (pseudo-chance)
 *
 * For UTBK context:
 * - a (discrimination): typically 0.5 - 2.5, default 1.0
 * - b (difficulty): scaled from -3 to +3, mapped from easy/medium/hard
 * - c (guessing): typically 0.2 for 4-choice, 0.25 for 5-choice
 */

const DIFFICULTY_MAP = {
  easy: -1.5,      // Easier than average
  medium: 0,        // Average difficulty
  hard: 1.5,        // Harder than average
  hots: 2.0        // High Order Thinking Skills (hardest)
};

// Default IRT parameters per difficulty
// c (guessing) kept low so even partial correctness yields meaningful theta
const DEFAULT_IRT_PARAMS = {
  easy: { a: 0.8, b: -1.5, c: 0.10 },
  medium: { a: 1.0, b: 0, c: 0.10 },
  hard: { a: 1.2, b: 1.5, c: 0.10 },
  hots: { a: 1.5, b: 2.0, c: 0.10 }
};

// UTBK Reference: ~140 questions total for full test
// TPS: 40 questions (Penalaran Umum, Pengetahuan Kuantitatif, Literasi Bahasa, Penalaran Matematika)
// TKA: 100 questions (varies by program)
const FULL_TEST_QUESTIONS = 140;

/**
 * Calculate probability of correct response using 3PL model
 * @param {number} theta - Ability parameter
 * @param {object} itemParams - IRT parameters {a, b, c}
 * @returns {number} Probability of correct response (0-1)
 */
function probability3PL(theta, itemParams) {
  const { a = 1.0, b = 0, c = 0.25 } = itemParams;
  const exponent = -a * (theta - b);
  return c + (1 - c) / (1 + Math.exp(exponent));
}

/**
 * Calculate log-likelihood for a single response
 * @param {boolean} isCorrect - Whether the response was correct
 * @param {number} theta - Ability parameter
 * @param {object} itemParams - IRT parameters
 * @returns {number} Log-likelihood
 */
function logLikelihood(isCorrect, theta, itemParams) {
  const p = probability3PL(theta, itemParams);
  if (isCorrect) {
    return Math.log(Math.max(p, 1e-10));
  } else {
    return Math.log(Math.max(1 - p, 1e-10));
  }
}

/**
 * Calculate total log-likelihood for all responses at a given theta
 * @param {Array} responses - Array of {isCorrect, difficulty, irtParams}
 * @param {number} theta - Ability parameter
 * @returns {number} Total log-likelihood
 */
function totalLogLikelihood(responses, theta) {
  return responses.reduce((sum, resp) => {
    return sum + logLikelihood(resp.isCorrect, theta, resp.irtParams);
  }, 0);
}

/**
 * Estimate ability using Maximum Likelihood Estimation (MLE)
 * @param {Array} responses - Array of response objects
 * @param {object} options - Options for estimation
 * @returns {number} Estimated ability (theta)
 */
function estimateAbility(responses, options = {}) {
  const {
    lowerBound = -4,
    upperBound = 4,
    tolerance = 0.001,
    maxIterations = 100
  } = options;

  if (responses.length === 0) return -4;
  if (responses.length === 1) {
    // With only one response, estimate based on that
    return responses[0].isCorrect ? 1 : -1;
  }

  // Initial estimate using classical test theory
  const correctCount = responses.filter(r => r.isCorrect).length;
  const initialTheta = ((correctCount / responses.length) - 0.5) * 6;

  // Grid search for maximum log-likelihood
  let bestTheta = initialTheta;
  let bestLL = totalLogLikelihood(responses, initialTheta);

  // Step size for grid search
  const step = 0.1;
  for (let theta = lowerBound; theta <= upperBound; theta += step) {
    const ll = totalLogLikelihood(responses, theta);
    if (ll > bestLL) {
      bestLL = ll;
      bestTheta = theta;
    }
  }

  return Math.max(lowerBound, Math.min(upperBound, bestTheta));
}

/**
 * Convert theta (ability) + mastery to UTBK scale score (0-1000)
 * Blends IRT theta with raw correctness so users always get credit for correct answers
 * @param {number} theta - Ability parameter (-4 to 4)
 * @param {number} correct - Number of correct answers (optional)
 * @param {number} total - Total answered questions (optional)
 * @returns {number} UTBK score (0-1000)
 */
function thetaToScore(theta, correct = null, total = null) {
  const minScore = 0;
  const maxScore = 1000;

  // IRT component: map theta [-4, 4] to [0, 1]
  const irtNormalized = Math.max(0, Math.min(1, (theta + 4) / 8));

  // If we don't have mastery data, use pure IRT
  if (correct === null || total === null || total === 0) {
    return Math.max(minScore, Math.min(maxScore, Math.round(irtNormalized * maxScore)));
  }

  // Mastery component: raw percentage correct
  const masteryNormalized = correct / total;

  // Blend 50% IRT (difficulty-aware) + 50% mastery (intuitive)
  // This guarantees that any correct answers contribute to the score
  const blended = 0.5 * irtNormalized + 0.5 * masteryNormalized;

  const finalScore = Math.round(blended * (maxScore - minScore) + minScore);
  return Math.max(minScore, Math.min(maxScore, finalScore));
}

/**
 * Calculate IRT-based score for a tryout session
 * @param {Array} answers - Array of answer objects with difficulty info
 * @returns {object} Detailed IRT scoring results
 */
function calculateIRTScore(answers) {
  const totalQuestions = answers.length;

  if (totalQuestions === 0) {
    return {
      theta: -4,
      rawScore: 0,
      totalScore: 0,
      benar: 0,
      salah: 0,
      kosong: totalQuestions,
      mastery: 0,
      percentile: 1,
      subjectScores: {},
      itemAnalysis: [],
      totalQuestionsAnswered: 0
    };
  }

  // Count basic stats
  let benar = 0;
  let salah = 0;
  let kosong = 0;

  // Build response history for IRT
  const responses = answers.map(ans => {
    const difficulty = ans.difficulty || 'medium';
    const irtParams = ans.irtParams || DEFAULT_IRT_PARAMS[difficulty] || DEFAULT_IRT_PARAMS.medium;

    const isAnswered = (ans.question_type === 'short_answer' || ans.question_type === 'complex_mc_tf')
      ? (ans.answer_text !== null && ans.answer_text !== undefined && String(ans.answer_text).trim() !== '')
      : (ans.chosen_choice_id !== null && ans.chosen_choice_id !== undefined);

    if (!isAnswered) {
      kosong++;
    } else if (ans.is_correct) {
      benar++;
    } else {
      salah++;
    }

    return {
      isCorrect: isAnswered ? ans.is_correct : false,
      difficulty,
      irtParams,
      questionId: ans.question_id,
      chosenChoiceId: ans.chosen_choice_id,
      answerText: ans.answer_text || null
    };
  });

  // Estimate ability using IRT
  const theta = estimateAbility(responses);

  // Calculate raw score (weighted by difficulty)
  let rawScore = 0;
  const WEIGHTS = { easy: 2, medium: 3, hard: 4, hots: 5 };

  answers.forEach(ans => {
    const difficulty = ans.difficulty || 'medium';
    const weight = WEIGHTS[difficulty] || 3;

    const isAnswered = (ans.question_type === 'short_answer' || ans.question_type === 'complex_mc_tf')
      ? (ans.answer_text !== null && ans.answer_text !== undefined && String(ans.answer_text).trim() !== '')
      : (ans.chosen_choice_id !== null && ans.chosen_choice_id !== undefined);

    if (isAnswered) {
      if (ans.is_correct) {
        rawScore += weight * 4;
      } else {
        rawScore -= weight * 1;
      }
    }
  });

  // Calculate percentage of correct answers
  const masteryPercent = Math.round((benar / totalQuestions) * 100);

  // Estimate percentile based on mastery
  const percentile = Math.max(1, Math.min(99, Math.round(masteryPercent * 0.9)));

  // Analyze each item
  const itemAnalysis = responses.map((resp, idx) => {
    const pCorrect = probability3PL(theta, resp.irtParams);
    const info = (resp.irtParams.a * resp.irtParams.a * (pCorrect - resp.irtParams.c) * (1 - pCorrect)) /
                 Math.pow(1 - resp.irtParams.c, 2);

    return {
      questionIndex: idx + 1,
      questionId: resp.questionId,
      difficulty: resp.difficulty,
      isCorrect: resp.isCorrect,
      chosenChoiceId: resp.chosenChoiceId || null,
      answerText: resp.answerText || null,
      probabilityCorrect: Math.round(pCorrect * 100),
      informationValue: Math.round(info * 100) / 100,
      status: resp.isCorrect ? 'correct' : 'incorrect'
    };
  });

  // Group scores by subject if available
  const subjectScores = {};
  if (answers[0]?.subject_name) {
    answers.forEach(ans => {
      const subject = ans.subject_name || 'Unknown';
      if (!subjectScores[subject]) {
        subjectScores[subject] = {
          benar: 0,
          salah: 0,
          kosong: 0,
          total: 0,
          theta: 0,
          rawScore: 0
        };
      }

      subjectScores[subject].total++;
      if (ans.chosen_choice_id) {
        if (ans.is_correct) {
          subjectScores[subject].benar++;
        } else {
          subjectScores[subject].salah++;
        }
      } else {
        subjectScores[subject].kosong++;
      }
    });

    // Calculate subject-specific theta and scores
    Object.keys(subjectScores).forEach(subject => {
      const subData = subjectScores[subject];
      const subResponses = responses.filter((_, idx) =>
        answers[idx].subject_name === subject
      );

      if (subResponses.length > 0) {
        subData.theta = estimateAbility(subResponses);
        subData.mastery = Math.round((subData.benar / subData.total) * 100);

        // Calculate per-subject score (0-1000) blending theta + mastery
        subData.percentage = subData.mastery;
        subData.score = thetaToScore(subData.theta, subData.benar, subData.total);

        // Provide status
        if (subData.mastery >= 85) {
          subData.status = 'Sangat Baik';
          subData.statusColor = 'primary';
          subData.description = 'Penguasaan konsep sangat baik. Pertahankan dan fokus pada soal HOTS.';
        } else if (subData.mastery >= 70) {
          subData.status = 'Baik';
          subData.statusColor = 'secondary';
          subData.description = 'Pemahaman dasar baik. Perlu latihan lebih untuk meningkatkan akurasi.';
        } else if (subData.mastery >= 50) {
          subData.status = 'Perlu Fokus';
          subData.statusColor = 'tertiary';
          subData.description = 'Perlu perhatian lebih. Fokus untuk memahami konsep dasar terlebih dahulu.';
        } else {
          subData.status = 'Perlu Perbaikan';
          subData.statusColor = 'tertiary';
          subData.description = 'Perlu perbaikan signifikan. Disarankan untuk review materi dari awal.';
        }
      }
    });
  }

  // Calculate total score = average of all subtest scores (each 0-1000)
  // If no subtests, fall back to global theta score
  const subjectKeys = Object.keys(subjectScores);
  let totalScore;
  if (subjectKeys.length > 0) {
    const sumSubjectScores = subjectKeys.reduce((sum, key) => sum + (subjectScores[key].score || 0), 0);
    totalScore = Math.round(sumSubjectScores / subjectKeys.length);
  } else {
    totalScore = thetaToScore(theta, benar, totalQuestions);
  }

  return {
    theta: Math.round(theta * 100) / 100,
    rawScore,
    totalScore,
    benar,
    salah,
    kosong,
    total: totalQuestions,
    mastery: masteryPercent,
    percentile,
    subjectScores,
    itemAnalysis,
    scoringMethod: 'IRT-3PL',
    metadata: {
      model: '3-Parameter Logistic Model',
      abilityRange: [-4, 4],
      scoreRange: [0, 1000],
      weights: WEIGHTS,
      totalQuestionsAnswered: totalQuestions,
      referenceQuestions: FULL_TEST_QUESTIONS
    }
  };
}

/**
 * Simplified scoring for real-time results (without full IRT estimation)
 * Used during tryout for quick feedback
 * @param {Array} answers - Current answers
 * @returns {object} Simplified scoring results
 */
function calculateQuickScore(answers) {
  let benar = 0;
  let salah = 0;
  let kosong = 0;
  const WEIGHTS = { easy: 2, medium: 3, hard: 4, hots: 5 };

  answers.forEach(ans => {
    if (!ans.chosen_choice_id) {
      kosong++;
    } else if (ans.is_correct) {
      benar++;
    } else {
      salah++;
    }
  });

  // Simple weighted score
  const rawScore = answers.reduce((score, ans) => {
    if (!ans.chosen_choice_id) return score;
    const weight = WEIGHTS[ans.difficulty] || 3;
    return score + (ans.is_correct ? weight * 4 : -weight * 1);
  }, 0);

  // Quick theta estimation
  const totalQuestions = answers.length;
  const pCorrect = totalQuestions > 0 ? benar / totalQuestions : 0;
  const theta = (pCorrect - 0.5) * 4;
  const totalScore = thetaToScore(theta, benar, totalQuestions);

  return {
    theta: Math.round(theta * 100) / 100,
    rawScore,
    totalScore,
    benar,
    salah,
    kosong,
    total: totalQuestions,
    mastery: Math.round(pCorrect * 100),
    scoringMethod: 'Quick-IRT'
  };
}

/**
 * Get difficulty-based description for a subject
 * @param {number} masteryPercent - Mastery percentage
 * @param {number} avgSpeed - Average time per question in seconds
 * @returns {object} Status info
 */
function getStatusFromMastery(masteryPercent, avgSpeed = 60) {
  if (masteryPercent >= 85) {
    return {
      status: 'Sangat Baik',
      statusColor: 'primary',
      description: 'Penguasaan konsep sangat baik. Pertahankan dan fokus pada soal HOTS.',
      icon: 'check_circle'
    };
  } else if (masteryPercent >= 70) {
    return {
      status: 'Baik',
      statusColor: 'secondary',
      description: 'Pemahaman dasar baik. Perlu latihan lebih untuk meningkatkan akurasi.',
      icon: 'check_circle'
    };
  } else if (masteryPercent >= 50) {
    return {
      status: 'Perlu Fokus',
      statusColor: 'tertiary',
      description: 'Perlu perhatian lebih. Fokus untuk memahami konsep dasar terlebih dahulu.',
      icon: 'circle'
    };
  } else {
    return {
      status: 'Perlu Perbaikan',
      statusColor: 'tertiary',
      description: 'Perlu perbaikan signifikan. Disarankan untuk review materi dari awal.',
      icon: 'circle'
    };
  }
}

// ============================================================================
// EMPIRICAL IRT CALIBRATION FUNCTIONS
// ============================================================================

/**
 * Calibrate IRT parameters from empirical student data
 * Uses logistic transform of p-value for difficulty (b),
 * variance-based estimation for discrimination (a)
 * 
 * @param {number} totalAttempts - Total number of students who attempted the question
 * @param {number} totalCorrect - Number of students who answered correctly
 * @param {string} difficulty - Static difficulty label (fallback)
 * @returns {object} Calibrated IRT parameters {a, b, c}
 */
function calibrateItemParams(totalAttempts, totalCorrect, difficulty = 'medium') {
  const defaultParams = DEFAULT_IRT_PARAMS[difficulty] || DEFAULT_IRT_PARAMS.medium;
  
  // Not enough data — use defaults
  if (!totalAttempts || totalAttempts < 5) {
    return { ...defaultParams, calibrated: false, attempts: totalAttempts || 0 };
  }

  // Empirical p-value (proportion correct)
  const pValue = Math.max(0.01, Math.min(0.99, totalCorrect / totalAttempts));

  // Empirical difficulty (b) via logit transform: b = -ln(p / (1 - p))
  // High p-value (easy question) → negative b → easier
  // Low p-value (hard question) → positive b → harder
  const empiricalB = -Math.log(pValue / (1 - pValue));
  const clampedB = Math.max(-3, Math.min(3, empiricalB));

  // Empirical discrimination (a) based on variance
  // Variance of binary outcomes = p(1-p), peaks at p=0.5
  // Higher variance → question differentiates better → higher discrimination
  const variance = pValue * (1 - pValue);
  const empiricalA = 0.5 + (variance * 4); // range ~0.5-1.5
  const clampedA = Math.max(0.4, Math.min(2.5, empiricalA));

  // Guessing parameter stays relatively fixed
  const c = defaultParams.c || 0.10;

  // Blending strategy based on amount of data
  if (totalAttempts < 10) {
    // Very little data: 70% default, 30% empirical
    return {
      a: defaultParams.a * 0.7 + clampedA * 0.3,
      b: defaultParams.b * 0.7 + clampedB * 0.3,
      c,
      calibrated: 'partial',
      attempts: totalAttempts,
      pValue: Math.round(pValue * 100) / 100
    };
  } else if (totalAttempts < 50) {
    // Moderate data: 50% default, 50% empirical
    return {
      a: defaultParams.a * 0.5 + clampedA * 0.5,
      b: defaultParams.b * 0.5 + clampedB * 0.5,
      c,
      calibrated: 'partial',
      attempts: totalAttempts,
      pValue: Math.round(pValue * 100) / 100
    };
  } else {
    // Sufficient data: use fully empirical
    return {
      a: clampedA,
      b: clampedB,
      c,
      calibrated: true,
      attempts: totalAttempts,
      pValue: Math.round(pValue * 100) / 100
    };
  }
}

/**
 * Update item statistics after a student answers a question
 * Uses UPSERT to atomically increment counters and recalibrate
 * 
 * @param {object} pool - Database pool
 * @param {string} questionId - Question UUID
 * @param {boolean} isCorrect - Whether the student answered correctly
 * @param {string} difficulty - Static difficulty label
 */
async function updateItemStats(pool, questionId, isCorrect, difficulty = 'medium') {
  if (!pool || !questionId) return;

  try {
    const correctIncrement = isCorrect ? 1 : 0;
    
    // UPSERT: insert or update stats atomically
    const result = await pool.query(`
      INSERT INTO question_item_stats (question_id, total_attempts, total_correct, updated_at)
      VALUES ($1, 1, $2, NOW())
      ON CONFLICT (question_id) DO UPDATE SET
        total_attempts = question_item_stats.total_attempts + 1,
        total_correct = question_item_stats.total_correct + $2,
        updated_at = NOW()
      RETURNING total_attempts, total_correct
    `, [questionId, correctIncrement]);

    if (result.rows.length > 0) {
      const { total_attempts, total_correct } = result.rows[0];
      
      // Recalibrate IRT parameters
      const calibrated = calibrateItemParams(total_attempts, total_correct, difficulty);
      const pValue = total_attempts > 0 ? total_correct / total_attempts : 0.5;
      
      // Update calibrated parameters
      await pool.query(`
        UPDATE question_item_stats
        SET p_value = $1,
            discrimination = $2,
            irt_a = $3,
            irt_b = $4,
            irt_c = $5,
            last_calibrated_at = NOW()
        WHERE question_id = $6
      `, [
        Math.round(pValue * 10000) / 10000,
        calibrated.a,
        calibrated.a,
        calibrated.b,
        calibrated.c,
        questionId
      ]);
    }
  } catch (err) {
    // Non-critical — don't break the main flow
    console.error('[IRT] Error updating item stats:', err.message);
  }
}

/**
 * Batch update item statistics for multiple questions at once
 * More efficient than calling updateItemStats for each question individually
 * 
 * @param {object} pool - Database pool
 * @param {Array} answers - Array of { question_id, is_correct, difficulty }
 */
async function batchUpdateItemStats(pool, answers) {
  if (!pool || !answers || answers.length === 0) return;

  try {
    for (const ans of answers) {
      if (ans.question_id) {
        await updateItemStats(pool, ans.question_id, ans.is_correct === true, ans.difficulty || 'medium');
      }
    }
  } catch (err) {
    console.error('[IRT] Error in batch update item stats:', err.message);
  }
}

/**
 * Fetch calibrated IRT parameters for a list of question IDs
 * Returns a map: questionId → {a, b, c, pValue, totalAttempts, calibrated}
 * 
 * @param {object} pool - Database pool
 * @param {Array} questionIds - Array of question UUIDs
 * @returns {object} Map of questionId → calibrated params
 */
async function getItemStatsForQuestions(pool, questionIds) {
  const statsMap = {};
  
  if (!pool || !questionIds || questionIds.length === 0) {
    return statsMap;
  }

  try {
    const result = await pool.query(`
      SELECT question_id, total_attempts, total_correct, p_value,
             irt_a, irt_b, irt_c, discrimination, last_calibrated_at
      FROM question_item_stats
      WHERE question_id = ANY($1)
    `, [questionIds]);

    for (const row of result.rows) {
      statsMap[row.question_id] = {
        a: row.irt_a,
        b: row.irt_b,
        c: row.irt_c,
        pValue: row.p_value,
        totalAttempts: row.total_attempts,
        totalCorrect: row.total_correct,
        discrimination: row.discrimination,
        calibrated: row.total_attempts >= 50 ? true : (row.total_attempts >= 10 ? 'partial' : false),
        lastCalibratedAt: row.last_calibrated_at
      };
    }
  } catch (err) {
    console.error('[IRT] Error fetching item stats:', err.message);
  }

  return statsMap;
}

module.exports = {
  calculateIRTScore,
  calculateQuickScore,
  probability3PL,
  estimateAbility,
  thetaToScore,
  getStatusFromMastery,
  calibrateItemParams,
  updateItemStats,
  batchUpdateItemStats,
  getItemStatsForQuestions,
  DEFAULT_IRT_PARAMS,
  DIFFICULTY_MAP,
  FULL_TEST_QUESTIONS
};
