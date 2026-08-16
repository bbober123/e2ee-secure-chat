import { supabase } from './supabase.js';
import { AppState } from './state.js';

const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const ProfileManager = {
    /**
     * Wgrywa nowy awatar do Supabase Storage (bucket 'avatars', folder = user id)
     * i aktualizuje users.avatar_url. Zwraca nowy publiczny URL.
     */
    async updateAvatar(file) {
        if (!AppState.getUser()) throw new Error('Brak zalogowanego użytkownika.');
        if (!ALLOWED_TYPES.includes(file.type)) {
            throw new Error('Dozwolone formaty: PNG, JPG, WEBP, GIF.');
        }
        if (file.size > MAX_AVATAR_BYTES) {
            throw new Error('Plik jest za duży (maks. 3 MB).');
        }

        const userId = AppState.getUser().id;
        const ext = (file.name.split('.').pop() || 'png').toLowerCase();
        const path = `${userId}/avatar.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(path, file, { upsert: true, cacheControl: '3600' });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(path);
        // Doklej znacznik czasu, żeby przeglądarka nie pokazywała starego awatara z cache.
        const avatarUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

        const { error: updateError } = await supabase
            .from('users')
            .update({ avatar_url: avatarUrl })
            .eq('id', userId);

        if (updateError) throw updateError;

        return avatarUrl;
    },

    /** Ostatnie logowania na to konto (IP, urządzenie, data) - do wglądu w ustawieniach. */
    async getLoginHistory(limit = 15) {
        if (!AppState.getUser()) return [];
        const { data, error } = await supabase
            .from('login_history')
            .select('*')
            .eq('user_id', AppState.getUser().id)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Nie udało się pobrać historii logowań', error);
            return [];
        }
        return data;
    },
};
