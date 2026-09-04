/**
 * chat/send.js — wysyłanie wiadomości tekstowych, zaproszeń do gier i mediów
 * (zdjęcia/filmy/głosówki), zaszyfrowanych przez Double Ratchet przed wysyłką.
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { keyManager } from '../auth.js';
import { CryptoEngine, utils } from '../crypto.js';
import { CONFIG } from '../config.js';
import { AppState } from '../state.js';
import { MediaManager, VoiceRecorder } from '../media.js';
import { cachePlaintext } from '../plaintext-cache.js';
import { groupCrypto } from '../groups.js';
import { saveGroupState } from '../groupkeys.js';

export const SendMixin = {
    async sendMessage(text) {
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
    },

    /**
     * Wysyła zaproszenie do gry (kazyno) jako wiadomość czatu (type='game_invite').
     * Treść zaproszenia (nazwa gry + id stołu) jest szyfrowana DOKŁADNIE tak samo jak
     * zwykły tekst - przechodzi przez tę samą sesję Double Ratchet z odbiorcą.
     */
    /** Wysyła zwykłą wiadomość tekstową do KONKRETNEGO kontaktu, niezależnie od tego,
     * jaka rozmowa jest akurat otwarta w UI (sam znajduje/tworzy rozmowę) - używane
     * np. do "pochwalenia się" przedmiotem z kasyna bez konieczności przełączania czatu. */
    async sendTextToContact(contactId, text) {
        const userId = AppState.getUser().id;
        const { data: convs } = await supabase.from('conversations')
            .select('id').eq('type', 'direct').contains('participant_ids', [userId, contactId]);
        let convId = convs?.[0]?.id;

        if (!convId) {
            const { data: created, error } = await supabase.from('conversations')
                .insert({ participant_ids: [userId, contactId], created_by: userId, type: 'direct' })
                .select().single();
            if (error) throw error;
            convId = created.id;
        }

        const ratchet = await this.prepareOutgoingRatchet(convId, contactId);
        if (!ratchet) throw new Error('Nie udało się nawiązać bezpiecznej sesji z tym znajomym.');

        const enc = await this.encryptOutgoing(ratchet, text);

        const { data: inserted, error } = await supabase.from('messages').insert({
            conversation_id: convId,
            sender_id: userId,
            ciphertext: enc.ciphertextBase64,
            nonce: enc.nonceBase64,
            header: enc.headerJson,
            mode: AppState.getMode(),
            type: 'text',
            status: 'delivered'
        }).select().single();
        if (error) throw error;

        await this.persistRatchet(convId, ratchet);
        await cachePlaintext(userId, AppState.getMode(), inserted.id, text, keyManager.passwordKey);
        await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
        this.loadConversations();
    },

    async sendGameInviteMessage(contactId, payload) {
        const userId = AppState.getUser().id;
        const { data: convs } = await supabase.from('conversations')
            .select('id').eq('type', 'direct').contains('participant_ids', [userId, contactId]);
        let convId = convs?.[0]?.id;

        if (!convId) {
            const { data: created, error } = await supabase.from('conversations')
                .insert({ participant_ids: [userId, contactId], created_by: userId, type: 'direct' })
                .select().single();
            if (error) throw error;
            convId = created.id;
        }

        const ratchet = await this.prepareOutgoingRatchet(convId, contactId);
        if (!ratchet) throw new Error('Nie udało się nawiązać bezpiecznej sesji z tym znajomym.');

        const text = JSON.stringify(payload);
        const enc = await this.encryptOutgoing(ratchet, text);

        const { data: inserted, error } = await supabase.from('messages').insert({
            conversation_id: convId,
            sender_id: userId,
            ciphertext: enc.ciphertextBase64,
            nonce: enc.nonceBase64,
            header: enc.headerJson,
            mode: AppState.getMode(),
            type: 'game_invite',
            status: 'delivered'
        }).select().single();
        if (error) throw error;

        await this.persistRatchet(convId, ratchet);
        await cachePlaintext(userId, AppState.getMode(), inserted.id, text, keyManager.passwordKey);
        await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
        this.loadConversations();
    },

    /**
     * Wysyła wiadomość medialną (zdjęcie/film/głosówkę). `file` to obiekt File
     * (z <input type=file> albo z VoiceRecorder.stop()). `durationSeconds` -
     * tylko dla głosówek/filmów, opcjonalne.
     */
    async sendMedia(file, durationSeconds = null) {
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
    },
};
