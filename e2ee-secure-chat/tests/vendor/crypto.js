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

    // =================================================================
    // === X3DH + Double Ratchet — prymitywy niskiego poziomu       ===
    // === (RSA-4096 powyżej zostaje WYŁĄCZNIE dla src/js/calls.js —  ===
    // === wymiana kluczy połączeń głosowych/wideo nie jest w        ===
    // === zakresie tej zmiany; wiadomości tekstowe/media używają    ===
    // === odtąd wyłącznie poniższego).                              ===
    // =================================================================

    /** Identity Key (IK) — ECDH P-256, długoterminowy klucz tożsamości używany w X3DH. */
    static async generateIdentityDHKeyPair() {
        const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
        return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicJwk, privateJwk };
    }

    /**
     * Identity Signing Key — ECDSA P-256, osobny klucz od IK powyżej.
     * UWAGA / odejście od specyfikacji zadania: zadanie proponowało "podpis" Signed Prekey
     * jako HMAC-SHA256 z klucza prywatnego IK. To NIE działa jako podpis w kryptograficznym
     * sensie: HMAC to funkcja symetryczna — ktokolwiek miałby zweryfikować podpis, musiałby
     * znać ten sam sekret co podpisujący, czyli sam klucz prywatny IK. To niweczyłoby sens
     * podpisu (weryfikowalność przez stronę trzecią bez ujawniania sekretu). Web Crypto API
     * nie pozwala użyć jednego klucza P-256 zarówno do ECDH, jak i ECDSA, więc generujemy
     * DRUGI, osobny klucz P-256 wyłącznie do podpisywania Signed Prekey prawdziwym ECDSA —
     * to jedyny sposób, żeby SPK dało się faktycznie zweryfikować kluczem publicznym.
     */
    static async generateIdentitySigningKeyPair() {
        const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
        return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicJwk, privateJwk };
    }

    static async signEcdsa(signingPrivateKey, dataBytes) {
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingPrivateKey, dataBytes);
        return utils.bufferToBase64(sig);
    }

    static async verifyEcdsa(signingPublicKey, dataBytes, signatureBase64) {
        const sig = utils.base64ToBuffer(signatureBase64);
        return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingPublicKey, sig, dataBytes);
    }

    /** Kanoniczna (stabilna kolejność pól) reprezentacja JWK klucza publicznego ECDH P-256, do podpisywania/hashowania. */
    static canonicalEcdhJwk(jwk) {
        return new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
    }

    /** Signed Prekey (SPK) — ECDH P-256 rotowany co 7 dni, podpisany prawdziwym ECDSA przez klucz podpisujący tożsamości. */
    static async generateSignedPrekey(identitySigningPrivateKey, prekeyId) {
        const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
        const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
        const signature = await this.signEcdsa(identitySigningPrivateKey, this.canonicalEcdhJwk(publicJwk));
        return { prekeyId, publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk, signature };
    }

    /** One-Time Prekeys (OPK) — lista jednorazowych kluczy ECDH P-256, zużywanych po jednym DH-ie w X3DH. */
    static async generateOneTimePrekeys(count, startId = 1) {
        const out = [];
        for (let i = 0; i < count; i++) {
            const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
            const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
            const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
            out.push({ prekeyId: startId + i, publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk });
        }
        return out;
    }

    /** Surowy DH: importuje ewentualny JWK i zwraca 32 surowe bajty shared secret (deriveBits, NIE deriveKey — potrzebujemy bajtów do HKDF). */
    static async ecdhRaw(privateKey, publicKeyJwkOrCryptoKey) {
        const publicKey = publicKeyJwkOrCryptoKey instanceof CryptoKey
            ? publicKeyJwkOrCryptoKey
            : await crypto.subtle.importKey("jwk", publicKeyJwkOrCryptoKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
        return await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
    }

    /** HKDF-SHA256 na surowych bajtach -> surowe bajty (nie CryptoKey — root/chain keys muszą zostać w postaci, którą da się serializować/HMAC-ować dalej). */
    static async hkdfRaw(ikmRaw, saltRaw, infoStr, lengthBytes = 32) {
        const hkdfKey = await crypto.subtle.importKey("raw", ikmRaw, { name: "HKDF" }, false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: saltRaw || new Uint8Array(32),
                info: new TextEncoder().encode(infoStr)
            },
            hkdfKey,
            lengthBytes * 8
        );
        return bits;
    }

    /** HMAC-SHA256(keyRaw, dataBytes) -> 32 surowe bajty. Używane w KDF_CK (chain ratchet) i chain-init. */
    static async hmacSha256Raw(keyRaw, dataBytes) {
        const hmacKey = await crypto.subtle.importKey("raw", keyRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return await crypto.subtle.sign("HMAC", hmacKey, dataBytes);
    }

    /**
     * X3DH — strona inicjująca (Alice). Liczy DH1..DH3(/4) i wyprowadza 32-bajtowy Root Key.
     * bundle = { ikPubJwk, spkPubJwk, opkPubJwk? } — klucze publiczne Boba pobrane z serwera.
     */
    static async x3dhInitiator({ identityPriv, ephemeralPriv, bundle }) {
        const dh1 = await this.ecdhRaw(identityPriv, bundle.spkPubJwk);   // IKa  x SPKb
        const dh2 = await this.ecdhRaw(ephemeralPriv, bundle.ikPubJwk);   // EKa  x IKb
        const dh3 = await this.ecdhRaw(ephemeralPriv, bundle.spkPubJwk);  // EKa  x SPKb

        let combined;
        if (bundle.opkPubJwk) {
            const dh4 = await this.ecdhRaw(ephemeralPriv, bundle.opkPubJwk); // EKa x OPKb
            combined = new Uint8Array(128);
            combined.set(new Uint8Array(dh1), 0);
            combined.set(new Uint8Array(dh2), 32);
            combined.set(new Uint8Array(dh3), 64);
            combined.set(new Uint8Array(dh4), 96);
        } else {
            combined = new Uint8Array(96);
            combined.set(new Uint8Array(dh1), 0);
            combined.set(new Uint8Array(dh2), 32);
            combined.set(new Uint8Array(dh3), 64);
        }

        return await this.hkdfRaw(combined, new Uint8Array(32), "securechat-x3dh-v1", 32);
    }

    /**
     * X3DH — strona odbierająca (Bob). Odtwarza IDENTYCZNY Root Key używając własnych
     * kluczy prywatnych (IK, SPK, opcjonalnie OPK) i kluczy publicznych Alice z headera pierwszej wiadomości.
     */
    static async x3dhResponder({ identityPriv, spkPriv, opkPriv, initiatorIkPubJwk, initiatorEkPubJwk }) {
        const dh1 = await this.ecdhRaw(spkPriv, initiatorIkPubJwk);  // SPKb x IKa
        const dh2 = await this.ecdhRaw(identityPriv, initiatorEkPubJwk); // IKb x EKa
        const dh3 = await this.ecdhRaw(spkPriv, initiatorEkPubJwk);  // SPKb x EKa

        let combined;
        if (opkPriv) {
            const dh4 = await this.ecdhRaw(opkPriv, initiatorEkPubJwk); // OPKb x EKa
            combined = new Uint8Array(128);
            combined.set(new Uint8Array(dh1), 0);
            combined.set(new Uint8Array(dh2), 32);
            combined.set(new Uint8Array(dh3), 64);
            combined.set(new Uint8Array(dh4), 96);
        } else {
            combined = new Uint8Array(96);
            combined.set(new Uint8Array(dh1), 0);
            combined.set(new Uint8Array(dh2), 32);
            combined.set(new Uint8Array(dh3), 64);
        }

        return await this.hkdfRaw(combined, new Uint8Array(32), "securechat-x3dh-v1", 32);
    }
}

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

