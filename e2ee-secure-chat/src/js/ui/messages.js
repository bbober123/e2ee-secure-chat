/**
 * ui/messages.js — renderowanie listy rozmów i wiadomości (tekst, media, zaproszenia
 * do gier), statusy dostarczenia/przeczytania, lightbox do zdjęć.
 */
import { AppState } from '../state.js';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export const MessagesUI = {
    _lastReactionsMap: new Map(),

    /** Buduje rząd "pigułek" (emoji + licznik, podświetlona jeśli JA tak zareagowałem/am) + przycisk otwierający picker. */
    _renderReactionsRow(messageId, reactionList) {
        const row = document.createElement('div');
        row.className = 'msg-reactions-row';

        const counts = new Map(); // emoji -> {count, mine}
        for (const r of reactionList) {
            const c = counts.get(r.emoji) || { count: 0, mine: false };
            c.count++;
            if (r.user_id === AppState.getUserId()) c.mine = true;
            counts.set(r.emoji, c);
        }

        const pills = [...counts.entries()].map(([emoji, { count, mine }]) => `
            <button type="button" class="msg-reaction-pill ${mine ? 'mine' : ''}" data-react-toggle="${messageId}" data-react-emoji="${emoji}">
                <span>${emoji}</span><span class="msg-reaction-count">${count}</span>
            </button>`).join('');

        row.innerHTML = `
            ${pills}
            <button type="button" class="msg-react-trigger" data-react-open="${messageId}" title="Dodaj reakcję">😊+</button>
            <div class="msg-reaction-picker" data-picker-for="${messageId}">
                ${QUICK_REACTIONS.map(e => `<button type="button" data-react-toggle="${messageId}" data-react-emoji="${e}">${e}</button>`).join('')}
            </div>`;
        return row;
    },

    /** Otwiera picker szybkich reakcji pod daną wiadomością (i zamyka wszystkie inne otwarte). */
    toggleReactionPicker(messageId) {
        const target = document.querySelector(`[data-picker-for="${messageId}"]`);
        const wasOpen = target?.classList.contains('open');
        this.closeReactionPicker();
        if (target && !wasOpen) target.classList.add('open');
    },

    closeReactionPicker() {
        document.querySelectorAll('.msg-reaction-picker.open').forEach(el => el.classList.remove('open'));
    },

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
                window.dispatchEvent(new CustomEvent('conversation-selected', { detail: { convId: conv.id, contactId: conv.contactId, isGroup: !!conv.isGroup, groupId: conv.groupId || null } }));
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

    renderMessages(messages, reactionsByMessage) {
        if (reactionsByMessage) this._lastReactionsMap = reactionsByMessage;
        const reactions = this._lastReactionsMap;
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

            // Wiadomości optymistyczne (jeszcze nie zapisane w bazie, id zaczyna się od "temp-")
            // nie mają jeszcze prawdziwego UUID, więc reakcji pod nimi jeszcze nie da się dodać.
            if (!msg.id?.toString().startsWith('temp-')) {
                content.appendChild(this._renderReactionsRow(msg.id, reactions.get(msg.id) || []));
            }

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

        if (msg.type === 'game_invite') {
            const meta = msg.mediaMeta || {};
            const gameLabels = { blackjack: '🂡 Blackjack', roulette: '🎡 Ruletka', slots: '🎰 Automaty', poker: '🃏 Poker' };
            wrap.className = 'msg-game-invite';
            wrap.innerHTML = `
                <div class="invite-icon">🎰</div>
                <div class="invite-body">
                    <div class="invite-title">Zaproszenie do gry</div>
                    <div class="invite-game">${this._escapeHtml(gameLabels[meta.game] || meta.game || 'Gra')} · stawka ${meta.bet ?? '?'} żetonów</div>
                </div>
                <button type="button" class="btn-primary invite-join-btn" data-join-game="${this._escapeHtml(meta.game || '')}" data-join-table="${this._escapeHtml(meta.tableId || '')}">Dołącz</button>`;
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
};
