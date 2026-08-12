export const CONFIG = {
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL || 'https://TWOJ-PROJEKT.supabase.co',
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || 'TWOJ-ANON-KEY',
  
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

  // Media (zdjęcia / filmy / głosówki) - patrz src/js/media.js
  MAX_MEDIA_BYTES: 50 * 1024 * 1024, // 50 MB (bucket Supabase dopuszcza do 100 MB - patrz database.sql)
  MAX_VOICE_SECONDS: 300, // 5 minut na jedną wiadomość głosową
  ALLOWED_IMAGE_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/quicktime'],

  // Połączenia głosowe/wideo (WebRTC) - patrz src/js/calls.js
  // UWAGA: sam STUN (Google) wystarcza tylko dla części sieci/NAT-ów. Dla
  // niezawodnych połączeń w produkcji (sieci firmowe, CGNAT, symetryczny
  // NAT) potrzebny jest też serwer TURN z danymi uwierzytelniającymi -
  // podmień/uzupełnij poniższą listę własnym serwerem TURN przed wdrożeniem
  // dla realnych użytkowników. Bez TURN część połączeń po prostu się nie
  // nawiąże (to ograniczenie sieciowe, nie luka bezpieczeństwa).
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // { urls: 'turn:twoj-turn-serwer.example.com:3478', username: '...', credential: '...' },
  ],

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

// Wymuszenie HTTPS: klient nie powinien nigdy łączyć się z Supabase po
// zwykłym HTTP - to jedyna linia obrony przed pasywnym podsłuchem/MITM na
// warstwie transportowej (E2EE chroni TREŚĆ wiadomości, ale nie chroni
// samego transportu, jeśli ten nie jest szyfrowany TLS-em).
if (CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.startsWith('https://')) {
  console.error('BŁĄD BEZPIECZEŃSTWA: SUPABASE_URL musi zaczynać się od https:// (nie http://).');
}
