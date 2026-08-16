import { supabase } from './supabase.js';
import { CryptoEngine, utils } from './crypto.js';
import { DoubleRatchet } from './ratchet.js';

const SPK_ROTATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dni
const OPK_BATCH_SIZE = 20;
const OPK_TOPUP_THRESHOLD = 5;

/**
 * IdentityVault — komplet materiału kryptograficznego jednej tożsamości
 * (real ALBO fake): Identity Key (ECDH, do X3DH), Identity Signing Key
 * (ECDSA, do podpisywania SPK), aktualny Signed Prekey i zapas One-Time
 * Prekeys. Trzymany WYŁĄCZNIE w RAM po odblokowaniu; na dysku istnieje
 * tylko jako ciphertext (AES-GCM, kluczem z PBKDF2(hasło)) w devices.encrypted_prekey_vault_{real|fake}.
 */
export class IdentityVault {
    static async create() {
        const identity = await CryptoEngine.generateIdentityDHKeyPair();
        const signing = await CryptoEngine.generateIdentitySigningKeyPair();
        const spk = await CryptoEngine.generateSignedPrekey(signing.privateKey, 1);
        const opks = await CryptoEngine.generateOneTimePrekeys(OPK_BATCH_SIZE, 1);

        return {
            identityDh: { publicJwk: identity.publicJwk, privateJwk: identity.privateJwk },
            identitySign: { publicJwk: signing.publicJwk, privateJwk: signing.privateJwk },
            spk: { id: spk.prekeyId, publicJwk: spk.publicJwk, privateJwk: spk.privateJwk, signature: spk.signature, createdAt: Date.now() },
            opks: opks.map(o => ({ id: o.prekeyId, publicJwk: o.publicJwk, privateJwk: o.privateJwk })),
            nextOpkId: OPK_BATCH_SIZE + 1
        };
    }

    /** Bundle publiczny do zapisu w users/signed_prekeys/one_time_prekeys. */
    static publicBundle(vault) {
        return {
            identity_bundle: JSON.stringify({ dh: vault.identityDh.publicJwk, sign: vault.identitySign.publicJwk }),
            signed_prekey: { prekeyId: vault.spk.id, publicKey: JSON.stringify(vault.spk.publicJwk), signature: vault.spk.signature },
            one_time_prekeys: vault.opks.map(o => ({ prekeyId: o.id, publicKey: JSON.stringify(o.publicJwk) }))
        };
    }

    static async encrypt(vault, passwordKey) {
        return await CryptoEngine.encryptPrivateKey(vault, passwordKey);
    }

    static async decrypt(ciphertextBase64, ivBase64, passwordKey) {
        return await CryptoEngine.decryptPrivateKey(ciphertextBase64, ivBase64, passwordKey);
    }

