/**
 * chat/messaging-realtime.js — kanały Realtime dla nowych wiadomości i wskaźnika
 * "X pisze..." (throttlowany broadcast, żeby nie zalać kanału).
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { AppState } from '../state.js';

export const MessagingRealtimeMixin = {
    subscribeToMessages(convId) {
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
    },

    /**
     * Kanał "broadcast" (bez zapisu do bazy) do wskaźnika "X pisze..." - lekki i natychmiastowy,
     * bo nie wymaga round-tripu przez tabelę messages/Postgres.
     */
    subscribeToTyping(convId) {
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
    },

    /** Wywoływane przy każdym wpisywanym znaku (throttled do 1 zdarzenia / 2s, żeby nie zalać kanału). */
    broadcastTyping() {
        if (!this.activeConversation || !this.typingChannel) return;
        const now = Date.now();
        if (this._lastTypingBroadcast && now - this._lastTypingBroadcast < 2000) return;
        this._lastTypingBroadcast = now;

        this.typingChannel.send({
            type: 'broadcast',
            event: 'typing',
            payload: { userId: AppState.getUser().id, isTyping: true }
        });
    },

    /** Wywoływane po wysłaniu wiadomości / opuszczeniu pola - natychmiast chowa "pisze..." u drugiej strony. */
    stopTypingBroadcast() {
        if (!this.typingChannel) return;
        this._lastTypingBroadcast = 0;
        this.typingChannel.send({
            type: 'broadcast',
            event: 'typing',
            payload: { userId: AppState.getUser().id, isTyping: false }
        });
    },
};
