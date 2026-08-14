async function isPackageCompleted(db, userId, packageType, packageId) {
  const res = await db.query(
    'SELECT 1 FROM tryout_package_completions WHERE user_id = $1 AND package_type = $2 AND package_id = $3',
    [userId, packageType, packageId]
  );
  return res.rows.length > 0;
}

async function markPackageCompleted(db, userId, packageType, packageId) {
  await db.query(
    `INSERT INTO tryout_package_completions (user_id, package_type, package_id, completed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, package_type, package_id)
     DO UPDATE SET completed_at = NOW()`,
    [userId, packageType, packageId]
  );
}

module.exports = { isPackageCompleted, markPackageCompleted };
