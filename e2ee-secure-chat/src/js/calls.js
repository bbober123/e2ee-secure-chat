import { supabase } from './supabase.js';
import { CryptoEngine } from './crypto.js';
import { AppState } from './state.js';
import { CONFIG } from './config.js';
import { keyManager } from './auth.js';

/**
 * CallManager - połączenia głosowe i wideo 1:1 przez WebRTC.
 *
 * BEZPIECZEŃSTWO POŁĄCZEŃ (dlaczego to jest naprawdę E2E, nie tylko "szyfrowane"):
 *
 * WebRTC zawsze szyfruje sam strumień audio/wideo między przeglądarkami
 * (DTLS-SRTP) - to standard, nieopcjonalne. PROBLEM: negocjacja tego
 * szyfrowania (SDP offer/answer) zawiera odcisk certyfikatu DTLS obu stron
 * i normalnie leci przez serwer sygnalizacyjny (tu: kanał broadcast
 * Supabase Realtime) W JAWNEJ POSTACI. Ktoś kontrolujący ten serwer
 * mógłby podmienić odciski certyfikatów obu stron i wstawić się jako
 * pełnoprawny MITM (proxy dwóch osobnych sesji DTLS) - użytkownicy widzieliby
 * "szyfrowane" połączenie, a serwer i tak słyszałby/widziałby wszystko.
 *
 * Rozwiązanie zastosowane tutaj: SDP (offer/answer) i kandydaci ICE są
 * szyfrowane AES-256-GCM kluczem sesyjnym połączenia, który jest owinięty
 * RSA-OAEP kluczem publicznym drugiej strony (CryptoEngine.encryptSessionKey/
 * decryptSessionKey w crypto.js) - NIEZALEŻNIE od X3DH/Double Ratchet, który
 * od tej migracji szyfruje tylko wiadomości tekstowe i media (patrz
 * ChatApp.prepareOutgoingRatchet w chat.js). Wymiana kluczy połączeń nadal
 * używa starszego mechanizmu RSA-4096 opisanego w crypto.js - migracja
 * calls.js na tożsamości X3DH to naturalny, ale osobny krok następny.
 * Serwer sygnalizacyjny widzi tylko nieprzezroczysty ciphertext niezależnie
 * od tego, którym mechanizmem jest owinięty. Odcisk certyfikatu DTLS jest więc
 * uwierzytelniony (AES-GCM daje integralność) między długoterminowymi
 * tożsamościami obu użytkowników - serwer nie może go podmienić bez
 * unieważnienia szyfrogramu (błąd deszyfrowania po drugiej stronie).
 *
 * Ograniczenie uczciwie: to chroni przed serwerem/MITM na warstwie
 * sygnalizacji. NIE chroni przed atakującym, który już skompromitował
 * jedno z urządzeń końcowych (tak jak żadne E2EE tego nie robi).
 */
export class CallManager {
    static pc = null;
    static localStream = null;
    static channel = null;
    static callAesKey = null;
    static currentCall = null; // { convId, contactId, callId, isVideo, isCaller }
    static state = 'idle'; // idle | calling | ringing | active
    static handlers = {}; // callbacks ustawiane przez warstwę UI (chat.js)

    /** Musi być wywołane raz przy otwarciu konwersacji - nasłuchuje przychodzących połączeń. */
    static subscribe(convId, handlers) {
        this.unsubscribe();
        this.handlers = handlers || {};

        this.channel = supabase.channel(`calls-${convId}`, { config: { broadcast: { self: false } } })
            .on('broadcast', { event: 'call-signal' }, (msg) => this._onSignal(convId, msg.payload))
            .subscribe();
    }

    static unsubscribe() {
        if (this.channel) {
            supabase.removeChannel(this.channel);
            this.channel = null;
        }
    }

    static _send(convId, payload) {
        if (!this.channel) return;
        this.channel.send({ type: 'broadcast', event: 'call-signal', payload });
    }

    static _buildAad(callId, convId, part) {
        return CryptoEngine.buildAAD(convId, callId, `call-${part}`);
    }

