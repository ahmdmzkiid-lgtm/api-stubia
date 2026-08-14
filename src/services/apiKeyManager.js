/**
 * API Key Manager for Gemini API
 * Manages multiple API keys with automatic rotation and rate limit handling
 *
 * Features:
 * - Round-robin key rotation for load distribution
 * - Automatic fallback when key hits rate limit
 * - Cooldown tracking and auto-recovery
 * - Health monitoring and metrics
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

class ApiKeyManager {
  constructor() {
    // Load API keys from environment
    const keysString = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';

    if (!keysString) {
      throw new Error('No Gemini API keys configured. Set GEMINI_API_KEYS in environment.');
    }

    // Parse keys (comma-separated)
    this.keys = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);

    if (this.keys.length === 0) {
      throw new Error('No valid Gemini API keys found after parsing.');
    }

    // Initialize key state tracking
    this.keyStates = this.keys.map((key, index) => ({
      index,
      key,
      status: 'available', // 'available' | 'exhausted'
      requestCount: 0,
      lastUsed: null,
      exhaustedAt: null,
      cooldownUntil: null
    }));

    // Configuration
    this.currentIndex = 0; // For round-robin
    this.cooldownPeriod = 60 * 1000; // 60 seconds (Gemini rate limit window)

    console.log(`[ApiKeyManager] Initialized with ${this.keys.length} API key(s)`);
  }

  /**
   * Get next available API key using round-robin strategy
   * Automatically skips exhausted keys and checks for cooldown recovery
   * @returns {string|null} API key or null if all exhausted
   */
  getNextKey() {
    // First, check and recover any keys that have cooled down
    this._recoverCooledDownKeys();

    // Try to find an available key (max attempts = number of keys)
    const maxAttempts = this.keys.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const state = this.keyStates[this.currentIndex];

      if (state.status === 'available') {
        // Found available key
        state.requestCount++;
        state.lastUsed = new Date();

        const selectedKey = state.key;
        const selectedIndex = this.currentIndex;

        // Move to next index for round-robin
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;

        console.log(`[ApiKeyManager] Using key #${selectedIndex + 1} (total requests: ${state.requestCount})`);
        return selectedKey;
      }

      // Current key exhausted, try next
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;
    }

    // All keys exhausted
    console.error('[ApiKeyManager] All API keys are exhausted');
    return null;
  }

  /**
   * Get GoogleGenerativeAI instance with next available key
   * @returns {GoogleGenerativeAI|null}
   */
  getNextGeminiInstance() {
    const key = this.getNextKey();
    if (!key) {
      return null;
    }
    return new GoogleGenerativeAI(key);
  }

  /**
   * Mark a key as exhausted (rate limited)
   * @param {string} key - The API key that hit rate limit
   */
  markKeyExhausted(key) {
    const state = this.keyStates.find(s => s.key === key);
    if (!state) {
      console.warn('[ApiKeyManager] Attempted to mark unknown key as exhausted');
      return;
    }

    if (state.status === 'exhausted') {
      return; // Already marked
    }

    state.status = 'exhausted';
    state.exhaustedAt = new Date();
    state.cooldownUntil = new Date(Date.now() + this.cooldownPeriod);

    console.warn(`[ApiKeyManager] Key #${state.index + 1} marked as exhausted. Cooldown until ${state.cooldownUntil.toISOString()}`);
  }

  /**
   * Manually mark a key as available (admin override)
   * @param {number} keyIndex - Index of the key to mark available
   */
  markKeyAvailable(keyIndex) {
    if (keyIndex < 0 || keyIndex >= this.keyStates.length) {
      throw new Error('Invalid key index');
    }

    const state = this.keyStates[keyIndex];
    state.status = 'available';
    state.exhaustedAt = null;
    state.cooldownUntil = null;

    console.log(`[ApiKeyManager] Key #${keyIndex + 1} manually restored to available`);
  }

  /**
   * Get count of currently available keys
   * @returns {number}
   */
  getAvailableKeysCount() {
    this._recoverCooledDownKeys();
    return this.keyStates.filter(s => s.status === 'available').length;
  }

  /**
   * Get detailed status of all keys
   * @returns {Object}
   */
  getKeyStatus() {
    this._recoverCooledDownKeys();

    return {
      totalKeys: this.keys.length,
      availableKeys: this.keyStates.filter(s => s.status === 'available').length,
      exhaustedKeys: this.keyStates.filter(s => s.status === 'exhausted').length,
      keys: this.keyStates.map(state => ({
        id: state.index + 1,
        status: state.status,
        requestCount: state.requestCount,
        lastUsed: state.lastUsed ? state.lastUsed.toISOString() : null,
        exhaustedAt: state.exhaustedAt ? state.exhaustedAt.toISOString() : null,
        cooldownUntil: state.cooldownUntil ? state.cooldownUntil.toISOString() : null,
        // Don't expose actual key for security
        keyPreview: state.key.substring(0, 10) + '...'
      }))
    };
  }

  /**
   * Reset all keys to available (admin function)
   */
  resetAllKeys() {
    this.keyStates.forEach(state => {
      state.status = 'available';
      state.exhaustedAt = null;
      state.cooldownUntil = null;
    });
    console.log('[ApiKeyManager] All keys reset to available');
  }

  /**
   * Private: Check and recover keys that have passed cooldown period
   */
  _recoverCooledDownKeys() {
    const now = Date.now();

    this.keyStates.forEach(state => {
      if (state.status === 'exhausted' && state.cooldownUntil) {
        if (now >= state.cooldownUntil.getTime()) {
          state.status = 'available';
          state.exhaustedAt = null;
          state.cooldownUntil = null;
          console.log(`[ApiKeyManager] Key #${state.index + 1} auto-recovered from cooldown`);
        }
      }
    });
  }

  /**
   * Check if a specific error is a rate limit error
   * @param {Error} error
   * @returns {boolean}
   */
  isRateLimitError(error) {
    if (!error || !error.message) return false;

    const message = error.message.toLowerCase();
    return message.includes('too many requests') ||
           message.includes('quota') ||
           message.includes('rate limit') ||
           message.includes('429') ||
           message.includes('403') ||
           message.includes('forbidden') ||
           message.includes('denied access');
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the ApiKeyManager singleton instance
 * @returns {ApiKeyManager}
 */
function getApiKeyManager() {
  if (!instance) {
    instance = new ApiKeyManager();
  }
  return instance;
}

module.exports = { getApiKeyManager };
