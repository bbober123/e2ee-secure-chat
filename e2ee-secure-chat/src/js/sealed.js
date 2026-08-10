/**
 * sealed.js — jednorazowe, "zapieczętowane" (sealed box) szyfrowanie X3DH
 * bez utrzymywania stanu Double Ratchet. Używane WYŁĄCZNIE do przesyłania
 * krótkich, rzadkich pakietów kontrolnych między dwiema osobami, które
 * niekoniecznie są ze sobą w ogóle "znajomymi" (np. dystrybucja Sender Key
 * przy dołączeniu do grupy — patrz groupkeys.js). Dla zwykłych wiadomości
 * używamy PEŁNEGO Double Ratchet (ratchet.js) — sealed.js NIE daje forward
 * secrecy między kolejnymi pakietami do tej samej osoby (to jednorazowy X3DH,
 * nie łańcuch), co jest akceptowalne dla rzadkich, krótkich payloadów
 * kontrolnych, ale NIE powinno być używane do treści rozmowy.
 */
import { CryptoEngine, utils } from './crypto.js';

/** Nadawca: szyfruje plaintext dla odbiorcy, którego bundle (IK/SPK/OPK) już ma. */
export async function sealedEncrypt({ identityPriv, identityPubJwk, bundle, plaintext }) {
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephemeralPubJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);

    const rootKeyRaw = await CryptoEngine.x3dhInitiator({ identityPriv, ephemeralPriv: ephemeral.privateKey, bundle });
    const mkRaw = await CryptoEngine.hkdfRaw(rootKeyRaw, new Uint8Array(32), 'securechat-sealed-v1', 32);
    const mkKey = await crypto.subtle.importKey('raw', mkRaw, { name: 'AES-GCM' }, false, ['encrypt']);

    const nonce = utils.generateRandomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, mkKey, new TextEncoder().encode(plaintext));

    return JSON.stringify({
        ik: identityPubJwk,
        ek: ephemeralPubJwk,
        spkId: bundle.spkId,
        opkId: bundle.opkId ?? null,
        ciphertext: utils.bufferToBase64(ciphertext),
        nonce: utils.bufferToBase64(nonce)
    });
}

/**
 * Odbiorca: odszyfrowuje pakiet, dopasowując SPK/OPK po id z lokalnego vaulta.
 * `spkKeyPairsById`/`opksById` to mapy {id: {privateJwk}} z IdentityVault odbiorcy.
 */
export async function sealedDecrypt({ identityPriv, spkKeyPairsById, opksById, payloadJson }) {
    const payload = JSON.parse(payloadJson);

    const spkEntry = spkKeyPairsById[payload.spkId];
    if (!spkEntry) {
        throw new Error('Nieznany Signed Prekey (już zrotowany?) — nie można otworzyć tego pakietu.');
    }
    const spkPriv = await crypto.subtle.importKey('jwk', spkEntry.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

    let opkPriv = null;
    if (payload.opkId != null && opksById[payload.opkId]) {
        opkPriv = await crypto.subtle.importKey('jwk', opksById[payload.opkId].privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    }

    const rootKeyRaw = await CryptoEngine.x3dhResponder({
        identityPriv, spkPriv, opkPriv,
        initiatorIkPubJwk: payload.ik, initiatorEkPubJwk: payload.ek
    });
    const mkRaw = await CryptoEngine.hkdfRaw(rootKeyRaw, new Uint8Array(32), 'securechat-sealed-v1', 32);
    const mkKey = await crypto.subtle.importKey('raw', mkRaw, { name: 'AES-GCM' }, false, ['decrypt']);

    const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(utils.base64ToBuffer(payload.nonce)) },
        mkKey,
        utils.base64ToBuffer(payload.ciphertext)
    );
    return new TextDecoder().decode(plainBuf);
}
