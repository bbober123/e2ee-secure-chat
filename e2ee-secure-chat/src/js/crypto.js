/**
 * Narzędzia pomocnicze (Hex & Base64)
 */
export const utils = {
    bufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },
    base64ToBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    },
    bufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },
    /** Stałoczasowe porównanie dwóch stringów (np. fingerprintów kluczy) - chroni przed timing attack. */
    constantTimeEqual(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return diff === 0;
    },
    hexToBuffer(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return bytes.buffer;
    },
    generateRandomBytes(length = 12) {
        return crypto.getRandomValues(new Uint8Array(length));
    }
};

/**
 * Klasa CryptoEngine - silnik kryptograficzny Web Crypto API
 */
export class CryptoEngine {
    /**
     * Fingerprint klucza publicznego (do weryfikacji "safety number" / TOFU pinning).
     * Liczony z kanonicznej reprezentacji JWK (posortowane klucze modulus+exponent),
     * żeby ten sam klucz zawsze dawał ten sam fingerprint niezależnie od kolejności pól JSON.
     */
    static async fingerprintPublicKeyJwk(jwkStringOrObj) {
        const jwk = typeof jwkStringOrObj === 'string' ? JSON.parse(jwkStringOrObj) : jwkStringOrObj;
        // Dla RSA-OAEP jedynym materiałem kryptograficznym są n (modulus) i e (exponent).
        const canonical = JSON.stringify({ n: jwk.n, e: jwk.e, kty: jwk.kty });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
        const hex = utils.bufferToHex(digest);
        // Grupowanie w bloki po 4 znaki, ułatwia wizualne porównanie przez użytkowników (jak w Signal).
        return hex.match(/.{1,4}/g).join(' ');
    }

    static async deriveKeyFromPassword(password, saltHex, iterations = 600000) {
        const passwordBuffer = new TextEncoder().encode(password);
        const saltBuffer = utils.hexToBuffer(saltHex);

        const importedPassword = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );

