import { supabase } from './supabase.js';
import { UI } from './ui.js';
import { keyManager, AuthManager } from './auth.js';
import { CryptoEngine, KeyTrustStore, utils } from './crypto.js';
import { CONFIG } from './config.js';
import { AppState } from './state.js';
import { MediaManager, VoiceRecorder } from './media.js';
import { CallManager } from './calls.js';
import { DoubleRatchet } from './ratchet.js';
import { IdentityVault, fetchPrekeyBundle, saveRatchetState, loadRatchetState } from './prekeys.js';
import { cachePlaintext, readCachedPlaintext } from './plaintext-cache.js';
import { groupCrypto, createGroup, joinGroupByCode } from './groups.js';
import { saveGroupState, loadGroupState, distributeOwnKeyTo, consumePendingKeyDistributions } from './groupkeys.js';
import { sendFriendRequest, listIncomingFriendRequests, listOutgoingFriendRequests, acceptFriendRequest, declineOrCancelFriendRequest } from './friends.js';

export class ChatApp {
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

    /** Awatar bieżącego użytkownika (uploadowany) albo placeholder Dicebear jako fallback. */
    static getMyAvatar() {
        return this.myAvatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${AppState.getUser().id}`;
    }

    /** Wylicza URL awatara kontaktu: nadpisanie per-kontakt > realny avatar_url usera > placeholder. */
    static resolveContactAvatar(c, nickname) {
        const override = AppState.getMode() === 'fake' ? c.fake_avatar_url : c.real_avatar_url;
        const real = c.contact_user?.avatar_url;
        const fallback = `https://api.dicebear.com/7.x/avataaars/svg?seed=${nickname}${AppState.getMode() === 'fake' ? 'Fake' : ''}`;
        return override || real || fallback;
    }

