import { supabase } from './supabase.js';

const STORAGE_KEY = 'securechat_accounts';

/**
 * Przechowuje na tym urządzeniu listę kont, na które użytkownik się kiedyś
 * zalogował (tokeny sesji Supabase + podstawowy profil), dzięki czemu:
 *  - można przełączać się między wieloma zalogowanymi kontami bez ponownego
 *    wpisywania e-maila/loginu (wystarczy hasło do odblokowania sejfu E2EE),
 *  - konto pozostaje "zalogowane" na urządzeniu dopóki użytkownik świadomie
 *    się z niego nie wyloguje (logout usuwa je z tej listy).
 *
 * Tokeny sesji trzymane są lokalnie w tej przeglądarce/na tym urządzeniu -
 * to ten sam mechanizm, którego domyślnie używa klient Supabase
 * (persistSession), tylko rozszerzony o obsługę więcej niż jednego konta
 * naraz.
 */
export const AccountSwitcher = {
    _readAll() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            console.error('AccountSwitcher: nie udało się odczytać zapisanych kont', e);
            return {};
        }
    },

    _writeAll(map) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
        } catch (e) {
            console.error('AccountSwitcher: nie udało się zapisać kont', e);
        }
    },

    /**
     * Zapisuje/odświeża zapisaną sesję dla danego konta.
     * @param {{id: string, email: string, username: string, avatar_url?: string}} profile
     * @param {{access_token: string, refresh_token: string}} session
     */
    save(profile, session) {
        if (!profile?.id || !session?.refresh_token) return;
        const all = this._readAll();
        all[profile.id] = {
            id: profile.id,
            email: profile.email,
            username: profile.username,
            avatar_url: profile.avatar_url || null,
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            updated_at: new Date().toISOString(),
        };
        this._writeAll(all);
    },

    /** Zwraca zapisane konta, posortowane od ostatnio używanego. */
    list() {
        const all = this._readAll();
        return Object.values(all).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },

    /** Usuwa konto z listy zapisanych (wywoływane przy pełnym wylogowaniu). */
    remove(userId) {
        const all = this._readAll();
        delete all[userId];
        this._writeAll(all);
    },

    get(userId) {
        return this._readAll()[userId] || null;
    },

    /**
     * Aktywuje w kliencie Supabase zapisaną sesję innego konta (bez
     * wpisywania e-maila/hasła logowania - tylko hasło do odblokowania
     * sejfu E2EE trzeba będzie podać osobno przez AuthManager.unlock()).
     */
    async activate(userId) {
        const acc = this.get(userId);
        if (!acc) throw new Error('Nie znaleziono zapisanego konta na tym urządzeniu.');

        const { data, error } = await supabase.auth.setSession({
            access_token: acc.access_token,
            refresh_token: acc.refresh_token,
        });

        if (error || !data.session) {
            // Token odświeżający wygasł/został unieważniony - trzeba się zalogować od nowa.
            this.remove(userId);
            throw new Error('Sesja tego konta wygasła. Zaloguj się ponownie podając e-mail i hasło.');
        }

        // Zapisz odświeżone tokeny.
        this.save(acc, data.session);
        return acc;
    },
};
