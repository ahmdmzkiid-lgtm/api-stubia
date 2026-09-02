const { pool } = require('../config/db');

/**
 * Logs an admin action in the database.
 * 
 * @param {Object} req - The Express request object containing req.user (admin)
 * @param {string} action - Action type: 'CREATE', 'UPDATE', 'DELETE', or custom action
 * @param {string} targetType - Object type: 'SOAL', 'PAKET_TRYOUT', 'PAKET_LATIHAN', 'TRYOUT', 'ARTICLE', 'VACANCY', 'TODO', 'SETTINGS'
 * @param {string} targetName - Name or identifier of the object being acted upon
 * @param {string} details - Detailed human-readable description
 */
async function logAdminActivity(reqOrId, action, targetType, targetName, details) {
  try {
    let adminId = null;
    let adminName = null;
    let adminEmail = null;

    if (reqOrId && typeof reqOrId === 'object' && reqOrId.user) {
      adminId = reqOrId.user.id || null;
      adminName = reqOrId.user.name || null;
      adminEmail = reqOrId.user.email || null;
    } else if (typeof reqOrId === 'string') {
      adminId = reqOrId;
    }

    // Handle variable parameter patterns
    let finalAction = action;
    let finalTargetType = targetType;
    let finalTargetName = targetName;
    let finalDetails = details;

    if (finalTargetName === undefined && finalDetails === undefined && finalTargetType) {
      finalTargetName = finalTargetType;
      finalTargetType = 'SYSTEM';
      finalDetails = finalTargetName;
    }

    // Fetch real name and email from users table if not present or placeholder
    if (adminId && (!adminName || !adminEmail || adminEmail === 'admin@stubia.id')) {
      const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [adminId]);
      if (userRes.rows.length > 0) {
        adminName = userRes.rows[0].name;
        adminEmail = userRes.rows[0].email;
      }
    }

    adminName = adminName || 'System Admin';
    adminEmail = adminEmail || 'admin@stubia.id';

    await pool.query(
      `INSERT INTO admin_activity_logs (admin_id, admin_name, admin_email, action, target_type, target_name, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [adminId, adminName, adminEmail, finalAction, finalTargetType, finalTargetName, finalDetails || null]
    );
  } catch (error) {
    console.error('Error logging admin activity:', error);
  }
}

module.exports = {
  logAdminActivity
};
