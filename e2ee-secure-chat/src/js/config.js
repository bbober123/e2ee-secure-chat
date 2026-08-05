export const CONFIG = {
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL || 'https://mkxguotixyihlmsxpvyi.supabase.co/rest/v1/',
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_N5DOG-i1sE9RcNZ1L-AOVw_ytUrVecP',
  
  // Kryptografia
  PBKDF2_ITERATIONS: 600000,
  RSA_MODULUS_LENGTH: 4096,
  RSA_HASH: 'SHA-256',
  ECDH_CURVE: 'P-256',
  AES_KEY_LENGTH: 256,
  AES_IV_LENGTH: 12, // bytes
  AES_TAG_LENGTH: 128, // bits
  
  // Aplikacja
  APP_NAME: 'SecureChat',
  APP_VERSION: '1.0.0',
  AUTO_LOCK_MINUTES: 5,
  MAX_MESSAGE_LENGTH: 4000,
  MESSAGE_RATE_LIMIT: 15, // per minute
  DEVICE_FINGERPRINT_SALT: 'SecureChat-v1-',
  
  // Tryby
  MODES: {
    REAL: 'real',
    FAKE: 'fake'
  }
};

// Walidacja przy starcie
if (CONFIG.SUPABASE_URL.includes('TWOJ-PROJEKT')) {
  console.error('BŁĄD: Uzupełnij SUPABASE_URL i SUPABASE_ANON_KEY w js/config.js lub .env');
}
