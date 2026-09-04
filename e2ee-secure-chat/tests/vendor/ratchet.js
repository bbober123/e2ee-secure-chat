/**
 * DoubleRatchet — implementacja Double Ratchet (wzorowana na Signal Protocol)
 * na bazie Web Crypto API (SubtleCrypto). Jedna instancja = jeden ratchet
 * dla jednej pary (konwersacja, tryb real/fake).
 *
 * Odejścia od pseudokodu w specyfikacji zadania (świadome, dla poprawności):
 *
 * 1. Root Key / Chain Key trzymane są jako SUROWE bajty (base64), nie jako
 *    CryptoKey AES-GCM. RK/CK to materiał wejściowy do HKDF/HMAC, a nie klucz
 *    do szyfrowania czegokolwiek wprost — import go jako AES-GCM (jak w
 *    przykładowym kodzie zadania) był technicznie niepoprawny i nie pozwalał
 *    później użyć go jako klucza HMAC/HKDF.
 *
 * 2. Inicjalizacja ratchetu Alice generuje NOWĄ parę kluczy ratchetu (DHs)
 *    OSOBNĄ od efemerycznego klucza X3DH (EK) — zgodnie z oryginalną
 *    specyfikacją Double Ratchet (RatchetInitAlice w spec Signal), a nie
 *    reużywa EK. EK służy wyłącznie do X3DH; DHs to klucz ratchetu wysyłany
 *    w nagłówku KAŻDEJ wiadomości.
 *
 * 3. encrypt() rzuca błąd, jeśli CKs jest puste (strona, która jeszcze nie
 *    odebrała żadnej wiadomości od inicjatora, nie może wysłać — to zgodne
 *    ze standardowym Double Ratchet: Bob dostaje CKs dopiero po przetworzeniu
 *    pierwszej wiadomości Alice, bo to ona niesie jego pierwszy DH ratchet).
 */
import { CryptoEngine, utils } from './crypto.js';

const MAX_SKIP = 1000;

async function importEcdhPublic(jwk) {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function generateRatchetKeyPair() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk };
}

function b64(buf) { return utils.bufferToBase64(buf); }
function unb64(str) { return new Uint8Array(utils.base64ToBuffer(str)); }

export class DoubleRatchet {
    constructor() {
        /** @type {null | {
         *   DHs: {publicKey:CryptoKey, privateKey:CryptoKey, publicJwk:object, privateJwk:object},
         *   DHrJwk: object|null,
         *   RK: string,           // base64, 32 bajty
         *   CKs: string|null,     // base64, 32 bajty
         *   CKr: string|null,     // base64, 32 bajty
         *   Ns: number, Nr: number, PN: number,
         *   MKSKIPPED: Map<string,string>  // "dhFingerprint:N" -> base64 message key
         * }} */
        this.state = null;
    }

    // -----------------------------------------------------------------
    // Inicjalizacja po X3DH
    // -----------------------------------------------------------------

    /**
     * Alice (inicjator otwiera pierwszą rozmowę). Wykonuje X3DH, generuje jej
     * własny, świeży klucz ratchetu (DHs), i sadowi Root Key + CKs.
     * Zwraca { x3dhHeader } do dołączenia do pierwszej wychodzącej wiadomości.
     */
    async initAsInitiator({ identityPriv, identityPubJwk, bundle }) {
        const ephemeral = await generateRatchetKeyPair(); // EK — tylko do X3DH
        const rootKeyRaw = await CryptoEngine.x3dhInitiator({ identityPriv, ephemeralPriv: ephemeral.privateKey, bundle });

        const ratchetKeyPair = await generateRatchetKeyPair(); // DHs — klucz ratchetu, osobny od EK
        const dh = await CryptoEngine.ecdhRaw(ratchetKeyPair.privateKey, bundle.spkPubJwk);
        const { rk, ck } = await this._kdfRk(rootKeyRaw, dh);

        this.state = {
            DHs: ratchetKeyPair,
            DHrJwk: bundle.spkPubJwk,
            RK: b64(rk),
            CKs: b64(ck),
            CKr: null,
            Ns: 0,
            Nr: 0,
            PN: 0,
            MKSKIPPED: new Map()
        };

        return {
            x3dhHeader: {
                ik: identityPubJwk,
                ek: ephemeral.publicJwk,
                spkId: bundle.spkId,
                opkId: bundle.opkId ?? null
            }
        };
    }

