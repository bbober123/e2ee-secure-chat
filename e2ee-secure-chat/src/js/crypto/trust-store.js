/**
 * crypto/trust-store.js — KeyTrustStore: TOFU pinning / wykrywanie zmiany klucza
 * publicznego kontaktu (ostrzeżenie przed możliwym atakiem MITM).
 */
import { utils } from './utils.js';
import { CryptoEngine } from './engine.js';

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
