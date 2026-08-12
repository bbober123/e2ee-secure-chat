/**
 * plaintext-cache.js — lokalny (IndexedDB), per-urządzenie cache TYLKO NA TYM
 * URZĄDZENIU już odszyfrowanych treści wiadomości.
 *
 * Dlaczego to jest konieczne (nie opcjonalna optymalizacja):
 * Double Ratchet daje forward secrecy właśnie przez to, że klucz każdej
 * wiadomości (message key) jest jednorazowy i kasowany natychmiast po użyciu.
 * To oznacza, że:
 *   - nie da się NIGDY ponownie odszyfrować ciphertextu z serwera po tym, jak
 *     został już raz odszyfrowany (np. po odświeżeniu strony i ponownym
 *     wczytaniu historii z Supabase),
 *   - nadawca w ogóle nie potrafi odszyfrować WŁASNYCH wysłanych wiadomości —
 *     ratchet ma tylko jednokierunkowe chainy (CKs do wysyłania, CKr do odbioru).
 * To jest dokładnie ten sam powód, dla którego Signal/WhatsApp trzymają lokalną,
 * urządzeniową bazę już odszyfrowanych wiadomości zamiast deszyfrować "na
 * żądanie" z serwera za każdym razem. Serwer nigdy nie widzi i nie przechowuje
 * jawnego tekstu — ten plik trzyma go WYŁĄCZNIE lokalnie, i to dodatkowo
 * zaszyfrowany kluczem z hasła użytkownika (ten sam co do prywatnych kluczy),
 * więc IndexedDB samo w sobie nie ujawnia treści komuś z dostępem do dysku
 * bez znajomości hasła.
 */
import { utils } from './crypto.js';

const DB_NAME = 'securechat_plaintext_cache_v1';
const STORE = 'entries';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function cacheKey(userId, mode, messageId) {
    return `${userId}:${mode}:${messageId}`;
}

/** Zapisuje odszyfrowany jawny tekst (już PO udanym ratchet.decrypt()) do lokalnego cache. */
export async function cachePlaintext(userId, mode, messageId, plaintext, passwordKey) {
    if (!passwordKey) return; // brak hasła w RAM (np. sesja nie w pełni odblokowana) - pomiń cache
    try {
        const nonce = utils.generateRandomBytes(12);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce },
            passwordKey,
            new TextEncoder().encode(plaintext)
        );
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({
                key: cacheKey(userId, mode, messageId),
                ciphertext: utils.bufferToBase64(ciphertext),
                nonce: utils.bufferToBase64(nonce)
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('Nie udało się zapisać lokalnego cache wiadomości', e);
    }
}

/** Zwraca odszyfrowany jawny tekst z lokalnego cache, albo null jeśli nie ma go (jeszcze) w cache. */
export async function readCachedPlaintext(userId, mode, messageId, passwordKey) {
    if (!passwordKey) return null;
    try {
        const db = await openDb();
        const row = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(cacheKey(userId, mode, messageId));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
        if (!row) return null;

        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(utils.base64ToBuffer(row.nonce)) },
            passwordKey,
            utils.base64ToBuffer(row.ciphertext)
        );
        return new TextDecoder().decode(plainBuf);
    } catch (e) {
        return null;
    }
}
