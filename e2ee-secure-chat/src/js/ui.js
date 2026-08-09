import { AppState } from './state.js';

export const UI = {
    init() {
        this.appContainer = document.getElementById('app-container');
        this.lockScreen = document.getElementById('lock-screen');
        this.authScreen = document.getElementById('auth-screen');
        this.switchAccountScreen = document.getElementById('switch-account-screen');
        this.unlockPassword = document.getElementById('unlock-password');
        this.toastContainer = document.getElementById('toast-container');
        
        // Auto-grow textarea
        const textarea = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-button');
        
        textarea.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            sendBtn.disabled = this.value.trim().length === 0;
        });
        
        // Mobile back navigation
        document.getElementById('mobile-back-btn').addEventListener('click', () => {
            this.appContainer.classList.remove('chat-active');
        });
        
        // Modals
        document.getElementById('add-contact-btn').addEventListener('click', () => {
            document.getElementById('add-contact-modal').style.display = 'flex';
        });
        document.getElementById('cancel-add-contact').addEventListener('click', () => {
            document.getElementById('add-contact-modal').style.display = 'none';
        });
        document.getElementById('close-settings-modal').addEventListener('click', () => {
            document.getElementById('settings-modal').style.display = 'none';
        });
    },

    showApp() {
        this.appContainer.style.visibility = 'visible';
        this.lockScreen.style.display = 'none';
        this.authScreen.style.display = 'none';
        this.switchAccountScreen.style.display = 'none';
    },

    showLockScreen() {
        this.appContainer.style.visibility = 'hidden';
        this.lockScreen.style.display = 'flex';
        this.authScreen.style.display = 'none';
        this.switchAccountScreen.style.display = 'none';
        this.unlockPassword.value = '';
        this.unlockPassword.focus();
    },

    showAuthScreen() {
        this.appContainer.style.visibility = 'hidden';
        this.lockScreen.style.display = 'none';
        this.switchAccountScreen.style.display = 'none';
        this.authScreen.style.display = 'flex';
    },

    /** Ekran "wybierz konto" - lista kont zapisanych na tym urządzeniu. */
    renderSavedAccounts(accounts, onSelect) {
        const panel = document.getElementById('saved-accounts-panel');
        const authForm = document.getElementById('auth-form');
        const list = document.getElementById('saved-accounts-list');

        if (!accounts || accounts.length === 0) {
            panel.style.display = 'none';
            authForm.style.display = 'flex';
            return;
        }

        panel.style.display = 'block';
        authForm.style.display = 'none';
        list.innerHTML = '';

        accounts.forEach(acc => {
            const item = document.createElement('div');
            item.className = 'saved-account-item';
            item.innerHTML = `
                <img src="${this._escapeHtml(acc.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${acc.id}`)}" alt="">
                <div class="acc-meta">
                    <span class="acc-name">${this._escapeHtml(acc.username || acc.email)}</span>
                    <span class="acc-email">${this._escapeHtml(acc.email)}</span>
                </div>
            `;
            item.onclick = () => onSelect(acc);
            list.appendChild(item);
        });
    },

    showSwitchAccountScreen(account) {
        this.appContainer.style.visibility = 'hidden';
        this.lockScreen.style.display = 'none';
        this.authScreen.style.display = 'none';
        this.switchAccountScreen.style.display = 'flex';
        this.switchAccountScreen.dataset.accountId = account.id;

        document.getElementById('switch-account-name').textContent = account.username || account.email;
        document.getElementById('switch-account-avatar').src = account.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${account.id}`;
        const pwInput = document.getElementById('switch-account-password');
        pwInput.value = '';
        pwInput.focus();
    },

    /** Modal ustawień: wypełnia awatar, listę kont i historię logowań. */
    openSettingsModal({ avatarUrl, accounts, currentUserId, history, onSwitchAccount }) {
        document.getElementById('settings-avatar-preview').src = avatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${currentUserId}`;
        this.renderSettingsAccounts(accounts, currentUserId, onSwitchAccount);
        this.renderLoginHistory(history);
        document.getElementById('settings-modal').style.display = 'flex';
    },

    renderSettingsAccounts(accounts, currentUserId, onSwitch) {
        const list = document.getElementById('settings-accounts-list');
        list.innerHTML = '';

        accounts.forEach(acc => {
            const isCurrent = acc.id === currentUserId;
            const item = document.createElement('div');
            item.className = `settings-account-item ${isCurrent ? 'current' : ''}`;
            item.innerHTML = `
                <img src="${this._escapeHtml(acc.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${acc.id}`)}" alt="">
                <div class="acc-meta">
                    <span class="acc-name">${this._escapeHtml(acc.username || acc.email)}${isCurrent ? ' (to konto)' : ''}</span>
                    <span class="acc-email">${this._escapeHtml(acc.email)}</span>
                </div>
            `;
            if (!isCurrent && onSwitch) item.onclick = () => onSwitch(acc);
            list.appendChild(item);
        });
    },

    renderLoginHistory(rows) {
        const container = document.getElementById('login-history-list');
        if (!rows || rows.length === 0) {
            container.innerHTML = '<span>Brak zapisanej historii logowań.</span>';
            return;
        }
        container.innerHTML = rows.map(r => `
            <div class="login-history-row">
                <span>${this._escapeHtml(r.ip || 'nieznane IP')}</span>
                <span>${this._escapeHtml(new Date(r.created_at).toLocaleString())}</span>
            </div>
        `).join('');
    },

    showUnlockError() {
        this.unlockPassword.classList.add('error', 'shake');
        setTimeout(() => {
            this.unlockPassword.classList.remove('shake');
        }, 400);
    },

    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ';
        const duration = 4500;

        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <span class="toast-msg"></span>
            <button class="toast-close" aria-label="Zamknij">✕</button>
            <span class="toast-progress" style="animation-duration:${duration}ms"></span>
        `;
        toast.querySelector('.toast-msg').textContent = message;

        this.toastContainer.appendChild(toast);

        // Ogranicz liczbę widocznych toastów - najstarszy znika, żeby nie zasypać ekranu.
        const toasts = this.toastContainer.querySelectorAll('.toast');
        if (toasts.length > 4) this._dismissToast(toasts[0]);

        const timer = setTimeout(() => this._dismissToast(toast), duration);
        toast.querySelector('.toast-close').addEventListener('click', () => {
            clearTimeout(timer);
            this._dismissToast(toast);
        });
    },

    _dismissToast(toast) {
        if (!toast || toast.classList.contains('leaving')) return;
        toast.classList.add('leaving');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    },

    /** Skeleton placeholders wyświetlane natychmiast, zanim dane dotrą z serwera. */
    renderConversationsSkeleton(count = 5) {
        const list = document.getElementById('conversations-list');
        let html = '';
        for (let i = 0; i < count; i++) {
            html += `
                <div class="skel-conv">
                    <div class="skeleton skel-avatar"></div>
                    <div class="skel-lines">
                        <div class="skeleton skel-line w60"></div>
                        <div class="skeleton skel-line w40"></div>
                    </div>
                </div>`;
        }
        list.innerHTML = html;
    },

    renderMessagesSkeleton(count = 6) {
        const container = document.getElementById('messages-container');
        let html = '';
        for (let i = 0; i < count; i++) {
            const w = ['85%', '55%', '70%', '40%', '60%', '90%'][i % 6];
            html += `
                <div class="skel-msg">
                    <div class="skeleton skel-avatar"></div>
                    <div class="skel-lines">
                        <div class="skeleton skel-line" style="width:30%"></div>
                        <div class="skeleton skel-line" style="width:${w}"></div>
                    </div>
                </div>`;
        }
        container.innerHTML = html;
    },

    /** Pokazuje/ukrywa status "X pisze..." w nagłówku aktywnej rozmowy (z płynnym fade). */
    showTypingIndicator(name) {
        const typingEl = document.getElementById('chat-typing-status');
        const e2eeEl = document.getElementById('chat-e2ee-status');
        if (!typingEl) return;
        document.getElementById('chat-typing-name').textContent = `${name} pisze...`;
        typingEl.classList.add('visible');
        e2eeEl.classList.add('hidden-by-typing');
    },

    hideTypingIndicator() {
        const typingEl = document.getElementById('chat-typing-status');
        const e2eeEl = document.getElementById('chat-e2ee-status');
        if (!typingEl) return;
        typingEl.classList.remove('visible');
        e2eeEl.classList.remove('hidden-by-typing');
    },

    /** Odznacza w liście rozmów, że kontakt aktualnie pisze (zielony tekst zamiast ostatniej wiadomości). */
    setConversationTyping(convId, isTyping) {
        const item = document.querySelector(`.conv-item[data-conv-id="${convId}"] .conv-msg`);
        if (!item) return;
        if (isTyping) {
            item.dataset.originalText = item.dataset.originalText ?? item.textContent;
            item.textContent = 'pisze...';
            item.classList.add('is-typing');
        } else {
            item.classList.remove('is-typing');
            if (item.dataset.originalText !== undefined) item.textContent = item.dataset.originalText;
        }
    },

    /** Ikony statusu dla własnych wiadomości: wysyłanie / wysłano / dostarczono / przeczytano. */
    _statusTicksHtml(status) {
        const check = `<path d="M20 6L9 17l-5-5"/>`;
        const doubleCheck = `<path d="M18 6L7 17l-5-5"/><path d="M22 6L11 17l-1.5-1.5"/>`;
        if (status === 'sending') {
            return `<span class="msg-status-ticks" title="Wysyłanie..."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${check}</svg></span>`;
        }
        if (status === 'read') {
            return `<span class="msg-status-ticks read" title="Przeczytano"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${doubleCheck}</svg></span>`;
        }
        // 'delivered' / 'sent' / default
        return `<span class="msg-status-ticks" title="Dostarczono"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${doubleCheck}</svg></span>`;
    },

    renderConversations(conversations, activeId = null) {
        const list = document.getElementById('conversations-list');
        list.innerHTML = '';
        
        conversations.forEach(conv => {
            const item = document.createElement('div');
            item.className = `conv-item ${conv.id === activeId ? 'active' : ''}`;
            item.dataset.convId = conv.id;
            item.onclick = () => {
                document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                this.appContainer.classList.add('chat-active');
                document.getElementById('chat-title').textContent = conv.nickname;
                this.hideTypingIndicator();
                this.renderMessagesSkeleton();
                window.dispatchEvent(new CustomEvent('conversation-selected', { detail: { convId: conv.id, contactId: conv.contactId } }));
            };
            
            item.innerHTML = `
                <div class="conv-avatar">
                    <img src="${this._escapeHtml(conv.avatar)}" alt="" style="width:100%; height:100%; border-radius:50%">
                </div>
                <div class="conv-info">
                    <div class="conv-top">
                        <span class="conv-name">${this._escapeHtml(conv.nickname)}</span>
                        <span class="conv-time">${this._escapeHtml(conv.time)}</span>
                    </div>
                    <div class="conv-bottom">
                        <span class="conv-msg">🔒 ${this._escapeHtml(conv.lastMessage)}</span>
                    </div>
                </div>
            `;
            list.appendChild(item);
        });
    },

    renderMessages(messages) {
        const container = document.getElementById('messages-container');
        container.innerHTML = '';
        
        let lastAuthorId = null;
        let lastTime = null;

        // Assumes messages are sorted newest first. Reversing to render from top-to-bottom logic if needed,
        // but flex-col-reverse handles it correctly from bottom to top. 
        // We iterate backwards to group correctly if they are ordered descending from DB.
        
        const sortedMessages = [...messages].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)); // Newest first

        sortedMessages.forEach((msg, idx) => {
            const msgTime = new Date(msg.timestamp);
            
            // Check previous message in DOM flow (which is chronologically older due to flex-col-reverse)
            // Wait, if it's newest first, idx 0 is newest. idx 1 is older.
            // We group if msg is within 5 minutes of the older message.
            const olderMsg = sortedMessages[idx + 1];
            let isGrouped = false;
            
            if (olderMsg && olderMsg.authorId === msg.authorId) {
                const olderTime = new Date(olderMsg.timestamp);
                if (msgTime - olderTime < 5 * 60000) {
                    isGrouped = true;
                }
            }

            const group = document.createElement('div');
            group.className = 'msg-group fade-in';
            
            const avatar = document.createElement('div');
            avatar.className = `msg-avatar ${isGrouped ? 'grouped' : ''}`;
            if (!isGrouped) {
                avatar.innerHTML = `<img src="${this._escapeHtml(msg.avatar)}" alt="" style="width:100%; height:100%; border-radius:50%">`;
            } else {
                avatar.innerHTML = `<span class="msg-hover-time">${msgTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>`;
            }

            const content = document.createElement('div');
            content.className = 'msg-content-wrapper';
            
            if (!isGrouped) {
                const header = document.createElement('div');
                header.className = 'msg-header';
                header.innerHTML = `
                    <span class="msg-author">${this._escapeHtml(msg.authorName)}</span>
                    <span class="msg-time">${msgTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                `;
                content.appendChild(header);
            }

            const body = this._renderMessageBody(msg);
            content.appendChild(body);

            // Statusy (✓ wysyłanie / ✓✓ dostarczono / ✓✓ niebieskie przeczytano) - tylko przy własnych wiadomościach.
            if (msg.authorId === AppState.getUserId()) {
                const statusRow = document.createElement('div');
                statusRow.className = 'msg-row-bottom';
                statusRow.innerHTML = this._statusTicksHtml(msg.status || (msg.id?.toString().startsWith('temp-') ? 'sending' : 'delivered'));
                content.appendChild(statusRow);
            }

            group.appendChild(avatar);
            group.appendChild(content);

            if (msg.id?.toString().startsWith('temp-')) group.classList.add('optimistic');
            if (msg.sendError) group.classList.add('send-error');

            container.appendChild(group);
        });
    },

    _renderMessageBody(msg) {
        const wrap = document.createElement('div');

        if (!msg.type || msg.type === 'text') {
            wrap.className = 'msg-text';
            wrap.textContent = msg.text;
            return wrap;
        }

        wrap.className = 'msg-media';
        const meta = msg.mediaMeta || {};
        const sizeKb = meta.size ? Math.max(1, Math.round(meta.size / 1024)) : null;
        const durationLabel = meta.duration ? this._formatDuration(meta.duration) : null;

        if (msg.mediaState === 'ready' && msg.mediaUrl) {
            if (msg.type === 'image') {
                const img = document.createElement('img');
                img.className = 'msg-media-image';
                img.src = msg.mediaUrl;
                img.alt = this._escapeHtml(meta.name || 'zdjęcie');
                img.loading = 'lazy';
                img.addEventListener('click', () => this._openLightbox(msg.mediaUrl, 'image'));
                wrap.appendChild(img);
            } else if (msg.type === 'video') {
                const video = document.createElement('video');
                video.className = 'msg-media-video';
                video.src = msg.mediaUrl;
                video.controls = true;
                video.preload = 'metadata';
                wrap.appendChild(video);
            } else if (msg.type === 'voice') {
                const holder = document.createElement('div');
                holder.className = 'msg-voice-player';
                holder.innerHTML = `<span class="msg-voice-icon">🎤</span>`;
                const audio = document.createElement('audio');
                audio.src = msg.mediaUrl;
                audio.controls = true;
                holder.appendChild(audio);
                if (durationLabel) {
                    const dur = document.createElement('span');
                    dur.className = 'msg-voice-duration';
                    dur.textContent = durationLabel;
                    holder.appendChild(dur);
                }
                wrap.appendChild(holder);
            }
        } else {
            const placeholder = document.createElement('button');
            placeholder.type = 'button';
            placeholder.className = 'msg-media-placeholder';
            placeholder.dataset.loadMedia = msg.id;

            let icon = '📎', label = 'Załącznik';
            if (msg.type === 'image') { icon = '🖼️'; label = 'Zdjęcie'; }
            if (msg.type === 'video') { icon = '🎬'; label = 'Film'; }
            if (msg.type === 'voice') { icon = '🎤'; label = 'Wiadomość głosowa'; }

            if (msg.mediaState === 'loading') {
                placeholder.disabled = true;
                placeholder.innerHTML = `<span class="spinner"></span> Odszyfrowywanie…`;
            } else if (msg.mediaState === 'error') {
                placeholder.innerHTML = `⚠️ Błąd — kliknij, aby spróbować ponownie`;
            } else {
                const extra = [durationLabel, sizeKb ? `${sizeKb} KB` : null].filter(Boolean).join(' · ');
                placeholder.innerHTML = `${icon} ${this._escapeHtml(label)}${extra ? ` <span class="msg-media-extra">(${this._escapeHtml(extra)})</span>` : ''} — kliknij, aby pobrać i odszyfrować`;
            }
            wrap.appendChild(placeholder);
        }

        return wrap;
    },

    _formatDuration(totalSeconds) {
        const m = Math.floor(totalSeconds / 60);
        const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    },

    _openLightbox(url, kind) {
        let overlay = document.getElementById('media-lightbox');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'media-lightbox';
            overlay.className = 'media-lightbox';
            overlay.addEventListener('click', () => overlay.classList.remove('open'));
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = kind === 'image'
            ? `<img src="${this._escapeHtml(url)}" alt="">`
            : '';
        overlay.classList.add('open');
    },

    setSendStatus(status) {
        const btn = document.getElementById('send-button');
        if (status === 'sending') {
            btn.innerHTML = '🔒';
        } else if (status === 'sent') {
            btn.innerHTML = '✓';
            btn.classList.remove('pop');
            void btn.offsetWidth; // restart animacji nawet przy szybkich kolejnych wysyłkach
            btn.classList.add('pop');
            setTimeout(() => {
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="send-icon"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>`;
            }, 500);
        } else if (status === 'error') {
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="send-icon"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>`;
        }
    },
    
    _escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
             .toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    },

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
