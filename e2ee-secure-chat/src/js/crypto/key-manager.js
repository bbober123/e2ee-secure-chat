/**
 * crypto/key-manager.js — KeyManager: trzyma klucze WYŁĄCZNIE w pamięci RAM
 * (real/fake mode, hasło -> AES-GCM, odszyfrowany IdentityVault).
 */
import { CryptoEngine } from './engine.js';

/**
 * Menedżer kluczy przechowujący je wyłącznie w pamięci operacyjnej (RAM).
 */
export class KeyManager {
    constructor() {
        this.memoryKeys = new Map();
        this.currentMode = null; // 'real' lub 'fake'
        this.myPrivateKey = null; // Załadowany klucz prywatny (RSA) - tylko calls.js
        this.passwordKey = null; // AES-GCM CryptoKey z PBKDF2(hasło) - też szyfruje ratchet_states
        this.identityVault = null; // Odszyfrowany IdentityVault (patrz prekeys.js) trybu bieżącego
    }

    async unlockDevice(userId, password, deviceFingerprint, deviceRecord) {
        if (!deviceRecord) {
            throw new Error("Device not found");
        }

        // Możliwość dostosowania do struktury złączeń Supabase 
        // (np. record ma { users: { salt_real... } })
        const userSalts = deviceRecord.users || deviceRecord.user || deviceRecord;
        
        // 1. Spróbuj hasło 'fake'
        try {
            const fakePasswordKey = await CryptoEngine.deriveKeyFromPassword(password, userSalts.salt_fake);
            const fakeData = JSON.parse(deviceRecord.encrypted_private_key_fake);
            
            const privateJwk = await CryptoEngine.decryptPrivateKey(
                fakeData.ciphertextBase64,
                fakeData.ivBase64,
                fakePasswordKey
            );

            this.myPrivateKey = await crypto.subtle.importKey(
                "jwk",
                privateJwk,
                { name: "RSA-OAEP", hash: "SHA-256" },
                false, // non-extractable: raz w Web Crypto API, klucz prywatny nie może być odczytany przez JS (obrona przed XSS)
                ["decrypt"]
            );
            this.currentMode = 'fake';
            this.passwordKey = fakePasswordKey;
            this.identityVault = await this._decryptVaultIfPresent(deviceRecord.encrypted_prekey_vault_fake, fakePasswordKey);
            return { mode: 'fake', privateKey: this.myPrivateKey };
        } catch (e) {
            // Kontynuuj do sprawdzenia klucza 'real'
        }

        // 2. Spróbuj hasło 'real'
        try {
            const realPasswordKey = await CryptoEngine.deriveKeyFromPassword(password, userSalts.salt_real);
            const realData = JSON.parse(deviceRecord.encrypted_private_key_real);
            
            const privateJwk = await CryptoEngine.decryptPrivateKey(
                realData.ciphertextBase64,
                realData.ivBase64,
                realPasswordKey
            );

            this.myPrivateKey = await crypto.subtle.importKey(
                "jwk",
                privateJwk,
                { name: "RSA-OAEP", hash: "SHA-256" },
                false, // non-extractable: raz w Web Crypto API, klucz prywatny nie może być odczytany przez JS (obrona przed XSS)
                ["decrypt"]
            );
            this.currentMode = 'real';
            this.passwordKey = realPasswordKey;
            this.identityVault = await this._decryptVaultIfPresent(deviceRecord.encrypted_prekey_vault_real, realPasswordKey);
            return { mode: 'real', privateKey: this.myPrivateKey };
        } catch (e) {
            throw new Error("Invalid password");
        }
    }

    /** Odszyfrowuje encrypted_prekey_vault_{real|fake} jeśli kolumna istnieje (konto założone po tej migracji). */
    async _decryptVaultIfPresent(encryptedVaultJson, passwordKey) {
        if (!encryptedVaultJson) return null;
        try {
            const { ciphertextBase64, ivBase64 } = JSON.parse(encryptedVaultJson);
            return await CryptoEngine.decryptPrivateKey(ciphertextBase64, ivBase64, passwordKey);
        } catch (e) {
            console.warn('Nie udało się odszyfrować X3DH prekey vault (konto sprzed migracji?)', e);
            return null;
        }
    }

    getSessionKey(conversationId) {
        return this.memoryKeys.get(conversationId) || null;
    }

    setSessionKey(conversationId, key) {
        this.memoryKeys.set(conversationId, key);
    }

    clearMemory() {
        this.memoryKeys.clear();
        this.myPrivateKey = null;
        this.currentMode = null;
        this.passwordKey = null;
        this.identityVault = null;
    }

    hasUnlockedKeys() {
        return this.myPrivateKey !== null;
    }
}

