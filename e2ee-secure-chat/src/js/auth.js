import { supabase } from './supabase.js';
import { CryptoEngine, DoubleVault, KeyManager, utils } from './crypto.js';

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

    static async register(email, username, passwordReal, passwordFake) {
        const fakePass = passwordFake || passwordReal; 
        const vaultData = await DoubleVault.createUser(passwordReal, fakePass);
        
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password: passwordReal,
        });

        if (authError) throw authError;

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

        if (userError) throw userError;

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
            .select('*, users!inner(salt_real, salt_fake)')
            .eq('user_id', userId)
            .eq('device_fingerprint', fingerprint)
            .single();

        if (fetchError || !deviceRecord) {
            // Urządzenie nieznane - pobierz klucze z innego rekordu tego samego użytkownika
            let { data: anyDevice, error: anyDeviceError } = await supabase
                .from('devices')
                .select('*, users!inner(salt_real, salt_fake)')
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
        }

        // Odblokuj klucze
        const unlockResult = await keyManager.unlockDevice(userId, password, fingerprint, deviceRecord);
        
        window.APP_MODE = unlockResult.mode;
        window.CURRENT_USER = authData.user;
        this.startAutoLockTimer();
        return unlockResult;
    }

    static async unlock(password) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Brak aktywnej sesji Supabase.");

        const userId = session.user.id;
        const fingerprint = await this.generateDeviceFingerprint();

        const { data: deviceRecord, error: fetchError } = await supabase
            .from('devices')
            .select('*, users!inner(salt_real, salt_fake)')
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
        return unlockResult;
    }

    static async ensureFakeMessagesExist() {
        // Funkcja z punktu 5g - generuje fake wiadomości jeśli pusto
        // Wymaga pobrania konwersacji w fake mode, zostawimy to do implementacji warstwy UI / DB
    }

    static async logout() {
        keyManager.clearMemory();
        window.APP_MODE = null;
        window.CURRENT_USER = null;
        this.clearAutoLockTimer();
        sessionStorage.removeItem('lastUserEmail');
        localStorage.removeItem('securechat_device_id');
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