    static async init() {
        try {
            UI.renderConversationsSkeleton();
            this.deviceFingerprint = await AuthManager.generateDeviceFingerprint();
            const { data } = await supabase.from('users').select('*').eq('id', AppState.getUser().id).single();
            const keyStr = AppState.getMode() === 'fake' ? data.public_key_fake : data.public_key_real;
            this.myPublicKey = await crypto.subtle.importKey("jwk", JSON.parse(keyStr), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
            this.myAvatarUrl = data.avatar_url || null;

            await this.loadContacts();
            await this.loadConversations();
            this.setupUIHandlers();
            this.subscribeToProfileUpdates();
            this.subscribeToFriendRequests();
            this.subscribeToGroupJoins();
            this.subscribeToKeyDistributions();
            await this.refreshFriendRequestsBadge();

            // Odbierz od razu wszystkie zaległe pakiety dystrybucji kluczy grupowych
            // (np. ktoś dołączył/wypchnął klucz, gdy byliśmy offline).
            const touchedGroups = await consumePendingKeyDistributions(AppState.getUser().id, AppState.getMode(), groupCrypto, keyManager.identityVault);
            for (const groupId of touchedGroups) {
                await saveGroupState(AppState.getUser().id, groupId, AppState.getMode(), groupCrypto, keyManager.passwordKey);
            }

            window.addEventListener('conversation-selected', (e) => {
                this.openConversation(e.detail.convId, e.detail.contactId, e.detail.isGroup, e.detail.groupId);
            });
            window.addEventListener('open-friend-requests', () => this.openFriendRequestsModal());
            
            document.getElementById('current-username').textContent = AppState.getMode() === 'fake' ? 'Prywatny Tryb' : data.username;

            const myAvatarImg = document.getElementById('my-avatar-img');
            if (myAvatarImg) {
                myAvatarImg.src = this.getMyAvatar();
            }
        } catch (err) {
            console.error("Init error", err);
            UI.showToast("Błąd inicjalizacji czatu", "error");
        }
    }

    /**
     * Wywoływane zaraz po zmianie własnego awatara (ProfileManager.updateAvatar),
     * żeby natychmiast odświeżyć wszystkie miejsca w UI, które go pokazują,
     * bez przeładowania strony.
     */
    static updateMyAvatar(url) {
        this.myAvatarUrl = url;
        const myAvatarImg = document.getElementById('my-avatar-img');
        if (myAvatarImg) myAvatarImg.src = url;

        this.currentMessages.forEach(m => {
            if (m.authorId === AppState.getUser().id) m.avatar = url;
        });
        if (this.currentMessages.length) UI.renderMessages(this.currentMessages);
    }

    static async loadContacts() {
        const { data, error } = await supabase.from('contacts').select('*, contact_user:contact_user_id(username, public_key_real, public_key_fake, avatar_url)');
        if (error) throw error;
        
        this.contacts.clear();
        data.forEach(c => {
            const nickname = AppState.getMode() === 'fake' ? (c.fake_nickname || c.contact_user.username) : (c.real_nickname || c.contact_user.username);
            this.contacts.set(c.contact_user_id, {
                ...c,
                display_name: nickname,
                public_key_real: c.contact_user.public_key_real,
                public_key_fake: c.contact_user.public_key_fake,
                avatar: this.resolveContactAvatar(c, nickname)
            });
        });
    }

    /**
     * Nasłuchuje na żywo zmian w tabeli users (np. inny użytkownik zmienia swój awatar)
     * i odświeża go u wszystkich, którzy mają go w kontaktach - bez odświeżania strony.
     * Wymaga dodania tabeli `users` do publikacji `supabase_realtime` w Supabase (patrz database.sql).
     */
    static subscribeToProfileUpdates() {
        if (this.profileChannel) supabase.removeChannel(this.profileChannel);

        this.profileChannel = supabase.channel('profile-avatar-updates')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'users' }, (payload) => {
                const updated = payload.new;
                if (!updated || updated.id === AppState.getUser().id) return;

                const contact = this.contacts.get(updated.id);
                if (!contact) return;

                contact.contact_user = { ...contact.contact_user, avatar_url: updated.avatar_url };
                contact.avatar = this.resolveContactAvatar(contact, contact.display_name);

                this.loadConversations();
                if (this.activeConversation?.contactId === updated.id) {
                    this.currentMessages.forEach(m => {
                        if (m.authorId === updated.id) m.avatar = contact.avatar;
                    });
                    UI.renderMessages(this.currentMessages);
                }
            })
            .subscribe();
    }

    /** Prośby o znajomość skierowane DO mnie - na żywo pokazują toast + odświeżają badge na przycisku "+". */
    static subscribeToFriendRequests() {
        if (this.friendRequestsChannel) supabase.removeChannel(this.friendRequestsChannel);

        this.friendRequestsChannel = supabase.channel('friend-requests-incoming')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friend_requests', filter: `to_user_id=eq.${AppState.getUser().id}` }, async () => {
                UI.showToast('Nowa prośba o znajomość!', 'success');
                await this.refreshFriendRequestsBadge();
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'friend_requests' }, async () => {
                await this.refreshFriendRequestsBadge();
            })
            .subscribe();
    }

    static async refreshFriendRequestsBadge() {
        try {
            const incoming = await listIncomingFriendRequests();
            UI.setFriendRequestsBadge(incoming.length);
        } catch (e) {
            console.error('Nie udało się odświeżyć liczby próśb o znajomość', e);
        }
    }

    /**
     * Gdy KTOŚ INNY dołączy (na żywo) do grupy, w której już jestem - jeśli mam
     * własny Sender Key dla tej grupy, wypycham go nowemu członkowi pairwise
     * (patrz groupkeys.js). Dzięki temu nowy członek może odczytać moje wiadomości
     * bez konieczności czekania, aż sam otworzy ze mną osobną rozmowę.
     */
    static subscribeToGroupJoins() {
        if (this.groupJoinsChannel) supabase.removeChannel(this.groupJoinsChannel);

        this.groupJoinsChannel = supabase.channel('group-members-joins')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_members' }, async (payload) => {
                const joined = payload.new;
                if (!joined || joined.user_id === AppState.getUser().id) return;
                if (!groupCrypto.hasOwnChain(joined.group_id)) return; // nie mam jeszcze/w ogóle klucza dla tej grupy w tym trybie

                try {
                    await distributeOwnKeyTo(joined.group_id, AppState.getMode(), AppState.getUser().id, joined.user_id, groupCrypto, keyManager.identityVault);
                } catch (e) {
                    console.warn('Nie udało się wypchnąć klucza grupowego nowemu członkowi', e);
                }

                this.groupMembersCache.delete(joined.group_id); // wymuś odświeżenie listy nazw przy następnym otwarciu
            })
            .subscribe();
    }

    /** Pakiety dystrybucji klucza grupowego skierowane do mnie - odbierane na żywo, bez czekania na kolejne otwarcie apki. */
    static subscribeToKeyDistributions() {
        if (this.keyDistChannel) supabase.removeChannel(this.keyDistChannel);

        this.keyDistChannel = supabase.channel('group-key-messages-incoming')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_key_messages', filter: `to_user_id=eq.${AppState.getUser().id}` }, async () => {
                const touched = await consumePendingKeyDistributions(AppState.getUser().id, AppState.getMode(), groupCrypto, keyManager.identityVault);
                for (const groupId of touched) {
                    await saveGroupState(AppState.getUser().id, groupId, AppState.getMode(), groupCrypto, keyManager.passwordKey);
                }
            })
            .subscribe();
    }

    // -----------------------------------------------------------------
    // Akcje wywoływane z UI: grupy i prośby o znajomość
    // -----------------------------------------------------------------

    static async createGroupAction(name) {
        if (!name || !name.trim()) return;
        try {
            const { group } = await createGroup(name);
            UI.showToast(`Grupa "${group.name}" utworzona! Kod dołączenia: ${group.join_code}`, 'success');
            UI.closeAllMenusAndModals();
            await this.loadConversations();
        } catch (e) {
            console.error(e);
            UI.showToast(e.message || 'Nie udało się utworzyć grupy.', 'error');
        }
    }

    static async joinGroupAction(creatorUsername, code) {
        if (!creatorUsername || !code) return;
        try {
            const { groupName } = await joinGroupByCode(creatorUsername, code);
            UI.showToast(`Dołączono do grupy "${groupName}"!`, 'success');
            UI.closeAllMenusAndModals();
            await this.loadConversations();
        } catch (e) {
            console.error(e);
            UI.showToast(e.message || 'Nie udało się dołączyć do grupy.', 'error');
        }
    }

    static async sendFriendRequestAction(username, realNick, fakeNick) {
        if (!username) return;
        try {
            await sendFriendRequest(username, realNick, fakeNick);
            UI.showToast('Prośba o znajomość wysłana!', 'success');
            UI.closeAllMenusAndModals();
        } catch (e) {
            UI.showToast(e.message || 'Nie udało się wysłać prośby.', 'error');
        }
    }

    static async openFriendRequestsModal() {
        try {
            const [incoming, outgoing] = await Promise.all([listIncomingFriendRequests(), listOutgoingFriendRequests()]);
            UI.renderFriendRequests(incoming, outgoing);
            UI.showModal('friend-requests-modal');
        } catch (e) {
            UI.showToast('Nie udało się wczytać próśb o znajomość.', 'error');
        }
    }

    static async acceptFriendRequestAction(requestId) {
        try {
            await acceptFriendRequest(requestId);
            UI.showToast('Znajomość zaakceptowana!', 'success');
            await this.loadContacts();
            await this.loadConversations();
            await this.refreshFriendRequestsBadge();
            await this.openFriendRequestsModal();
        } catch (e) {
            UI.showToast(e.message || 'Nie udało się zaakceptować prośby.', 'error');
        }
    }

    static async declineFriendRequestAction(requestId) {
        try {
            await declineOrCancelFriendRequest(requestId);
            await this.refreshFriendRequestsBadge();
            await this.openFriendRequestsModal();
        } catch (e) {
            UI.showToast('Nie udało się usunąć prośby.', 'error');
        }
    }

    static async loadConversations() {
        const { data: convs, error } = await supabase.from('conversations')
            .select('*, groups(name), messages(id, ciphertext, timestamp, mode)')
            .order('updated_at', { ascending: false });
            
        if (error) {
            console.error("Load conv err", error);
            return;
        }

        this.conversationMeta.clear();

        const uiConvs = convs.map(c => {
            const modeMsgs = c.messages ? c.messages.filter(m => m.mode === AppState.getMode()).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)) : [];
            const lastMsg = modeMsgs.length > 0 ? modeMsgs[0] : null;
            const time = lastMsg ? new Date(lastMsg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
            const lastMessage = lastMsg ? 'Zaszyfrowana wiadomość' : 'Brak wiadomości';

            if (c.type === 'group') {
                const groupName = c.groups?.name || 'Grupa';
                this.conversationMeta.set(c.id, { isGroup: true, groupId: c.group_id, groupName });
                return {
                    id: c.id,
                    isGroup: true,
                    groupId: c.group_id,
                    contactId: null,
                    nickname: `👥 ${groupName}`,
                    avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=group-${c.group_id}`,
                    time,
                    lastMessage
                };
            }

            const otherId = c.participant_ids.find(id => id !== AppState.getUser().id) || AppState.getUser().id;
            const contact = this.contacts.get(otherId) || { display_name: 'Nieznany', avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${otherId}` };
            this.conversationMeta.set(c.id, { isGroup: false, contactId: otherId });

            return {
                id: c.id,
                isGroup: false,
                contactId: otherId,
                nickname: contact.display_name,
                avatar: contact.avatar,
                time,
                lastMessage
            };
        });

        UI.renderConversations(uiConvs, this.activeConversation?.id);
    }

    static async openConversation(convId, contactId, isGroup = false, groupId = null) {
        // Zwolnij blob: URL-e odszyfrowanych mediów z poprzednio otwartej rozmowy -
        // inaczej przy częstym przełączaniu konwersacji przeglądarka gromadzi w pamięci
        // coraz więcej niezwolnionych obiektów (zdjęcia/filmy/głosówki nigdy nie giną z RAM).
        this.revokeMediaUrls(this.currentMessages);

        const meta = this.conversationMeta.get(convId);
        isGroup = isGroup || meta?.isGroup || false;
        groupId = groupId || meta?.groupId || null;

        this.activeConversation = { id: convId, contactId, isGroup, groupId };

        UI.hideTypingIndicator();
        UI.renderMessagesSkeleton();

        if (isGroup) {
            await this.ensureGroupState(groupId);
            await this.loadGroupMembers(groupId);
        }

        const audioCallBtn = document.getElementById('start-audio-call-btn');
        const videoCallBtn = document.getElementById('start-video-call-btn');
        if (audioCallBtn) audioCallBtn.style.display = isGroup ? 'none' : '';
        if (videoCallBtn) videoCallBtn.style.display = isGroup ? 'none' : '';

        await this.loadMessages(convId);
        this.subscribeToMessages(convId);
        this.subscribeToTyping(convId);

        if (!isGroup) {
            this.subscribeToCalls(convId);
            if (AppState.getMode() === 'fake') {
                await this.ensureFakeMessages(convId, contactId);
            }
        }
    }

    /** Upewnia się, że mamy w RAM stan Sender Keys tej grupy (ładuje z zaszyfrowanego zapisu, jeśli trzeba) i konsumuje zaległe dystrybucje. */
    static async ensureGroupState(groupId) {
        const userId = AppState.getUser().id;
        const mode = AppState.getMode();

        if (!groupCrypto.hasOwnChain(groupId)) {
            await loadGroupState(userId, groupId, mode, groupCrypto, keyManager.passwordKey);
        }
        if (!groupCrypto.hasOwnChain(groupId)) {
            console.warn('Brak lokalnego stanu Sender Keys dla tej grupy (dołączono na innym urządzeniu?) - wysyłanie będzie niedostępne.');
        }

        const touched = await consumePendingKeyDistributions(userId, mode, groupCrypto, keyManager.identityVault);
        if (touched.length) {
            for (const gId of touched) await saveGroupState(userId, gId, mode, groupCrypto, keyManager.passwordKey);
        }
    }

    /** Pobiera (i cache'uje) listę członków grupy do wyświetlania nazw autorów wiadomości. */
    static async loadGroupMembers(groupId) {
        if (this.groupMembersCache.has(groupId)) return this.groupMembersCache.get(groupId);

        const { data } = await supabase.from('group_members')
            .select('user_id, users:user_id(username, avatar_url)')
            .eq('group_id', groupId);

        const map = new Map();
        (data || []).forEach(row => {
            map.set(row.user_id, { username: row.users?.username || 'Nieznany', avatar_url: row.users?.avatar_url || null });
        });
        this.groupMembersCache.set(groupId, map);
        return map;
    }

    /** Zwalnia blob: URL-e (URL.createObjectURL) trzymane przez wiadomości medialne, żeby uniknąć wycieku pamięci. */
    static revokeMediaUrls(messages) {
        (messages || []).forEach(m => {
            if (m.mediaUrl && m.mediaUrl.startsWith('blob:')) {
                try { URL.revokeObjectURL(m.mediaUrl); } catch (e) { /* noop */ }
            }
        });
    }

    /** Nasłuchuje przychodzących połączeń głosowych/wideo dla aktywnej konwersacji. */
    static subscribeToCalls(convId) {
        CallManager.subscribe(convId, {
            onIncomingCall: ({ from, isVideo }) => {
                const contact = this.contacts.get(from);
                UI.showIncomingCall({
                    name: contact ? contact.display_name : 'Nieznany kontakt',
                    avatar: contact ? contact.avatar : '',
                    isVideo,
                    onAccept: () => this.answerCall(),
                    onReject: () => this.declineCall()
                });
            },
            onRemoteStream: (stream, isVideo) => UI.setRemoteCallStream(stream, isVideo),
            onActive: () => UI.setCallActive(),
            onEnded: (reason) => {
                UI.hideCallUI();
                const messages = {
                    hangup: 'Połączenie zakończone.',
                    reject: 'Połączenie odrzucone.',
                    busy: 'Kontakt jest zajęty na innej rozmowie.',
                    'connection-lost': 'Połączenie przerwane.'
                };
                UI.showToast(messages[reason] || 'Połączenie zakończone.', 'success');
            }
        });
    }

    static async startCall(isVideo) {
        if (!this.activeConversation) return;
        const contact = this.contacts.get(this.activeConversation.contactId);
        if (!contact) return;
        try {
            const { localStream } = await CallManager.startCall({
                convId: this.activeConversation.id,
                contact,
                myPublicKey: this.myPublicKey,
                isVideo
            });
            UI.showOutgoingCall({ name: contact.display_name, avatar: contact.avatar, isVideo, localStream, onCancel: () => this.endCall() });
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    static async answerCall() {
        try {
            const { localStream } = await CallManager.acceptCall({
                myPrivateKey: keyManager.myPrivateKey,
                myPublicKey: this.myPublicKey
            });
            UI.setLocalCallStream(localStream, CallManager.currentCall?.isVideo);
            UI.setCallActive();
        } catch (e) {
            UI.showToast(e.message, 'error');
            UI.hideCallUI();
        }
    }

    static declineCall() {
        CallManager.rejectCall();
        UI.hideCallUI();
    }

    static endCall() {
        CallManager.hangup();
        UI.hideCallUI();
    }

    /** Wywoływane przy wylogowaniu / auto-blokadzie - nie zostawiamy "wiszącego" połączenia z otwartym mikrofonem/kamerą. */
    static endActiveCallIfAny() {
        if (CallManager.state !== 'idle') {
            CallManager.hangup();
        }
        CallManager.unsubscribe();
        UI.hideCallUI();
        this.revokeMediaUrls(this.currentMessages);
    }

    static async loadMessages(convId) {
        const { data: msgs, error } = await supabase.from('messages')
            .select('*')
            .eq('conversation_id', convId)
            .eq('mode', AppState.getMode())
            .order('timestamp', { ascending: false })
            .limit(50);
            
        if (error) throw error;
        
        this.currentMessages = [];
        for (const msg of msgs) {
            const dec = await this.decryptMessageRow(msg);
            this.currentMessages.push(dec);
        }
        UI.renderMessages(this.currentMessages);
        // Zdjęcia ładujemy od razu (jak w typowych komunikatorach) - filmy/głosówki
        // pozostają "na żądanie" (kliknięcie), żeby nie ściągać niepotrzebnie dużych plików.
        this.currentMessages.filter(m => m.type === 'image').forEach(m => this.loadMediaContent(m.id));
    }

    /**
     * UWAGA ARCHITEKTONICZNA (Double Ratchet): klucze wiadomości są jednorazowe i
     * usuwane natychmiast po (pierwszym) użyciu — to fundament forward secrecy.
     * Oznacza to, że NIE da się ponownie odszyfrować ciphertextu z bazy danych
     * po tym, jak został już raz odszyfrowany (ani własnych wysłanych wiadomości —
     * ratchet w ogóle nie potrafi deszyfrować własnego kierunku wysyłania).
     * Dlatego, dokładnie jak w Signal/WhatsApp, treść jest deszyfrowana z serwera
     * TYLKO RAZ, a potem trzymana lokalnie (tu: IndexedDB, zaszyfrowana kluczem z
     * hasła) - patrz src/js/plaintext-cache.js. Serwer nadal przechowuje wyłącznie
     * ciphertext; cache lokalny nie zmienia modelu zaufania serwera, tylko
     * pozwala użytkownikowi ponownie zobaczyć TO, CO JUŻ RAZ ZOSTAŁO ODSZYFROWANE
     * na tym urządzeniu.
     */
    static async decryptMessageRow(msg) {
        const type = msg.type || 'text';
        const isMe = msg.sender_id === AppState.getUser().id;
        const meta = this.conversationMeta.get(msg.conversation_id);
        const isGroup = !!meta?.isGroup;
        let text = "[Nie można odszyfrować na tym urządzeniu]";
        let mediaMeta = null;
        let fileKeyRaw = null;
        const aad = CryptoEngine.buildAAD(msg.conversation_id, msg.sender_id, msg.mode);

        try {
            let plaintext = await readCachedPlaintext(AppState.getUser().id, msg.mode, msg.id, keyManager.passwordKey);

            if (plaintext === null) {
                if (isMe) {
                    // Nasza własna wiadomość, ale brak lokalnego cache (np. inne urządzenie
                    // albo wyczyszczony IndexedDB) - z Double Ratchet/Sender Keys nie da się jej odzyskać.
                    throw new Error('Brak lokalnej kopii własnej wysłanej wiadomości (inne urządzenie / wyczyszczony cache).');
                }
                if (isGroup) {
                    plaintext = await groupCrypto.decrypt(meta.groupId, msg.sender_id, msg.ciphertext, msg.nonce, msg.header);
                    await saveGroupState(AppState.getUser().id, meta.groupId, msg.mode, groupCrypto, keyManager.passwordKey);
                } else {
                    const ratchet = await this.getOrBootstrapIncomingRatchet(msg.conversation_id, msg.header);
                    plaintext = await ratchet.decrypt(msg.ciphertext, msg.nonce, msg.header);
                    await this.persistRatchet(msg.conversation_id, ratchet);
                }
                await cachePlaintext(AppState.getUser().id, msg.mode, msg.id, plaintext, keyManager.passwordKey);
            }

            if (type === 'text') {
                text = plaintext;
            } else {
                mediaMeta = JSON.parse(plaintext);
                fileKeyRaw = utils.base64ToBuffer(mediaMeta.fileKey);
                text = '';
            }

            if (msg.status !== 'read' && !isMe) {
                supabase.from('messages').update({ status: 'read' }).eq('id', msg.id).then();
            }
        } catch (e) {
            console.error("Decrypt error", e);
        }

        let authorName, avatar;
        if (isMe) {
            authorName = 'Ja';
            avatar = this.getMyAvatar();
        } else if (isGroup) {
            const member = this.groupMembersCache.get(meta.groupId)?.get(msg.sender_id);
            authorName = member?.username || 'Nieznany';
            avatar = member?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${msg.sender_id}`;
        } else {
            const contact = this.contacts.get(msg.sender_id);
            authorName = contact ? contact.display_name : 'Nieznany';
            avatar = contact ? contact.avatar : '';
        }

        return {
            id: msg.id,
            authorId: msg.sender_id,
            authorName,
            avatar,
            timestamp: msg.timestamp,
            status: msg.status,
            type,
            text,
            mediaMeta,
            mediaState: type === 'text' ? null : 'idle', // idle | loading | ready | error
            mediaUrl: null,
            _mediaRaw: (type === 'text' || !fileKeyRaw) ? null : {
                media_path: msg.media_path,
                media_nonce: msg.media_nonce,
                fileKeyRaw,
                aad
            }
        };
    }

    /**
     * Leniwe pobranie i deszyfrowanie treści wiadomości medialnej (na żądanie
     * użytkownika - kliknięcie odtwórz/pokaż, albo automatycznie dla miniatur
     * zdjęć w renderMessages). Aktualizuje obiekt wiadomości w miejscu i
     * ponownie renderuje listę.
     */
    static async loadMediaContent(msgId) {
        const msg = this.currentMessages.find(m => m.id === msgId);
        if (!msg || msg.type === 'text' || msg.mediaState === 'ready' || msg.mediaState === 'loading') return;
        if (!msg._mediaRaw) {
            msg.mediaState = 'error';
            UI.renderMessages(this.currentMessages);
            return;
        }

        msg.mediaState = 'loading';
        UI.renderMessages(this.currentMessages);

        try {
            // Klucz pliku jest efemeryczny, jednorazowy per wiadomość — wygenerowany przy
            // wysyłce (sendMedia) i przekazany odbiorcy WEWNĄTRZ ratchet-owanych metadanych
            // (patrz mediaMeta.fileKey), a nie owinięty RSA jak poprzednio.
            const fileKey = await crypto.subtle.importKey('raw', msg._mediaRaw.fileKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
            const { blobUrl } = await MediaManager.downloadAndDecryptWithKey({
                media_path: msg._mediaRaw.media_path,
                media_nonce: msg._mediaRaw.media_nonce,
                sessionKey: fileKey,
                aad: msg._mediaRaw.aad,
                mime: msg.mediaMeta?.mime
            });
            msg.mediaUrl = blobUrl;
            msg.mediaState = 'ready';
        } catch (e) {
            console.error('Media decrypt error', e);
            msg.mediaState = 'error';
        }
        UI.renderMessages(this.currentMessages);
    }

    static checkRateLimit(convId) {
        const now = Date.now();
        const times = this.messageTimestamps.get(convId) || [];
        const recent = times.filter(t => now - t < 60000);
        if (recent.length >= CONFIG.MESSAGE_RATE_LIMIT) return false;
        recent.push(now);
        this.messageTimestamps.set(convId, recent);
        return true;
    }

    /**
     * Zwraca (z RAM, albo odtworzony z zaszyfrowanego stanu w bazie) DoubleRatchet
     * dla tej konwersacji, jeśli już istnieje sesja. Zwraca null, jeśli jeszcze
     * nigdy nie wysłaliśmy ani nie odebraliśmy wiadomości w tej rozmowie/trybie
     * na TYM urządzeniu (trzeba dopiero zainicjować X3DH).
     */
    static async getExistingRatchet(convId) {
        if (this.ratchets.has(convId)) return this.ratchets.get(convId);
        if (!keyManager.passwordKey) return null;
        const ratchet = await loadRatchetState(AppState.getUser().id, convId, AppState.getMode(), this.deviceFingerprint, keyManager.passwordKey);
        if (ratchet) this.ratchets.set(convId, ratchet);
        return ratchet;
    }

    static async persistRatchet(convId, ratchet) {
        try {
            await saveRatchetState(AppState.getUser().id, convId, AppState.getMode(), this.deviceFingerprint, ratchet, keyManager.passwordKey);
        } catch (e) {
            console.error('Nie udało się zapisać stanu ratchetu', e);
        }
    }

    /**
     * Zwraca sesję gotową do WYSYŁANIA. Jeśli nie istnieje jeszcze żadna sesja z
     * tym kontaktem (na tym urządzeniu/w tym trybie), wykonuje X3DH jako
     * inicjator, pobierając bundle kontaktu (IK/SPK/OPK) z serwera i weryfikując
     * podpis SPK (patrz fetchPrekeyBundle w prekeys.js). Zwraca null (pokazując
     * toast) jeśli TOFU wykrył zmianę tożsamości kontaktu i użytkownik anulował.
     */
    static async prepareOutgoingRatchet(convId, contactId) {
        let ratchet = await this.getExistingRatchet(convId);
        if (ratchet) return ratchet;

        if (!keyManager.identityVault) {
            UI.showToast("To konto nie ma jeszcze kluczy X3DH (założone przed aktualizacją). Zarejestruj nowe konto.", "error");
            return null;
        }

        const contact = this.contacts.get(contactId);
        const mode = AppState.getMode();

        let bundle;
        try {
            bundle = await fetchPrekeyBundle(contactId, mode);
        } catch (e) {
            UI.showToast(e.message, "error");
            return null;
        }
        if (!bundle) {
            UI.showToast(`Kontakt "${contact.display_name}" nie ma jeszcze opublikowanych kluczy szyfrujących.`, "error");
            return null;
        }

        // TOFU: fingerprint tożsamości kontaktu (Identity Key, nie efemeryczny SPK/OPK) —
        // ten sam mechanizm co poprzednio dla RSA, teraz nad ik zamiast public_key_real/fake.
        const trust = await KeyTrustStore.verify(AppState.getUser().id, contactId, mode, JSON.stringify(bundle.ikPubJwk));
        if (trust.status === 'changed') {
            const proceed = window.confirm(
                "⚠️ UWAGA BEZPIECZEŃSTWA\n\n" +
                `Klucz tożsamości kontaktu "${contact.display_name}" zmienił się od ostatniej rozmowy.\n\n` +
                "To może oznaczać, że kontakt zainstalował aplikację na nowym urządzeniu — ALE może też " +
                "oznaczać próbę przechwycenia wiadomości (atak man-in-the-middle).\n\n" +
                "Jeśli nie potwierdziłeś/aś tej zmiany z kontaktem innym kanałem (np. telefonicznie), " +
                "zalecamy anulowanie.\n\n" +
                "Nowy fingerprint klucza:\n" + trust.fingerprint + "\n\n" +
                "Kontynuować wysyłanie i zaufać nowemu kluczowi?"
            );
            if (!proceed) {
                UI.showToast("Wysyłanie anulowane — klucz kontaktu się zmienił", "error");
                return null;
            }
            KeyTrustStore.trustNewKey(AppState.getUser().id, contactId, mode, trust.fingerprint);
        }

        const { identityPriv, identityPubJwk } = await IdentityVault.importUsableKeys(keyManager.identityVault);
        ratchet = new DoubleRatchet();
        const { x3dhHeader } = await ratchet.initAsInitiator({ identityPriv, identityPubJwk, bundle });
        ratchet._pendingX3dhHeader = x3dhHeader; // dołączany TYLKO do pierwszej wychodzącej wiadomości

        this.ratchets.set(convId, ratchet);
        return ratchet;
    }

    /** Szyfruje plaintext ratchetem i dokleja nagłówek X3DH, jeśli to pierwsza wychodząca wiadomość tej sesji. */
    static async encryptOutgoing(ratchet, plaintext) {
        const enc = await ratchet.encrypt(plaintext);
        if (ratchet._pendingX3dhHeader) {
            const headerObj = JSON.parse(enc.headerJson);
            headerObj.x3dh = ratchet._pendingX3dhHeader;
            enc.headerJson = JSON.stringify(headerObj);
            delete ratchet._pendingX3dhHeader;
        }
        return enc;
    }

    /**
     * Zwraca sesję gotową do ODBIERANIA wiadomości o danym nagłówku. Jeśli nagłówek
     * niesie pole `x3dh` (PIERWSZA wiadomość nowej sesji od inicjatora) i jeszcze nie
     * mamy stanu, bootstrapuje ratchet jako odbiorca (X3DH-responder) korzystając
     * z własnego IK oraz SPK/OPK z lokalnego vaulta (dopasowanych po id z nagłówka).
     */
    static async getOrBootstrapIncomingRatchet(convId, headerJson) {
        let ratchet = await this.getExistingRatchet(convId);
        if (ratchet) return ratchet;

        const header = JSON.parse(headerJson);
        if (!header.x3dh) {
            throw new Error('Brak stanu ratchetu i nagłówek nie zawiera danych X3DH — nie da się odszyfrować.');
        }
        if (!keyManager.identityVault) {
            throw new Error('Brak lokalnych kluczy X3DH do zbootstrapowania sesji odbiorczej.');
        }

        const vault = keyManager.identityVault;
        const identityPriv = await crypto.subtle.importKey('jwk', vault.identityDh.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

        if (vault.spk.id !== header.x3dh.spkId) {
            // SPK już zrotowany od czasu wysłania — w tej wersji trzymamy tylko bieżący SPK w vaulcie.
            throw new Error('Wiadomość odwołuje się do już zrotowanego Signed Prekey — nie można zainicjować sesji.');
        }
        const spkPrivateKey = await crypto.subtle.importKey('jwk', vault.spk.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const spkKeyPair = { publicKey: await crypto.subtle.importKey('jwk', vault.spk.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []), privateKey: spkPrivateKey, publicJwk: vault.spk.publicJwk, privateJwk: vault.spk.privateJwk };

        let opkPriv = null;
        if (header.x3dh.opkId != null) {
            const opkEntry = vault.opks.find(o => o.id === header.x3dh.opkId);
            if (opkEntry) {
                opkPriv = await crypto.subtle.importKey('jwk', opkEntry.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
                // Jednorazowe: usuń lokalnie po użyciu (serwer już oznaczył used=true przy claim_one_time_prekey).
                vault.opks = vault.opks.filter(o => o.id !== header.x3dh.opkId);
            }
        }

        ratchet = new DoubleRatchet();
        await ratchet.initAsResponder({ identityPriv, spkKeyPair, opkPriv, x3dh: header.x3dh });
        this.ratchets.set(convId, ratchet);
        return ratchet;
    }

    static async sendMessage(text) {
        if (!this.activeConversation) return;
        const convId = this.activeConversation.id;
        const contactId = this.activeConversation.contactId;

        // Wymuszenie limitu długości wiadomości (obrona przed nadużyciem/DoS na przechowywanie).
        if (text.length > CONFIG.MAX_MESSAGE_LENGTH) {
            UI.showToast(`Wiadomość jest za długa (maks. ${CONFIG.MAX_MESSAGE_LENGTH} znaków)`, "error");
            return;
        }

        if (!this.checkRateLimit(convId)) {
            UI.showToast("Zwolnij — wysyłasz za szybko", "error");
            document.getElementById('send-button').disabled = true;
            setTimeout(() => document.getElementById('send-button').disabled = false, 10000);
            return;
        }

        UI.setSendStatus('sending');

        const isGroup = this.activeConversation.isGroup;
        const groupId = this.activeConversation.groupId;

        try {
            let ratchet = null, encMsg;
            if (isGroup) {
                if (!groupCrypto.hasOwnChain(groupId)) {
                    UI.showToast('Brak lokalnego klucza nadawczego tej grupy — spróbuj otworzyć rozmowę ponownie.', 'error');
                    UI.setSendStatus('error');
                    return;
                }
                encMsg = await groupCrypto.encrypt(groupId, text);
            } else {
                ratchet = await this.prepareOutgoingRatchet(convId, contactId);
                if (!ratchet) { UI.setSendStatus('error'); return; }
                encMsg = await this.encryptOutgoing(ratchet, text);
            }

            const tempMsg = {
                id: 'temp-' + Date.now(),
                authorId: AppState.getUser().id,
                authorName: 'Ja',
                avatar: this.getMyAvatar(),
                timestamp: new Date().toISOString(),
                status: 'sending',
                type: 'text',
                text: text
            };
            this.currentMessages.unshift(tempMsg);
            UI.renderMessages(this.currentMessages);
            this.stopTypingBroadcast();

            const { data: inserted, error } = await supabase.from('messages').insert({
                conversation_id: convId,
                sender_id: AppState.getUser().id,
                ciphertext: encMsg.ciphertextBase64,
                nonce: encMsg.nonceBase64,
                header: encMsg.headerJson,
                mode: AppState.getMode(),
                type: 'text',
                status: 'delivered'
            }).select().single();
            
            if (error) {
                UI.showToast("Brak połączenia — wiadomość zostanie wysłana później", "error");
                tempMsg.status = 'error';
                tempMsg.sendError = true;
                UI.renderMessages(this.currentMessages);
                throw error;
            }

            // Persystuj stan łańcucha (przetrwa F5) i zachowaj lokalną kopię jawnego tekstu -
            // to JEDYNY sposób, żeby zobaczyć własną wysłaną wiadomość później: ani Double
            // Ratchet, ani Sender Keys nie pozwalają odszyfrować własnego kierunku wysyłania
            // z samego ciphertextu na serwerze (patrz komentarz przy ChatApp.decryptMessageRow).
            if (isGroup) {
                await saveGroupState(AppState.getUser().id, groupId, AppState.getMode(), groupCrypto, keyManager.passwordKey);
            } else {
                await this.persistRatchet(convId, ratchet);
            }
            await cachePlaintext(AppState.getUser().id, AppState.getMode(), inserted.id, text, keyManager.passwordKey);

            // Podmień optymistyczną wiadomość na prawdziwą (finalne id + status z serwera),
            // z małym opóźnieniem żeby animacja "wysłano" (pop na przycisku) była widoczna.
            tempMsg.id = inserted.id;
            tempMsg.status = inserted.status;
            UI.setSendStatus('sent');
            UI.renderMessages(this.currentMessages);

            await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
            this.loadConversations();
        } catch (err) {
            console.error(err);
            UI.setSendStatus('error');
        }
    }

    /**
     * Wysyła wiadomość medialną (zdjęcie/film/głosówkę). `file` to obiekt File
     * (z <input type=file> albo z VoiceRecorder.stop()). `durationSeconds` -
     * tylko dla głosówek/filmów, opcjonalne.
     */
    static async sendMedia(file, durationSeconds = null) {
        if (!this.activeConversation) return;
        const convId = this.activeConversation.id;
        const contactId = this.activeConversation.contactId;

        let type;
        try {
            type = MediaManager.validateFile(file);
        } catch (e) {
            UI.showToast(e.message, "error");
            return;
        }

        if (!this.checkRateLimit(convId)) {
            UI.showToast("Zwolnij — wysyłasz za szybko", "error");
            return;
        }

        const tempId = 'temp-' + Date.now();
        const localPreviewUrl = (type === 'image' || type === 'video') ? URL.createObjectURL(file) : null;
        const tempMsg = {
            id: tempId,
            authorId: AppState.getUser().id,
            authorName: 'Ja',
            avatar: this.getMyAvatar(),
            timestamp: new Date().toISOString(),
            status: 'sending',
            type,
            text: '',
            mediaMeta: { name: file.name, mime: file.type, size: file.size, duration: durationSeconds },
            mediaState: 'ready',
            mediaUrl: localPreviewUrl
        };
        this.currentMessages.unshift(tempMsg);
        UI.renderMessages(this.currentMessages);
        UI.showToast('Szyfrowanie i wysyłanie pliku…', 'success');

        const isGroup = this.activeConversation.isGroup;
        const groupId = this.activeConversation.groupId;

        try {
            let ratchet = null;
            if (isGroup) {
                if (!groupCrypto.hasOwnChain(groupId)) {
                    UI.showToast('Brak lokalnego klucza nadawczego tej grupy — spróbuj otworzyć rozmowę ponownie.', 'error');
                    tempMsg.status = 'error';
                    tempMsg.sendError = true;
                    UI.renderMessages(this.currentMessages);
                    return;
                }
            } else {
                ratchet = await this.prepareOutgoingRatchet(convId, contactId);
                if (!ratchet) {
                    tempMsg.status = 'error';
                    tempMsg.sendError = true;
                    UI.renderMessages(this.currentMessages);
                    return;
                }
            }

            // Świeży, jednorazowy klucz AES-256-GCM TYLKO dla tego pliku (analogicznie do
            // tego, jak Signal szyfruje załączniki) - podróżuje do odbiorcy WEWNĄTRZ
            // treści wiadomości ratchetu/Sender Key, więc korzysta z tych samych gwarancji
            // forward secrecy co tekst.
            const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
            const fileKeyRaw = await crypto.subtle.exportKey('raw', fileKey);
            const aad = CryptoEngine.buildAAD(convId, AppState.getUser().id, AppState.getMode());

            const messageId = crypto.randomUUID();
            const uploadResult = await MediaManager.encryptAndUpload({
                file, type, conversationId: convId, messageId, sessionKey: fileKey, aad, durationSeconds
            });

            const metaPayload = JSON.stringify({
                name: MediaManager.sanitizeFileName(file.name || `${type}-${Date.now()}`),
                mime: file.type || 'application/octet-stream',
                size: file.size,
                duration: durationSeconds || null,
                fileKey: utils.bufferToBase64(fileKeyRaw)
            });
            const encMeta = isGroup ? await groupCrypto.encrypt(groupId, metaPayload) : await this.encryptOutgoing(ratchet, metaPayload);

            const { data: inserted, error } = await supabase.from('messages').insert({
                id: messageId,
                conversation_id: convId,
                sender_id: AppState.getUser().id,
                ciphertext: encMeta.ciphertextBase64,
                nonce: encMeta.nonceBase64,
                header: encMeta.headerJson,
                mode: AppState.getMode(),
                type,
                media_path: uploadResult.media_path,
                media_size: uploadResult.media_size,
                media_nonce: uploadResult.media_nonce,
                status: 'delivered'
            }).select().single();

            if (error) throw error;

            if (isGroup) {
                await saveGroupState(AppState.getUser().id, groupId, AppState.getMode(), groupCrypto, keyManager.passwordKey);
            } else {
                await this.persistRatchet(convId, ratchet);
            }
            await cachePlaintext(AppState.getUser().id, AppState.getMode(), inserted.id, metaPayload, keyManager.passwordKey);

            tempMsg.id = inserted.id;
            tempMsg.status = inserted.status;
            UI.renderMessages(this.currentMessages);

            await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
            this.loadConversations();
        } catch (err) {
            console.error(err);
            UI.showToast("Nie udało się wysłać pliku", "error");
            tempMsg.status = 'error';
            tempMsg.sendError = true;
            UI.renderMessages(this.currentMessages);
        }
    }

    static subscribeToMessages(convId) {
        if (this.realtimeChannel) supabase.removeChannel(this.realtimeChannel);
        
        this.realtimeChannel = supabase.channel(`messages-${convId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` }, async (payload) => {
                const newMsg = payload.new;
                if (newMsg.mode !== AppState.getMode()) return;
                if (newMsg.sender_id === AppState.getUser().id) return;

                // Wiadomość od kontaktu właśnie dotarła - jeśli pokazywaliśmy "pisze...", chowamy je.
                UI.hideTypingIndicator();
                UI.setConversationTyping(convId, false);
                clearTimeout(this.typingHideTimer);

                const decMsg = await this.decryptMessageRow(newMsg);
                this.currentMessages.unshift(decMsg);
                UI.renderMessages(this.currentMessages);
                this.loadConversations();
                if (decMsg.type === 'image') this.loadMediaContent(decMsg.id);
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` }, (payload) => {
                // Odbiór na żywo zmiany statusu (np. druga strona oznaczyła jako przeczytane -
                // pokazujemy niebieskie "ptaszki" bez odświeżania).
                const updated = payload.new;
                const local = this.currentMessages.find(m => m.id === updated.id);
                if (local && local.status !== updated.status) {
                    local.status = updated.status;
                    UI.renderMessages(this.currentMessages);
                }
            })
            .subscribe();
    }

    /**
     * Kanał "broadcast" (bez zapisu do bazy) do wskaźnika "X pisze..." - lekki i natychmiastowy,
     * bo nie wymaga round-tripu przez tabelę messages/Postgres.
     */
    static subscribeToTyping(convId) {
        if (this.typingChannel) supabase.removeChannel(this.typingChannel);
        clearTimeout(this.typingHideTimer);

        this.typingChannel = supabase.channel(`typing-${convId}`, { config: { broadcast: { self: false } } })
            .on('broadcast', { event: 'typing' }, (payload) => {
                const { userId, isTyping } = payload.payload || {};
                if (!userId || userId === AppState.getUser().id) return;

                const contact = this.contacts.get(userId);
                const name = contact ? contact.display_name : 'Kontakt';

                clearTimeout(this.typingHideTimer);
                if (isTyping) {
                    UI.showTypingIndicator(name);
                    UI.setConversationTyping(convId, true);
                    this.typingHideTimer = setTimeout(() => {
                        UI.hideTypingIndicator();
                        UI.setConversationTyping(convId, false);
                    }, 3000);
                } else {
                    UI.hideTypingIndicator();
                    UI.setConversationTyping(convId, false);
                }
            })
            .subscribe();
    }

    /** Wywoływane przy każdym wpisywanym znaku (throttled do 1 zdarzenia / 2s, żeby nie zalać kanału). */
    static broadcastTyping() {
        if (!this.activeConversation || !this.typingChannel) return;
        const now = Date.now();
        if (this._lastTypingBroadcast && now - this._lastTypingBroadcast < 2000) return;
        this._lastTypingBroadcast = now;

        this.typingChannel.send({
            type: 'broadcast',
            event: 'typing',
            payload: { userId: AppState.getUser().id, isTyping: true }
        });
    }

    /** Wywoływane po wysłaniu wiadomości / opuszczeniu pola - natychmiast chowa "pisze..." u drugiej strony. */
    static stopTypingBroadcast() {
        if (!this.typingChannel) return;
        this._lastTypingBroadcast = 0;
        this.typingChannel.send({
            type: 'broadcast',
            event: 'typing',
            payload: { userId: AppState.getUser().id, isTyping: false }
        });
    }

    static async ensureFakeMessages(convId, contactId) {
        const { data } = await supabase.from('messages').select('id').eq('conversation_id', convId).eq('mode', 'fake').limit(1);
        if (data && data.length === 0) {
            const fakeMsgs = ["Bezpieczna sesja nawiązana.", "Historia została wyczyszczona."];

            const ratchet = await this.prepareOutgoingRatchet(convId, contactId);
            if (!ratchet) return; // brak kluczy X3DH kontaktu w trybie fake - pomiń ciche seedowanie

            for (const text of fakeMsgs) {
                const enc = await this.encryptOutgoing(ratchet, text);
                const { data: inserted } = await supabase.from('messages').insert({
                    conversation_id: convId,
                    sender_id: AppState.getUser().id,
                    ciphertext: enc.ciphertextBase64,
                    nonce: enc.nonceBase64,
                    header: enc.headerJson,
                    mode: 'fake',
                    status: 'delivered',
                    type: 'text'
                }).select().single();

                if (inserted) {
                    await cachePlaintext(AppState.getUser().id, 'fake', inserted.id, text, keyManager.passwordKey);
                }
            }
            await this.persistRatchet(convId, ratchet);
            this.loadMessages(convId);
        }
    }

    static setupUIHandlers() {
        document.getElementById('confirm-add-contact').addEventListener('click', () => {
            const username = document.getElementById('contact-username').value.trim();
            const realNick = document.getElementById('contact-nickname').value.trim();
            const fakeNick = document.getElementById('contact-fake-nickname').value.trim();
            if (username) this.sendFriendRequestAction(username, realNick, fakeNick);
        });

        document.getElementById('confirm-create-group').addEventListener('click', () => {
            const name = document.getElementById('group-name-input').value.trim();
            if (name) this.createGroupAction(name);
        });

        document.getElementById('confirm-join-group').addEventListener('click', () => {
            const creatorUsername = document.getElementById('join-group-username').value.trim();
            const code = document.getElementById('join-group-code').value.trim();
            if (creatorUsername && code) this.joinGroupAction(creatorUsername, code);
        });

        document.getElementById('friend-requests-list').addEventListener('click', (e) => {
            const acceptBtn = e.target.closest('[data-accept-request]');
            const declineBtn = e.target.closest('[data-decline-request]');
            if (acceptBtn) this.acceptFriendRequestAction(acceptBtn.dataset.acceptRequest);
            if (declineBtn) this.declineFriendRequestAction(declineBtn.dataset.declineRequest);
        });
        
        document.getElementById('send-button').addEventListener('click', () => {
            const text = document.getElementById('message-input').value.trim();
            if (text) {
                this.sendMessage(text);
                document.getElementById('message-input').value = '';
                document.getElementById('message-input').style.height = 'auto';
            }
        });

        document.getElementById('message-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('send-button').click();
            }
        });

        // Wskaźnik "X pisze..." u drugiej strony - throttlowane broadcasty przez Supabase Realtime.
        const messageInput = document.getElementById('message-input');
        messageInput.addEventListener('input', () => {
            if (messageInput.value.trim().length > 0) this.broadcastTyping();
        });
        messageInput.addEventListener('blur', () => this.stopTypingBroadcast());

        // --- Załączniki: zdjęcia / filmy ---
        const attachBtn = document.getElementById('attach-button');
        const attachInput = document.getElementById('attach-file-input');
        if (attachBtn && attachInput) {
            attachBtn.addEventListener('click', () => attachInput.click());
            attachInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) this.sendMedia(file);
                e.target.value = '';
            });
        }

        // --- Wiadomości głosowe (nagrywanie przytrzymaniem/kliknięciem) ---
        const voiceBtn = document.getElementById('voice-record-button');
        if (voiceBtn) {
            const recorder = new VoiceRecorder();
            let recording = false;

            voiceBtn.addEventListener('click', async () => {
                if (!recording) {
                    try {
                        await recorder.start();
                        recording = true;
                        voiceBtn.classList.add('recording');
                        UI.showToast('Nagrywanie… kliknij ponownie, aby wysłać', 'success');
                    } catch (e) {
                        UI.showToast('Brak dostępu do mikrofonu. Sprawdź uprawnienia przeglądarki.', 'error');
                    }
                } else {
                    recording = false;
                    voiceBtn.classList.remove('recording');
                    try {
                        const { file, durationSeconds } = await recorder.stop();
                        if (durationSeconds < 1) {
                            UI.showToast('Nagranie za krótkie, anulowano.', 'error');
                            return;
                        }
                        if (durationSeconds > CONFIG.MAX_VOICE_SECONDS) {
                            UI.showToast(`Nagranie za długie (maks. ${CONFIG.MAX_VOICE_SECONDS}s).`, 'error');
                            return;
                        }
                        this.sendMedia(file, durationSeconds);
                    } catch (e) {
                        UI.showToast('Nie udało się zapisać nagrania.', 'error');
                    }
                }
            });
        }

        // --- Kliknięcie w wiadomość medialną (pobierz/odtwórz) - delegacja zdarzeń ---
        document.getElementById('messages-container').addEventListener('click', (e) => {
            const el = e.target.closest('[data-load-media]');
            if (el) this.loadMediaContent(el.dataset.loadMedia);
        });

        // --- Połączenia głosowe / wideo ---
        const audioCallBtn = document.getElementById('start-audio-call-btn');
        const videoCallBtn = document.getElementById('start-video-call-btn');
        if (audioCallBtn) audioCallBtn.addEventListener('click', () => this.startCall(false));
        if (videoCallBtn) videoCallBtn.addEventListener('click', () => this.startCall(true));

        const hangupBtn = document.getElementById('call-hangup-btn');
        const muteBtn = document.getElementById('call-mute-btn');
        const cameraBtn = document.getElementById('call-camera-btn');
        if (hangupBtn) hangupBtn.addEventListener('click', () => this.endCall());
        if (muteBtn) muteBtn.addEventListener('click', () => {
            const muted = CallManager.toggleMute();
            UI.setMuteButtonState(muted);
        });
        if (cameraBtn) cameraBtn.addEventListener('click', () => {
            const off = CallManager.toggleCamera();
            UI.setCameraButtonState(off);
        });
    }
}
