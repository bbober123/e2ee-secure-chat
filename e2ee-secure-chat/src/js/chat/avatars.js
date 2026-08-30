/**
 * chat/avatars.js — pomocnicze funkcje do wyliczania URL awatara (własnego i kontaktów).
 * Część klasy ChatApp (patrz ../chat.js — łączy wszystkie grupy metod przez Object.assign).
 */
import { AppState } from '../state.js';

export const AvatarsMixin = {
    /** Awatar bieżącego użytkownika (uploadowany) albo placeholder Dicebear jako fallback. */
    getMyAvatar() {
        return this.myAvatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${AppState.getUser().id}`;
    },

    /** Wylicza URL awatara kontaktu: nadpisanie per-kontakt > realny avatar_url usera > placeholder. */
    resolveContactAvatar(c, nickname) {
        const override = AppState.getMode() === 'fake' ? c.fake_avatar_url : c.real_avatar_url;
        const real = c.contact_user?.avatar_url;
        const fallback = `https://api.dicebear.com/7.x/avataaars/svg?seed=${nickname}${AppState.getMode() === 'fake' ? 'Fake' : ''}`;
        return override || real || fallback;
    },
};
