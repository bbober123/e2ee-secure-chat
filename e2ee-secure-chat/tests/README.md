# Test end-to-end protokołu kryptograficznego

`crypto-e2e-test.mjs` uruchamia rzeczywisty, niezmodyfikowany kod z `src/js/`
(crypto.js, ratchet.js, sealed.js, prekeys.js, groupkeys.js) w Node.js,
symulując dwie/trzy niezależne "strony" (Alice, Bob, Carol) rozmawiające
ze sobą — bez przeglądarki i bez Supabase.

## Uruchomienie

```bash
./run.sh
```

(Odświeża `vendor/*.js` z `../src/js/` i uruchamia test — używaj TEGO
polecenia, nie `node crypto-e2e-test.mjs` bezpośrednio, bo `vendor/`
to tylko skopiowany snapshot i może być nieaktualny.)

## Co jest sprawdzane

- X3DH: Alice i Bob niezależnie wyprowadzają IDENTYCZNY Root Key
- Double Ratchet 1:1: wielokrotna wymiana wiadomości, wiadomości spoza
  kolejności (skip-keys), niemożność ponownego użycia zużytego klucza
  (forward secrecy), odrzucanie zmanipulowanego ciphertextu (AES-GCM),
  przetrwanie F5 (serialize/deserialize), zmiana klucza DH między turami
- Grupy (Sender Keys): dystrybucja klucza przez sealed box (X3DH
  jednorazowy), brak dostępu do wiadomości bez wcześniejszej dystrybucji,
  nowi członkowie NIE widzą historii sprzed dołączenia, odrzucanie
  zmanipulowanego nagłówka, przetrwanie F5
- **Regresja**: stan ratchetu/łańcucha PRZEŻYWA odrzucony/zmanipulowany
  pakiet — to konkretny bug, który ten test złapał podczas pisania
  (`decrypt()` commitował nowy stan PRZED potwierdzeniem, że uwierzytelnione
  odszyfrowanie faktycznie się powiodło; sfałszowany pakiet trwale
  rozsynchronizowywał ratchet mimo że sam został poprawnie odrzucony —
  czyli jednym złym pakietem dało się trwale zablokować rozmowę). Naprawione
  w obu miejscach (ratchet.js i groupkeys.js): cały nowy stan liczony jest
  teraz w kopii roboczej i commitowany dopiero po sukcesie.

## Czego ten test NIE sprawdza

- Polityk RLS i rzeczywistych zapytań SQL (`database.sql` nie jest tu
  uruchamiane — do tego potrzebna jest prawdziwa instancja Supabase)
- Realtime (subskrypcje `postgres_changes`)
- UI / DOM / wiring w `chat.js`, `ui.js`, `groups.js`, `friends.js`
- Warstwy sieciowej i faktycznego przechowywania w Supabase

Innymi słowy: to jest gwarancja, że sam PROTOKÓŁ kryptograficzny jest
poprawny — nie że cała aplikacja działa od A do Z. Pełny test wymaga
uruchomienia `database.sql` na testowej instancji Supabase i przejścia
scenariusza ręcznie (rejestracja dwóch kont → dodanie znajomego →
utworzenie/dołączenie do grupy → wymiana wiadomości).
