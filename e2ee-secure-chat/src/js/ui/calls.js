/**
 * ui/calls.js — nakładka połączeń głosowych/wideo (przychodzące, wychodzące,
 * aktywne), przełączniki mute/kamera i licznik czasu trwania połączenia.
 */
export const CallsUI = {
    // ------------------------------------------------------------------
    // Interfejs połączeń głosowych / wideo
    // ------------------------------------------------------------------
    showIncomingCall({ name, avatar, isVideo, onAccept, onReject }) {
        const overlay = document.getElementById('call-overlay');
        const incoming = document.getElementById('call-incoming');
        const outgoing = document.getElementById('call-outgoing');
        const active = document.getElementById('call-active');
        if (!overlay) return;

        outgoing.style.display = 'none';
        active.style.display = 'none';
        incoming.style.display = 'flex';

        document.getElementById('call-incoming-name').textContent = name;
        document.getElementById('call-incoming-avatar').src = avatar || '';
        document.getElementById('call-incoming-type').textContent = isVideo ? 'Połączenie wideo…' : 'Połączenie głosowe…';

        const acceptBtn = document.getElementById('call-accept-btn');
        const rejectBtn = document.getElementById('call-reject-btn');
        const newAccept = acceptBtn.cloneNode(true);
        const newReject = rejectBtn.cloneNode(true);
        acceptBtn.replaceWith(newAccept);
        rejectBtn.replaceWith(newReject);
        newAccept.addEventListener('click', onAccept);
        newReject.addEventListener('click', onReject);

        overlay.classList.add('open');
    },

    showOutgoingCall({ name, avatar, isVideo, localStream, onCancel }) {
        const overlay = document.getElementById('call-overlay');
        const incoming = document.getElementById('call-incoming');
        const outgoing = document.getElementById('call-outgoing');
        const active = document.getElementById('call-active');
        if (!overlay) return;

        incoming.style.display = 'none';
        active.style.display = 'none';
        outgoing.style.display = 'flex';

        document.getElementById('call-outgoing-name').textContent = name;
        document.getElementById('call-outgoing-avatar').src = avatar || '';
        document.getElementById('call-outgoing-type').textContent = isVideo ? 'Dzwonię (wideo)…' : 'Dzwonię…';

        const cancelBtn = document.getElementById('call-cancel-btn');
        const newCancel = cancelBtn.cloneNode(true);
        cancelBtn.replaceWith(newCancel);
        newCancel.addEventListener('click', onCancel);

        this.setLocalCallStream(localStream, isVideo);
        overlay.classList.add('open');
    },

    setCallActive() {
        const incoming = document.getElementById('call-incoming');
        const outgoing = document.getElementById('call-outgoing');
        const active = document.getElementById('call-active');
        incoming.style.display = 'none';
        outgoing.style.display = 'none';
        active.style.display = 'flex';
        this._startCallTimer();
    },

    setLocalCallStream(stream, isVideo) {
        if (!stream) return;
        ['call-local-video', 'call-local-video-active'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.srcObject = stream;
            el.muted = true;
            el.style.display = isVideo ? 'block' : 'none';
        });
    },

    setRemoteCallStream(stream, isVideo) {
        const remoteVideo = document.getElementById('call-remote-video');
        const remoteAudio = document.getElementById('call-remote-audio');
        if (isVideo && remoteVideo) {
            remoteVideo.srcObject = stream;
            remoteVideo.style.display = 'block';
        } else if (remoteAudio) {
            remoteAudio.srcObject = stream;
        }
    },

    setMuteButtonState(muted) {
        const btn = document.getElementById('call-mute-btn');
        if (btn) btn.classList.toggle('active', muted);
    },

    setCameraButtonState(off) {
        const btn = document.getElementById('call-camera-btn');
        if (btn) btn.classList.toggle('active', off);
        const localVideo = document.getElementById('call-local-video');
        if (localVideo) localVideo.style.opacity = off ? '0.2' : '1';
    },

    _startCallTimer() {
        clearInterval(this._callTimerInterval);
        const el = document.getElementById('call-duration');
        if (!el) return;
        const start = Date.now();
        el.textContent = '00:00';
        this._callTimerInterval = setInterval(() => {
            const secs = Math.floor((Date.now() - start) / 1000);
            const m = Math.floor(secs / 60).toString().padStart(2, '0');
            const s = (secs % 60).toString().padStart(2, '0');
            el.textContent = `${m}:${s}`;
        }, 1000);
    },

    hideCallUI() {
        clearInterval(this._callTimerInterval);
        const overlay = document.getElementById('call-overlay');
        if (overlay) overlay.classList.remove('open');
        ['call-local-video', 'call-local-video-active', 'call-remote-video'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.srcObject = null; el.style.display = 'none'; }
        });
        const remoteAudio = document.getElementById('call-remote-audio');
        if (remoteAudio) remoteAudio.srcObject = null;
        document.getElementById('call-mute-btn')?.classList.remove('active');
        document.getElementById('call-camera-btn')?.classList.remove('active');
    }
};
