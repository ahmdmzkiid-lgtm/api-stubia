// Utility to calculate UTBK tryout package attempts and enforce 2x max limit
async function getUtbkPackageAttemptInfo(dbOrPool, userId, packageId) {
  const pkgRes = await dbOrPool.query(
    "SELECT subject_config FROM tryout_packages WHERE id = $1",
    [packageId]
  );
  let totalExpectedSubtests = 7;
  if (pkgRes.rows.length > 0 && pkgRes.rows[0].subject_config) {
    try {
      const cfg = typeof pkgRes.rows[0].subject_config === "string" 
        ? JSON.parse(pkgRes.rows[0].subject_config) 
        : pkgRes.rows[0].subject_config;
      if (Array.isArray(cfg) && cfg.length > 0) {
        totalExpectedSubtests = cfg.length;
      }
    } catch {}
  }

  const sessionsRes = await dbOrPool.query(
    `SELECT ts.id, ts.started_at, ts.submitted_at
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
      canAttempt: true,
      latestGroup: null
    };
  }

  const groups = [];
  let currentGroup = null;

  sessionsRes.rows.forEach((row) => {
    const startedAt = new Date(row.started_at);

    const timeSinceLast = currentGroup
      ? (startedAt - new Date(currentGroup.latestStartedAt)) / 3600000
      : Infinity;

    const isCurrentGroupFull = currentGroup && currentGroup.sessionIds.length >= totalExpectedSubtests;

    if (!currentGroup || isCurrentGroupFull || timeSinceLast > 24) {
      currentGroup = {
        latestStartedAt: row.started_at,
        allSubmitted: true,
        sessionIds: [],
      };
      groups.push(currentGroup);
    }

    currentGroup.sessionIds.push(row.id);
    if (!row.submitted_at) {
      currentGroup.allSubmitted = false;
    }
  });

  groups.forEach(g => {
    g.isCompleted = g.allSubmitted && g.sessionIds.length >= totalExpectedSubtests;
  });

  const completedAttempts = groups.filter(g => g.isCompleted).length;
  const attemptsUsed = groups.length;
  const isLatestAttemptActive = currentGroup && !currentGroup.isCompleted && ((Date.now() - new Date(currentGroup.latestStartedAt).getTime()) / 3600000 <= 24);
  const canAttempt = completedAttempts < 2 && (attemptsUsed < 2 || isLatestAttemptActive);

  return {
    attemptsUsed,
    completedAttempts,
    maxAttempts: 2,
    canAttempt,
    latestGroup: currentGroup
  };
}

module.exports = { getUtbkPackageAttemptInfo };