    /** Importuje JWK-i zapisane w vaulcie z powrotem do (non-extractable) obiektów CryptoKey gotowych do użycia. */
    static async importUsableKeys(vault) {
        const identityPriv = await crypto.subtle.importKey('jwk', vault.identityDh.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        const identityPub = await crypto.subtle.importKey('jwk', vault.identityDh.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
        return { identityPriv, identityPub, identityPubJwk: vault.identityDh.publicJwk };
    }
}

/** Zapisuje pełny bundle (IK, SPK, OPKs) danego trybu na serwerze — wołane raz przy rejestracji i po każdej rotacji/uzupełnieniu. */
export async function publishBundle(userId, mode, vault) {
    const bundle = IdentityVault.publicBundle(vault);
    const column = mode === 'fake' ? 'identity_bundle_fake' : 'identity_bundle_real';

    await supabase.from('users').update({ [column]: bundle.identity_bundle }).eq('id', userId);

    await supabase.from('signed_prekeys').upsert({
        user_id: userId,
        mode,
        prekey_id: bundle.signed_prekey.prekeyId,
        public_key: bundle.signed_prekey.publicKey,
        signature: bundle.signed_prekey.signature
    }, { onConflict: 'user_id,mode,prekey_id' });

    if (bundle.one_time_prekeys.length) {
        await supabase.from('one_time_prekeys').upsert(
            bundle.one_time_prekeys.map(o => ({
                user_id: userId,
                mode,
                prekey_id: o.prekeyId,
                public_key: o.publicKey,
                used: false
            })),
            { onConflict: 'user_id,mode,prekey_id' }
        );
    }
}

/** Rotuje Signed Prekey jeśli starszy niż 7 dni. Zwraca zaktualizowany vault (ten sam obiekt, zmutowany) i publikuje zmianę, jeśli nastąpiła. */
export async function rotateSignedPrekeyIfNeeded(userId, mode, vault) {
    if (Date.now() - vault.spk.createdAt < SPK_ROTATION_MS) return vault;

    const signingPrivateKey = await crypto.subtle.importKey('jwk', vault.identitySign.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const newSpk = await CryptoEngine.generateSignedPrekey(signingPrivateKey, vault.spk.id + 1);
    vault.spk = { id: newSpk.prekeyId, publicJwk: newSpk.publicJwk, privateJwk: newSpk.privateJwk, signature: newSpk.signature, createdAt: Date.now() };

    await publishBundle(userId, mode, vault);
    return vault;
}

/** Dogenerowuje kolejną porcję OPK, jeśli lokalny zapas jest niski (sprawdzone po stronie serwera). */
export async function topUpOneTimePrekeysIfNeeded(userId, mode, vault) {
    const { count } = await supabase.from('one_time_prekeys')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('mode', mode).eq('used', false);

    if ((count ?? 0) >= OPK_TOPUP_THRESHOLD) return vault;

    const fresh = await CryptoEngine.generateOneTimePrekeys(OPK_BATCH_SIZE, vault.nextOpkId);
    vault.opks.push(...fresh.map(o => ({ id: o.prekeyId, publicJwk: o.publicJwk, privateJwk: o.privateJwk })));
    vault.nextOpkId += OPK_BATCH_SIZE;

    await publishBundle(userId, mode, vault);
    return vault;
}

/**
 * Pobiera bundle kontaktu do X3DH: tożsamość, najnowszy (zweryfikowany podpisem) SPK,
 * i atomowo "zaklaimowany" (used=true, jednorazowo) OPK przez RPC — patrz claim_one_time_prekey
 * w database.sql. Zwraca null jeśli kontakt nie ma jeszcze opublikowanych kluczy (stare konto sprzed migracji).
 */
export async function fetchPrekeyBundle(contactUserId, mode) {
    const column = mode === 'fake' ? 'identity_bundle_fake' : 'identity_bundle_real';
    const { data: userRow } = await supabase.from('users').select(column).eq('id', contactUserId).single();
    if (!userRow || !userRow[column]) return null;

    const { data: spkRow } = await supabase.from('signed_prekeys')
        .select('*').eq('user_id', contactUserId).eq('mode', mode)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!spkRow) return null;

    const identity = JSON.parse(userRow[column]);
    const spkPubJwk = JSON.parse(spkRow.public_key);

    // Zweryfikuj podpis SPK kluczem podpisującym tożsamości kontaktu, ZANIM go użyjemy —
    // to jedyna rzecz w X3DH, która wykrywa podstawiony/sfałszowany SPK od nieuczciwego serwera.
    const signingPubKey = await crypto.subtle.importKey('jwk', identity.sign, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const valid = await CryptoEngine.verifyEcdsa(signingPubKey, CryptoEngine.canonicalEcdhJwk(spkPubJwk), spkRow.signature);
    if (!valid) {
        throw new Error('Podpis Signed Prekey kontaktu jest NIEPRAWIDŁOWY — możliwa próba podstawienia klucza. Wysyłanie zablokowane.');
    }

    let opkPubJwk = null, opkId = null;
    const { data: claimed } = await supabase.rpc('claim_one_time_prekey', { target_user_id: contactUserId, target_mode: mode });
    if (claimed && claimed.length) {
        opkPubJwk = JSON.parse(claimed[0].public_key);
        opkId = claimed[0].prekey_id;
    }

    return {
        ikPubJwk: identity.dh,
        spkPubJwk,
        spkId: spkRow.prekey_id,
        opkPubJwk,
        opkId
    };
}

// -----------------------------------------------------------------------
// Persystencja stanu ratchetu (zaszyfrowana, per-device, przetrwa F5)
// -----------------------------------------------------------------------

export async function saveRatchetState(userId, conversationId, mode, deviceFingerprint, ratchet, passwordKey) {
    const stateJson = ratchet.serialize();
    if (!stateJson) return;

    const data = new TextEncoder().encode(stateJson);
    const nonce = utils.generateRandomBytes(12);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, passwordKey, data);

    await supabase.from('ratchet_states').upsert({
        user_id: userId,
        conversation_id: conversationId,
        device_fingerprint: deviceFingerprint,
        mode,
        encrypted_state: utils.bufferToBase64(encrypted),
        nonce: utils.bufferToBase64(nonce),
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,conversation_id,device_fingerprint,mode' });
}

export async function loadRatchetState(userId, conversationId, mode, deviceFingerprint, passwordKey) {
    const { data } = await supabase.from('ratchet_states')
        .select('*')
        .eq('user_id', userId)
        .eq('conversation_id', conversationId)
        .eq('device_fingerprint', deviceFingerprint)
        .eq('mode', mode)
        .maybeSingle();

    if (!data) return null;

    try {
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(utils.base64ToBuffer(data.nonce)) },
            passwordKey,
            utils.base64ToBuffer(data.encrypted_state)
        );
        return await DoubleRatchet.deserialize(new TextDecoder().decode(plainBuf));
    } catch (e) {
        console.error('Nie udało się odszyfrować zapisanego stanu ratchetu (złe hasło / uszkodzone dane)', e);
        return null;
    }
}
