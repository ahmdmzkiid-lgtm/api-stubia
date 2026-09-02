const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');
const { careerApplyLimiter } = require('../middleware/rateLimiter');
const { getJwtSecret } = require('../config/jwt');

// GET /api/careers - Public: Get active job vacancies
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, title, department, location, type, description, requirements, benefits, responsibilities, is_active, created_at, updated_at FROM job_vacancies WHERE is_active = TRUE ORDER BY created_at DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/careers/all - Admin only: Get all job vacancies (active + inactive)
router.get('/all', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, title, department, location, type, description, requirements, benefits, responsibilities, is_active, created_at, updated_at FROM job_vacancies ORDER BY created_at DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/careers/applications/all - Admin only: Get all job applications
router.get('/applications/all', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ja.id, ja.vacancy_id, ja.name, ja.email, ja.phone, ja.photo_url, ja.cv_url, ja.description, 
              ja.start_date, ja.ready_for_training, ja.portfolio_url, ja.last_education,
              ja.address, ja.birth_place_date, ja.institution_name, ja.experience_duration, ja.motivation, ja.ktp_url, ja.work_duration, ja.created_at,
              jv.title as vacancy_title, jv.department as vacancy_department
       FROM job_applications ja
       JOIN job_vacancies jv ON ja.vacancy_id = jv.id
       ORDER BY ja.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/careers/applications/:id - Admin only: Delete a job application
router.delete('/applications/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM job_applications WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lamaran pekerjaan tidak ditemukan' });
    }

    logAdminActivity(req, 'DELETE', 'KARIR', `Lamaran ID: ${id}`, `Menghapus lamaran masuk dari "${result.rows[0].name}"`);
    res.json({ success: true, message: 'Lamaran pekerjaan berhasil dihapus', data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// POST /api/careers/:id/apply - Public: Submit application for a job vacancy
router.post('/:id/apply', careerApplyLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      email, 
      phone, 
      photo_url, 
      cv_url, 
      description,
      start_date,
      ready_for_training,
      portfolio_url,
      last_education,
      address,
      birth_place_date,
      institution_name,
      experience_duration,
      motivation,
      ktp_url,
      work_duration
    } = req.body;

    if (!name || !email || !phone || !photo_url || !cv_url || !description || !start_date || ready_for_training === undefined || !last_education || !address || !birth_place_date || !institution_name || !experience_duration || !motivation || !ktp_url || !work_duration) {
      return res.status(400).json({ success: false, error: 'Harap isi semua kolom wajib pada form lamaran' });
    }

    // Verify vacancy exists and is active
    const vacancyCheck = await pool.query('SELECT is_active, title, type FROM job_vacancies WHERE id = $1', [id]);
    if (vacancyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lowongan pekerjaan tidak ditemukan' });
    }
    if (!vacancyCheck.rows[0].is_active) {
      return res.status(400).json({ success: false, error: 'Lowongan pekerjaan ini sudah tidak aktif' });
    }

    // Generate sequential registration number
    const currentYear = new Date().getFullYear();
    const regCheck = await pool.query(
      `SELECT registration_number FROM job_applications 
       WHERE registration_number LIKE $1 
       ORDER BY created_at DESC LIMIT 1`,
      [`APP/${currentYear}/%`]
    );

    let nextNum = 1;
    if (regCheck.rows.length > 0) {
      const lastCode = regCheck.rows[0].registration_number;
      if (lastCode) {
        const parts = lastCode.split('/');
        const lastNumStr = parts[parts.length - 1];
        const lastNum = parseInt(lastNumStr, 10);
        if (!isNaN(lastNum)) {
          nextNum = lastNum + 1;
        }
      }
    }
    const paddedNum = String(nextNum).padStart(4, '0');
    const registration_number = `APP/${currentYear}/${paddedNum}`;

    const result = await pool.query(
      `INSERT INTO job_applications (
        vacancy_id, name, email, phone, photo_url, cv_url, description, 
        start_date, ready_for_training, portfolio_url, last_education,
        address, birth_place_date, institution_name, experience_duration, motivation, ktp_url, work_duration, registration_number, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()) RETURNING *`,
      [
        id, name, email, phone, photo_url, cv_url, description,
        start_date, ready_for_training, portfolio_url || null, last_education,
        address, birth_place_date, institution_name, experience_duration, motivation, ktp_url, work_duration, registration_number
      ]
    );

    const jobTitle = vacancyCheck.rows[0].title;
    const jobType = vacancyCheck.rows[0].type;
    const { sendJobApplicationSubmittedEmail } = require('../services/emailService');
    sendJobApplicationSubmittedEmail(email, name, registration_number, jobTitle, jobType)
      .catch(err => console.error('Error sending confirmation email:', err));

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/careers/:id - Public/Admin: Get details of a job vacancy
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, title, department, location, type, description, requirements, benefits, responsibilities, is_active, created_at FROM job_vacancies WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lowongan pekerjaan tidak ditemukan' });
    }

    const job = result.rows[0];

    // If inactive, check if requester is admin
    if (!job.is_active) {
      let isAdmin = false;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const jwt = require('jsonwebtoken');
          const token = authHeader.split(' ')[1];
          const decoded = jwt.verify(token, getJwtSecret());
          if (decoded.role === 'admin') {
            isAdmin = true;
          } else {
            const userCheck = await pool.query('SELECT role FROM users WHERE id = $1', [decoded.id]);
            if (userCheck.rows.length > 0 && userCheck.rows[0].role === 'admin') {
              isAdmin = true;
            }
          }
        } catch (err) {
          // Token invalid, keep isAdmin false
        }
      }

      if (!isAdmin) {
        return res.status(403).json({ success: false, error: 'Akses ditolak. Lowongan ini tidak aktif.' });
      }
    }

    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// POST /api/careers - Admin only: Create a new job vacancy
