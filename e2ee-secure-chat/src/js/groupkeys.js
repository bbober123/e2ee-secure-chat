/**
 * groupkeys.js — szyfrowanie grupowe metodą "Sender Keys" (uproszczoną,
 * w duchu Signal Groups v2 / Sender Key Distribution Messages):
 *
 *  - każdy członek grupy ma WŁASNY łańcuch nadawczy: prosty hash-ratchet
 *    HMAC-SHA256 (KDF_CK z ratchet.js, bez kroku DH) — każda kolejna
 *    wiadomość tego samego nadawcy zużywa i odrzuca bieżący klucz łańcucha,
 *    idąc TYLKO do przodu (forward secrecy per-nadawca w obrębie grupy),
 *  - żeby pozostali członkowie mogli odczytać czyjeś wiadomości, ten
 *    ktoś musi im wcześniej PRZEKAZAĆ swój bieżący klucz łańcucha —
 *    dzieje się to pairwise, przez jednorazowy "zapieczętowany" pakiet
 *    X3DH (sealed.js), NIGDY przez sam serwer w jawnej postaci.
 *
 * Świadomy kompromis: to NIE jest pełny Double Ratchet między każdą parą
 * członków (co byłoby O(n²) operacji DH na każdą wiadomość grupową) — to
 * ten sam kompromis, jaki robi Signal/WhatsApp dla grup. Nowi członkowie
 * NIE widzą historii sprzed dołączenia (nie dostają przeszłych kluczy) —
 * to zamierzone zachowanie, nie błąd.
 */
import { supabase } from './supabase.js';
import { CryptoEngine, utils } from './crypto.js';
import { IdentityVault, fetchPrekeyBundle } from './prekeys.js';
import { sealedEncrypt, sealedDecrypt } from './sealed.js';

const MAX_SKIP = 1000;

function b64(buf) { return utils.bufferToBase64(buf); }
function unb64(str) { return new Uint8Array(utils.base64ToBuffer(str)); }

async function ratchetForward(chainKeyRaw) {
    const mk = await CryptoEngine.hmacSha256Raw(chainKeyRaw, new Uint8Array([0x01]));
    const ck = await CryptoEngine.hmacSha256Raw(chainKeyRaw, new Uint8Array([0x02]));
    return { messageKey: new Uint8Array(mk), newChainKey: new Uint8Array(ck) };
}

export class GroupCrypto {
    constructor() {
        /** @type {Map<string, { own: {chainKey:string, iteration:number}|null, members: Map<string,{chainKey:string, iteration:number, skipped:Map<number,string>}> }>} */
        this.groups = new Map();
    }

    _stateFor(groupId) {
        if (!this.groups.has(groupId)) {
            this.groups.set(groupId, { own: null, members: new Map() });
        }
        return this.groups.get(groupId);
    }

    hasOwnChain(groupId) {
        return !!this.groups.get(groupId)?.own;
    }

    hasMemberChain(groupId, memberId) {
        return !!this.groups.get(groupId)?.members?.has(memberId);
    }

    /** Generuje świeży, losowy własny łańcuch nadawczy (przy tworzeniu grupy lub dołączeniu do niej). */
    async initOwnChain(groupId) {
        const seed = utils.generateRandomBytes(32);
        const state = this._stateFor(groupId);
        state.own = { chainKey: b64(seed), iteration: 0 };
        return state.own;
    }

    /** Szyfruje wiadomość grupową własnym łańcuchem. Zwraca envelope gotowy do zapisu w messages.{ciphertext,nonce,header}. */
    async encrypt(groupId, plaintext) {
        const state = this._stateFor(groupId);
        if (!state.own) throw new Error('Brak własnego łańcucha nadawczego dla tej grupy — spróbuj ponownie otworzyć konwersację.');

        const { messageKey, newChainKey } = await ratchetForward(unb64(state.own.chainKey));
        const iteration = state.own.iteration;
        state.own.chainKey = b64(newChainKey);
        state.own.iteration += 1;

        const nonce = utils.generateRandomBytes(12);
        const mkKey = await crypto.subtle.importKey('raw', messageKey, { name: 'AES-GCM' }, false, ['encrypt']);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, mkKey, new TextEncoder().encode(plaintext));

