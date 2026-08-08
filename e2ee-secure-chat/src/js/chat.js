import { supabase } from './supabase.js';
import { UI } from './ui.js';
import { keyManager } from './auth.js';
import { CryptoEngine } from './crypto.js';

export class ChatApp {
    static activeConversation = null;
    static messageTimestamps = new Map();
    static realtimeChannel = null;
    static profileChannel = null;
    static contacts = new Map();
    static myPublicKey = null;
    static myAvatarUrl = null;
    static currentMessages = [];

    /** Awatar bieżącego użytkownika (uploadowany) albo placeholder Dicebear jako fallback. */
    static getMyAvatar() {
        return this.myAvatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${window.CURRENT_USER.id}`;
    }

    /** Wylicza URL awatara kontaktu: nadpisanie per-kontakt > realny avatar_url usera > placeholder. */
    static resolveContactAvatar(c, nickname) {
        const override = window.APP_MODE === 'fake' ? c.fake_avatar_url : c.real_avatar_url;
        const real = c.contact_user?.avatar_url;
        const fallback = `https://api.dicebear.com/7.x/avataaars/svg?seed=${nickname}${window.APP_MODE === 'fake' ? 'Fake' : ''}`;
        return override || real || fallback;
    }

    static async init() {
        try {
            const { data } = await supabase.from('users').select('*').eq('id', window.CURRENT_USER.id).single();
            const keyStr = window.APP_MODE === 'fake' ? data.public_key_fake : data.public_key_real;
            this.myPublicKey = await crypto.subtle.importKey("jwk", JSON.parse(keyStr), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
            this.myAvatarUrl = data.avatar_url || null;

            await this.loadContacts();
            await this.loadConversations();
            this.setupUIHandlers();
            this.subscribeToProfileUpdates();
            
            window.addEventListener('conversation-selected', (e) => {
                this.openConversation(e.detail.convId, e.detail.contactId);
            });
            
            document.getElementById('current-username').textContent = window.APP_MODE === 'fake' ? 'Prywatny Tryb' : data.username;

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
            if (m.authorId === window.CURRENT_USER.id) m.avatar = url;
        });
        if (this.currentMessages.length) UI.renderMessages(this.currentMessages);
    }