router.post('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { title, department, location, type, description, requirements, benefits, responsibilities, is_active } = req.body;

    if (!title || !department || !location || !type || !description) {
      return res.status(400).json({ success: false, error: 'Semua kolom wajib diisi kecuali persyaratan' });
    }

    const result = await pool.query(
      `INSERT INTO job_vacancies (title, department, location, type, description, requirements, benefits, responsibilities, is_active, created_at, updated_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING *`,
      [
        title,
        department,
        location,
        type,
        description,
        requirements || null,
        benefits || null,
        responsibilities || null,
        is_active === undefined ? true : is_active
      ]
    );

    logAdminActivity(req, 'CREATE', 'KARIR', title, `Membuat lowongan baru: "${title}" (${department})`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/careers/:id - Admin only: Update a job vacancy
router.put('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, department, location, type, description, requirements, benefits, responsibilities, is_active } = req.body;

    const jobCheck = await pool.query('SELECT * FROM job_vacancies WHERE id = $1', [id]);
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lowongan pekerjaan tidak ditemukan' });
    }

    const oldJob = jobCheck.rows[0];

    const updatedTitle = title !== undefined ? title : oldJob.title;
    const updatedDept = department !== undefined ? department : oldJob.department;
    const updatedLocation = location !== undefined ? location : oldJob.location;
    const updatedType = type !== undefined ? type : oldJob.type;
    const updatedDesc = description !== undefined ? description : oldJob.description;
    const updatedReqs = requirements !== undefined ? requirements : oldJob.requirements;
    const updatedBenefits = benefits !== undefined ? benefits : oldJob.benefits;
    const updatedResponsibilities = responsibilities !== undefined ? responsibilities : oldJob.responsibilities;
    const updatedIsActive = is_active !== undefined ? is_active : oldJob.is_active;

    const result = await pool.query(
      `UPDATE job_vacancies 
       SET title = $1, department = $2, location = $3, type = $4, description = $5, requirements = $6, benefits = $7, responsibilities = $8, is_active = $9, updated_at = NOW() 
       WHERE id = $10 RETURNING *`,
      [
        updatedTitle,
        updatedDept,
        updatedLocation,
        updatedType,
        updatedDesc,
        updatedReqs,
        updatedBenefits,
        updatedResponsibilities,
        updatedIsActive,
        id
      ]
    );

    logAdminActivity(req, 'UPDATE', 'KARIR', updatedTitle, `Mengubah lowongan: "${updatedTitle}"`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/careers/:id - Admin only: Delete a job vacancy
router.delete('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM job_vacancies WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lowongan pekerjaan tidak ditemukan' });
    }

    logAdminActivity(req, 'DELETE', 'KARIR', result.rows[0].title || `ID: ${id}`, `Menghapus lowongan: "${result.rows[0].title}"`);
    res.json({ success: true, message: 'Lowongan pekerjaan berhasil dihapus', data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
