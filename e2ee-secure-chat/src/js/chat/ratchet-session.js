/**
 * chat/ratchet-session.js — zarządzanie sesją Double Ratchet per konwersacja:
 * pobranie istniejącej sesji, X3DH jako inicjator/odbiorca, szyfrowanie wychodzące.
 */
import { UI } from '../ui.js';
import { keyManager } from '../auth.js';
import { KeyTrustStore } from '../crypto.js';
import { AppState } from '../state.js';
import { DoubleRatchet } from '../ratchet.js';
import { IdentityVault, fetchPrekeyBundle, saveRatchetState, loadRatchetState } from '../prekeys.js';

export const RatchetSessionMixin = {
    /**
     * Zwraca (z RAM, albo odtworzony z zaszyfrowanego stanu w bazie) DoubleRatchet
     * dla tej konwersacji, jeśli już istnieje sesja. Zwraca null, jeśli jeszcze
     * nigdy nie wysłaliśmy ani nie odebraliśmy wiadomości w tej rozmowie/trybie
     * na TYM urządzeniu (trzeba dopiero zainicjować X3DH).
     */
    async getExistingRatchet(convId) {
        if (this.ratchets.has(convId)) return this.ratchets.get(convId);
        if (!keyManager.passwordKey) return null;
        const ratchet = await loadRatchetState(AppState.getUser().id, convId, AppState.getMode(), this.deviceFingerprint, keyManager.passwordKey);
        if (ratchet) this.ratchets.set(convId, ratchet);
        return ratchet;
    },

    async persistRatchet(convId, ratchet) {
        try {
            await saveRatchetState(AppState.getUser().id, convId, AppState.getMode(), this.deviceFingerprint, ratchet, keyManager.passwordKey);
        } catch (e) {
            console.error('Nie udało się zapisać stanu ratchetu', e);
        }
    },

    /**
     * Zwraca sesję gotową do WYSYŁANIA. Jeśli nie istnieje jeszcze żadna sesja z
     * tym kontaktem (na tym urządzeniu/w tym trybie), wykonuje X3DH jako
     * inicjator, pobierając bundle kontaktu (IK/SPK/OPK) z serwera i weryfikując
     * podpis SPK (patrz fetchPrekeyBundle w prekeys.js). Zwraca null (pokazując
     * toast) jeśli TOFU wykrył zmianę tożsamości kontaktu i użytkownik anulował.
     */
    async prepareOutgoingRatchet(convId, contactId) {
        let ratchet = await this.getExistingRatchet(convId);
        if (ratchet) return ratchet;

        if (!keyManager.identityVault) {
            UI.showToast("To konto nie ma jeszcze kluczy X3DH (założone przed aktualizacją). Zarejestruj nowe konto.", "error");
            return null;
        }

        const contact = this.contacts.get(contactId);
        const mode = AppState.getMode();

        let bundle;
        try {
            bundle = await fetchPrekeyBundle(contactId, mode);
        } catch (e) {
            UI.showToast(e.message, "error");
            return null;
        }
        if (!bundle) {
            UI.showToast(`Kontakt "${contact.display_name}" nie ma jeszcze opublikowanych kluczy szyfrujących.`, "error");
            return null;
        }

        // TOFU: fingerprint tożsamości kontaktu (Identity Key, nie efemeryczny SPK/OPK) —
        // ten sam mechanizm co poprzednio dla RSA, teraz nad ik zamiast public_key_real/fake.
        const trust = await KeyTrustStore.verify(AppState.getUser().id, contactId, mode, JSON.stringify(bundle.ikPubJwk));
        if (trust.status === 'changed') {
            const proceed = window.confirm(
                "⚠️ UWAGA BEZPIECZEŃSTWA\n\n" +
                `Klucz tożsamości kontaktu "${contact.display_name}" zmienił się od ostatniej rozmowy.\n\n` +
                "To może oznaczać, że kontakt zainstalował aplikację na nowym urządzeniu — ALE może też " +
                "oznaczać próbę przechwycenia wiadomości (atak man-in-the-middle).\n\n" +
                "Jeśli nie potwierdziłeś/aś tej zmiany z kontaktem innym kanałem (np. telefonicznie), " +
                "zalecamy anulowanie.\n\n" +
                "Nowy fingerprint klucza:\n" + trust.fingerprint + "\n\n" +
                "Kontynuować wysyłanie i zaufać nowemu kluczowi?"
            );
            if (!proceed) {
                UI.showToast("Wysyłanie anulowane — klucz kontaktu się zmienił", "error");
                return null;
            }
            KeyTrustStore.trustNewKey(AppState.getUser().id, contactId, mode, trust.fingerprint);
        }

        const { identityPriv, identityPubJwk } = await IdentityVault.importUsableKeys(keyManager.identityVault);
        ratchet = new DoubleRatchet();
        const { x3dhHeader } = await ratchet.initAsInitiator({ identityPriv, identityPubJwk, bundle });
        ratchet._pendingX3dhHeader = x3dhHeader; // dołączany TYLKO do pierwszej wychodzącej wiadomości

        this.ratchets.set(convId, ratchet);
        return ratchet;
    },

    /** Szyfruje plaintext ratchetem i dokleja nagłówek X3DH, jeśli to pierwsza wychodząca wiadomość tej sesji. */
    async encryptOutgoing(ratchet, plaintext) {
        const enc = await ratchet.encrypt(plaintext);
        if (ratchet._pendingX3dhHeader) {
            const headerObj = JSON.parse(enc.headerJson);
            headerObj.x3dh = ratchet._pendingX3dhHeader;
            enc.headerJson = JSON.stringify(headerObj);
            delete ratchet._pendingX3dhHeader;
        }
        return enc;
    },

    /**
     * Zwraca sesję gotową do ODBIERANIA wiadomości o danym nagłówku. Jeśli nagłówek
     * niesie pole `x3dh` (PIERWSZA wiadomość nowej sesji od inicjatora) i jeszcze nie
     * mamy stanu, bootstrapuje ratchet jako odbiorca (X3DH-responder) korzystając
     * z własnego IK oraz SPK/OPK z lokalnego vaulta (dopasowanych po id z nagłówka).
     */
    async getOrBootstrapIncomingRatchet(convId, headerJson) {
        let ratchet = await this.getExistingRatchet(convId);
        if (ratchet) return ratchet;

        const header = JSON.parse(headerJson);
        if (!header.x3dh) {
            throw new Error('Brak stanu ratchetu i nagłówek nie zawiera danych X3DH — nie da się odszyfrować.');
        }
        if (!keyManager.identityVault) {
            throw new Error('Brak lokalnych kluczy X3DH do zbootstrapowania sesji odbiorczej.');
        }

        const vault = keyManager.identityVault;
        const identityPriv = await crypto.subtle.importKey('jwk', vault.identityDh.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

        if (vault.spk.id !== header.x3dh.spkId) {
            // SPK już zrotowany od czasu wysłania — w tej wersji trzymamy tylko bieżący SPK w vaulcie.
            throw new Error('Wiadomość odwołuje się do już zrotowanego Signed Prekey — nie można zainicjować sesji.');
        }
        const spkPrivateKey = await crypto.subtle.importKey('jwk', vault.spk.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const spkKeyPair = { publicKey: await crypto.subtle.importKey('jwk', vault.spk.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []), privateKey: spkPrivateKey, publicJwk: vault.spk.publicJwk, privateJwk: vault.spk.privateJwk };

        let opkPriv = null;
        if (header.x3dh.opkId != null) {
            const opkEntry = vault.opks.find(o => o.id === header.x3dh.opkId);
            if (opkEntry) {
                opkPriv = await crypto.subtle.importKey('jwk', opkEntry.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
                // Jednorazowe: usuń lokalnie po użyciu (serwer już oznaczył used=true przy claim_one_time_prekey).
                vault.opks = vault.opks.filter(o => o.id !== header.x3dh.opkId);
            }
        }

        ratchet = new DoubleRatchet();
        await ratchet.initAsResponder({ identityPriv, spkKeyPair, opkPriv, x3dh: header.x3dh });
        this.ratchets.set(convId, ratchet);
        return ratchet;
    },
};
