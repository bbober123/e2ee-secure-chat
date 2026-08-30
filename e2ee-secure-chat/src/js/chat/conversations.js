/**
 * chat/conversations.js — ładowanie listy rozmów, otwieranie konwersacji,
 * stan grup (Sender Keys) i cache członków grupy.
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { keyManager } from '../auth.js';
import { AppState } from '../state.js';
import { groupCrypto } from '../groups.js';
import { saveGroupState, loadGroupState, consumePendingKeyDistributions } from '../groupkeys.js';

export const ConversationsMixin = {
    async loadConversations() {
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
    },

    async openConversation(convId, contactId, isGroup = false, groupId = null) {
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
    },

    /** Upewnia się, że mamy w RAM stan Sender Keys tej grupy (ładuje z zaszyfrowanego zapisu, jeśli trzeba) i konsumuje zaległe dystrybucje. */
    async ensureGroupState(groupId) {
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
    },

    /** Pobiera (i cache'uje) listę członków grupy do wyświetlania nazw autorów wiadomości. */
    async loadGroupMembers(groupId) {
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
    },

    /** Zwalnia blob: URL-e (URL.createObjectURL) trzymane przez wiadomości medialne, żeby uniknąć wycieku pamięci. */
    revokeMediaUrls(messages) {
        (messages || []).forEach(m => {
            if (m.mediaUrl && m.mediaUrl.startsWith('blob:')) {
                try { URL.revokeObjectURL(m.mediaUrl); } catch (e) { /* noop */ }
            }
        });
    },
};
