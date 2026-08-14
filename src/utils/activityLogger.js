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
async function logAdminActivity(req, action, targetType, targetName, details) {
  try {
    const adminId = req.user?.id || null;
    const adminName = req.user?.name || 'System Admin';
    const adminEmail = req.user?.email || 'admin@stubia.id';

    await pool.query(
      `INSERT INTO admin_activity_logs (admin_id, admin_name, admin_email, action, target_type, target_name, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [adminId, adminName, adminEmail, action, targetType, targetName, details]
    );
  } catch (error) {
    console.error('Error logging admin activity:', error);
  }
}

module.exports = {
  logAdminActivity
};