        return {
            ciphertextBase64: b64(ciphertext),
            nonceBase64: b64(nonce),
            headerJson: JSON.stringify({ senderKeyIteration: iteration })
        };
    }

    /**
     * Deszyfruje wiadomość grupową od `senderId` — wymaga wcześniej odebranego łańcucha tego nadawcy.
     * Tak samo jak w ratchet.js: cały nowy stan (przesunięcie łańcucha, nowo pominięte klucze)
     * jest liczony w lokalnej kopii roboczej i commitowany do `member` DOPIERO po tym, jak
     * uwierzytelnione AES-GCM odszyfrowanie faktycznie się powiedzie — sfałszowany/uszkodzony
     * pakiet nie może trwale rozsynchronizować łańcucha nadawczego tego członka.
     */
    async decrypt(groupId, senderId, ciphertextBase64, nonceBase64, headerJson) {
        const header = JSON.parse(headerJson);
        const state = this._stateFor(groupId);
        const member = state.members.get(senderId);
        if (!member) {
            throw new Error('Nieznany łańcuch nadawczy tego członka — dystrybucja klucza jeszcze nie dotarła.');
        }
        if (!member.skipped) member.skipped = new Map();

        if (member.skipped.has(header.senderKeyIteration)) {
            const mk = unb64(member.skipped.get(header.senderKeyIteration));
            const plaintext = await this._open(mk, ciphertextBase64, nonceBase64);
            member.skipped.delete(header.senderKeyIteration); // dopiero po sukcesie
            return plaintext;
        }

        if (header.senderKeyIteration < member.iteration) {
            throw new Error('Klucz tej wiadomości został już zużyty i skasowany (forward secrecy).');
        }
        if (header.senderKeyIteration - member.iteration > MAX_SKIP) {
            throw new Error('Zbyt duża luka w łańcuchu nadawczym — odrzucam.');
        }

        let ck = unb64(member.chainKey);
        let iteration = member.iteration;
        const newSkipped = [];
        while (iteration < header.senderKeyIteration) {
            const { messageKey, newChainKey } = await ratchetForward(ck);
            newSkipped.push([iteration, b64(messageKey)]);
            ck = newChainKey;
            iteration += 1;
        }

        const { messageKey, newChainKey } = await ratchetForward(ck);

        // Dopiero teraz próba uwierzytelnionego odszyfrowania - jeśli się nie uda, nic poniżej się nie wykona.
        const plaintext = await this._open(messageKey, ciphertextBase64, nonceBase64);

        // Sukces - commitujemy draft: przesunięcie iteracji/chainKey i wszystkie nowo pominięte klucze.
        member.chainKey = b64(newChainKey);
        member.iteration = iteration + 1;
        for (const [it, mk] of newSkipped) {
            member.skipped.set(it, mk);
            if (member.skipped.size > MAX_SKIP) member.skipped.delete(member.skipped.keys().next().value);
        }

        return plaintext;
    }

    async _open(messageKeyRaw, ciphertextBase64, nonceBase64) {
        const mkKey = await crypto.subtle.importKey('raw', messageKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: unb64(nonceBase64) }, mkKey, utils.base64ToBuffer(ciphertextBase64)
        );
        return new TextDecoder().decode(plainBuf);
    }

    /** Zapisuje otrzymany (lub własny, świeżo zainicjowany) chain key `memberId` w RAM. */
    setMemberChain(groupId, memberId, chainKeyBase64, iteration = 0) {
        const state = this._stateFor(groupId);
        const existing = state.members.get(memberId);
        // Nie cofaj się: jeśli już mamy nowszy stan tego łańcucha (np. wielokrotna dystrybucja), zignoruj starszy pakiet.
        if (existing && existing.iteration >= iteration) return;
        state.members.set(memberId, { chainKey: chainKeyBase64, iteration, skipped: new Map() });
    }

    serializeGroup(groupId) {
        const state = this.groups.get(groupId);
        if (!state) return null;
        return JSON.stringify({
            own: state.own,
            members: Array.from(state.members.entries()).map(([id, m]) => [
                id,
                { chainKey: m.chainKey, iteration: m.iteration, skipped: Array.from((m.skipped || new Map()).entries()) }
            ])
        });
    }

    loadGroup(groupId, json) {
        const data = JSON.parse(json);
        this.groups.set(groupId, {
            own: data.own,
            members: new Map((data.members || []).map(([id, m]) => [id, { chainKey: m.chainKey, iteration: m.iteration, skipped: new Map(m.skipped || []) }]))
        });
    }
}

