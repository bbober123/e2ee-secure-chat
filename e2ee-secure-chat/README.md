# SecureChat — E2EE Chat with Plausible Deniability

Aplikacja czatu z 4-warstwowym szyfrowaniem, End-to-End Encryption i trybem plausible deniability (fake mode).

## ✉️ Wiadomości i połączenia

- Tekst, zdjęcia, filmy i wiadomości głosowe — wszystko szyfrowane end-to-end
  po stronie klienta przed wysłaniem (patrz `src/js/media.js`).
- Połączenia głosowe i wideo (WebRTC, z możliwością wyłączenia kamery) z
  sygnalizacją (SDP/ICE) szyfrowaną i uwierzytelnianą tym samym mechanizmem
  co wiadomości — patrz `src/js/calls.js` i `SECURITY.md`.
- Szczegóły wzmocnień przeciw MITM/XSS/manipulacji danymi oraz uczciwa lista
  ograniczeń: sekcja "Zmiany z tej rundy" w `SECURITY.md`.

## 🛡️ Architektura bezpieczeństwa

### Warstwa 1: Transport (TLS 1.3)
Zapewnia Supabase / hosting.

### Warstwa 2: Szyfrowanie w spoczynku (At-rest)
Supabase PostgreSQL jest szyfrowane przez dostawcę.

### Warstwa 3: End-to-End Encryption
- Każda wiadomość: AES-256-GCM z kluczem sesji
- Klucz sesji: wyprowadzony z ECDH P-256 + HKDF-SHA256
- Klucz sesji szyfrowany kluczem publicznym RSA-4096 odbiorcy
- Forward secrecy: nowy ephemeral ECDH per konwersacja (lub per wiadomość)

### Warstwa 4: Client-side Vault
- Klucz prywatny RSA użytkownika szyfrowany AES-256-GCM
- Klucz AES pochodzi z PBKDF2-SHA256 (600k iteracji) z hasła użytkownika
- Zaszyfrowany klucz prywatny trafia do tabeli `devices` w Supabase
- Klucz prywatny NIGDY nie opuszcza RAM (przy F5 / zamknięciu karty — znika)

### Tryb Fake (Plausible Deniability)
- 2 niezależne pary kluczy RSA (real + fake)
- 2 niezależne hasła
- Fake mode wygląda IDENTYCZNIE jak real mode
- Te same kontakty, inne nicki/awatary/wiadomości
- Serwer nie może odróżnić real od fake po strukturze danych

## 🚀 Szybki start

### 1. Supabase Setup
- Załóż konto na [supabase.com](https://supabase.com)
- Stwórz nowy projekt
- W SQL Editor wklej kod z `database.sql` (schemat bazy, RLS, indeksy)
- Database → Replication → Realtime → włącz dla tabeli `messages`
- Project Settings → API → skopiuj `URL` i `anon public` key

> Wskaźnik "X pisze..." działa przez kanały Realtime **Broadcast** (nie wymaga
> dodatkowej konfiguracji w Dashboardzie — działa od razu z tym samym projektem
> Supabase co reszta aplikacji).

### 2. Konfiguracja aplikacji
- Utwórz plik `.env` na bazie `.env.example`
- Wklej swój URL i ANON KEY w miejsca `VITE_SUPABASE_URL` i `VITE_SUPABASE_ANON_KEY`
- Ewentualnie edytuj zmienne `SUPABASE_URL` na twardo w `src/js/config.js`

### 3. Deployment
- Zobacz plik `DEPLOY.md` w celu wdrożenia
- Otwórz URL w przeglądarce

### 4. Pierwsze uruchomienie
- Zarejestruj się (email + username + hasło + opcjonalne fake hasło)
- Dodaj kontakt (podaj username znajomego)
- Zacznij pisać — wiadomości są szyfrowane lokalnie PRZED wysłaniem

## 📋 Checklista testów (przeprowadź przed użyciem)

### Rejestracja i logowanie
- [ ] Rejestracja z real i fake hasłem powiodła się
- [ ] Po rejestracji w Supabase Dashboard w tabeli `users` widzę public_key_real i public_key_fake
- [ ] W tabeli `devices` widzę encrypted_private_key_real i encrypted_private_key_fake (base64, nie plaintext!)

### Fake Mode
- [ ] Logowanie real hasłem → widzę prawdziwe nicki kontaktów
- [ ] Logowanie fake hasłem → widzę te same kontakty z innymi nickami
- [ ] W fake mode UI wygląda IDENTYCZNIE (brak napisów "FAKE", innych kolorów, etc.)
- [ ] Wiadomości wysłane w fake mode są widoczne tylko w fake mode

### Ochrona kluczy
- [ ] Po naciśnięciu F5 / Ctrl+R aplikacja wymaga ponownego wpisania hasła (overlay lock)
- [ ] Po zamknięciu karty i ponownym otwarciu — wymaga hasła
- [ ] W DevTools → Application → Local Storage / Session Storage — BRAK kluczy prywatnych
- [ ] W DevTools → Console — `window.KeyManager` lub obiekt managera kluczy nie wycieka do okna

### Szyfrowanie
- [ ] W Supabase Dashboard → tabela `messages` → kolumna `encrypted_payload` zawiera nieczytelny base64 (nie plaintext)
- [ ] Wysłana wiadomość pojawia się u odbiorcy bez odświeżania (Realtime)
- [ ] Odbiorca widzi plaintext, serwer widzi tylko ciphertext

### Auto-lock
- [ ] 5 minut bez aktywności → aplikacja blokuje się i wymaga hasła
- [ ] Kliknięcie / scroll / klawiatura resetuje timer

## ⚠️ Ostrzeżenia bezpieczeństwa

1. **Brak backdoora**: Jeśli zapomnisz hasła — dane są nieodwracalnie utracone. Nie ma możliwości resetu hasła przez administratora.
2. **Fake hasło**: Nie udostępniaj fake hasła osobom, którym nie ufasz. Osoba z fake hasłem widzi fake rozmowy, ale może próbować zgadywać real hasło.
3. **Serwer**: Supabase widzi metadane (kto z kim rozmawia, kiedy), ale NIE widzi treści wiadomości (tylko ciphertext).
4. **Browser security**: Używaj tylko zaktualizowanej przeglądarki. Web Crypto API wymaga HTTPS (lub localhost).
5. **Screenshots**: Aplikacja nie blokuje screenshotów systemowych — to zadanie systemu operacyjnego.

## 🔧 Troubleshooting

### "Cannot decrypt message"
- Sprawdź czy odblokowałeś klucze przy wejściu (lock screen)
- Sprawdź czy nonce ma dokładnie 12 bajtów
- Upewnij się, że odbiorca używa tego samego trybu (real/fake)

### "Invalid key length"
- PBKDF2 musi zwracać 256-bit key (32 bajty)
- Sprawdź czy salt jest poprawnie dekodowany z hex

### Realtime nie działa
- W Supabase Dashboard: Database → Replication → Realtime → czy tabela `messages` jest włączona?
- Sprawdź konsolę przeglądarki — czy loguje status 'SUBSCRIBED'?

### Po F5 klucze znikają
- To jest POPRAWNE zachowanie. Klucze prywatne są trzymane TYLKO w RAM. Po odświeżeniu strony musisz wpisać hasło ponownie.

## 📝 Licencja
MIT — używaj na własną odpowiedzialność.
