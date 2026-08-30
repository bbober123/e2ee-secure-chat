/**
 * crypto/double-vault.js — DoubleVault: tworzenie użytkownika z plausible deniability
 * (generuje równolegle komplet kluczy 'real' i 'fake').
 */
import { utils } from './utils.js';
import { CryptoEngine } from './engine.js';

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

