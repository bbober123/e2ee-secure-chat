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
        toast.className = `toast ${type} slide-up`;
        toast.textContent = message;
        
        this.toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    renderConversations(conversations, activeId = null) {
        const list = document.getElementById('conversations-list');
        list.innerHTML = '';
        
        conversations.forEach(conv => {
            const item = document.createElement('div');
            item.className = `conv-item ${conv.id === activeId ? 'active' : ''}`;
            item.onclick = () => {
                document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                this.appContainer.classList.add('chat-active');
                document.getElementById('chat-title').textContent = conv.nickname;
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

            const text = document.createElement('div');
            text.className = 'msg-text';
            text.textContent = msg.text;
            
            content.appendChild(text);
            group.appendChild(avatar);
            group.appendChild(content);
            
            container.appendChild(group);
        });
    },

    setSendStatus(status) {
        const btn = document.getElementById('send-button');
        if (status === 'sending') {
            btn.innerHTML = '🔒';
        } else if (status === 'sent') {
            btn.innerHTML = '✓';
            setTimeout(() => {
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="send-icon"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>`;
            }, 500);
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
    }
};
