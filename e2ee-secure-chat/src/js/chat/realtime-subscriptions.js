/**
 * chat/realtime-subscriptions.js — kanały Supabase Realtime nasłuchujące na żywo:
 * zmiany awatara kontaktów, przychodzące prośby o znajomość, dołączenia do grup
 * i dystrybucje kluczy grupowych.
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { keyManager } from '../auth.js';
import { AppState } from '../state.js';
import { groupCrypto } from '../groups.js';
import { saveGroupState, distributeOwnKeyTo, consumePendingKeyDistributions } from '../groupkeys.js';
import { listIncomingFriendRequests } from '../friends.js';

export const RealtimeSubscriptionsMixin = {
    /**
     * Nasłuchuje na żywo zmian w tabeli users (np. inny użytkownik zmienia swój awatar)
     * i odświeża go u wszystkich, którzy mają go w kontaktach - bez odświeżania strony.
     * Wymaga dodania tabeli `users` do publikacji `supabase_realtime` w Supabase (patrz database.sql).
     */
    subscribeToProfileUpdates() {
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
    },

    /** Prośby o znajomość skierowane DO mnie - na żywo pokazują toast + odświeżają badge na przycisku "+". */
    subscribeToFriendRequests() {
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
    },

    async refreshFriendRequestsBadge() {
        try {
            const incoming = await listIncomingFriendRequests();
            UI.setFriendRequestsBadge(incoming.length);
        } catch (e) {
            console.error('Nie udało się odświeżyć liczby próśb o znajomość', e);
        }
    },

    /**
     * Gdy KTOŚ INNY dołączy (na żywo) do grupy, w której już jestem - jeśli mam
     * własny Sender Key dla tej grupy, wypycham go nowemu członkowi pairwise
     * (patrz groupkeys.js). Dzięki temu nowy członek może odczytać moje wiadomości
     * bez konieczności czekania, aż sam otworzy ze mną osobną rozmowę.
     */
    subscribeToGroupJoins() {
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
    },

    /** Pakiety dystrybucji klucza grupowego skierowane do mnie - odbierane na żywo, bez czekania na kolejne otwarcie apki. */
    subscribeToKeyDistributions() {
        if (this.keyDistChannel) supabase.removeChannel(this.keyDistChannel);

        this.keyDistChannel = supabase.channel('group-key-messages-incoming')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_key_messages', filter: `to_user_id=eq.${AppState.getUser().id}` }, async () => {
                const touched = await consumePendingKeyDistributions(AppState.getUser().id, AppState.getMode(), groupCrypto, keyManager.identityVault);
                for (const groupId of touched) {
                    await saveGroupState(AppState.getUser().id, groupId, AppState.getMode(), groupCrypto, keyManager.passwordKey);
                }
            })
            .subscribe();
    },
};