    /**
     * Bob — bootstrap z nagłówka x3dh pierwszej wiadomości Alice. Ustawia
     * RK, DHs = jego para SPK (reużyta jako początkowy klucz ratchetu, zgodnie
     * z RatchetInitBob), DHr = null (dostanie go za chwilę z decrypt()).
     */
    async initAsResponder({ identityPriv, spkKeyPair, opkPriv, x3dh }) {
        const rootKeyRaw = await CryptoEngine.x3dhResponder({
            identityPriv,
            spkPriv: spkKeyPair.privateKey,
            opkPriv: opkPriv || null,
            initiatorIkPubJwk: x3dh.ik,
            initiatorEkPubJwk: x3dh.ek
        });

        this.state = {
            DHs: spkKeyPair,
            DHrJwk: null,
            RK: b64(rootKeyRaw),
            CKs: null,
            CKr: null,
            Ns: 0,
            Nr: 0,
            PN: 0,
            MKSKIPPED: new Map()
        };
    }

    // -----------------------------------------------------------------
    // KDF-y
    // -----------------------------------------------------------------

    async _kdfRk(rootKeyRaw, dhOutRaw) {
        const out = await CryptoEngine.hkdfRaw(dhOutRaw, rootKeyRaw, 'securechat-ratchet-root-v1', 64);
        const bytes = new Uint8Array(out);
        return { rk: bytes.slice(0, 32), ck: bytes.slice(32, 64) };
    }

    async _kdfCk(chainKeyRaw) {
        const mk = await CryptoEngine.hmacSha256Raw(chainKeyRaw, new Uint8Array([0x01]));
        const ck = await CryptoEngine.hmacSha256Raw(chainKeyRaw, new Uint8Array([0x02]));
        return { messageKey: new Uint8Array(mk), newChainKey: new Uint8Array(ck) };
    }

    async _fingerprintJwk(jwk) {
        const digest = await crypto.subtle.digest('SHA-256', CryptoEngine.canonicalEcdhJwk(jwk));
        return utils.bufferToHex(digest);
    }

    // -----------------------------------------------------------------
    // DH Ratchet (patrz opis DHRatchet w SECURITY.md / opis w odpowiedzi)
    // -----------------------------------------------------------------

    /**
     * WERSJA "DRAFT": liczy nowy stan DH ratchetu na podstawie kopii roboczej
     * `draft` i zwraca ZAKTUALIZOWANY draft, NIE dotykając `this.state`.
     * `this.state` jest modyfikowany dopiero w decrypt() po potwierdzeniu,
     * że uwierzytelnione odszyfrowanie wiadomości faktycznie się powiodło —
     * inaczej pojedynczy sfałszowany/uszkodzony pakiet mógłby trwale rozsynchronizować
     * ratchet, mimo że sam zostałby poprawnie odrzucony (samo-DoS wywołany jednym złym pakietem).
     */
    async _draftDhRatchet(draft, newDHrJwk) {
        draft.PN = draft.Ns;
        draft.Ns = 0;
        draft.Nr = 0;
        draft.DHrJwk = newDHrJwk;

        const dh1 = await CryptoEngine.ecdhRaw(draft.DHs.privateKey, newDHrJwk);
        const step1 = await this._kdfRk(unb64(draft.RK), dh1);
        draft.RK = b64(step1.rk);
        draft.CKr = b64(step1.ck);

        draft.DHs = await generateRatchetKeyPair();

        const dh2 = await CryptoEngine.ecdhRaw(draft.DHs.privateKey, newDHrJwk);
        const step2 = await this._kdfRk(unb64(draft.RK), dh2);
        draft.RK = b64(step2.rk);
        draft.CKs = b64(step2.ck);
    }