    static async loadContacts() {
        const { data, error } = await supabase.from('contacts').select('*, contact_user:contact_user_id(username, public_key_real, public_key_fake, avatar_url)');
        if (error) throw error;
        
        this.contacts.clear();
        data.forEach(c => {
            const nickname = window.APP_MODE === 'fake' ? (c.fake_nickname || c.contact_user.username) : (c.real_nickname || c.contact_user.username);
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
                if (!updated || updated.id === window.CURRENT_USER.id) return;

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
            owner_id: window.CURRENT_USER.id,
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
                participant_ids: [window.CURRENT_USER.id, contactId],
                created_by: window.CURRENT_USER.id
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
            const otherId = c.participant_ids.find(id => id !== window.CURRENT_USER.id) || window.CURRENT_USER.id;
            const contact = this.contacts.get(otherId) || { display_name: 'Nieznany', avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${otherId}` };
            
            const modeMsgs = c.messages ? c.messages.filter(m => m.mode === window.APP_MODE).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)) : [];
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
        this.activeConversation = { id: convId, contactId: contactId };
        
        await this.loadMessages(convId);
        this.subscribeToMessages(convId);

        if (window.APP_MODE === 'fake') {
            await this.ensureFakeMessages(convId, contactId);
        }
    }

    static async loadMessages(convId) {
        const { data: msgs, error } = await supabase.from('messages')
            .select('*')
            .eq('conversation_id', convId)
            .eq('mode', window.APP_MODE)
            .order('timestamp', { ascending: false })
            .limit(50);
            
        if (error) throw error;
        
        this.currentMessages = [];
        for (const msg of msgs) {
            const dec = await this.decryptMessageRow(msg);
            this.currentMessages.push(dec);
        }
        UI.renderMessages(this.currentMessages);
    }

    static async decryptMessageRow(msg) {
        let text = "[Nie można odszyfrować — klucz nieprawidłowy lub uszkodzony]";
        try {
            const keys = JSON.parse(msg.encrypted_content_key);
            const myKeyBase64 = (msg.sender_id === window.CURRENT_USER.id) ? keys.s : keys.r;
            
            const sessionKey = await CryptoEngine.decryptSessionKey(myKeyBase64, keyManager.myPrivateKey);
            text = await CryptoEngine.decryptMessage(msg.encrypted_payload, msg.nonce, sessionKey);
            
            if (msg.status !== 'read' && msg.sender_id !== window.CURRENT_USER.id) {
                supabase.from('messages').update({ status: 'read' }).eq('id', msg.id).then();
            }
        } catch (e) {
            console.error("Decrypt error", e);
        }
        
        const isMe = msg.sender_id === window.CURRENT_USER.id;
        const contact = this.contacts.get(msg.sender_id);
        const authorName = isMe ? 'Ja' : (contact ? contact.display_name : 'Nieznany');
        const avatar = isMe ? this.getMyAvatar() : (contact ? contact.avatar : '');

        return {
            id: msg.id,
            authorId: msg.sender_id,
            authorName,
            avatar,
            timestamp: msg.timestamp,
            text
        };
    }

    static checkRateLimit(convId) {
        const now = Date.now();
        const times = this.messageTimestamps.get(convId) || [];
        const recent = times.filter(t => now - t < 60000);
        if (recent.length >= 15) return false;
        recent.push(now);
        this.messageTimestamps.set(convId, recent);
        return true;
    }

    static async sendMessage(text) {
        if (!this.activeConversation) return;
        const convId = this.activeConversation.id;
        const contactId = this.activeConversation.contactId;
        
        if (!this.checkRateLimit(convId)) {
            UI.showToast("Zwolnij — wysyłasz za szybko", "error");
            document.getElementById('send-button').disabled = true;
            setTimeout(() => document.getElementById('send-button').disabled = false, 10000);
            return;
        }

        UI.setSendStatus('sending');

        try {
            const contact = this.contacts.get(contactId);
            const keyStr = window.APP_MODE === 'fake' ? contact.public_key_fake : contact.public_key_real;
            const recipientPubKey = await crypto.subtle.importKey("jwk", JSON.parse(keyStr), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);

            const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
            const encMsg = await CryptoEngine.encryptMessage(text, sessionKey);
            
            const keysPayload = JSON.stringify({
                r: await CryptoEngine.encryptSessionKey(sessionKey, recipientPubKey),
                s: await CryptoEngine.encryptSessionKey(sessionKey, this.myPublicKey)
            });

            const tempMsg = {
                id: 'temp-' + Date.now(),
                authorId: window.CURRENT_USER.id,
                authorName: 'Ja',
                avatar: this.getMyAvatar(),
                timestamp: new Date().toISOString(),
                text: text
            };
            this.currentMessages.unshift(tempMsg);
            UI.renderMessages(this.currentMessages);

            const { error } = await supabase.from('messages').insert({
                conversation_id: convId,
                sender_id: window.CURRENT_USER.id,
                encrypted_payload: encMsg.ciphertextBase64,
                nonce: encMsg.nonceBase64,
                encrypted_content_key: keysPayload,
                mode: window.APP_MODE,
                status: 'delivered'
            });
            
            if (error) {
                UI.showToast("Brak połączenia — wiadomość zostanie wysłana później", "error");
                throw error;
            }
            UI.setSendStatus('sent');
            await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
            this.loadConversations();
        } catch (err) {
            console.error(err);
            UI.setSendStatus('error');
        }
    }

    static subscribeToMessages(convId) {
        if (this.realtimeChannel) supabase.removeChannel(this.realtimeChannel);
        
        this.realtimeChannel = supabase.channel(`messages-${convId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` }, async (payload) => {
                const newMsg = payload.new;
                if (newMsg.mode !== window.APP_MODE) return;
                if (newMsg.sender_id === window.CURRENT_USER.id) return;

                const decMsg = await this.decryptMessageRow(newMsg);
                this.currentMessages.unshift(decMsg);
                UI.renderMessages(this.currentMessages);
                this.loadConversations();
            })
            .subscribe();
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

            for (const text of fakeMsgs) {
                const enc = await CryptoEngine.encryptMessage(text, sessionKey);
                await supabase.from('messages').insert({
                    conversation_id: convId,
                    sender_id: window.CURRENT_USER.id,
                    encrypted_payload: enc.ciphertextBase64,
                    nonce: enc.nonceBase64,
                    encrypted_content_key: keysPayload,
                    mode: 'fake',
                    status: 'delivered'
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
    }
}
