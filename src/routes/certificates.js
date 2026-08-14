const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');

// Helper to generate sequential certificate code
async function generateCertificateCode(programType) {
  const currentYear = new Date().getFullYear();
  let codePrefix = 'VOL';
  if (programType === 'internship') codePrefix = 'INT';
  else if (programType === 'fellowship') codePrefix = 'FLW';
  else if (programType === 'bug_hunter') codePrefix = 'BUG';
  
  // Find latest number for this type and year
  const result = await pool.query(
    `SELECT certificate_code FROM certificates 
     WHERE certificate_code LIKE $1 
     ORDER BY created_at DESC LIMIT 1`,
    [`STUBIA/${currentYear}/${codePrefix}/%`]
  );

  let nextNum = 1;
  if (result.rows.length > 0) {
    const lastCode = result.rows[0].certificate_code;
    const parts = lastCode.split('/');
    const lastNumStr = parts[parts.length - 1];
    const lastNum = parseInt(lastNumStr, 10);
    if (!isNaN(lastNum)) {
      nextNum = lastNum + 1;
    }
  }

  // Pad to 3 digits (e.g. 001, 012, 123)
  const paddedNum = String(nextNum).padStart(3, '0');
  return `STUBIA/${currentYear}/${codePrefix}/${paddedNum}`;
}

// POST /api/certificates - Admin only: Create a new certificate
router.post('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const {
      recipient_name,
      program_type,
      position,
      start_date,
      end_date,
      signer_name,
      signer_role,
      signature_url,
      location,
      competencies
    } = req.body;

    if (!recipient_name || !program_type || !position || !start_date || !end_date || !signer_name || !signer_role || !signature_url) {
      return res.status(400).json({ success: false, error: 'Semua kolom wajib diisi' });
    }

    const certificate_code = await generateCertificateCode(program_type);

    const result = await pool.query(
      `INSERT INTO certificates (
        certificate_code, recipient_name, program_type, position, 
        start_date, end_date, signer_name, signer_role, signature_url, location, competencies, created_at, updated_at
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()) RETURNING *`,
      [
        certificate_code,
        recipient_name,
        program_type,
        position,
        start_date,
        end_date,
        signer_name,
        signer_role,
        signature_url,
        location || 'Jakarta',
        competencies || []
      ]
    );

    logAdminActivity(req, 'CREATE', 'SERTIFIKAT', recipient_name, `Membuat sertifikat ${program_type} untuk "${recipient_name}" (${position})`);
    
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/certificates - Admin only: Get all certificates
router.get('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM certificates ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/certificates/verify/:id - Public: Verify certificate by ID
router.get('/verify/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if ID is a valid UUID to avoid DB error
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(404).json({ success: false, error: 'Sertifikat tidak valid atau tidak ditemukan' });
    }

    const result = await pool.query('SELECT * FROM certificates WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sertifikat tidak ditemukan' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/certificates/search - Public: Search certificate by certificate_code (query param)
router.get('/search', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, error: 'Kode sertifikat wajib diisi' });
    }

    const result = await pool.query(
      'SELECT * FROM certificates WHERE LOWER(certificate_code) = LOWER($1)',
      [code.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sertifikat tidak ditemukan' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/certificates/:id - Admin only: Get details of a certificate
router.get('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM certificates WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sertifikat tidak ditemukan' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/certificates/:id - Admin only: Update a certificate
router.put('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      recipient_name,
      program_type,
      position,
      start_date,
      end_date,
      signer_name,
      signer_role,
      signature_url,
      location,
      competencies
    } = req.body;

    const certCheck = await pool.query('SELECT * FROM certificates WHERE id = $1', [id]);
    if (certCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sertifikat tidak ditemukan' });
    }

    const oldCert = certCheck.rows[0];

    const updatedName = recipient_name !== undefined ? recipient_name : oldCert.recipient_name;
    const updatedType = program_type !== undefined ? program_type : oldCert.program_type;
    const updatedPos = position !== undefined ? position : oldCert.position;
    const updatedStart = start_date !== undefined ? start_date : oldCert.start_date;
    const updatedEnd = end_date !== undefined ? end_date : oldCert.end_date;
    const updatedSigner = signer_name !== undefined ? signer_name : oldCert.signer_name;
    const updatedRole = signer_role !== undefined ? signer_role : oldCert.signer_role;
    const updatedSig = signature_url !== undefined ? signature_url : oldCert.signature_url;
    const updatedLocation = location !== undefined ? location : oldCert.location;
    const updatedCompetencies = competencies !== undefined ? competencies : oldCert.competencies;

    const result = await pool.query(
      `UPDATE certificates 
       SET recipient_name = $1, program_type = $2, position = $3, 
           start_date = $4, end_date = $5, signer_name = $6, signer_role = $7, 
           signature_url = $8, location = $9, competencies = $10, updated_at = NOW() 
       WHERE id = $11 RETURNING *`,
      [
        updatedName,
        updatedType,
        updatedPos,
        updatedStart,
        updatedEnd,
        updatedSigner,
        updatedRole,
        updatedSig,
        updatedLocation,
        updatedCompetencies,
        id
      ]
    );

    logAdminActivity(req, 'UPDATE', 'SERTIFIKAT', updatedName, `Mengubah sertifikat ID: ${id} milik "${updatedName}"`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/certificates/:id - Admin only: Delete a certificate
router.delete('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM certificates WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sertifikat tidak ditemukan' });
    }

    logAdminActivity(req, 'DELETE', 'SERTIFIKAT', result.rows[0].recipient_name, `Menghapus sertifikat milik "${result.rows[0].recipient_name}"`);
    res.json({ success: true, message: 'Sertifikat berhasil dihapus', data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