        return await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: saltBuffer,
                iterations: iterations,
                hash: 'SHA-256'
            },
            importedPassword,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    static async generateLongTermKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 4096,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["encrypt", "decrypt"]
        );

        const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

        return {
            publicKey: keyPair.publicKey,
            privateKey: keyPair.privateKey,
            publicJwk,
            privateJwk
        };
    }

    static async generateEphemeralKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: "ECDH",
                namedCurve: "P-256"
            },
            true,
            ["deriveKey", "deriveBits"]
        );

        const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

        return {
            publicKey: keyPair.publicKey,
            privateKey: keyPair.privateKey,
            publicJwk,
            privateJwk
        };
    }

    static async encryptPrivateKey(privateJwk, passwordKey) {
        const privateKeyString = JSON.stringify(privateJwk);
        const data = new TextEncoder().encode(privateKeyString);
        const iv = utils.generateRandomBytes(12);

        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            passwordKey,
            data
        );

        return {
            ciphertextBase64: utils.bufferToBase64(ciphertext),
            ivBase64: utils.bufferToBase64(iv)
        };
    }

    static async decryptPrivateKey(encryptedDataBase64, ivBase64, passwordKey) {
        const ciphertext = utils.base64ToBuffer(encryptedDataBase64);
        const iv = new Uint8Array(utils.base64ToBuffer(ivBase64));

        if (iv.length !== 12) {
            throw new Error("Invalid IV length. Must be 12 bytes.");
        }

        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            passwordKey,
            ciphertext
        );

        const decryptedString = new TextDecoder().decode(decryptedBuffer);
        return JSON.parse(decryptedString);
    }

    static async deriveSessionKey(myEcdhPrivate, theirEcdhPublic) {
        const sharedSecretBits = await crypto.subtle.deriveBits(
            {
                name: "ECDH",
                public: theirEcdhPublic
            },
            myEcdhPrivate,
            256
        );

        const hkdfKey = await crypto.subtle.importKey(
            "raw",
            sharedSecretBits,
            { name: "HKDF" },
            false,
            ["deriveKey"]
        );

        const info = new TextEncoder().encode('securechat-session-v1');

        return await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(),
                info: info
            },
            hkdfKey,
            { name: "AES-GCM", length: 256 },
            false, // non-extractable: klucz sesyjny pochodny z ECDH nie powinien opuszczać Web Crypto API
            ["encrypt", "decrypt"]
        );
    }

    /**
     * Buduje "Additional Authenticated Data" dla AES-GCM z kontekstu wiadomości
     * (conversation_id + sender_id + mode [+ opcjonalny typ]). AAD nie jest
     * szyfrowane, ale JEST uwierzytelnione razem z ciphertextem: jeśli ktoś z
     * dostępem do bazy danych (np. przejęty/złośliwy backend) spróbuje
     * "sklejać" (splice) - czyli skopiować poprawny szyfrogram do innego
     * wiersza/konwersacji, zmienić sender_id albo przełożyć wiadomość między
     * trybem real/fake - AAD przy odszyfrowaniu się nie zgodzi i
     * `crypto.subtle.decrypt` rzuci błąd zamiast po cichu zaakceptować
     * podmienioną wiadomość. To domyka lukę, której samo AES-GCM (bez AAD)
     * nie adresuje: samo GCM chroni ciphertext przed modyfikacją, ale NIE
     * chroni przed przeniesieniem ważnego, niezmienionego ciphertextu w inny
     * kontekst.
     */
    static buildAAD(conversationId, senderId, mode) {
        return new TextEncoder().encode(`v1|${conversationId}|${senderId}|${mode}`);
    }

    static async encryptMessage(plaintext, sessionKey, aad = null) {
        const data = new TextEncoder().encode(plaintext);
        const nonce = utils.generateRandomBytes(12);

        const params = { name: "AES-GCM", iv: nonce };
        if (aad) params.additionalData = aad;

        const ciphertext = await crypto.subtle.encrypt(params, sessionKey, data);

        return {
            ciphertextBase64: utils.bufferToBase64(ciphertext),
            nonceBase64: utils.bufferToBase64(nonce)
        };
    }

    static async decryptMessage(ciphertextBase64, nonceBase64, sessionKey, aad = null) {
        const ciphertext = utils.base64ToBuffer(ciphertextBase64);
        const nonce = new Uint8Array(utils.base64ToBuffer(nonceBase64));

        if (nonce.length !== 12) {
            throw new Error("Invalid nonce length. Must be 12 bytes.");
        }

        const params = { name: "AES-GCM", iv: nonce };
        if (aad) params.additionalData = aad;

        const decryptedBuffer = await crypto.subtle.decrypt(params, sessionKey, ciphertext);

        return new TextDecoder().decode(decryptedBuffer);
    }

    /**
     * Wersja binarna encryptMessage/decryptMessage - do szyfrowania plików
     * (zdjęcia, filmy, głosówki) zamiast tekstu. Ten sam klucz sesyjny może
     * bezpiecznie posłużyć zarówno do zaszyfrowania treści jak i pliku w tej
     * samej wiadomości, o ile każde szyfrowanie używa własnego, świeżego,
     * losowego nonce (co `generateRandomBytes(12)` zapewnia - kolizja
     * 96-bitowego losowego nonce jest praktycznie niemożliwa).
     */
    static async encryptBytes(dataBuffer, sessionKey, aad = null) {
        const nonce = utils.generateRandomBytes(12);
        const params = { name: "AES-GCM", iv: nonce };
        if (aad) params.additionalData = aad;

        const ciphertext = await crypto.subtle.encrypt(params, sessionKey, dataBuffer);

        return {
            ciphertext, // ArrayBuffer (nie base64 - trzymamy binarnie do uploadu)
            nonceBase64: utils.bufferToBase64(nonce)
        };
    }

    static async decryptBytes(ciphertextBuffer, nonceBase64, sessionKey, aad = null) {
        const nonce = new Uint8Array(utils.base64ToBuffer(nonceBase64));
        if (nonce.length !== 12) {
            throw new Error("Invalid nonce length. Must be 12 bytes.");
        }
        const params = { name: "AES-GCM", iv: nonce };
        if (aad) params.additionalData = aad;

        return await crypto.subtle.decrypt(params, sessionKey, ciphertextBuffer);
    }

    static async encryptSessionKey(sessionKey, recipientPublicKey) {
        const rawKey = await crypto.subtle.exportKey("raw", sessionKey);

        const encryptedKeyBuffer = await crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            recipientPublicKey,
            rawKey
        );

        return utils.bufferToBase64(encryptedKeyBuffer);
    }

    static async decryptSessionKey(encryptedSessionKeyBase64, myPrivateKey) {
        const encryptedKeyBuffer = utils.base64ToBuffer(encryptedSessionKeyBase64);

        const rawKey = await crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            myPrivateKey,
            encryptedKeyBuffer
        );

        return await crypto.subtle.importKey(
            "raw",
            rawKey,
            { name: "AES-GCM" },
            false, // non-extractable: klucz sesyjny AES pozostaje wyłącznie wewnątrz Web Crypto API
            ["encrypt", "decrypt"]
        );
    }
}

