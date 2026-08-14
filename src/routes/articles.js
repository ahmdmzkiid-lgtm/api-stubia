const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');
const { getJwtSecret } = require('../config/jwt');

// Helper to generate slug
const slugify = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start
    .replace(/-+$/, '');            // Trim - from end
};

// Helper to make slug unique
const makeSlugUnique = async (slug, id = null) => {
  let uniqueSlug = slug;
  let counter = 1;
  let exists = true;

  while (exists) {
    let query = 'SELECT 1 FROM articles WHERE slug = $1';
    let params = [uniqueSlug];
    
    if (id) {
      query += ' AND id != $2';
      params.push(id);
    }
    
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      exists = false;
    } else {
      uniqueSlug = `${slug}-${counter}`;
      counter++;
    }
  }
  return uniqueSlug;
};

// GET /api/articles - Public: Get all published articles
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, title, slug, excerpt, cover_image, author_name, category, is_pinned, created_at, updated_at FROM articles WHERE is_published = TRUE ORDER BY is_pinned DESC, created_at DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/articles/categories - Public: Get all distinct categories
router.get('/categories', async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT DISTINCT category FROM articles WHERE is_published = TRUE AND category IS NOT NULL AND category != '' ORDER BY category ASC"
    );
    const categories = result.rows.map(r => r.category);
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

// GET /api/articles/all - Admin only: Get all articles (drafts + published)
router.get('/all', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, title, slug, content, excerpt, cover_image, detail_image, author_name, is_published, category, is_pinned, created_at, updated_at FROM articles ORDER BY created_at DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/articles/:slug - Public: Get article details by slug
router.get('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const result = await pool.query(
      'SELECT id, title, slug, content, excerpt, cover_image, detail_image, author_name, is_published, category, is_pinned, created_at, updated_at FROM articles WHERE slug = $1',
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Artikel tidak ditemukan' });
    }

    const article = result.rows[0];

    // If it's a draft, check if requester is admin
    if (!article.is_published) {
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
            // Check in DB
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
        return res.status(403).json({ success: false, error: 'Akses ditolak. Artikel ini belum diterbitkan.' });
      }
    }

    res.json({ success: true, data: article });
  } catch (error) {
    next(error);
  }
});

// POST /api/articles - Admin only: Create a new article
router.post('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { title, content, excerpt, cover_image, detail_image, author_name, is_published, category, is_pinned } = req.body;

    if (!title || !content) {
      return res.status(400).json({ success: false, error: 'Judul dan konten harus diisi' });
    }

    const baseSlug = slugify(title) || 'untitled-article';
    const slug = await makeSlugUnique(baseSlug);

    const result = await pool.query(
      `INSERT INTO articles (title, slug, content, excerpt, cover_image, detail_image, author_name, is_published, category, is_pinned, created_at, updated_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()) RETURNING *`,
      [
        title,
        slug,
        content,
        excerpt || null,
        cover_image || null,
        detail_image || null,
        author_name || 'Admin Stubia',
        is_published === undefined ? false : is_published,
        category || 'Umum',
        is_pinned === undefined ? false : is_pinned
      ]
    );

    logAdminActivity(req, 'CREATE', 'ARTIKEL', title, `Membuat artikel baru: "${title}"`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/articles/:id - Admin only: Update an existing article
router.put('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, content, excerpt, cover_image, detail_image, author_name, is_published, category, is_pinned } = req.body;

    // Check if article exists
    const articleCheck = await pool.query('SELECT * FROM articles WHERE id = $1', [id]);
    if (articleCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Artikel tidak ditemukan' });
    }

    const oldArticle = articleCheck.rows[0];
    let slug = oldArticle.slug;

    // If title has changed, regenerate slug
    if (title && title !== oldArticle.title) {
      const baseSlug = slugify(title) || 'untitled-article';
      slug = await makeSlugUnique(baseSlug, id);
    }

    const updatedTitle = title !== undefined ? title : oldArticle.title;
    const updatedContent = content !== undefined ? content : oldArticle.content;
    const updatedExcerpt = excerpt !== undefined ? excerpt : oldArticle.excerpt;
    const updatedCoverImage = cover_image !== undefined ? cover_image : oldArticle.cover_image;
    const updatedDetailImage = detail_image !== undefined ? detail_image : oldArticle.detail_image;
    const updatedAuthorName = author_name !== undefined ? author_name : oldArticle.author_name;
    const updatedIsPublished = is_published !== undefined ? is_published : oldArticle.is_published;
    const updatedCategory = category !== undefined ? category : oldArticle.category;
    const updatedIsPinned = is_pinned !== undefined ? is_pinned : oldArticle.is_pinned;

    const result = await pool.query(
      `UPDATE articles 
       SET title = $1, slug = $2, content = $3, excerpt = $4, cover_image = $5, detail_image = $6, author_name = $7, is_published = $8, category = $9, is_pinned = $10, updated_at = NOW() 
       WHERE id = $11 RETURNING *`,
      [
        updatedTitle,
        slug,
        updatedContent,
        updatedExcerpt,
        updatedCoverImage,
        updatedDetailImage,
        updatedAuthorName,
        updatedIsPublished,
        updatedCategory,
        updatedIsPinned,
        id
      ]
    );

    logAdminActivity(req, 'UPDATE', 'ARTIKEL', updatedTitle, `Mengupdate artikel: "${updatedTitle}"`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/articles/:id - Admin only: Delete an article
router.delete('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM articles WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Artikel tidak ditemukan' });
    }

    logAdminActivity(req, 'DELETE', 'ARTIKEL', result.rows[0].title || `ID: ${id}`, `Menghapus artikel: "${result.rows[0].title}"`);
    res.json({ success: true, message: 'Artikel berhasil dihapus', data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
