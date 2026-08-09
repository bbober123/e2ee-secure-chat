import { supabase } from './supabase.js';
import { CryptoEngine, utils } from './crypto.js';
import { CONFIG } from './config.js';

/**
 * MediaManager - szyfrowanie/wgrywanie/pobieranie/deszyfrowanie zdjęć,
 * filmów i wiadomości głosowych.
 *
 * Model bezpieczeństwa jest identyczny jak dla wiadomości tekstowych:
 *  - świeży, losowy klucz sesyjny AES-256-GCM na wiadomość,
 *  - klucz sesyjny owinięty RSA-OAEP kluczem publicznym nadawcy i odbiorcy
 *    (ta sama kolumna `encrypted_content_key`, ten sam format {r, s}),
 *  - PLIK jest szyfrowany tym samym kluczem sesyjnym, ale WŁASNYM, świeżym
 *    12-bajtowym nonce (kolumna `media_nonce`) - AES-GCM wymaga unikalności
 *    pary (klucz, nonce), więc dwa różne, losowe nonce z tym samym kluczem
 *    są bezpieczne,
 *  - do serwera trafia WYŁĄCZNIE ciphertext (Content-Type ustawiany jawnie
 *    na 'application/octet-stream', żeby przeglądarka nigdy nie próbowała
 *    "zgadnąć" i wyrenderować surowych bajtów jako HTML/SVG - obrona przed
 *    XSS przez błędne wnioskowanie typu MIME nawet gdyby ktoś pobrał surowy
 *    URL pliku bezpośrednio),
 *  - AAD (patrz CryptoEngine.buildAAD) wiąże ciphertext z konwersacją/
 *    nadawcą/trybem - serwer nie może "przekleić" pliku do innej wiadomości.
 */
export const MediaManager = {
    /** Usuwa znaki niebezpieczne dla ścieżek/UI z nazwy pliku (obrona przed path traversal i XSS przy wyświetlaniu nazwy). */
    sanitizeFileName(name) {
        if (!name || typeof name !== 'string') return 'plik';
        return name
            .replace(/[\/\\]/g, '_')
            .replace(/\.\./g, '_')
            .replace(/[\x00-\x1f\x7f<>"'`]/g, '_')
            .slice(0, 120) || 'plik';
    },

    detectType(mime) {
        if (CONFIG.ALLOWED_IMAGE_TYPES.includes(mime)) return 'image';
        if (CONFIG.ALLOWED_VIDEO_TYPES.includes(mime)) return 'video';
        if (mime.startsWith('audio/')) return 'voice';
        return null;
    },

    validateFile(file) {
        if (file.size > CONFIG.MAX_MEDIA_BYTES) {
            throw new Error(`Plik jest za duży (maks. ${Math.floor(CONFIG.MAX_MEDIA_BYTES / (1024 * 1024))} MB).`);
        }
        const type = this.detectType(file.type);
        if (!type) {
            throw new Error('Nieobsługiwany typ pliku. Dozwolone: zdjęcia, filmy, nagrania audio.');
        }
        return type;
    },

    /**
     * Szyfruje plik + metadane i wgrywa ciphertext do prywatnego bucketu 'media'.
     * Zwraca dane gotowe do zapisania w wierszu `messages`.
     */
    async encryptAndUpload({ file, type, conversationId, messageId, sessionKey, aad, durationSeconds }) {
        const fileBuffer = await file.arrayBuffer();
        const { ciphertext, nonceBase64: mediaNonce } = await CryptoEngine.encryptBytes(fileBuffer, sessionKey, aad);

        const metaPlain = JSON.stringify({
            name: this.sanitizeFileName(file.name || `${type}-${Date.now()}`),
            mime: file.type || 'application/octet-stream',
            size: file.size,
            duration: durationSeconds || null
        });
        const encMeta = await CryptoEngine.encryptMessage(metaPlain, sessionKey, aad);

        const randomSuffix = utils.bufferToHex(utils.generateRandomBytes(8));
        const path = `${conversationId}/${messageId}-${randomSuffix}`;

        const { error: uploadError } = await supabase.storage
            .from('media')
            .upload(path, new Blob([ciphertext]), {
                contentType: 'application/octet-stream', // zawsze - to ciphertext, nigdy prawdziwy typ pliku
                upsert: false,
                cacheControl: '3600'
            });

        if (uploadError) throw uploadError;

        return {
            media_path: path,
            media_size: ciphertext.byteLength,
            media_nonce: mediaNonce,
            encrypted_payload: encMeta.ciphertextBase64,
            nonce: encMeta.nonceBase64
        };
    },

    /** Pobiera i deszyfruje plik + metadane danej wiadomości medialnej. Zwraca { blobUrl, meta }. */
    async downloadAndDecrypt({ media_path, media_nonce, encrypted_payload, nonce, sessionKey, aad }) {
        const metaJson = await CryptoEngine.decryptMessage(encrypted_payload, nonce, sessionKey, aad);
        const meta = JSON.parse(metaJson);

        const { data, error } = await supabase.storage.from('media').download(media_path);
        if (error) throw error;

        const ciphertextBuffer = await data.arrayBuffer();
        const plainBuffer = await CryptoEngine.decryptBytes(ciphertextBuffer, media_nonce, sessionKey, aad);

        const blob = new Blob([plainBuffer], { type: meta.mime || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);

        return { blobUrl, meta };
    }
};

/**
 * VoiceRecorder - cienka otoczka na MediaRecorder do nagrywania głosówek.
 * Mikrofon jest zwalniany (getTracks().stop()) natychmiast po zatrzymaniu
 * nagrywania - aplikacja nigdy nie trzyma otwartego strumienia mikrofonu
 * w tle bez wyraźnej akcji użytkownika.
 */
export class VoiceRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.stream = null;
        this.chunks = [];
        this.startedAt = null;
    }

    async start() {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

        this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
        this.chunks = [];
        this.startedAt = Date.now();

        this.mediaRecorder.addEventListener('dataavailable', (e) => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        });

        this.mediaRecorder.start();
    }

    /** Zatrzymuje nagrywanie i zwraca { file, durationSeconds }. */
    stop() {
        return new Promise((resolve, reject) => {
            if (!this.mediaRecorder) {
                reject(new Error('Nagrywanie nie zostało rozpoczęte.'));
                return;
            }
            this.mediaRecorder.addEventListener('stop', () => {
                const durationSeconds = Math.round((Date.now() - this.startedAt) / 1000);
                const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
                const file = new File([blob], `glosowka-${Date.now()}.webm`, { type: blob.type });

                this.stream.getTracks().forEach(t => t.stop());
                this.stream = null;
                this.mediaRecorder = null;

                resolve({ file, durationSeconds });
            }, { once: true });

            this.mediaRecorder.stop();
        });
    }

    /** Anuluje nagrywanie bez zwracania pliku (np. użytkownik zrezygnował) i zwalnia mikrofon. */
    cancel() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
        }
        this.stream = null;
        this.mediaRecorder = null;
        this.chunks = [];
    }
}
