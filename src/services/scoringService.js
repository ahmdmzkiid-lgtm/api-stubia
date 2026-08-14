/**
 * Calculate UTBK Score based on user answers
 * @param {Array} answers - Array of answer objects: { chosen_choice_id, is_correct, question_id }
 * @returns {Object} Score breakdown and total score
 */
function calculateScore(answers) {
  let benar = 0;
  let salah = 0;
  let kosong = 0;

  for (const ans of answers) {
    if (!ans.chosen_choice_id) {
      kosong++;
    } else if (ans.is_correct) {
      benar++;
    } else {
      salah++;
    }
  }

  // UTBK-SNBT Scoring Rule
  // Benar = +4, Salah = -1, Kosong = 0
  const rawScore = (benar * 4) - (salah * 1);

  // Scale to UTBK range (200-1000)
  // With 60 questions: max raw score = 60*4 = 240, min = -60
  // Normalize to 200-1000 range
  const minPossible = -(answers.length * 1);
  const maxPossible = answers.length * 4;
  const range = maxPossible - minPossible;
  const normalizedRange = 800; // 1000 - 200
  const totalScore = Math.round(200 + ((rawScore - minPossible) / range) * normalizedRange);

  return {
    benar,
    salah,
    kosong,
    raw_score: rawScore,
    total_score: Math.max(200, totalScore) // Ensure minimum 200
  };
}

module.exports = { calculateScore };
