import { supabase } from './supabase.js';
import { CryptoEngine, DoubleVault, KeyManager, utils } from './crypto.js';
import { AccountSwitcher } from './accounts.js';

export const keyManager = new KeyManager();
window.APP_MODE = null; // 'real' or 'fake'
window.CURRENT_USER = null;

export class AuthManager {
    static INACTIVITY_LIMIT_MS = 5 * 60 * 1000;
    static autoLockTimer = null;

    static async generateDeviceFingerprint() {
        let deviceId = localStorage.getItem('securechat_device_id');
        if (!deviceId) {
            deviceId = crypto.randomUUID();
            localStorage.setItem('securechat_device_id', deviceId);
        }
        return deviceId;
    }

    /** Publiczne IP tego urządzenia (best-effort, tylko do logu bezpieczeństwa). */
    static async getPublicIp() {
        try {
            const res = await fetch('https://api.ipify.org?format=json');
            if (!res.ok) return null;
            const data = await res.json();
            return data.ip || null;
        } catch (e) {
            console.warn('Nie udało się pobrać adresu IP', e);
            return null;
        }
    }

    /**
     * Zapisuje zdarzenie logowania (IP, urządzenie, przeglądarka) w historii
     * konta oraz aktualizuje ostatnie IP na rekordzie urządzenia.
     */
    static async recordLoginEvent(userId, fingerprint) {
        try {
            const ip = await this.getPublicIp();
            const userAgent = navigator.userAgent;
            const now = new Date().toISOString();

            await supabase.from('login_history').insert({
                user_id: userId,
                device_fingerprint: fingerprint,
                ip,
                user_agent: userAgent,
            });

            await supabase.from('devices')
                .update({ last_ip: ip, last_user_agent: userAgent, last_login_at: now })
                .eq('user_id', userId)
                .eq('device_fingerprint', fingerprint);
        } catch (e) {
            // Logowanie IP nigdy nie powinno blokować logowania do aplikacji.
            console.warn('Nie udało się zapisać historii logowania', e);
        }
    }

