const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

router.get('/', async (req, res, next) => {
  try {
    // 1. Ambil semua artikel yang di-publish dari database
    const articlesQuery = await pool.query(
      'SELECT slug, updated_at, created_at FROM articles WHERE is_published = TRUE ORDER BY created_at DESC'
    );
    const articles = articlesQuery.rows;

    // 2. Ambil semua ujian mandiri dari database untuk meningkatkan SEO halaman ujian mandiri
    let ujianMandiri = [];
    try {
      const ujianQuery = await pool.query('SELECT id, updated_at FROM ujian_mandiri ORDER BY id ASC');
      ujianMandiri = ujianQuery.rows;
    } catch (e) {
      console.warn("Tabel ujian_mandiri tidak ditemukan atau gagal di-query:", e.message);
    }

    // 3. Bangun string XML sitemap secara dinamis
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Halaman Utama -->
  <url>
    <loc>https://www.stubia.id/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.00</priority>
  </url>
  <url>
    <loc>https://www.stubia.id/pricing</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.80</priority>
  </url>
  <url>
    <loc>https://www.stubia.id/blog</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.90</priority>
  </url>
  <url>
    <loc>https://www.stubia.id/careers</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.60</priority>
  </url>
  <url>
    <loc>https://www.stubia.id/contact-us</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.50</priority>
  </url>
  <url>
    <loc>https://www.stubia.id/privacy-policy</loc>
    <lastmod>2026-07-01</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.30</priority>
  </url>
  <url>
    <loc>https://www.stubia.id/terms-and-conditions</loc>
    <lastmod>2026-07-01</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.30</priority>
  </url>
`;

    // 4. Masukkan artikel blog secara dinamis
    articles.forEach(art => {
      const date = art.updated_at || art.created_at || new Date();
      const isoDate = new Date(date).toISOString().split('T')[0];
      xml += `  <url>
    <loc>https://www.stubia.id/blog/${art.slug}</loc>
    <lastmod>${isoDate}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.75</priority>
  </url>\n`;
    });

    // 5. Masukkan halaman ujian mandiri secara dinamis
    ujianMandiri.forEach(um => {
      const date = um.updated_at || new Date();
      const isoDate = new Date(date).toISOString().split('T')[0];
      xml += `  <url>
    <loc>https://www.stubia.id/ujian-mandiri/${um.id}</loc>
    <lastmod>${isoDate}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.70</priority>
  </url>\n`;
    });

    xml += `</urlset>`;

    // 6. Kirim respon sebagai file XML
    res.header('Content-Type', 'application/xml');
    res.status(200).send(xml);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
