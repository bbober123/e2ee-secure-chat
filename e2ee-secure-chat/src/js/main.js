import { AuthManager, keyManager } from './auth.js';
import { UI } from './ui.js';
import { supabase } from './supabase.js';
import { ChatApp } from './chat.js';
import { AccountSwitcher } from './accounts.js';
import { ProfileManager } from './profile.js';
import { AppState } from './state.js';
import './casino.js';

/** Pokazuje ekran logowania, z listą zapisanych kont (jeśli jakieś są). */
function presentAuthScreen() {
    UI.showAuthScreen();
    UI.renderSavedAccounts(AccountSwitcher.list(), (acc) => {
        UI.showSwitchAccountScreen(acc);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    UI.init();

    // 1. Sprawdzenie sesji Supabase
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
        presentAuthScreen();
    } else {
        AppState.setUser(session.user);
        // Zalogowany - sprawdzamy czy klucze E2EE są w pamięci operacyjnej
        if (keyManager.hasUnlockedKeys()) {
            UI.showApp();
            ChatApp.init();
        } else {
            UI.showLockScreen();
        }
    }

    document.getElementById('force-logout-button').addEventListener('click', async () => {
        ChatApp.endActiveCallIfAny();
        await AuthManager.logout();
    });

    window.addEventListener('app-locked', () => ChatApp.endActiveCallIfAny());

    // 2. Odblokowanie (Lock Screen)
    document.getElementById('unlock-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('unlock-password').value;
        const btn = document.getElementById('unlock-button');
        btn.textContent = 'Odblokowywanie...';
        btn.disabled = true;

        try {
            await AuthManager.unlock(password);
            UI.showApp();
            ChatApp.init();
            UI.showToast(`Zdeszyfrowano bezpieczny magazyn`, 'success');
        } catch (err) {
            UI.showUnlockError();
            UI.showToast(err.message, 'error');
        } finally {
            btn.textContent = 'Odblokuj';
            btn.disabled = false;
        }
    });

    // 3. Logowanie / Rejestracja
    let isRegistering = false;
    const authTitle = document.getElementById('auth-title');
    const authSubmitBtn = document.getElementById('auth-submit-btn');
    const authToggleText = document.getElementById('auth-toggle-text');
    const authToggleBtn = document.getElementById('auth-toggle-btn');
    const authUsername = document.getElementById('auth-username');
    const authFakePassword = document.getElementById('auth-fake-password');

    authToggleBtn.addEventListener('click', () => {
        isRegistering = !isRegistering;
        if (isRegistering) {
            authTitle.textContent = 'Rejestracja';
            authSubmitBtn.textContent = 'Zarejestruj';
            authToggleText.textContent = 'Masz konto?';
            authToggleBtn.textContent = 'Zaloguj się';
            authUsername.style.display = 'block';
            authUsername.required = true;
            authFakePassword.style.display = 'block';
        } else {
            authTitle.textContent = 'Logowanie';
            authSubmitBtn.textContent = 'Wejdź';
            authToggleText.textContent = 'Nie masz konta?';
            authToggleBtn.textContent = 'Zarejestruj się';
            authUsername.style.display = 'none';
            authUsername.required = false;
            authFakePassword.style.display = 'none';
        }
    });

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        
        const origText = authSubmitBtn.textContent;
        authSubmitBtn.textContent = 'Proszę czekać...';
        authSubmitBtn.disabled = true;
        
        try {
            if (isRegistering) {
                const username = authUsername.value;
                const fakePassword = authFakePassword.value;
                await AuthManager.register(email, username, password, fakePassword);
                UI.showToast('Zarejestrowano pomyślnie. Trwa logowanie...', 'success');
                const r1 = await AuthManager.loginAndUnlock(email, password);
                UI.showApp();
                ChatApp.init();
                UI.showToast('Zalogowano bezpiecznie', 'success');
                if (r1.isNewDevice) UI.showToast('To urządzenie zostało dodane do Twojego konta', 'success');
            } else {
                const r2 = await AuthManager.loginAndUnlock(email, password);
                UI.showApp();
                ChatApp.init();
                UI.showToast('Zalogowano bezpiecznie', 'success');
                if (r2.isNewDevice) UI.showToast('⚠️ Nowe urządzenie zostało dodane do konta. Jeśli to nie Ty się logujesz, zmień hasło.', 'error');
            }
        } catch (err) {
            UI.showToast(err.message, 'error');
        } finally {
            authSubmitBtn.textContent = origText;
            authSubmitBtn.disabled = false;
        }
    });

    // 4. Blokada ręczna
    document.getElementById('manual-lock-btn').addEventListener('click', () => {
        AuthManager.lockDevice();
        UI.showLockScreen();
        UI.showToast('Pamięć wyczyszczona. Aplikacja zablokowana.', 'success');
    });

    // 5. Wybór zapisanego konta na ekranie logowania
    document.getElementById('use-other-account-btn').addEventListener('click', () => {
        document.getElementById('saved-accounts-panel').style.display = 'none';
        document.getElementById('auth-form').style.display = 'flex';
    });

    document.getElementById('switch-account-cancel-btn').addEventListener('click', () => {
        presentAuthScreen();
    });

    document.getElementById('switch-account-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const accountId = document.getElementById('switch-account-screen').dataset.accountId;
        const password = document.getElementById('switch-account-password').value;
        const btn = document.getElementById('switch-account-button');
        btn.textContent = 'Odblokowywanie...';
        btn.disabled = true;

        try {
            if (!accountId) throw new Error('Nie znaleziono wybranego konta. Spróbuj ponownie.');
            await AuthManager.switchAccount(accountId, password);
            UI.showApp();
            ChatApp.init();
            UI.showToast('Zalogowano bezpiecznie', 'success');
        } catch (err) {
            UI.showToast(err.message, 'error');
            presentAuthScreen();
        } finally {
            btn.textContent = 'Odblokuj';
            btn.disabled = false;
        }
    });

    // 6. Ustawienia: awatar, historia logowań, przełączanie/dodawanie kont
    async function openSettings() {
        let avatarUrl = null;
        try {
            const { data } = await supabase.from('users').select('avatar_url').eq('id', AppState.getUser().id).single();
            avatarUrl = data?.avatar_url;
        } catch (e) { /* ignore */ }

        const history = await ProfileManager.getLoginHistory();

        UI.openSettingsModal({
            avatarUrl,
            accounts: AccountSwitcher.list(),
            currentUserId: AppState.getUserId(),
            history,
            onSwitchAccount: (acc) => {
                document.getElementById('settings-modal').style.display = 'none';
                keyManager.clearMemory();
                AuthManager.clearAutoLockTimer();
                AppState.setMode(null);
                AppState.setUser(null);
                UI.showSwitchAccountScreen(acc);
            },
        });
    }

    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('my-avatar-btn').addEventListener('click', openSettings);

    document.getElementById('avatar-choose-btn').addEventListener('click', () => {
        document.getElementById('avatar-file-input').click();
    });

    document.getElementById('avatar-file-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const url = await ProfileManager.updateAvatar(file);
            document.getElementById('settings-avatar-preview').src = url;
            ChatApp.updateMyAvatar(url);
            UI.showToast('Awatar zaktualizowany', 'success');
        } catch (err) {
            UI.showToast(err.message, 'error');
        } finally {
            e.target.value = '';
        }
    });

    document.getElementById('settings-add-account-btn').addEventListener('click', () => {
        // Zachowuje bieżące konto zapisane na urządzeniu (bez wylogowania) -
        // po prostu przełącza kartę logowania na pusty formularz nowego konta.
        document.getElementById('settings-modal').style.display = 'none';
        keyManager.clearMemory();
        AuthManager.clearAutoLockTimer();
        AppState.setMode(null);
        AppState.setUser(null);
        UI.showAuthScreen();
        document.getElementById('saved-accounts-panel').style.display = 'none';
        document.getElementById('auth-form').style.display = 'flex';
    });

    document.getElementById('settings-logout-btn').addEventListener('click', async () => {
        document.getElementById('settings-modal').style.display = 'none';
        ChatApp.endActiveCallIfAny();
        await AuthManager.logout();
    });
});
