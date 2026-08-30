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

## Zmiany z tej rundy: media, połączenia, ukrycie trybu fake, MITM/XSS/tampering

### Nowe funkcje
- [x] **Zdjęcia, filmy, wiadomości głosowe**: szyfrowane end-to-end tym samym
  mechanizmem co tekst (świeży klucz AES-256-GCM na wiadomość, owinięty
  RSA-OAEP). Plik trafia jako nieprzezroczysty ciphertext do prywatnego
  bucketu Supabase Storage `media`, z RLS ograniczonym do uczestników
  konwersacji. Zawsze wgrywany z `Content-Type: application/octet-stream`,
  żeby przeglądarka nigdy nie próbowała wyrenderować surowych bajtów jako
  HTML. (`src/js/media.js`, `database.sql`)
- [x] **Połączenia głosowe/wideo (WebRTC)**: audio i wideo (z możliwością
  wyłączenia kamery) 1:1. Sam strumień audio/wideo jest zawsze szyfrowany
  DTLS-SRTP (standard WebRTC), ale dodatkowo negocjacja SDP i kandydatów ICE
  (czyli m.in. odcisk certyfikatu DTLS) jest szyfrowana i uwierzytelniana
  AES-GCM + RSA-OAEP tym samym mechanizmem co wiadomości — patrz obszerny
  komentarz na górze `src/js/calls.js`. Bez tego serwer sygnalizacyjny mógłby
  teoretycznie podmienić odciski certyfikatów i wstawić się jako MITM mimo
  "szyfrowanego" połączenia.
  - ⚠️ Ograniczenie sieciowe (nie bezpieczeństwa): skonfigurowany jest tylko
    publiczny STUN (Google). Część sieci (CGNAT, symetryczny NAT, sieci
    firmowe) będzie wymagać własnego serwera TURN — patrz `CONFIG.ICE_SERVERS`
    w `src/js/config.js`.
- [x] **Ukrycie trybu "fake" przed szybkim sprawdzeniem konsoli**: `window.APP_MODE`
  i `window.CURRENT_USER` zostały usunięte. Stan żyje wyłącznie w domknięciu
  modułu `src/js/state.js` (`AppState`) — nieosiągalnym przez zwykłe
  `window.APP_MODE` w konsoli. Zobacz zastrzeżenie w komentarzu na górze tego
  pliku: to NIE chroni przed kimś, kto ustawi breakpoint w DevTools →
  Sources i podejrzy zmienne domknięcia, ani przed analizą samego kodu
  źródłowego (cały JS i tak trafia do przeglądarki) — chroni przed
  najbardziej typowym, szybkim sprawdzeniem.

### Wzmocnienia przeciw MITM / XSS / manipulacji (tampering)
- [x] **AAD (Additional Authenticated Data) w AES-GCM**: każdy szyfrogram
  (tekst, plik, sygnalizacja połączenia) jest teraz kryptograficznie związany
  z kontekstem `conversation_id + sender_id/callId + mode`. Ktoś z dostępem
  do bazy (skompromitowany/złośliwy backend) nie może już "przekleić"
  poprawnego, nieodszyfrowanego szyfrogramu do innej rozmowy, zmienić
  nadawcy, ani przełożyć wiadomości między trybem real/fake bez unieważnienia
  szyfrogramu. (`CryptoEngine.buildAAD` w `src/js/crypto.js`)
- [x] **Rozszerzona CSP**: dodano `media-src 'self' blob:` (dla odtwarzania
  odszyfrowanych plików), `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`.
  (`index.html`)
- [x] **Wymuszenie HTTPS w konfiguracji**: `config.js` teraz sprawdza przy
  starcie, że `SUPABASE_URL` zaczyna się od `https://`, i głośno ostrzega w
  konsoli, jeśli nie — E2EE chroni treść, ale nie sam transport, jeśli ten
  nie jest szyfrowany TLS-em.
- [x] **Sanityzacja nazw plików**: `MediaManager.sanitizeFileName` usuwa
  separatory ścieżek, `..`, znaki kontrolne i znaki HTML z nazw plików przed
  ich zapisaniem/wyświetleniem — obrona przed path traversal w ścieżce
  Storage i przed XSS przy wyświetlaniu nazwy załącznika w UI.
  Nazwy plików nadal są renderowane przez `textContent`/`_escapeHtml`
  (nigdy `innerHTML`), zgodnie z resztą aplikacji.
- [x] **Rozszerzenie triggera niezmienności** (`prevent_message_content_tampering`)
  o nowe kolumny (`type`, `media_path`, `media_size`, `media_nonce`) — te pola
  są teraz równie chronione przed modyfikacją po insercie jak
  `encrypted_payload`. (`database.sql`)
- [x] **Bucket Storage `media` prywatny + RLS po uczestnikach konwersacji**
  (analogicznie do wierszy `messages`), z twardym limitem rozmiaru pliku na
  poziomie bucketu (100 MB) niezależnym od walidacji klienckiej.

### Uczciwie: czego to NIE naprawia
- ⚠️ Nagłówki takie jak `Strict-Transport-Security`, `X-Frame-Options`,
  `X-Content-Type-Options`, `Permissions-Policy` **nie mogą** być w pełni
  ustawione przez znacznik `<meta>` w HTML — wymagają konfiguracji na
  poziomie hostingu/CDN (Vercel, Netlify, Cloudflare itp.). Ustaw je tam
  przed wdrożeniem produkcyjnym; patrz `DEPLOY.md`.
- ⚠️ Ukrycie trybu fake w `state.js` i sanityzacja nazw plików to obrony
  "w głębi" (defense in depth), nie kryptograficzne gwarancje — patrz
  zastrzeżenia w komentarzach odpowiednich plików.
- ⚠️ WebRTC bez serwera TURN nie zawsze nawiąże połączenie w restrykcyjnych
  sieciach — to nie jest luka bezpieczeństwa, ale ograniczenie działania.