    /** Zapisuje/odświeża sesję tego konta na liście kont zapisanych na tym urządzeniu. */
    static async saveAccountSession(profile) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) AccountSwitcher.save(profile, session);
    }

    static async register(email, username, passwordReal, passwordFake) {
        const fakePass = passwordFake || passwordReal; 
        const vaultData = await DoubleVault.createUser(passwordReal, fakePass);
        
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password: passwordReal,
        });

        if (authError) throw authError;

        if (!authData.session) {
            // Supabase ma włączone "Confirm email" - signUp() nie zwraca aktywnej sesji,
            // więc auth.uid() jest puste i polityki RLS odrzucą zapis do users/devices.
            // Wyłącz "Confirm email" w Supabase (Authentication -> Providers -> Email)
            // dla tej aplikacji, albo dokończ rejestrację profilu po potwierdzeniu adresu.
            throw new Error(
                "Konto utworzone, ale wymaga potwierdzenia e-mail zanim można dokończyć rejestrację " +
                "(zapis kluczy szyfrujących). Potwierdź adres e-mail, a następnie skontaktuj się z administratorem " +
                "lub wyłącz 'Confirm email' w ustawieniach Supabase i zarejestruj się ponownie."
            );
        }

        const userId = authData.user.id;

        const { error: userError } = await supabase.from('users').insert({
            id: userId,
            email: email,
            username: username,
            public_key_real: vaultData.userRecord.public_key_real,
            public_key_fake: vaultData.userRecord.public_key_fake,
            salt_real: vaultData.userRecord.salt_real,
            salt_fake: vaultData.userRecord.salt_fake,
        });

        if (userError) {
            if (userError.code === '23505') {
                throw new Error("Ta nazwa użytkownika lub e-mail jest już zajęta.");
            }
            throw userError;
        }

        const fingerprint = await this.generateDeviceFingerprint();
        
        const { error: deviceError } = await supabase.from('devices').insert({
            user_id: userId,
            device_fingerprint: fingerprint,
            encrypted_private_key_real: vaultData.deviceRecord.encrypted_private_key_real,
            encrypted_private_key_fake: vaultData.deviceRecord.encrypted_private_key_fake
        });

        if (deviceError) throw deviceError;
        
        return authData;
    }

    static async loginAndUnlock(email, password) {
        // Zaloguj do Supabase. Uwaga: logowanie od zera w Supabase wymaga prawdziwego hasła. 
        // Fake mode na czystym urządzeniu nie jest wspierany z powodu braku backendu.
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password: password,
        });

        if (authError) throw authError;

        sessionStorage.setItem('lastUserEmail', email);

        // Pobierz fingerprint
        const fingerprint = await this.generateDeviceFingerprint();
        const userId = authData.user.id;

        let { data: deviceRecord, error: fetchError } = await supabase
            .from('devices')
            .select('*, users!inner(salt_real, salt_fake, username, avatar_url)')
            .eq('user_id', userId)
            .eq('device_fingerprint', fingerprint)
            .single();

        let isNewDevice = false;

        if (fetchError || !deviceRecord) {
            // Urządzenie nieznane - pobierz klucze z innego rekordu tego samego użytkownika
            let { data: anyDevice, error: anyDeviceError } = await supabase
                .from('devices')
                .select('*, users!inner(salt_real, salt_fake, username, avatar_url)')
                .eq('user_id', userId)
                .limit(1)
                .single();

            if (anyDeviceError || !anyDevice) {
                throw new Error("Brak kluczy szyfrujących dla tego konta.");
            }

            // Automatycznie dodaj to urządzenie do bazy, aby użytkownik mógł się logować
            const { error: insertError } = await supabase.from('devices').insert({
                user_id: userId,
                device_fingerprint: fingerprint,
                encrypted_private_key_real: anyDevice.encrypted_private_key_real,
                encrypted_private_key_fake: anyDevice.encrypted_private_key_fake,
            });

            if (insertError) throw new Error("Błąd podczas konfiguracji urządzenia.");

            deviceRecord = anyDevice;
            isNewDevice = true;

            // Przejrzystość dla użytkownika: to urządzenie zostało właśnie dodane do konta.
            // Samo dodanie wymagało poprawnego hasła (auth.uid() z Supabase Auth), więc nie jest to
            // luka sama w sobie, ale użytkownik powinien być o tym poinformowany (np. żeby zauważyć,
            // gdyby ktoś inny logował się na jego konto z nieznanego urządzenia).
            console.info('[SecureChat] Nowe urządzenie zostało dodane do konta:', fingerprint);
        }

        // Odblokuj klucze
        const unlockResult = await keyManager.unlockDevice(userId, password, fingerprint, deviceRecord);
        
        window.APP_MODE = unlockResult.mode;
        window.CURRENT_USER = authData.user;
        this.startAutoLockTimer();

        await this.recordLoginEvent(userId, fingerprint);
        await this.saveAccountSession({
            id: userId,
            email,
            username: deviceRecord.users?.username,
            avatar_url: deviceRecord.users?.avatar_url,
        });

        return { ...unlockResult, isNewDevice };
    }

    static async unlock(password) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Brak aktywnej sesji Supabase.");

        const userId = session.user.id;
        const fingerprint = await this.generateDeviceFingerprint();

        const { data: deviceRecord, error: fetchError } = await supabase
            .from('devices')
            .select('*, users!inner(salt_real, salt_fake, username, avatar_url)')
            .eq('user_id', userId)
            .eq('device_fingerprint', fingerprint)
            .single();

        if (fetchError || !deviceRecord) {
            this.logout();
            throw new Error("Sesja wygasła lub to urządzenie nie jest w pełni skonfigurowane. Zaloguj się ponownie używając loginu i hasła.");
        }

        // System automatycznie próbuje REAL, a następnie FAKE klucz
        const unlockResult = await keyManager.unlockDevice(userId, password, fingerprint, deviceRecord);
        
        window.APP_MODE = unlockResult.mode;
        window.CURRENT_USER = session.user;
        
        if (window.APP_MODE === 'fake') {
            await this.ensureFakeMessagesExist();
        }

        this.startAutoLockTimer();

        await this.recordLoginEvent(userId, fingerprint);
        await this.saveAccountSession({
            id: userId,
            email: session.user.email,
            username: deviceRecord.users?.username,
            avatar_url: deviceRecord.users?.avatar_url,
        });

        return unlockResult;
    }

    /**
     * Przełącza się na inne konto zapisane na tym urządzeniu (bez ponownego
     * wpisywania e-maila/loginu) - wystarczy hasło do odblokowania sejfu E2EE
     * tego konta.
     */
    static async switchAccount(userId, password) {
        keyManager.clearMemory();
        this.clearAutoLockTimer();
        window.APP_MODE = null;
        window.CURRENT_USER = null;

        await AccountSwitcher.activate(userId);
        return await this.unlock(password);
    }

    static async ensureFakeMessagesExist() {
        // Funkcja z punktu 5g - generuje fake wiadomości jeśli pusto
        // Wymaga pobrania konwersacji w fake mode, zostawimy to do implementacji warstwy UI / DB
    }

    static async logout() {
        // Wylogowanie usuwa TYLKO to jedno konto z listy zapisanych na tym
        // urządzeniu - dopóki się nie wylogujesz, konto zostaje zapamiętane
        // i można się na nie przełączyć bez ponownego wpisywania loginu.
        // Uwaga: nie czyścimy 'securechat_device_id' - to ten sam identyfikator
        // urządzenia jest współdzielony przez wszystkie zalogowane tu konta.
        if (window.CURRENT_USER) {
            AccountSwitcher.remove(window.CURRENT_USER.id);
        }

        keyManager.clearMemory();
        window.APP_MODE = null;
        window.CURRENT_USER = null;
        this.clearAutoLockTimer();
        sessionStorage.removeItem('lastUserEmail');
        await supabase.auth.signOut();
        
        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) lockScreen.style.display = 'none';
        
        // Reset do ekranu logowania
        window.location.reload();
    }

    static startAutoLockTimer() {
        this.clearAutoLockTimer();
        this.autoLockTimer = setTimeout(() => {
            this.lockDevice();
        }, this.INACTIVITY_LIMIT_MS);

        // Nasłuchiwanie aktywności
        const resetEvents = ['mousemove', 'keydown', 'click'];
        resetEvents.forEach(event => {
            window.addEventListener(event, this.resetAutoLockTimer, { passive: true });
        });
    }

    static resetAutoLockTimer = () => {
        if (!keyManager.hasUnlockedKeys()) return;
        this.clearAutoLockTimer();
        this.autoLockTimer = setTimeout(() => {
            this.lockDevice();
        }, this.INACTIVITY_LIMIT_MS);
    };

    static clearAutoLockTimer() {
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
    }

    static lockDevice() {
        keyManager.clearMemory();
        window.APP_MODE = null;
        this.clearAutoLockTimer();
        
        // Pokaż overlay odblokowania
        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) {
            lockScreen.style.display = 'flex';
            lockScreen.style.opacity = '1';
        }
    }
}
