// Utility to calculate UTBK tryout package attempts and enforce 2x max limit
async function getUtbkPackageAttemptInfo(dbOrPool, userId, packageId) {
  const sessionsRes = await dbOrPool.query(
    `SELECT ts.id, ts.started_at, ts.submitted_at,
       (
         SELECT s.name
         FROM user_answers ua
         JOIN questions q ON ua.question_id = q.id
         LEFT JOIN subjects s ON q.subject_id = s.id
         WHERE ua.session_id = ts.id AND s.name IS NOT NULL
         GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 1
       ) AS subtest_name
     FROM tryout_sessions ts
     WHERE ts.user_id = $1 AND ts.package_id = $2
     ORDER BY ts.started_at ASC`,
    [userId, packageId]
  );

  if (sessionsRes.rows.length === 0) {
    return {
      attemptsUsed: 0,
      completedAttempts: 0,
      maxAttempts: 2,
      canAttempt: true
    };
  }

  const groups = [];
  let currentGroup = null;

  sessionsRes.rows.forEach((row) => {
    const subtest = row.subtest_name || "Unknown";
    const startedAt = new Date(row.started_at);

    const timeSinceLast = currentGroup
      ? (startedAt - new Date(currentGroup.latestStartedAt)) / 3600000
      : Infinity;
    const subtestAlreadyUsed = currentGroup && currentGroup.subtestSet.has(subtest);

    if (!currentGroup || subtestAlreadyUsed || timeSinceLast > 12) {
      currentGroup = {
        subtestSet: new Set(),
        latestStartedAt: row.started_at,
        isCompleted: true,
        sessionIds: [],
      };
      groups.push(currentGroup);
    }

    currentGroup.subtestSet.add(subtest);
    currentGroup.sessionIds.push(row.id);
    if (!row.submitted_at) {
      currentGroup.isCompleted = false;
    }
  });

  const completedAttempts = groups.filter(g => g.isCompleted).length;
  const attemptsUsed = groups.length;
  const isLatestAttemptActive = currentGroup && !currentGroup.isCompleted && ((Date.now() - new Date(currentGroup.latestStartedAt).getTime()) / 3600000 <= 12);
  const canAttempt = completedAttempts < 2 && (attemptsUsed < 2 || isLatestAttemptActive);

  return {
    attemptsUsed,
    completedAttempts,
    maxAttempts: 2,
    canAttempt
  };
}

module.exports = { getUtbkPackageAttemptInfo };
