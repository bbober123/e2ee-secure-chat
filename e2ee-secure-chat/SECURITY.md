# Security Checklist

- [x] **CSP header**: `default-src 'self'; connect-src https://*.supabase.co wss://*.supabase.co; style-src 'self' 'unsafe-inline'; script-src 'self' 'module'; img-src * data: blob:;`
- [x] **XSS Protection**: Wszystkie dane wejściowe sanityzowane przed innerHTML (zabezpieczenie _escapeHtml w UI.js)
- [x] **No eval()**: Brak eval(), new Function(), i niebezpiecznych API
- [x] **Non-extractable keys**: Klucze prywatne posiadają extractable=false po imporcie do Web Crypto (do operacji)
- [x] **Password inputs type**: Pola posiadają type="password" z odpowiednimi typami wejść
- [x] **Rate limiting**: Client-side limit 15 wiadomości na minutę (dodatkowo zalecany rate limiting lub trigger po stronie DB)
- [x] **Fake mode stealth**: Pełny brak rozróżnienia wizualnego w UI, logi konsoli nie zdradzają "fake mode"
- [x] **Zero-persistence keys**: Klucze zawsze trzymane tylko jako referencje `CryptoKey` w RAM (wystarczy odświeżyć by usunąć stan)
- [x] **Device fingerprinting**: Hash bazujący na urządzeniu dodaje dodatkowy czynnik utrudniający atak (nawet mając hasło, trzeba logować z autoryzowanego env)
