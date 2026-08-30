/**
 * crypto/utils.js — funkcje pomocnicze: Hex/Base64, stałoczasowe porównanie, losowe bajty.
 * Bez zależności od innych modułów crypto/*.
 */
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

