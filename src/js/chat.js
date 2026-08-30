/**
 * chat.js — punkt wejścia dla ChatApp (główna logika aplikacji czatu).
 *
 * Ten plik był kiedyś jedną klasą na ~1320 linii. Metody statyczne są teraz
 * pogrupowane tematycznie w folderze `chat/`:
 *
 *   chat/avatars.js                — URL awatara własnego/kontaktów
 *   chat/lifecycle.js              — start aplikacji, ładowanie kontaktów
 *   chat/realtime-subscriptions.js — kanały Realtime (profil, prośby, grupy, klucze)
 *   chat/group-friend-actions.js   — akcje UI: grupy i prośby o znajomość
 *   chat/conversations.js          — lista rozmów, otwieranie konwersacji, stan grup
 *   chat/calls.js                  — start/odbiór/zakończenie połączeń głos./wideo
 *   chat/messages-load.js          — ładowanie/odszyfrowywanie wiadomości i mediów
 *   chat/ratchet-session.js        — sesje Double Ratchet (X3DH init/odbiór)
 *   chat/send.js                   — wysyłanie tekstu / zaproszeń do gier / mediów
 *   chat/messaging-realtime.js     — kanał nowych wiadomości i "X pisze..."
 *   chat/fake-mode.js              — seedowanie wiadomości w trybie fake
 *   chat/ui-handlers.js            — podpięcie event listenerów UI
 *
 * Każdy moduł eksportuje zwykły obiekt z metodami ("mixin"). Łączymy je na
 * klasę ChatApp przez `Object.assign`, więc każda metoda dalej może wołać
 * `this.innaMetoda()` lub `this.jakisStan` — `this` to zawsze klasa ChatApp,
 * niezależnie w którym pliku metoda jest zdefiniowana. Cała reszta aplikacji
 * dalej robi `import { ChatApp } from './chat.js'` bez żadnych zmian.
 */
import { AvatarsMixin } from './chat/avatars.js';
import { LifecycleMixin } from './chat/lifecycle.js';
import { RealtimeSubscriptionsMixin } from './chat/realtime-subscriptions.js';
import { GroupFriendActionsMixin } from './chat/group-friend-actions.js';
import { ConversationsMixin } from './chat/conversations.js';
import { CallsMixin } from './chat/calls.js';
import { MessagesLoadMixin } from './chat/messages-load.js';
import { RatchetSessionMixin } from './chat/ratchet-session.js';
import { SendMixin } from './chat/send.js';
import { MessagingRealtimeMixin } from './chat/messaging-realtime.js';
import { FakeModeMixin } from './chat/fake-mode.js';
import { UiHandlersMixin } from './chat/ui-handlers.js';

export class ChatApp {
    // Stan aplikacji trzymany w RAM (współdzielony przez wszystkie mixiny powyżej).
    static activeConversation = null;
    static messageTimestamps = new Map();
    static realtimeChannel = null;
    static typingChannel = null;
    static typingHideTimer = null;
    static _lastTypingBroadcast = 0;
    static profileChannel = null;
    static contacts = new Map();
    static myPublicKey = null;
    static myAvatarUrl = null;
    static currentMessages = [];
    static ratchets = new Map();       // convId -> DoubleRatchet (stan w RAM, per konwersacja 1:1)
    static deviceFingerprint = null;
    static conversationMeta = new Map();   // convId -> { isGroup, groupId, groupName }
    static groupMembersCache = new Map();  // groupId -> Map<userId, {username, avatar_url}>
    static friendRequestsChannel = null;
    static groupJoinsChannel = null;
    static keyDistChannel = null;
}

Object.assign(
    ChatApp,
    AvatarsMixin,
    LifecycleMixin,
    RealtimeSubscriptionsMixin,
    GroupFriendActionsMixin,
    ConversationsMixin,
    CallsMixin,
    MessagesLoadMixin,
    RatchetSessionMixin,
    SendMixin,
    MessagingRealtimeMixin,
    FakeModeMixin,
    UiHandlersMixin
);
