/**
 * ui/toasts.js — małe powiadomienia (toasty) w prawym górnym rogu.
 */
export const ToastsUI = {
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
};
