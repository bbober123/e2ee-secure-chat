# Deployment SecureChat

Aplikacja jest statyczną stroną SPA (Single Page Application) używającą Vanilla JS i API Supabase.

## Konfiguracja lokalna (dev)
1. Uruchom `database.sql` w Supabase (SQL Editor) - tworzy tabele i polityki RLS.
2. Skopiuj `.env.example` do `.env` i uzupełnij `VITE_SUPABASE_URL` oraz `VITE_SUPABASE_ANON_KEY`
   (Dashboard -> Project Settings -> API).
3. W Supabase: Authentication -> Providers -> Email -> **wyłącz "Confirm email"**.
   Rejestracja w tej aplikacji zapisuje klucze szyfrujące do bazy zaraz po `signUp()` -
   wymaga to aktywnej sesji. Jeśli potwierdzenie e-mail jest włączone, `signUp()` nie
   zwraca sesji i zapis profilu zostanie odrzucony przez RLS.
4. `npm install` i `npm run dev`.

## Nowe funkcje (awatar, historia logowań, wiele kont na urządzeniu)
- Zmiana awatara wymaga publicznego bucketu Storage `avatars` (tworzy go `database.sql`
  wraz z politykami: każdy może odczytać, ale wgrywać/nadpisywać można tylko plik we
  własnym folderze `avatars/<user_id>/...`).
- Adres IP jest pobierany po stronie klienta (przez https://api.ipify.org - stąd wpis
  w CSP `connect-src`) i zapisywany do tabeli `login_history` przy każdym logowaniu/
  odblokowaniu, wraz z aktualizacją `devices.last_ip`. To adres IP zgłaszany przez
  przeglądarkę użytkownika, nie zweryfikowany serwerowo - do wglądu/orientacyjnie,
  nie jako twarde zabezpieczenie.
- Przełączanie kont: tokeny sesji każdego konta, na które użytkownik się zalogował,
  są zapisywane lokalnie w przeglądarce (localStorage, klucz `securechat_accounts`).
  Dzięki temu można przełączać się między kontami na tym urządzeniu podając tylko
  hasło (bez ponownego wpisywania e-maila/loginu) - konto znika z tej listy dopiero
  po jawnym wylogowaniu.

## Nagłówki bezpieczeństwa (ustaw na poziomie hostingu/CDN)
`index.html` ustawia przez `<meta>` to, co da się ustawić z poziomu HTML (CSP,
Referrer-Policy), ale kilka istotnych nagłówków HTTP **nie działa jako meta-tag**
i wymaga konfiguracji hostingu (np. plik `vercel.json` / `netlify.toml` / reguły
Cloudflare) przed wdrożeniem produkcyjnym dla realnych, wrażliwych rozmów:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Frame-Options: DENY` (CSP `frame-ancestors 'none'` już to częściowo pokrywa w nowszych przeglądarkach, ale starsze go ignorują)
- `X-Content-Type-Options: nosniff`
- `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`

## Serwer TURN (połączenia głosowe/wideo)
Skonfigurowany domyślnie jest tylko publiczny STUN (Google) w `src/js/config.js`
(`CONFIG.ICE_SERVERS`). To wystarcza w wielu sieciach domowych, ale NIE
gwarantuje połączenia w sieciach firmowych, CGNAT czy za symetrycznym NAT-em.
Do niezawodnych połączeń w produkcji dodaj własny serwer TURN (np. coturn) i
uzupełnij `CONFIG.ICE_SERVERS` o wpis z `urls`, `username`, `credential`.


1. Zainstaluj CLI: `npm i -g vercel`
2. Uruchom: `vercel --prod`
3. W dashboard Vercel: Settings → Environment Variables → dodaj `VITE_SUPABASE_URL` i `VITE_SUPABASE_ANON_KEY`.

## Opcja B: Netlify
1. Zainstaluj CLI: `npm i -g netlify-cli`
2. Zbuduj i wyślij: `netlify deploy --prod --dir=.`
3. W Netlify Dashboard: Site settings → Build & deploy → ustaw zmienne środowiskowe.

## Opcja C: Supabase Storage (statyczny hosting)
1. W Supabase Dashboard wejdź w Storage
2. Stwórz nowy bucket np. `securechat-hosting`
3. Zaznacz 'Enable public access'
4. Wgraj pliki `.html`, `.css`, `.js` (zachowując strukturę folderów)
5. Otwórz pod adresem publicznego URL.

## Opcja D: GitHub Pages
1. Wypushuj kod na repozytorium GitHub
2. W Settings → Pages → wybierz Source: "Deploy from a branch", wskaż `main` (folder `/root`).
3. Zaktualizuj plik config o bezpośrednie wartości Supabase URL w `js/config.js` (dla GitHub Pages bez build step).