/**
 * Menedżer kluczy przechowujący je wyłącznie w pamięci operacyjnej (RAM).
 */
export class KeyManager {
    constructor() {
        this.memoryKeys = new Map();
        this.currentMode = null; // 'real' lub 'fake'
        this.myPrivateKey = null; // Załadowany klucz prywatny (RSA)
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
            return { mode: 'real', privateKey: this.myPrivateKey };
        } catch (e) {
            throw new Error("Invalid password");
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
    }

    hasUnlockedKeys() {
        return this.myPrivateKey !== null;
    }
}

/**
 * Tworzenie użytkownika z 'plausible deniability' - generacja podwójnych kluczy.
 */
export class DoubleVault {
    static async createUser(passwordReal, passwordFake) {
        const realKeys = await CryptoEngine.generateLongTermKeyPair();
        const fakeKeys = await CryptoEngine.generateLongTermKeyPair();

        const saltReal = utils.bufferToHex(utils.generateRandomBytes(16));
        const saltFake = utils.bufferToHex(utils.generateRandomBytes(16));

        const passwordKeyReal = await CryptoEngine.deriveKeyFromPassword(passwordReal, saltReal);
        const passwordKeyFake = await CryptoEngine.deriveKeyFromPassword(passwordFake, saltFake);

        const encryptedPrivateReal = await CryptoEngine.encryptPrivateKey(realKeys.privateJwk, passwordKeyReal);
        const encryptedPrivateFake = await CryptoEngine.encryptPrivateKey(fakeKeys.privateJwk, passwordKeyFake);

        return {
            userRecord: {
                public_key_real: JSON.stringify(realKeys.publicJwk),
                public_key_fake: JSON.stringify(fakeKeys.publicJwk),
                salt_real: saltReal,
                salt_fake: saltFake
            },
            deviceRecord: {
                encrypted_private_key_real: JSON.stringify(encryptedPrivateReal),
                encrypted_private_key_fake: JSON.stringify(encryptedPrivateFake)
            }
        };
    }
}

/**
 * KeyTrustStore - wykrywanie zmiany klucza publicznego kontaktu (TOFU / "safety number").
 *
 * Problem: serwer (Supabase) dostarcza klucze publiczne kontaktów bez żadnej niezależnej
 * weryfikacji. Ktoś z dostępem administracyjnym do bazy (albo przejęty backend) mógłby
 * podstawić inny klucz publiczny i wykonać atak man-in-the-middle na wiadomości.
 *
 * To nie eliminuje ataku w 100% (prawdziwa ochrona wymaga poza-kanałowej weryfikacji,
 * jak porównanie "safety number" osobiście lub innym kanałem - patrz Signal), ale
 * wykrywa NIESPODZIEWANĄ zmianę klucza po pierwszym kontakcie, co jest głównym
 * praktycznym sygnałem ataku MITM lub przejęcia konta.
 *
 * Fingerprinty trzymane są per-urządzenie w localStorage (nie w bazie danych, żeby
 * sam serwer nie mógł ich fałszować).
 */
export class KeyTrustStore {
    static storageKey(userId, contactId, mode) {
        return `securechat_trust_${userId}_${contactId}_${mode}`;
    }

    /**
     * Sprawdza fingerprint klucza kontaktu wobec zapisanego wcześniej.
     * Zwraca: 'new' (pierwszy kontakt, zapisano), 'match' (zgodny), 'changed' (RÓŻNY - możliwy MITM).
     */
    static async verify(userId, contactId, mode, publicKeyJwkString) {
        const fingerprint = await CryptoEngine.fingerprintPublicKeyJwk(publicKeyJwkString);
        const key = this.storageKey(userId, contactId, mode);
        const stored = localStorage.getItem(key);

        if (!stored) {
            localStorage.setItem(key, fingerprint);
            return { status: 'new', fingerprint };
        }

        if (utils.constantTimeEqual(stored, fingerprint)) {
            return { status: 'match', fingerprint };
        }

        return { status: 'changed', fingerprint, previousFingerprint: stored };
    }

    /** Użytkownik świadomie zaakceptował nowy klucz (np. kontakt zmienił urządzenie) - aktualizujemy zaufany fingerprint. */
    static trustNewKey(userId, contactId, mode, fingerprint) {
        localStorage.setItem(this.storageKey(userId, contactId, mode), fingerprint);
    }
}
