/**
 * chat/calls.js — nasłuch przychodzących połączeń dla aktywnej konwersacji
 * oraz start/odbiór/odrzucenie/zakończenie połączenia głosowego/wideo.
 * (Nie mylić z ../calls.js — to jest część ChatApp, tamten plik to CallManager/WebRTC.)
 */
import { UI } from '../ui.js';
import { keyManager } from '../auth.js';
import { CallManager } from '../calls.js';

export const CallsMixin = {
    /** Nasłuchuje przychodzących połączeń głosowych/wideo dla aktywnej konwersacji. */
    subscribeToCalls(convId) {
        CallManager.subscribe(convId, {
            onIncomingCall: ({ from, isVideo }) => {
                const contact = this.contacts.get(from);
                UI.showIncomingCall({
                    name: contact ? contact.display_name : 'Nieznany kontakt',
                    avatar: contact ? contact.avatar : '',
                    isVideo,
                    onAccept: () => this.answerCall(),
                    onReject: () => this.declineCall()
                });
            },
            onRemoteStream: (stream, isVideo) => UI.setRemoteCallStream(stream, isVideo),
            onActive: () => UI.setCallActive(),
            onEnded: (reason) => {
                UI.hideCallUI();
                const messages = {
                    hangup: 'Połączenie zakończone.',
                    reject: 'Połączenie odrzucone.',
                    busy: 'Kontakt jest zajęty na innej rozmowie.',
                    'connection-lost': 'Połączenie przerwane.'
                };
                UI.showToast(messages[reason] || 'Połączenie zakończone.', 'success');
            }
        });
    },

    async startCall(isVideo) {
        if (!this.activeConversation) return;
        const contact = this.contacts.get(this.activeConversation.contactId);
        if (!contact) return;
        try {
            const { localStream } = await CallManager.startCall({
                convId: this.activeConversation.id,
                contact,
                myPublicKey: this.myPublicKey,
                isVideo
            });
            UI.showOutgoingCall({ name: contact.display_name, avatar: contact.avatar, isVideo, localStream, onCancel: () => this.endCall() });
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    },

    async answerCall() {
        try {
            const { localStream } = await CallManager.acceptCall({
                myPrivateKey: keyManager.myPrivateKey,
                myPublicKey: this.myPublicKey
            });
            UI.setLocalCallStream(localStream, CallManager.currentCall?.isVideo);
            UI.setCallActive();
        } catch (e) {
            UI.showToast(e.message, 'error');
            UI.hideCallUI();
        }
    },

    declineCall() {
        CallManager.rejectCall();
        UI.hideCallUI();
    },

    endCall() {
        CallManager.hangup();
        UI.hideCallUI();
    },

    /** Wywoływane przy wylogowaniu / auto-blokadzie - nie zostawiamy "wiszącego" połączenia z otwartym mikrofonem/kamerą. */
    endActiveCallIfAny() {
        if (CallManager.state !== 'idle') {
            CallManager.hangup();
        }
        CallManager.unsubscribe();
        UI.hideCallUI();
        this.revokeMediaUrls(this.currentMessages);
    },
};
