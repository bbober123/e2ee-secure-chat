/**
 * chat/messages-load.js — ładowanie i odszyfrowywanie wiadomości konwersacji,
 * leniwe pobieranie/odszyfrowywanie mediów, rate-limiting wysyłania.
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { keyManager } from '../auth.js';
import { CryptoEngine, utils } from '../crypto.js';
import { CONFIG } from '../config.js';
import { AppState } from '../state.js';
import { MediaManager } from '../media.js';
import { cachePlaintext, readCachedPlaintext } from '../plaintext-cache.js';
import { groupCrypto } from '../groups.js';
import { saveGroupState } from '../groupkeys.js';

export const MessagesLoadMixin = {
    async loadMessages(convId) {
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
    },

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
    async decryptMessageRow(msg) {
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
            } else if (type === 'game_invite') {
                mediaMeta = JSON.parse(plaintext); // { game, tableId, bet }
                text = '';
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
    },

    /**
     * Leniwe pobranie i deszyfrowanie treści wiadomości medialnej (na żądanie
     * użytkownika - kliknięcie odtwórz/pokaż, albo automatycznie dla miniatur
     * zdjęć w renderMessages). Aktualizuje obiekt wiadomości w miejscu i
     * ponownie renderuje listę.
     */
    async loadMediaContent(msgId) {
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
    },

    checkRateLimit(convId) {
        const now = Date.now();
        const times = this.messageTimestamps.get(convId) || [];
        const recent = times.filter(t => now - t < 60000);
        if (recent.length >= CONFIG.MESSAGE_RATE_LIMIT) return false;
        recent.push(now);
        this.messageTimestamps.set(convId, recent);
        return true;
    },
};
