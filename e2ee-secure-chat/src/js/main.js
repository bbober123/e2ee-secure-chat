import { AuthManager, keyManager } from './auth.js';
import { UI } from './ui.js';
import { supabase } from './supabase.js';
import { ChatApp } from './chat.js';

document.addEventListener('DOMContentLoaded', async () => {
    UI.init();

    // 1. Sprawdzenie sesji Supabase
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
        UI.showAuthScreen();
    } else {
        window.CURRENT_USER = session.user;
        // Zalogowany - sprawdzamy czy klucze E2EE są w pamięci operacyjnej
        if (keyManager.hasUnlockedKeys()) {
            UI.showApp();
            ChatApp.init();
        } else {
            UI.showLockScreen();
        }
    }

    document.getElementById('force-logout-button').addEventListener('click', async () => {
        await AuthManager.logout();
    });

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
                await AuthManager.loginAndUnlock(email, password);
                UI.showApp();
                ChatApp.init();
                UI.showToast('Zalogowano bezpiecznie', 'success');
            } else {
                await AuthManager.loginAndUnlock(email, password);
                UI.showApp();
                ChatApp.init();
                UI.showToast('Zalogowano bezpiecznie', 'success');
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
});
