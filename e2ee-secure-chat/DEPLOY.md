# Deployment SecureChat

Aplikacja jest statyczną stroną SPA (Single Page Application) używającą Vanilla JS i API Supabase.

## Opcja A: Vercel (zalecana)
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
