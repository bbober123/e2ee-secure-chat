/**
 * chat/reactions.js — reakcje emoji pod wiadomościami. Celowo NIE idą przez
 * Double Ratchet (patrz obszerny komentarz w database.sql przy tabeli
 * message_reactions) - serwer widzi jawnie które emoji, kto i pod którą
 * wiadomością, ale nigdy treść samej wiadomości.
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { AppState } from '../state.js';

export const ReactionsMixin = {
    /** Wczytuje reakcje dla WSZYSTKICH aktualnie wyświetlanych wiadomości jednym zapytaniem. */
    async loadReactionsForCurrentMessages() {
        const ids = this.currentMessages.map(m => m.id).filter(id => !id.toString().startsWith('temp-'));
        this.reactionsByMessage = new Map();
        if (!ids.length) { UI.renderMessages(this.currentMessages, this.reactionsByMessage); return; }

        const { data, error } = await supabase.from('message_reactions')
            .select('id, message_id, user_id, emoji').in('message_id', ids);
        if (error) { console.error(error); return; }

        for (const r of data) {
            if (!this.reactionsByMessage.has(r.message_id)) this.reactionsByMessage.set(r.message_id, []);
            this.reactionsByMessage.get(r.message_id).push(r);
        }
        UI.renderMessages(this.currentMessages, this.reactionsByMessage);
    },

    /** Klik na emoji: jeśli JA już tak zareagowałem/am pod tą wiadomością - zdejmuje reakcję, inaczej dodaje. */
    async toggleReaction(messageId, emoji) {
        const userId = AppState.getUser().id;
        const existing = (this.reactionsByMessage.get(messageId) || []).find(r => r.user_id === userId && r.emoji === emoji);

        if (existing) {
            const { error } = await supabase.from('message_reactions').delete().eq('id', existing.id);
            if (error) { console.error(error); return; }
            const list = this.reactionsByMessage.get(messageId) || [];
            this.reactionsByMessage.set(messageId, list.filter(r => r.id !== existing.id));
        } else {
            const msg = this.currentMessages.find(m => m.id === messageId);
            if (!msg) return;
            const { data, error } = await supabase.from('message_reactions')
                .insert({ message_id: messageId, conversation_id: this.activeConversation.id, user_id: userId, emoji })
                .select('id, message_id, user_id, emoji').single();
            if (error) { console.error(error); return; }
            if (!this.reactionsByMessage.has(messageId)) this.reactionsByMessage.set(messageId, []);
            this.reactionsByMessage.get(messageId).push(data);
        }
        UI.renderMessages(this.currentMessages, this.reactionsByMessage);
    },

    subscribeToReactions(convId) {
        if (this.reactionsChannel) supabase.removeChannel(this.reactionsChannel);

        this.reactionsChannel = supabase.channel(`reactions-${convId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${convId}` }, (payload) => {
                const r = payload.new;
                if (!this.currentMessages.some(m => m.id === r.message_id)) return; // reakcja pod wiadomością spoza aktualnie wczytanej strony
                const list = this.reactionsByMessage.get(r.message_id) || [];
                if (list.some(x => x.id === r.id)) return; // już dodane optymistycznie przez toggleReaction lokalnie
                list.push(r);
                this.reactionsByMessage.set(r.message_id, list);
                UI.renderMessages(this.currentMessages, this.reactionsByMessage);
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${convId}` }, (payload) => {
                const r = payload.old;
                const list = this.reactionsByMessage.get(r.message_id);
                if (!list) return;
                this.reactionsByMessage.set(r.message_id, list.filter(x => x.id !== r.id));
                UI.renderMessages(this.currentMessages, this.reactionsByMessage);
            })
            .subscribe();
    }
};
