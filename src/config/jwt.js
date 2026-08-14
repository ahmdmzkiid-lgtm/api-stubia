const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is missing in production!');
    }
    console.warn('⚠️ WARNING: JWT_SECRET is not set. Using fallback secret for development.');
    return 'fallback_dev_secret_change_me';
  }
  return secret;
};

module.exports = {
  getJwtSecret,
};
