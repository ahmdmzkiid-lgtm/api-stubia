const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");
const { getJwtSecret } = require("../config/jwt");

const verifyToken = (req, res, next) => {
  try {
    let token = req.headers.authorization;
    if (!token || !token.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ success: false, error: "Access denied. No token provided." });
    }

    token = token.split(" ")[1];
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded; // { id, email, role }
    next();
  } catch (error) {
    return res
      .status(401)
      .json({ success: false, error: "Invalid or expired token." });
  }
};

// Checks the actual role in DB — handles cases where role was updated after the JWT was issued
const verifyAdmin = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res
        .status(403)
        .json({ success: false, error: "Access denied. User authentication required." });
    }

    let role = req.user.role;

    // Verify against DB to handle dynamic updates
    const result = await pool.query("SELECT role FROM users WHERE id = $1", [
      req.user.id,
    ]);
    if (result.rows.length > 0) {
      role = result.rows[0].role;
      req.user.role = role;
    }

    // Super Admin has full access
    if (role === "admin") {
      return next();
    }

    const method = req.method;
    const baseUrl = req.baseUrl || "";
    const path = req.path || "";

    // Question Writer permissions
    if (role === "question_writer") {
      const allowedBaseUrls = [
        "/api/soal",
        "/api/tryout",
        "/api/ujian-mandiri",
        "/api/subjects",
        "/api/topics",
        "/api/import",
        "/api/upload"
      ];
      if (allowedBaseUrls.includes(baseUrl)) {
        return next();
      }
      if (baseUrl === "/api/admin") {
        if (["/stats", "/tryout-dashboard-stats", "/questions/duplicates", "/activity-logs", "/question-review"].includes(path)) {
          return next();
        }
      }
    }

    // Quality Assurance permissions
    if (role === "quality_assurance") {
      if (method === "GET") {
        const allowedBaseUrls = [
          "/api/soal",
          "/api/tryout",
          "/api/ujian-mandiri",
          "/api/subjects",
          "/api/topics"
        ];
        if (allowedBaseUrls.includes(baseUrl)) {
          return next();
        }
        if (baseUrl === "/api/admin") {
          if (["/stats", "/tryout-dashboard-stats", "/questions/duplicates", "/activity-logs", "/question-review"].includes(path)) {
            return next();
          }
        }
      } else if (method === "PATCH" || method === "POST") {
        if (baseUrl === "/api/soal" && (path.endsWith("/workflow") || path.endsWith("/bulk-workflow"))) {
          return next();
        }
      }
    }

    // Article Writer permissions
    if (role === "article_writer") {
      const allowedBaseUrls = ["/api/articles", "/api/upload"];
      if (allowedBaseUrls.includes(baseUrl)) {
        return next();
      }
    }

    return res
      .status(403)
      .json({ success: false, error: `Access denied. Insufficient permissions for role: ${role}` });
  } catch (err) {
    console.error("verifyAdmin DB check error:", err.message);
    return res
      .status(403)
      .json({ success: false, error: "Access denied. Permission verification failed." });
  }
};

module.exports = { verifyToken, verifyAdmin };
