/**
 * ui/friend-requests.js — odznaka i lista próśb o znajomość (przychodzące/wychodzące).
 */
export const FriendRequestsUI = {
    setFriendRequestsBadge(count) {
        const badge = document.getElementById('friend-requests-badge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 9 ? '9+' : String(count);
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    },

    renderFriendRequests(incoming, outgoing) {
        const list = document.getElementById('friend-requests-list');
        if (!list) return;

        if (!incoming.length && !outgoing.length) {
            list.innerHTML = `<p class="empty-hint">Brak oczekujących próśb.</p>`;
            return;
        }

        let html = '';
        if (incoming.length) {
            html += `<h4 class="fr-section-title">Otrzymane</h4>`;
            incoming.forEach(r => {
                html += `
                    <div class="fr-item">
                        <img class="fr-avatar" src="${this._escapeHtml(r.from_user?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${r.from_user_id}`)}" alt="">
                        <span class="fr-name">${this._escapeHtml(r.from_user?.username || 'Nieznany')}</span>
                        <div class="fr-actions">
                            <button class="btn-primary fr-btn-sm" data-accept-request="${r.id}">Akceptuj</button>
                            <button class="btn-cancel fr-btn-sm" data-decline-request="${r.id}">Odrzuć</button>
                        </div>
                    </div>`;
            });
        }
        if (outgoing.length) {
            html += `<h4 class="fr-section-title">Wysłane</h4>`;
            outgoing.forEach(r => {
                html += `
                    <div class="fr-item">
                        <img class="fr-avatar" src="${this._escapeHtml(r.to_user?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${r.to_user_id}`)}" alt="">
                        <span class="fr-name">${this._escapeHtml(r.to_user?.username || 'Nieznany')}</span>
                        <div class="fr-actions">
                            <span class="fr-pending">Oczekuje…</span>
                            <button class="btn-cancel fr-btn-sm" data-decline-request="${r.id}">Cofnij</button>
                        </div>
                    </div>`;
            });
        }
        list.innerHTML = html;
    },
};