    static _newPeerConnection(convId, callId, isVideo) {
        const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });

        pc.onicecandidate = async (e) => {
            if (!e.candidate || !this.callAesKey) return;
            const aad = this._buildAad(callId, convId, 'ice');
            const enc = await CryptoEngine.encryptMessage(JSON.stringify(e.candidate), this.callAesKey, aad);
            this._send(convId, {
                type: 'ice', callId, from: AppState.getUser().id,
                ciphertextBase64: enc.ciphertextBase64, nonceBase64: enc.nonceBase64
            });
        };

        pc.ontrack = (e) => {
            this.handlers.onRemoteStream?.(e.streams[0], isVideo);
        };

        pc.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(pc.connectionState)) {
                this.handlers.onEnded?.('connection-lost');
                this._cleanup();
            }
        };

        return pc;
    }

    /**
     * Rozpoczyna połączenie wychodzące.
     * @param {{convId:string, contact:object, myPublicKey:CryptoKey, isVideo:boolean}} opts
     */
    static async startCall({ convId, contact, myPublicKey, isVideo }) {
        if (this.state !== 'idle') throw new Error('Już trwa inne połączenie.');
        this.state = 'calling';

        const callId = crypto.randomUUID();
        this.currentCall = { convId, contactId: contact.contact_user_id, callId, isVideo, isCaller: true };

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
        } catch (e) {
            this.state = 'idle';
            this.currentCall = null;
            throw new Error('Brak dostępu do mikrofonu' + (isVideo ? '/kamery' : '') + '. Sprawdź uprawnienia przeglądarki.');
        }

        this.callAesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

        const keyStr = AppState.getMode() === 'fake' ? contact.public_key_fake : contact.public_key_real;
        const recipientPubKey = await crypto.subtle.importKey('jwk', JSON.parse(keyStr), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
        const keysPayload = {
            r: await CryptoEngine.encryptSessionKey(this.callAesKey, recipientPubKey),
            s: await CryptoEngine.encryptSessionKey(this.callAesKey, myPublicKey)
        };

        this.pc = this._newPeerConnection(convId, callId, isVideo);
        this.localStream.getTracks().forEach(t => this.pc.addTrack(t, this.localStream));

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        const aad = this._buildAad(callId, convId, 'offer');
        const enc = await CryptoEngine.encryptMessage(JSON.stringify({ sdp: offer.sdp, type: offer.type }), this.callAesKey, aad);

        this._send(convId, {
            type: 'offer', callId, from: AppState.getUser().id, video: isVideo,
            keys: keysPayload, ciphertextBase64: enc.ciphertextBase64, nonceBase64: enc.nonceBase64
        });

        return { callId, localStream: this.localStream };
    }

    static async _onSignal(convId, sig) {
        if (!sig || sig.from === AppState.getUser().id) return;

        if (sig.type === 'offer') {
            if (this.state !== 'idle') {
                // Zajęci - odrzuć automatycznie.
                this._send(convId, { type: 'busy', callId: sig.callId, from: AppState.getUser().id });
                return;
            }
            this.state = 'ringing';
            this.currentCall = { convId, contactId: sig.from, callId: sig.callId, isVideo: !!sig.video, isCaller: false, _pendingOffer: sig };
            this.handlers.onIncomingCall?.({ from: sig.from, isVideo: !!sig.video, callId: sig.callId });
            return;
        }

        if (!this.currentCall || sig.callId !== this.currentCall.callId) return;

        if (sig.type === 'answer' && this.currentCall.isCaller) {
            const aad = this._buildAad(sig.callId, convId, 'answer');
            const json = await CryptoEngine.decryptMessage(sig.ciphertextBase64, sig.nonceBase64, this.callAesKey, aad);
            const answer = JSON.parse(json);
            await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
            this.state = 'active';
            this.handlers.onActive?.();
            return;
        }

        if (sig.type === 'ice' && this.pc) {
            try {
                const aad = this._buildAad(sig.callId, convId, 'ice');
                const json = await CryptoEngine.decryptMessage(sig.ciphertextBase64, sig.nonceBase64, this.callAesKey, aad);
                await this.pc.addIceCandidate(JSON.parse(json));
            } catch (e) {
                console.error('ICE decrypt/add error', e);
            }
            return;
        }

        if (sig.type === 'hangup' || sig.type === 'reject' || sig.type === 'busy') {
            this.handlers.onEnded?.(sig.type);
            this._cleanup();
        }
    }

    /** Wywoływane po tym jak użytkownik odbierze dzwoniące połączenie (przycisk "Odbierz"). */
    static async acceptCall({ myPrivateKey, myPublicKey }) {
        const call = this.currentCall;
        if (!call || !call._pendingOffer) throw new Error('Brak oczekującego połączenia.');
        const sig = call._pendingOffer;

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.isVideo });
        } catch (e) {
            this.rejectCall();
            throw new Error('Brak dostępu do mikrofonu' + (call.isVideo ? '/kamery' : '') + '. Sprawdź uprawnienia przeglądarki.');
        }

        this.callAesKey = await CryptoEngine.decryptSessionKey(sig.keys.r, myPrivateKey);

        const aadOffer = this._buildAad(sig.callId, call.convId, 'offer');
        const offerJson = await CryptoEngine.decryptMessage(sig.ciphertextBase64, sig.nonceBase64, this.callAesKey, aadOffer);
        const offer = JSON.parse(offerJson);

        this.pc = this._newPeerConnection(call.convId, call.callId, call.isVideo);
        this.localStream.getTracks().forEach(t => this.pc.addTrack(t, this.localStream));

        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        const aadAnswer = this._buildAad(sig.callId, call.convId, 'answer');
        const enc = await CryptoEngine.encryptMessage(JSON.stringify({ sdp: answer.sdp, type: answer.type }), this.callAesKey, aadAnswer);
        this._send(call.convId, {
            type: 'answer', callId: sig.callId, from: AppState.getUser().id,
            ciphertextBase64: enc.ciphertextBase64, nonceBase64: enc.nonceBase64
        });

        this.state = 'active';
        delete this.currentCall._pendingOffer;
        return { localStream: this.localStream };
    }

    static rejectCall() {
        if (this.currentCall) {
            this._send(this.currentCall.convId, { type: 'reject', callId: this.currentCall.callId, from: AppState.getUser().id });
        }
        this._cleanup();
    }

    static hangup() {
        if (this.currentCall) {
            this._send(this.currentCall.convId, { type: 'hangup', callId: this.currentCall.callId, from: AppState.getUser().id });
        }
        this._cleanup();
    }

    static _cleanup() {
        if (this.pc) {
            try { this.pc.close(); } catch (e) { /* noop */ }
        }
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
        }
        this.pc = null;
        this.localStream = null;
        this.callAesKey = null;
        this.currentCall = null;
        this.state = 'idle';
    }

    static toggleMute() {
        if (!this.localStream) return false;
        const track = this.localStream.getAudioTracks()[0];
        if (!track) return false;
        track.enabled = !track.enabled;
        return !track.enabled; // zwraca "czy wyciszone"
    }

    static toggleCamera() {
        if (!this.localStream) return false;
        const track = this.localStream.getVideoTracks()[0];
        if (!track) return false;
        track.enabled = !track.enabled;
        return !track.enabled; // zwraca "czy kamera wyłączona"
    }
}