// -----------------------------------------------------------------------
// Persystencja (zaszyfrowana, analogicznie do ratchet_states dla rozmów 1:1)
// -----------------------------------------------------------------------

export async function saveGroupState(userId, groupId, mode, groupCrypto, passwordKey) {
    const json = groupCrypto.serializeGroup(groupId);
    if (!json || !passwordKey) return;
    const nonce = utils.generateRandomBytes(12);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, passwordKey, new TextEncoder().encode(json));
    await supabase.from('group_sender_states').upsert({
        user_id: userId,
        group_id: groupId,
        mode,
        encrypted_state: utils.bufferToBase64(encrypted),
        nonce: utils.bufferToBase64(nonce),
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,group_id,mode' });
}

export async function loadGroupState(userId, groupId, mode, groupCrypto, passwordKey) {
    if (!passwordKey) return false;
    const { data } = await supabase.from('group_sender_states').select('*')
        .eq('user_id', userId).eq('group_id', groupId).eq('mode', mode).maybeSingle();
    if (!data) return false;
    try {
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(utils.base64ToBuffer(data.nonce)) },
            passwordKey,
            utils.base64ToBuffer(data.encrypted_state)
        );
        groupCrypto.loadGroup(groupId, new TextDecoder().decode(plainBuf));
        return true;
    } catch (e) {
        console.error('Nie udało się odszyfrować lokalnego stanu Sender Keys tej grupy', e);
        return false;
    }
}

// -----------------------------------------------------------------------
// Dystrybucja kluczy (pairwise, jednorazowe pakiety X3DH — patrz sealed.js)
// -----------------------------------------------------------------------

/** Wysyła WŁASNY bieżący chain key (seed + aktualna iteracja) do jednego członka grupy. */
export async function distributeOwnKeyTo(groupId, mode, fromUserId, recipientUserId, groupCrypto, identityVault) {
    const state = groupCrypto._stateFor(groupId);
    if (!state.own) return;

    const bundle = await fetchPrekeyBundle(recipientUserId, mode);
    if (!bundle) throw new Error('Odbiorca nie ma jeszcze opublikowanych kluczy X3DH.');

    const { identityPriv, identityPubJwk } = await IdentityVault.importUsableKeys(identityVault);
    const plaintext = JSON.stringify({ groupId, chainKey: state.own.chainKey, iteration: state.own.iteration });
    const payload = await sealedEncrypt({ identityPriv, identityPubJwk, bundle, plaintext });

    await supabase.from('group_key_messages').insert({
        group_id: groupId,
        from_user_id: fromUserId,
        to_user_id: recipientUserId,
        mode,
        payload
    });
}

/**
 * Odbiera i przetwarza WSZYSTKIE oczekujące pakiety dystrybucji kluczy dla mnie
 * (w danym trybie), zapisuje je w `groupCrypto`, i kasuje skonsumowane wiersze.
 * Zwraca listę id grup, których stan się zmienił (do ewentualnego odświeżenia UI).
 */
export async function consumePendingKeyDistributions(userId, mode, groupCrypto, identityVault) {
    if (!identityVault) return [];
    const { data: rows } = await supabase.from('group_key_messages').select('*').eq('to_user_id', userId).eq('mode', mode);
    if (!rows || !rows.length) return [];

    const identityPriv = await crypto.subtle.importKey('jwk', identityVault.identityDh.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const spkKeyPairsById = { [identityVault.spk.id]: identityVault.spk };
    const opksById = Object.fromEntries(identityVault.opks.map(o => [o.id, o]));

    const touchedGroups = new Set();
    for (const row of rows) {
        try {
            const plaintext = await sealedDecrypt({ identityPriv, spkKeyPairsById, opksById, payloadJson: row.payload });
            const data = JSON.parse(plaintext);
            groupCrypto.setMemberChain(data.groupId, row.from_user_id, data.chainKey, data.iteration);
            touchedGroups.add(data.groupId);
        } catch (e) {
            console.error('Nie udało się odszyfrować pakietu dystrybucji klucza grupowego', e);
        }
        await supabase.from('group_key_messages').delete().eq('id', row.id);
    }
    return Array.from(touchedGroups);
}
