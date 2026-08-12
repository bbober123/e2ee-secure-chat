/**
 * ui.js — punkt wejścia dla warstwy UI (manipulacja DOM, renderowanie).
 *
 * Kod był kiedyś jednym obiektem UI na ~740 linii. Metody są teraz
 * pogrupowane tematycznie w folderze `ui/`:
 *
 *   ui/screens.js          — lock/auth screen, modal ustawień, otwieranie/zamykanie modali
 *   ui/friend-requests.js  — odznaka i lista próśb o znajomość
 *   ui/toasts.js           — powiadomienia (toasty)
 *   ui/skeletons.js        — placeholdery ładowania (shimmer)
 *   ui/typing.js           — wskaźnik "X pisze..."
 *   ui/messages.js         — renderowanie rozmów/wiadomości, media, _escapeHtml
 *   ui/calls.js            — nakładka połączeń głosowych/wideo
 *
 * Wszystkie moduły są łączone (spread) w jeden obiekt `UI`, dokładnie tak
 * jak wcześniej — każda metoda woła `this.inna_metoda()`, co nadal działa
 * poprawnie niezależnie od tego, w którym pliku dana metoda jest
 * zdefiniowana, bo wszystkie lądują jako własności tego samego obiektu.
 * Reszta aplikacji dalej robi `import { UI } from './ui.js'` bez zmian.
 */
import { ScreensUI } from './ui/screens.js';
import { FriendRequestsUI } from './ui/friend-requests.js';
import { ToastsUI } from './ui/toasts.js';
import { SkeletonsUI } from './ui/skeletons.js';
import { TypingUI } from './ui/typing.js';
import { MessagesUI } from './ui/messages.js';
import { CallsUI } from './ui/calls.js';

export const UI = {
    ...ScreensUI,
    ...FriendRequestsUI,
    ...ToastsUI,
    ...SkeletonsUI,
    ...TypingUI,
    ...MessagesUI,
    ...CallsUI,
};