    /**
     * WERSJA "DRAFT" pomijania kluczy: dopisuje nowo obliczone pominięte klucze
     * do `draft.newSkipped` (NIE do `this.state.MKSKIPPED` bezpośrednio) i
     * przesuwa `draft.CKr`/`draft.Nr` do przodu w kopii roboczej.
     */
    async _draftSkipMessageKeys(draft, until, fp) {
        if (draft.CKr === null) return;
        if (until - draft.Nr > MAX_SKIP) {
            throw new Error('Zbyt wiele pominiętych wiadomości — odrzucam (możliwy atak DoS na stan ratchetu).');
        }
        let ck = unb64(draft.CKr);
        while (draft.Nr < until) {
            const { messageKey, newChainKey } = await this._kdfCk(ck);
            draft.newSkipped.push([`${fp}:${draft.Nr}`, b64(messageKey)]);
            ck = newChainKey;
            draft.Nr += 1;
        }
        draft.CKr = b64(ck);
    }

    // -----------------------------------------------------------------
    // Szyfrowanie / deszyfrowanie wiadomości
    // -----------------------------------------------------------------

    async encrypt(plaintext) {
        const s = this.state;
        if (!s) throw new Error('Ratchet nie zainicjalizowany.');
        if (s.CKs === null) {
            throw new Error('Nie można jeszcze wysłać — poczekaj na pierwszą wiadomość od rozmówcy (Double Ratchet wymaga odebrania przed nadaniem przy świeżej sesji).');
        }

        const { messageKey, newChainKey } = await this._kdfCk(unb64(s.CKs));
        s.CKs = b64(newChainKey);
        s.Ns += 1;

        const nonce = utils.generateRandomBytes(12);
        const mkCryptoKey = await crypto.subtle.importKey('raw', messageKey, { name: 'AES-GCM' }, false, ['encrypt']);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, mkCryptoKey, new TextEncoder().encode(plaintext));

        const header = {
            dh: s.DHs.publicJwk,
            pn: s.PN,
            n: s.Ns - 1
        };

