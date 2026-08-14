const multer = require('multer');

// Configure multer for memory storage (we'll process the CSV directly from memory)
const storage = multer.memoryStorage();

// Filter to accept CSV and Excel files
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
    'application/x-zip-compressed',
    'application/zip',
    'application/x-vnd.ms-excel',
    'text/plain',
  ];
  const ext = file.originalname ? file.originalname.split('.').pop().toLowerCase() : '';
  const allowedExts = ['xlsx', 'xls', 'csv'];

  if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    const err = new Error('File harus berformat Excel (.xlsx, .xls) atau CSV');
    err.status = 400;
    cb(err, false);
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: fileFilter
});

module.exports = upload;
