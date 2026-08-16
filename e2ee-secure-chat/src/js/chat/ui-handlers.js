/**
 * chat/ui-handlers.js — podpięcie wszystkich event listenerów UI (przyciski,
 * formularze modali, akcje na wiadomościach, połączenia) do metod ChatApp.
 */
import { UI } from '../ui.js';
import { CONFIG } from '../config.js';
import { VoiceRecorder } from '../media.js';
import { CallManager } from '../calls.js';

export const UiHandlersMixin = {
    setupUIHandlers() {
        document.getElementById('confirm-add-contact').addEventListener('click', () => {
            const username = document.getElementById('contact-username').value.trim();
            const realNick = document.getElementById('contact-nickname').value.trim();
            const fakeNick = document.getElementById('contact-fake-nickname').value.trim();
            if (username) this.sendFriendRequestAction(username, realNick, fakeNick);
        });

        document.getElementById('confirm-create-group').addEventListener('click', () => {
            const name = document.getElementById('group-name-input').value.trim();
            if (name) this.createGroupAction(name);
        });

        document.getElementById('confirm-join-group').addEventListener('click', () => {
            const creatorUsername = document.getElementById('join-group-username').value.trim();
            const code = document.getElementById('join-group-code').value.trim();
            if (creatorUsername && code) this.joinGroupAction(creatorUsername, code);
        });

        document.getElementById('friend-requests-list').addEventListener('click', (e) => {
            const acceptBtn = e.target.closest('[data-accept-request]');
            const declineBtn = e.target.closest('[data-decline-request]');
            if (acceptBtn) this.acceptFriendRequestAction(acceptBtn.dataset.acceptRequest);
            if (declineBtn) this.declineFriendRequestAction(declineBtn.dataset.declineRequest);
        });
        
        document.getElementById('send-button').addEventListener('click', () => {
            const text = document.getElementById('message-input').value.trim();
            if (text) {
                this.sendMessage(text);
                document.getElementById('message-input').value = '';
                document.getElementById('message-input').style.height = 'auto';
            }
        });

        document.getElementById('message-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('send-button').click();
            }
        });

        // Wskaźnik "X pisze..." u drugiej strony - throttlowane broadcasty przez Supabase Realtime.
        const messageInput = document.getElementById('message-input');
        messageInput.addEventListener('input', () => {
            if (messageInput.value.trim().length > 0) this.broadcastTyping();
        });
        messageInput.addEventListener('blur', () => this.stopTypingBroadcast());

        // --- Załączniki: zdjęcia / filmy ---
        const attachBtn = document.getElementById('attach-button');
        const attachInput = document.getElementById('attach-file-input');
        if (attachBtn && attachInput) {
            attachBtn.addEventListener('click', () => attachInput.click());
            attachInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) this.sendMedia(file);
                e.target.value = '';
            });
        }

        // --- Wiadomości głosowe (nagrywanie przytrzymaniem/kliknięciem) ---
        const voiceBtn = document.getElementById('voice-record-button');
        if (voiceBtn) {
            const recorder = new VoiceRecorder();
            let recording = false;

            voiceBtn.addEventListener('click', async () => {
                if (!recording) {
                    try {
                        await recorder.start();
                        recording = true;
                        voiceBtn.classList.add('recording');
                        UI.showToast('Nagrywanie… kliknij ponownie, aby wysłać', 'success');
                    } catch (e) {
                        UI.showToast('Brak dostępu do mikrofonu. Sprawdź uprawnienia przeglądarki.', 'error');
                    }
                } else {
                    recording = false;
                    voiceBtn.classList.remove('recording');
                    try {
                        const { file, durationSeconds } = await recorder.stop();
                        if (durationSeconds < 1) {
                            UI.showToast('Nagranie za krótkie, anulowano.', 'error');
                            return;
                        }
                        if (durationSeconds > CONFIG.MAX_VOICE_SECONDS) {
                            UI.showToast(`Nagranie za długie (maks. ${CONFIG.MAX_VOICE_SECONDS}s).`, 'error');
                            return;
                        }
                        this.sendMedia(file, durationSeconds);
                    } catch (e) {
                        UI.showToast('Nie udało się zapisać nagrania.', 'error');
                    }
                }
            });
        }

        // --- Kliknięcie w wiadomość medialną (pobierz/odtwórz) - delegacja zdarzeń ---
        document.getElementById('messages-container').addEventListener('click', async (e) => {
            const mediaEl = e.target.closest('[data-load-media]');
            if (mediaEl) { this.loadMediaContent(mediaEl.dataset.loadMedia); return; }

            const joinEl = e.target.closest('[data-join-game]');
            if (joinEl && joinEl.dataset.joinTable) {
                const { Casino } = await import('../casino.js');
                Casino.joinFromInvite(joinEl.dataset.joinGame, joinEl.dataset.joinTable);
            }
        });

        // --- Połączenia głosowe / wideo ---
        const audioCallBtn = document.getElementById('start-audio-call-btn');
        const videoCallBtn = document.getElementById('start-video-call-btn');
        if (audioCallBtn) audioCallBtn.addEventListener('click', () => this.startCall(false));
        if (videoCallBtn) videoCallBtn.addEventListener('click', () => this.startCall(true));

        const hangupBtn = document.getElementById('call-hangup-btn');
        const muteBtn = document.getElementById('call-mute-btn');
        const cameraBtn = document.getElementById('call-camera-btn');
        if (hangupBtn) hangupBtn.addEventListener('click', () => this.endCall());
        if (muteBtn) muteBtn.addEventListener('click', () => {
            const muted = CallManager.toggleMute();
            UI.setMuteButtonState(muted);
        });
        if (cameraBtn) cameraBtn.addEventListener('click', () => {
            const off = CallManager.toggleCamera();
            UI.setCameraButtonState(off);
        });
    },
};
