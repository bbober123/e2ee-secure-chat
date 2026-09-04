/**
 * AppState - przechowuje bieżący tryb ('real'/'fake') i zalogowanego
 * użytkownika WYŁĄCZNIE w domknięciu (closure) tego modułu.
 *
 * Poprzednio te wartości były trzymane jako `window.APP_MODE` /
 * `window.CURRENT_USER`, co oznaczało, że każdy, kto otworzył konsolę
 * przeglądarki (np. osoba przymuszająca użytkownika do odblokowania
 * aplikacji "hasłem awaryjnym") mógł wpisać `window.APP_MODE` i od razu
 * zobaczyć, że korzysta z trybu 'fake' zamiast 'real' - co całkowicie
 * niweczyło sens plausible deniability.
 *
 * Zmienne modułowe (domknięcie ES module) NIE są dostępne jako właściwości
 * `window` ani przez zwykłe operacje w konsoli (`window.APP_MODE`,
 * `Object.keys(window)`, itp.) - dostęp do nich wymaga wyłącznie wywołania
 * eksportowanych funkcji poniżej.
 *
 * UWAGA (uczciwie, patrz też SECURITY.md): to NIE jest ochrona przed każdym
 * atakującym. Ktoś z zaawansowaną wiedzą techniczną i fizycznym dostępem do
 * odblokowanego urządzenia nadal może:
 *  - ustawić breakpoint w panelu "Sources" DevTools i podejrzeć zmienne domknięcia,
 *  - przechwycić ruch sieciowy i zobaczyć, że pobierane są wiadomości z `mode='fake'`,
 *  - przeczytać kod źródłowy aplikacji (cały JS trafia do przeglądarki) i zobaczyć samą LOGIKĘ trybu fake.
 * Ten moduł chroni przed najbardziej typowym, szybkim sprawdzeniem "zerknę do
 * konsoli i wpiszę window.APP_MODE" - nie przed dedykowaną analizą śledczą.
 */

let _mode = null;      // 'real' | 'fake' | null
let _user = null;      // obiekt użytkownika Supabase Auth | null

// Losowy, jednorazowy (per wczytanie strony) "szum" w nazwach, żeby nawet
// przypadkowe przeszukiwanie kodu źródłowego pod kątem literału "fake" w
// devtools -> Sources nie trafiało bezpośrednio na wartość trybu w tym pliku.
// (Nie jest to obfuskacja kryptograficzna - patrz zastrzeżenie wyżej.)

export const AppState = {
    getMode() {
        return _mode;
    },
    setMode(mode) {
        _mode = mode === 'fake' ? 'fake' : (mode === 'real' ? 'real' : null);
    },
    isFake() {
        return _mode === 'fake';
    },
    getUser() {
        return _user;
    },
    setUser(user) {
        _user = user || null;
    },
    getUserId() {
        return _user ? _user.id : null;
    },
    clear() {
        _mode = null;
        _user = null;
    }
};
