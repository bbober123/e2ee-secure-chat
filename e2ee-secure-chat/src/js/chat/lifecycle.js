/**
 * chat/lifecycle.js — start aplikacji: odblokowanie/init, ładowanie kontaktów,
 * odświeżanie własnego awatara.
 */
import { supabase } from '../supabase.js';
import { UI } from '../ui.js';
import { AuthManager, keyManager } from '../auth.js';
import { AppState } from '../state.js';
import { groupCrypto } from '../groups.js';
import { saveGroupState, loadGroupState, consumePendingKeyDistributions } from '../groupkeys.js';

export const LifecycleMixin = {
    async init() {
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

            // NAPRAWA: wczytaj do RAM stany Sender Keys WSZYSTKICH moich grup. Bez tego
            // subscribeToGroupJoins po świeżym F5 widzi pusty groupCrypto i nie reaguje na dołączenia,
            // nawet jeśli mam zapisany stan w group_sender_states.
            try {
                const { data: myGroups } = await supabase.from('group_members').select('group_id').eq('user_id', AppState.getUser().id);
                for (const row of myGroups || []) {
                    try {
                        await loadGroupState(AppState.getUser().id, row.group_id, AppState.getMode(), groupCrypto, keyManager.passwordKey);
                    } catch (e) {
                        console.warn('Nie udało się wczytać stanu grupy', row.group_id, e);
                    }
                }
            } catch (e) {
                console.warn('Nie udało się wczytać listy grup', e);
            }

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
    },

    /**
     * Wywoływane zaraz po zmianie własnego awatara (ProfileManager.updateAvatar),
     * żeby natychmiast odświeżyć wszystkie miejsca w UI, które go pokazują,
     * bez przeładowania strony.
     */
    updateMyAvatar(url) {
        this.myAvatarUrl = url;
        const myAvatarImg = document.getElementById('my-avatar-img');
        if (myAvatarImg) myAvatarImg.src = url;

        this.currentMessages.forEach(m => {
            if (m.authorId === AppState.getUser().id) m.avatar = url;
        });
        if (this.currentMessages.length) UI.renderMessages(this.currentMessages);
    },

    async loadContacts() {
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
    },
};
