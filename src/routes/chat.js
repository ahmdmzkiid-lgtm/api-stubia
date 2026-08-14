const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { chatLimiter } = require('../middleware/rateLimiter');
const { chatWithKakZ, chatDiscussQuestion, chatKonsultasi } = require('../services/geminiService');

router.post('/', verifyToken, chatLimiter, async (req, res, next) => {
  try {
    const { message, history } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    const reply = await chatWithKakZ(message, history || []);
    
    res.json({ 
      success: true, 
      data: {
        reply
      }
    });
  } catch (error) {
    next(error);
  }
});

// Discuss a specific question with Stu
router.post('/discuss', verifyToken, chatLimiter, async (req, res, next) => {
  try {
    const { message, questionContext, history } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    if (!questionContext) {
      return res.status(400).json({ success: false, error: 'Question context is required' });
    }
    
    const reply = await chatDiscussQuestion(message, questionContext, history || []);
    
    res.json({ 
      success: true, 
      data: {
        reply
      }
    });
  } catch (error) {
    next(error);
  }
});

// Konsultasi belajar & PTN with Stu
router.post('/konsultasi', verifyToken, chatLimiter, async (req, res, next) => {
  try {
    const { message, history } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    const reply = await chatKonsultasi(message, history || []);
    
    res.json({ 
      success: true, 
      data: { reply }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
