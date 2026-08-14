const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Create or resubmit social verification request (latihan context)
router.post("/verify", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      platform,
      social_username,
      comment_link,
      contact_email,
      ig_username,
      x_username,
    } = req.body;

    const hasNewFormat =
      platform && social_username && comment_link && contact_email;
    const hasLegacyFormat = ig_username || x_username;

    if (!hasNewFormat && !hasLegacyFormat) {
      return res.status(400).json({
        success: false,
        error:
          "Data verifikasi tidak lengkap. Isi username, link komentar, pilih platform, dan isi email.",
      });
    }

    if (hasNewFormat) {
      if (!["instagram", "x"].includes(platform)) {
        return res.status(400).json({
          success: false,
          error: "Platform tidak valid. Pilih Instagram atau X.",
        });
      }
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email);
      if (!emailOk) {
        return res
          .status(400)
          .json({ success: false, error: "Format email tidak valid." });
      }
    }

    const pendingRes = await pool.query(
      `SELECT id FROM user_social_verifications
       WHERE user_id = $1 AND context = 'latihan' AND status = 'pending'
       LIMIT 1`,
      [userId],
    );
    if (pendingRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error:
          "Anda sudah mengajukan verifikasi dan sedang menunggu persetujuan admin.",
      });
    }

    const approvedRes = await pool.query(
      `SELECT id FROM user_social_verifications
       WHERE user_id = $1 AND context = 'latihan' AND status = 'approved'
       LIMIT 1`,
      [userId],
    );
    if (approvedRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Verifikasi latihan Anda sudah disetujui.",
      });
    }

    const rejectedRes = await pool.query(
      `SELECT id FROM user_social_verifications
       WHERE user_id = $1 AND context = 'latihan' AND status = 'rejected'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (rejectedRes.rows.length > 0) {
      await pool.query("DELETE FROM user_social_verifications WHERE id = $1", [
        rejectedRes.rows[0].id,
      ]);
    }

    let result;
    if (hasNewFormat) {
      const igUser = platform === "instagram" ? social_username.trim() : null;
      const xUser = platform === "x" ? social_username.trim() : null;
      result = await pool.query(
        `INSERT INTO user_social_verifications
         (user_id, ig_username, x_username, platform, social_username, comment_link, contact_email, status, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'latihan')
         RETURNING *`,
        [
          userId,
          igUser,
          xUser,
          platform,
          social_username.trim(),
          comment_link.trim(),
          contact_email.trim(),
        ],
      );
    } else {
      result = await pool.query(
        `INSERT INTO user_social_verifications (user_id, ig_username, x_username, status, context)
         VALUES ($1, $2, $3, 'pending', 'latihan')
         RETURNING *`,
        [userId, ig_username || null, x_username || null],
      );
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Get latest social verification status for current user (latihan context)
router.get("/status", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT * FROM user_social_verifications
       WHERE user_id = $1 AND context = 'latihan'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    next(error);
  }
});

// Admin: list pending requests
router.get(
  "/admin/requests",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT r.*, u.name AS user_name, u.email AS user_email
       FROM user_social_verifications r
       JOIN users u ON u.id = r.user_id
       WHERE r.context = 'latihan' AND r.status = 'pending'
       ORDER BY r.created_at ASC`,
      );
      res.json({ success: true, data: result.rows });
    } catch (error) {
      next(error);
    }
  },
);

// Admin: approve/reject
router.patch(
  "/admin/requests/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { action, rejection_reason } = req.body; // action: 'approve' | 'reject'

      console.log("Admin Social Review Request:", {
        id,
        action,
        rejection_reason,
        adminId: req.user.id,
      });

      if (!["approve", "reject"].includes(action)) {
        console.log("Social Review Error: Invalid action", action);
        return res
          .status(400)
          .json({ success: false, error: "Action must be approve or reject" });
      }
      const status = action === "approve" ? "approved" : "rejected";
      const result = await pool.query(
        `UPDATE user_social_verifications
       SET status = $1::varchar,
           rejection_reason = $2::text,
           approved_at = CASE WHEN $1::varchar = 'approved' THEN NOW() ELSE NULL END,
           reviewed_by = $3::uuid
       WHERE id = $4::uuid
       RETURNING *`,
        [status, rejection_reason || null, req.user.id, id],
      );

      if (result.rows.length === 0) {
        console.log(
          "Social Review Error: Request not found in database for ID:",
          id,
        );
        return res
          .status(404)
          .json({ success: false, error: "Request not found" });
      }

      console.log("Social Review Success:", result.rows[0]);
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error("Social Review Catch Error:", error);
      next(error);
    }
  },
);

// Admin: list all social verification requests (with optional status filter)
router.get(
  "/admin/requests/all",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const { status } = req.query;
      let query = `SELECT r.*, u.name AS user_name, u.email AS user_email
       FROM user_social_verifications r
       JOIN users u ON u.id = r.user_id
       WHERE r.context = 'latihan'`;
      const params = [];

      if (status) {
        params.push(status);
        query += ` AND r.status = $${params.length}`;
      }

      query += ` ORDER BY r.created_at DESC`;

      const result = await pool.query(query, params);
      res.json({ success: true, data: result.rows });
    } catch (error) {
      next(error);
    }
  },
);

// Admin: delete approved/rejected social verification
router.delete(
  "/admin/requests/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const check = await pool.query(
        "SELECT id, status FROM user_social_verifications WHERE id = $1",
        [id],
      );
      if (check.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Verifikasi tidak ditemukan." });
      }

      if (check.rows[0].status === "pending") {
        return res.status(400).json({
          success: false,
          error:
            "Tidak bisa menghapus verifikasi yang masih pending. Setujui atau tolak terlebih dahulu.",
        });
      }

      await pool.query("DELETE FROM user_social_verifications WHERE id = $1", [
        id,
      ]);

      res.json({ success: true, message: "Verifikasi berhasil dihapus." });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