        return {
            ciphertextBase64: utils.bufferToBase64(ciphertext),
            nonceBase64: b64(nonce),
            headerJson: JSON.stringify(header)
        };
    }

    /**
     * Deszyfruje wiadomość. `headerJson` może (tylko dla samej pierwszej
     * wiadomości w konwersacji) zawierać pole `x3dh` — w takim wypadku wywołaj
     * najpierw initAsResponder() z tymi danymi, ZANIM wywołasz decrypt().
     *
     * WAŻNE (patrz komentarz przy _draftDhRatchet): cały nowy stan (DH ratchet,
     * pominięte klucze, przesunięcie chainu) jest liczony w lokalnym `draft` i
     * zapisywany do `this.state` DOPIERO po tym, jak `crypto.subtle.decrypt`
     * (uwierzytelnione AES-GCM) faktycznie się powiedzie. Jeśli ktoś podeśle
     * spreparowany/uszkodzony/powtórzony pakiet, `this.state` zostaje CAŁKOWICIE
     * nietknięty i ratchet działa dalej normalnie dla kolejnych, prawdziwych wiadomości.
     */
    async decrypt(ciphertextBase64, nonceBase64, headerJson) {
        const s = this.state;
        if (!s) throw new Error('Ratchet nie zainicjalizowany — brak stanu X3DH.');

        const header = JSON.parse(headerJson);
        const incomingFp = await this._fingerprintJwk(header.dh);
        const currentFp = s.DHrJwk ? await this._fingerprintJwk(s.DHrJwk) : null;

        // 1. Pominięte klucze (wiadomość mogła dotrzeć nie po kolei). Klucz z mapy
        // usuwamy DOPIERO po udanym odszyfrowaniu - jeśli pakiet jest sfałszowany,
        // legalna wiadomość będzie mogła nadal skorzystać z tego zapisanego klucza później.
        const skippedKey = `${incomingFp}:${header.n}`;
        if (s.MKSKIPPED.has(skippedKey)) {
            const mk = unb64(s.MKSKIPPED.get(skippedKey));
            const plaintext = await this._decryptWithMessageKey(mk, ciphertextBase64, nonceBase64);
            s.MKSKIPPED.delete(skippedKey);
            return plaintext;
        }

        // 2. Policz WSZYSTKO (ew. DH ratchet + domknięcie luki) w kopii roboczej.
        const draft = {
            DHrJwk: s.DHrJwk, DHs: s.DHs, RK: s.RK, CKr: s.CKr, CKs: s.CKs,
            Ns: s.Ns, Nr: s.Nr, PN: s.PN, newSkipped: []
        };

        const isNewRatchet = currentFp === null || incomingFp !== currentFp;
        if (isNewRatchet) {
            await this._draftSkipMessageKeys(draft, header.pn, currentFp);
            await this._draftDhRatchet(draft, header.dh);
        }
        await this._draftSkipMessageKeys(draft, header.n, incomingFp);

        const { messageKey, newChainKey } = await this._kdfCk(unb64(draft.CKr));

        // 3. Dopiero teraz próba uwierzytelnionego odszyfrowania - jeśli to się nie
        // uda (zły klucz/podrobiony tag), rzuci wyjątkiem i NIC poniżej się nie wykona.
        const plaintext = await this._decryptWithMessageKey(messageKey, ciphertextBase64, nonceBase64);

        // 4. Sukces - dopiero teraz zatwierdzamy cały draft (w tym pominięte klucze) do this.state.
        draft.CKr = b64(newChainKey);
        draft.Nr += 1;
        s.DHrJwk = draft.DHrJwk;
        s.DHs = draft.DHs;
        s.RK = draft.RK;
        s.CKr = draft.CKr;
        s.CKs = draft.CKs;
        s.Ns = draft.Ns;
        s.Nr = draft.Nr;
        s.PN = draft.PN;
        for (const [key, val] of draft.newSkipped) {
            s.MKSKIPPED.set(key, val);
            if (s.MKSKIPPED.size > MAX_SKIP) {
                s.MKSKIPPED.delete(s.MKSKIPPED.keys().next().value);
            }
        }

        return plaintext;
    }

    async _decryptWithMessageKey(messageKeyRaw, ciphertextBase64, nonceBase64) {
        const mkCryptoKey = await crypto.subtle.importKey('raw', messageKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
        const plaintextBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: unb64(nonceBase64) },
            mkCryptoKey,
            utils.base64ToBuffer(ciphertextBase64)
        );
        return new TextDecoder().decode(plaintextBuf);
    }

    // -----------------------------------------------------------------
    // Serializacja (do zaszyfrowanego zapisu w tabeli ratchet_states)
    // -----------------------------------------------------------------

    serialize() {
        const s = this.state;
        if (!s) return null;
        return JSON.stringify({
            v: 1,
            DHsPub: s.DHs.publicJwk,
            DHsPriv: s.DHs.privateJwk,
            DHrJwk: s.DHrJwk,
            RK: s.RK,
            CKs: s.CKs,
            CKr: s.CKr,
            Ns: s.Ns,
            Nr: s.Nr,
            PN: s.PN,
            MKSKIPPED: Array.from(s.MKSKIPPED.entries())
        });
    }

    static async deserialize(json) {
        const data = JSON.parse(json);
        const ratchet = new DoubleRatchet();

        const dhPrivateKey = await crypto.subtle.importKey(
            'jwk', data.DHsPriv, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
        );
        const dhPublicKey = await importEcdhPublic(data.DHsPub);

        ratchet.state = {
            DHs: { publicKey: dhPublicKey, privateKey: dhPrivateKey, publicJwk: data.DHsPub, privateJwk: data.DHsPriv },
            DHrJwk: data.DHrJwk,
            RK: data.RK,
            CKs: data.CKs,
            CKr: data.CKr,
            Ns: data.Ns,
            Nr: data.Nr,
            PN: data.PN,
            MKSKIPPED: new Map(data.MKSKIPPED || [])
        };
        return ratchet;
    }
}
