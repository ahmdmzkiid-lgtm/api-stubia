const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { publicUploadLimiter } = require('../middleware/rateLimiter');

const path = require('path');

const sanitizeFolder = (input, fallback = 'stubia') => {
  if (!input || typeof input !== 'string') return fallback;
  const cleaned = input.replace(/\.\./g, '').replace(/[^a-zA-Z0-9_\-\/]/g, '').replace(/^\/+|\/+$/g, '');
  return cleaned || fallback;
};

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowedMimetypes = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];

    const ext = path.extname(file.originalname).toLowerCase();
    
    if (!allowedMimetypes.includes(file.mimetype) || !allowedExtensions.includes(ext)) {
      return cb(new Error('Hanya format JPG, JPEG, PNG, dan WEBP yang diizinkan untuk keamanan.'), false);
    }
    cb(null, true);
  },
});

// Upload single image
router.post('/image', verifyToken, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Ukuran file maksimal 5MB.' });
      }
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File gambar tidak ditemukan' });
    }

    const folder = sanitizeFolder(req.body.folder, 'stubia');

    // Upload to Cloudinary using buffer
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `stubia/${folder}`,
          resource_type: 'image',
          transformation: [
            { quality: 'auto:good' },
            { fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({
      success: true,
      data: {
        url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload image' });
  }
});

// Delete image (admin only)
router.delete('/image', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { public_id } = req.body;
    if (!public_id) {
      return res.status(400).json({ success: false, error: 'public_id is required' });
    }

    await cloudinary.uploader.destroy(public_id);
    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete image' });
  }
});

// Upload document (PDF/Word/Images)
const documentUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowedMimetypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/webp'
    ];
    const allowedExtensions = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp'];

    const ext = path.extname(file.originalname).toLowerCase();
    
    if (!allowedMimetypes.includes(file.mimetype) || !allowedExtensions.includes(ext)) {
      return cb(new Error('Hanya format PDF, DOC, DOCX, JPG, JPEG, PNG, dan WEBP yang diizinkan.'), false);
    }
    cb(null, true);
  },
});

router.post('/document', verifyToken, (req, res, next) => {
  documentUpload.single('document')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Ukuran file maksimal 10MB.' });
      }
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File dokumen tidak ditemukan' });
    }

    const folder = sanitizeFolder(req.body.folder, 'documents');

    // Upload to Cloudinary using buffer
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: `stubia/${folder}`,
          resource_type: 'auto',
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    res.json({
      success: true,
      data: {
        url: result.secure_url,
        public_id: result.public_id,
      },
    });
  } catch (error) {
    console.error('Upload document error:', error);
    res.status(500).json({ success: false, error: 'Gagal mengupload dokumen' });
  }
});

// Public Upload single image (No token required)
router.post('/public/image', publicUploadLimiter, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Ukuran file maksimal 5MB.' });
      }
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File gambar tidak ditemukan' });
    }

    const folder = sanitizeFolder(req.body.folder, 'stubia');

    // Upload to Cloudinary using buffer
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `stubia/${folder}`,
          resource_type: 'image',
          transformation: [
            { quality: 'auto:good' },
            { fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({
      success: true,
      data: {
        url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload image' });
  }
});

// Public Upload document (No token required)
router.post('/public/document', publicUploadLimiter, (req, res, next) => {
  documentUpload.single('document')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Ukuran file maksimal 10MB.' });
      }
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File dokumen tidak ditemukan' });
    }

    const folder = sanitizeFolder(req.body.folder, 'documents');

    // Upload to Cloudinary using buffer
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: `stubia/${folder}`,
          resource_type: 'auto',
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    res.json({
      success: true,
      data: {
        url: result.secure_url,
        public_id: result.public_id,
      },
    });
  } catch (error) {
    console.error('Upload document error:', error);
    res.status(500).json({ success: false, error: 'Gagal mengupload dokumen' });
  }
});

module.exports = router;
