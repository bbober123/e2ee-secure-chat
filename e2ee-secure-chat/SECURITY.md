# Security Checklist

## Naprawione w tym przeglądzie

- [x] **Non-extractable keys**: Klucze prywatne RSA oraz klucze sesyjne AES odbierane
      przez odbiorcę są teraz importowane z `extractable: false`. Wcześniej były
      `extractable: true`, co pozwoliłoby np. wstrzykniętemu przez XSS skryptowi
      wyeksportować surowy materiał klucza prywatnego z pamięci — mimo że dokument
      ten deklarował "non-extractable keys" jako spełnione. (`src/js/crypto.js`)
- [x] **Weryfikacja klucza kontaktu (TOFU / "safety number")**: Przed każdym
      wysłaniem wiadomości aplikacja porównuje fingerprint klucza publicznego
      odbiorcy z ostatnio zaufaną wartością (zapisaną lokalnie w przeglądarce,
      NIE na serwerze). Jeśli klucz się zmienił, użytkownik dostaje wyraźne
      ostrzeżenie o możliwym ataku man-in-the-middle i musi świadomie potwierdzić
      zaufanie nowemu kluczowi. (`KeyTrustStore` w `src/js/crypto.js`,
      użycie w `ChatApp.sendMessage`)
- [x] **Integralność wiadomości w bazie**: Polityka RLS `UPDATE` na `messages`
      pozwalała wcześniej dowolnemu uczestnikowi konwersacji nadpisać DOWOLNĄ
      kolumnę (w tym `encrypted_payload`, `sender_id`), a nie tylko `status`.
      Dodano trigger `prevent_message_content_tampering`, który wymusza, że
      UPDATE może zmienić wyłącznie pole `status`. (`database.sql`)
- [x] **Server-side rate limiting**: Limit 15 wiadomości/min istniał tylko po
      stronie klienta (trywialny do ominięcia bezpośrednim wywołaniem Supabase
      API). Dodano trigger DB wymuszający twardy limit (30/60s/nadawca) jako
      obronę w głębi. (`database.sql`)
- [x] **Limit długości wiadomości**: `CONFIG.MAX_MESSAGE_LENGTH` był zdefiniowany,
      ale nigdy nie egzekwowany w kodzie. Teraz wymuszany przed wysłaniem.
      (`src/js/chat.js`)
- [x] **Przejrzystość nowych urządzeń**: automatyczne dodawanie nowego urządzenia
      do konta (potrzebne do logowania na wielu urządzeniach) teraz jawnie
      informuje użytkownika toastem, żeby mógł zauważyć nieautoryzowane logowanie.

## Istniejące zabezpieczenia (zweryfikowane, bez zmian)

- [x] **CSP header**: `default-src 'self'; connect-src https://*.supabase.co wss://*.supabase.co; ...`
- [x] **XSS Protection**: Treść wiadomości renderowana przez `textContent`, nie `innerHTML`; pozostałe dane wejściowe przechodzą przez `_escapeHtml`.
- [x] **No eval()**: Brak eval(), new Function().
- [x] **RLS na wszystkich tabelach**: `users`, `devices`, `contacts`, `conversations`, `messages` mają włączone Row Level Security z politykami ograniczającymi dostęp do własnych danych / konwersacji, w których użytkownik uczestniczy.
- [x] **PBKDF2 600 000 iteracji** do wyprowadzania klucza z hasła (OWASP 2023 rekomenduje ≥600k dla SHA-256).
- [x] **AES-256-GCM** (authenticated encryption) do szyfrowania treści; świeży klucz sesyjny i nonce dla każdej wiadomości.
- [x] **Zero-persistence keys**: Klucze prywatne trzymane wyłącznie jako `CryptoKey` w RAM, czyszczone przy blokadzie/wylogowaniu.

## Znane ograniczenia architektury (NIE naprawione — wymagają większej przebudowy)

Te punkty warto znać zanim użyje się aplikacji do faktycznie wrażliwej komunikacji:

- ⚠️ **Brak Forward Secrecy (PFS)**: Każda wiadomość ma świeży klucz AES, ale ten
  klucz jest owijany (RSA-OAEP) statycznym, długoterminowym kluczem publicznym
  odbiorcy i przechowywany na serwerze (`encrypted_content_key`). Jeśli
  długoterminowy klucz prywatny odbiorcy zostanie kiedykolwiek skompromitowany
  (np. słabe hasło, keylogger), **CAŁA historia wiadomości** staje się możliwa
  do odszyfrowania. Prawdziwe PFS wymaga protokołu ratchetowego (jak Signal's
  Double Ratchet / X3DH) — to świadomy kompromis projektowy w obecnej wersji,
  nie prosta łatka. Kod zawiera już nieużywane funkcje `generateEphemeralKeyPair`
  i `deriveSessionKey` (ECDH) w `crypto.js` jako punkt wyjścia do takiej migracji.
- ⚠️ **Brak niezależnej weryfikacji tożsamości (poza TOFU)**: Dodane wykrywanie
  zmiany klucza (TOFU) chroni przed atakiem, który następuje PO pierwszym
  kontakcie, ale NIE chroni przy pierwszym połączeniu — jeśli atakujący
  kontroluje serwer od samego początku, może podstawić własny klucz od razu i
  TOFU tego nie wykryje. Prawdziwa ochrona wymaga weryfikacji fingerprintu
  innym kanałem (osobiście, telefonicznie) — obecnie UI tego nie ułatwia
  (brak ekranu "porównaj kody bezpieczeństwa").
- ⚠️ **"Fake mode" nie jest niewykrywalny dla serwera**: Kolumna `messages.mode`
  (`'real'` / `'fake'`) jest jawna dla każdego z dostępem do bazy danych.
  Choć chroni to przed kimś, kto zna tylko Twoje hasło (typowy scenariusz
  "przymuszonego odblokowania"), administrator bazy danych / dostawca hostingu
  / ktoś kto uzyska zrzut bazy może stwierdzić samą OBECNOŚĆ ukrytego trybu
  (nawet bez odszyfrowania treści), co częściowo podważa "plausible
  deniability" wobec adwersarza mającego dostęp do serwera.
- ⚠️ **Brak uwierzytelnienia nadawcy (celowo)**: RSA-OAEP daje poufność, nie
  podpis. To celowa decyzja projektowa spójna z ideą "plausible deniability"
  (dodanie podpisów cyfrowych dałoby niezaprzeczalność, co jest sprzeczne z
  celem aplikacji) — ale oznacza to też, że treść wiadomości nie jest
  kryptograficznie powiązana z tożsamością nadawcy poza `sender_id` w bazie
  (obecnie chronionym RLS + triggerem przed modyfikacją).
