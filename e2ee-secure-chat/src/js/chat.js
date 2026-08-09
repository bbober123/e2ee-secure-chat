import { supabase } from './supabase.js';
import { UI } from './ui.js';
import { keyManager } from './auth.js';
import { CryptoEngine, KeyTrustStore } from './crypto.js';
import { CONFIG } from './config.js';
import { AppState } from './state.js';
import { MediaManager, VoiceRecorder } from './media.js';
import { CallManager } from './calls.js';

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
            const { data } = await supabase.from('users').select('*').eq('id', AppState.getUser().id).single();
            const keyStr = AppState.getMode() === 'fake' ? data.public_key_fake : data.public_key_real;
            this.myPublicKey = await crypto.subtle.importKey("jwk", JSON.parse(keyStr), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
            this.myAvatarUrl = data.avatar_url || null;

            await this.loadContacts();
            await this.loadConversations();
            this.setupUIHandlers();
            this.subscribeToProfileUpdates();
            
            window.addEventListener('conversation-selected', (e) => {
                this.openConversation(e.detail.convId, e.detail.contactId);
            });
            
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

    static async addContact(username, realNick, fakeNick) {
        const { data: users, error: uErr } = await supabase.from('users').select('id').eq('username', username).single();
        if (uErr || !users) {
            UI.showToast("Nie znaleziono użytkownika", "error");
            return;
        }
        const contactId = users.id;
        
        const { error: cErr } = await supabase.from('contacts').insert({
            owner_id: AppState.getUser().id,
            contact_user_id: contactId,
            real_nickname: realNick || username,
            fake_nickname: fakeNick || username
        });
        
        if (cErr) {
            UI.showToast("Błąd dodawania kontaktu", "error");
            return;
        }

        const { data: convs } = await supabase.from('conversations').select('*').contains('participant_ids', [contactId]);
        if (!convs || convs.length === 0) {
            await supabase.from('conversations').insert({
                participant_ids: [AppState.getUser().id, contactId],
                created_by: AppState.getUser().id
            });
        }
        
        UI.showToast("Kontakt dodany!", "success");
        await this.loadContacts();
        await this.loadConversations();
        document.getElementById('add-contact-modal').style.display = 'none';
        document.getElementById('contact-username').value = '';
        document.getElementById('contact-nickname').value = '';
        document.getElementById('contact-fake-nickname').value = '';
    }

    static async loadConversations() {
        const { data: convs, error } = await supabase.from('conversations')
            .select('*, messages(id, encrypted_payload, timestamp, mode)')
            .order('updated_at', { ascending: false });
            
        if (error) {
            console.error("Load conv err", error);
            return;
        }

        const uiConvs = convs.map(c => {
            const otherId = c.participant_ids.find(id => id !== AppState.getUser().id) || AppState.getUser().id;
            const contact = this.contacts.get(otherId) || { display_name: 'Nieznany', avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${otherId}` };
            
            const modeMsgs = c.messages ? c.messages.filter(m => m.mode === AppState.getMode()).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)) : [];
            const lastMsg = modeMsgs.length > 0 ? modeMsgs[0] : null;

            return {
                id: c.id,
                contactId: otherId,
                nickname: contact.display_name,
                avatar: contact.avatar,
                time: lastMsg ? new Date(lastMsg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '',
                lastMessage: lastMsg ? 'Zaszyfrowana wiadomość' : 'Brak wiadomości'
            };
        });

        UI.renderConversations(uiConvs, this.activeConversation?.id);
    }

    static async openConversation(convId, contactId) {
        // Zwolnij blob: URL-e odszyfrowanych mediów z poprzednio otwartej rozmowy -
        // inaczej przy częstym przełączaniu konwersacji przeglądarka gromadzi w pamięci
        // coraz więcej niezwolnionych obiektów (zdjęcia/filmy/głosówki nigdy nie giną z RAM).
        this.revokeMediaUrls(this.currentMessages);

        this.activeConversation = { id: convId, contactId: contactId };

        UI.hideTypingIndicator();
        UI.renderMessagesSkeleton();
        await this.loadMessages(convId);
        this.subscribeToMessages(convId);
        this.subscribeToTyping(convId);
        this.subscribeToCalls(convId);

        if (AppState.getMode() === 'fake') {
            await this.ensureFakeMessages(convId, contactId);
        }
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

    static async decryptMessageRow(msg) {
        const type = msg.type || 'text';
        let text = "[Nie można odszyfrować — klucz nieprawidłowy lub uszkodzony]";
        let mediaMeta = null;
        let sessionKey = null;
        const aad = CryptoEngine.buildAAD(msg.conversation_id, msg.sender_id, msg.mode);

        try {
            const keys = JSON.parse(msg.encrypted_content_key);
            const myKeyBase64 = (msg.sender_id === AppState.getUser().id) ? keys.s : keys.r;

            sessionKey = await CryptoEngine.decryptSessionKey(myKeyBase64, keyManager.myPrivateKey);

            if (type === 'text') {
                text = await CryptoEngine.decryptMessage(msg.encrypted_payload, msg.nonce, sessionKey, aad);
            } else {
                // Dla wiadomości medialnych `encrypted_payload`/`nonce` zawierają
                // tylko (małe) zaszyfrowane metadane pliku - sama treść pliku jest
                // pobierana/deszyfrowana leniwie (na żądanie), patrz loadMediaContent.
                const metaJson = await CryptoEngine.decryptMessage(msg.encrypted_payload, msg.nonce, sessionKey, aad);
                mediaMeta = JSON.parse(metaJson);
                text = '';
            }

            if (msg.status !== 'read' && msg.sender_id !== AppState.getUser().id) {
                supabase.from('messages').update({ status: 'read' }).eq('id', msg.id).then();
            }
        } catch (e) {
            console.error("Decrypt error", e);
        }
        
        const isMe = msg.sender_id === AppState.getUser().id;
        const contact = this.contacts.get(msg.sender_id);
        const authorName = isMe ? 'Ja' : (contact ? contact.display_name : 'Nieznany');
        const avatar = isMe ? this.getMyAvatar() : (contact ? contact.avatar : '');

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
            _mediaRaw: type === 'text' ? null : {
                media_path: msg.media_path,
                media_nonce: msg.media_nonce,
                encrypted_payload: msg.encrypted_payload,
                nonce: msg.nonce,
                aad
            },
            _sessionKey: sessionKey
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
        if (!msg._sessionKey || !msg._mediaRaw) {
            msg.mediaState = 'error';
            UI.renderMessages(this.currentMessages);
            return;
        }

        msg.mediaState = 'loading';
        UI.renderMessages(this.currentMessages);

        try {
            const { blobUrl } = await MediaManager.downloadAndDecrypt({
                media_path: msg._mediaRaw.media_path,
                media_nonce: msg._mediaRaw.media_nonce,
                encrypted_payload: msg._mediaRaw.encrypted_payload,
                nonce: msg._mediaRaw.nonce,
                sessionKey: msg._sessionKey,
                aad: msg._mediaRaw.aad
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
     * Wspólna logika dla sendMessage/sendMedia: weryfikacja TOFU klucza kontaktu,
     * wygenerowanie świeżego klucza sesyjnego AES i owinięcie go RSA-OAEP dla
     * obu stron rozmowy. Zwraca null (i już pokazuje toast) jeśli użytkownik
     * anulował wysyłkę po ostrzeżeniu o zmianie klucza.
     */
    static async prepareOutgoing(convId, contactId) {
        const contact = this.contacts.get(contactId);
        const keyStr = AppState.getMode() === 'fake' ? contact.public_key_fake : contact.public_key_real;

        // TOFU: wykryj, czy klucz publiczny kontaktu zmienił się od ostatniej znanej wartości.
        // Chroni (częściowo) przed podstawieniem klucza przez skompromitowany/złośliwy backend.
        const trust = await KeyTrustStore.verify(AppState.getUser().id, contactId, AppState.getMode(), keyStr);
        if (trust.status === 'changed') {
            const proceed = window.confirm(
                "⚠️ UWAGA BEZPIECZEŃSTWA\n\n" +
                `Klucz szyfrujący kontaktu "${contact.display_name}" zmienił się od ostatniej rozmowy.\n\n` +
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
            KeyTrustStore.trustNewKey(AppState.getUser().id, contactId, AppState.getMode(), trust.fingerprint);
        }

        const recipientPubKey = await crypto.subtle.importKey("jwk", JSON.parse(keyStr), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
        const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const aad = CryptoEngine.buildAAD(convId, AppState.getUser().id, AppState.getMode());
        const keysPayload = JSON.stringify({
            r: await CryptoEngine.encryptSessionKey(sessionKey, recipientPubKey),
            s: await CryptoEngine.encryptSessionKey(sessionKey, this.myPublicKey)
        });

        return { contact, sessionKey, aad, keysPayload };
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

        try {
            const prep = await this.prepareOutgoing(convId, contactId);
            if (!prep) { UI.setSendStatus('error'); return; }
            const { sessionKey, aad, keysPayload } = prep;

            const encMsg = await CryptoEngine.encryptMessage(text, sessionKey, aad);

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
                encrypted_payload: encMsg.ciphertextBase64,
                nonce: encMsg.nonceBase64,
                encrypted_content_key: keysPayload,
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

        try {
            const prep = await this.prepareOutgoing(convId, contactId);
            if (!prep) {
                tempMsg.status = 'error';
                tempMsg.sendError = true;
                UI.renderMessages(this.currentMessages);
                return;
            }
            const { sessionKey, aad, keysPayload } = prep;

            const messageId = crypto.randomUUID();
            const uploadResult = await MediaManager.encryptAndUpload({
                file, type, conversationId: convId, messageId, sessionKey, aad, durationSeconds
            });

            const { data: inserted, error } = await supabase.from('messages').insert({
                id: messageId,
                conversation_id: convId,
                sender_id: AppState.getUser().id,
                encrypted_payload: uploadResult.encrypted_payload,
                nonce: uploadResult.nonce,
                encrypted_content_key: keysPayload,
                mode: AppState.getMode(),
                type,
                media_path: uploadResult.media_path,
                media_size: uploadResult.media_size,
                media_nonce: uploadResult.media_nonce,
                status: 'delivered'
            }).select().single();

            if (error) throw error;

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
            
            const contact = this.contacts.get(contactId);
            const recipientPubKey = await crypto.subtle.importKey("jwk", JSON.parse(contact.public_key_fake), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
            
            const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
            const keysPayload = JSON.stringify({
                r: await CryptoEngine.encryptSessionKey(sessionKey, recipientPubKey),
                s: await CryptoEngine.encryptSessionKey(sessionKey, this.myPublicKey)
            });

            const fakeAad = CryptoEngine.buildAAD(convId, AppState.getUser().id, 'fake');
            for (const text of fakeMsgs) {
                const enc = await CryptoEngine.encryptMessage(text, sessionKey, fakeAad);
                await supabase.from('messages').insert({
                    conversation_id: convId,
                    sender_id: AppState.getUser().id,
                    encrypted_payload: enc.ciphertextBase64,
                    nonce: enc.nonceBase64,
                    encrypted_content_key: keysPayload,
                    mode: 'fake',
                    status: 'delivered',
                    type: 'text'
                });
            }
            this.loadMessages(convId);
        }
    }

    static setupUIHandlers() {
        document.getElementById('confirm-add-contact').addEventListener('click', () => {
            const username = document.getElementById('contact-username').value.trim();
            const realNick = document.getElementById('contact-nickname').value.trim();
            const fakeNick = document.getElementById('contact-fake-nickname').value.trim();
            if (username) this.addContact(username, realNick, fakeNick);
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
