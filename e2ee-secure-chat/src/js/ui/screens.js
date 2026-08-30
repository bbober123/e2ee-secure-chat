/**
 * ui/screens.js — ekrany pełnoekranowe: lock screen, auth, przełączanie kont,
 * modal ustawień oraz generyczne helpery do otwierania/zamykania modali.
 * Część obiektu UI (patrz ../ui.js - łączy wszystkie moduły przez spread).
 */
export const ScreensUI = {
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
        // "+" - menu z 4 opcjami: utwórz grupę / dołącz do grupy / dodaj znajomego / prośby o znajomość
        document.getElementById('add-contact-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.getElementById('plus-dropdown-menu');
            menu.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('plus-dropdown-menu');
            if (menu && menu.classList.contains('open') && !menu.contains(e.target) && e.target.id !== 'add-contact-btn') {
                menu.classList.remove('open');
            }
        });
        document.getElementById('menu-open-add-friend').addEventListener('click', () => {
            document.getElementById('plus-dropdown-menu').classList.remove('open');
            this.showModal('add-contact-modal');
        });
        document.getElementById('menu-open-create-group').addEventListener('click', () => {
            document.getElementById('plus-dropdown-menu').classList.remove('open');
            this.showModal('create-group-modal');
        });
        document.getElementById('menu-open-join-group').addEventListener('click', () => {
            document.getElementById('plus-dropdown-menu').classList.remove('open');
            this.showModal('join-group-modal');
        });
        document.getElementById('menu-open-friend-requests').addEventListener('click', () => {
            document.getElementById('plus-dropdown-menu').classList.remove('open');
            window.dispatchEvent(new CustomEvent('open-friend-requests'));
        });

        // Zamykanie modali - wszystkie modale w tym projekcie mają [data-close-modal] na przyciskach anuluj/X.
        document.querySelectorAll('[data-close-modal]').forEach(btn => {
            btn.addEventListener('click', () => this.closeAllMenusAndModals());
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

    /** Otwiera dowolny modal z konwencją .modal-overlay używaną w tym projekcie. */
    showModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.style.display = 'flex';
    },

    /** Zamyka dropdown "+" i WSZYSTKIE modale naraz - wygodne po udanej akcji (utworzono grupę itp.). */
    closeAllMenusAndModals() {
        const menu = document.getElementById('plus-dropdown-menu');
        if (menu) menu.classList.remove('open');
        document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; });
        ['contact-username', 'contact-nickname', 'contact-fake-nickname', 'group-name-input', 'join-group-username', 'join-group-code']
            .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    },
};