/**
 * Tworzenie użytkownika z 'plausible deniability' - generacja podwójnych kluczy.
 * Generuje RÓWNOLEGLE dwa niezależne komplety materiału: stare RSA-4096 (zostaje
 * WYŁĄCZNIE do wymiany kluczy połączeń w src/js/calls.js) oraz nowy komplet X3DH/Double
 * Ratchet (IdentityVault z prekeys.js) używany odtąd do wszystkich wiadomości tekstowych/media.
 */
export class DoubleVault {
    static async createUser(passwordReal, passwordFake, identityVaultReal, identityVaultFake) {
        const realKeys = await CryptoEngine.generateLongTermKeyPair();
        const fakeKeys = await CryptoEngine.generateLongTermKeyPair();

        const saltReal = utils.bufferToHex(utils.generateRandomBytes(16));
        const saltFake = utils.bufferToHex(utils.generateRandomBytes(16));

        const passwordKeyReal = await CryptoEngine.deriveKeyFromPassword(passwordReal, saltReal);
        const passwordKeyFake = await CryptoEngine.deriveKeyFromPassword(passwordFake, saltFake);

        const encryptedPrivateReal = await CryptoEngine.encryptPrivateKey(realKeys.privateJwk, passwordKeyReal);
        const encryptedPrivateFake = await CryptoEngine.encryptPrivateKey(fakeKeys.privateJwk, passwordKeyFake);

        const deviceRecord = {
            encrypted_private_key_real: JSON.stringify(encryptedPrivateReal),
            encrypted_private_key_fake: JSON.stringify(encryptedPrivateFake)
        };

        // identityVaultReal/Fake są opcjonalne w sygnaturze (import cykliczny prekeys.js<->crypto.js
        // byłby niewygodny) — auth.js przekazuje już zaszyfrowane { ciphertextBase64, ivBase64 } dla
        // każdego trybu, wyprodukowane przez IdentityVault.encrypt() tymi samymi passwordKeyReal/Fake.
        if (identityVaultReal) deviceRecord.encrypted_prekey_vault_real = JSON.stringify(identityVaultReal);
        if (identityVaultFake) deviceRecord.encrypted_prekey_vault_fake = JSON.stringify(identityVaultFake);

        return {
            userRecord: {
                public_key_real: JSON.stringify(realKeys.publicJwk),
                public_key_fake: JSON.stringify(fakeKeys.publicJwk),
                salt_real: saltReal,
                salt_fake: saltFake
            },
            deviceRecord,
            passwordKeyReal,
            passwordKeyFake
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
