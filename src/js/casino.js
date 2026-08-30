import { AppState } from './state.js';
import { Wallet } from './casino/wallet.js';
import { SoloBlackjack, MultiplayerBlackjack, createBlackjackInviteTable } from './casino/blackjack.js';
import { Roulette } from './casino/roulette.js';
import { SlotMachine } from './casino/slots.js';
import { SoloPoker } from './casino/poker.js';
import { CaseOpening } from './casino/cases.js';

const GAMES = [
    { id: 'blackjack', title: 'Blackjack', icon: '🂡', tagline: 'Podbij krupiera do 21. Graj solo albo zaproś znajomego.' },
    { id: 'roulette', title: 'Ruletka', icon: '🎡', tagline: 'Postaw na kolor, numer albo tuzin i zakręć kołem.' },
    { id: 'slots', title: 'Automaty', icon: '🎰', tagline: 'Klasyczny jednoręki bandyta z 3 bębnami.' },
    { id: 'poker', title: 'Poker', icon: '🃏', tagline: 'Texas Hold\'em przeciwko botom przy stole.' },
    { id: 'cases', title: 'Skrzynki', icon: '📦', tagline: 'Otwórz skrzynkę i zgarnij losowy skin za żetony.' }
];

export const Casino = {
    currentGame: null,
    currentInstance: null,

    async open(gameId = null, opts = {}) {
        document.getElementById('casino-overlay').style.display = 'flex';
        await Wallet.load();
        this._renderWalletBar();
        if (gameId) {
            await this._openGame(gameId, opts);
        } else {
            this._renderHub();
        }
    },

    close() {
        document.getElementById('casino-overlay').style.display = 'none';
        this._teardownCurrent();
    },

    _teardownCurrent() {
        if (this.currentInstance?.stop) this.currentInstance.stop();
        this.currentInstance = null;
        this.currentGame = null;
    },

    _renderWalletBar() {
        document.getElementById('casino-balance').textContent = Wallet.balance.toLocaleString('pl-PL');
        const bonusBtn = document.getElementById('casino-daily-bonus-btn');
        bonusBtn.style.display = Wallet.canClaimDailyBonus() ? 'inline-block' : 'none';
    },

    _renderHub() {
        this._teardownCurrent();
        const body = document.getElementById('casino-body');
        body.innerHTML = `
            <div class="casino-hub-grid">
                ${GAMES.map(g => `
                    <div class="casino-game-card" data-game="${g.id}">
                        <div class="casino-game-icon">${g.icon}</div>
                        <div class="casino-game-title">${g.title}</div>
                        <div class="casino-game-tagline">${g.tagline}</div>
                    </div>`).join('')}
            </div>`;
        body.querySelectorAll('[data-game]').forEach(card => {
            card.addEventListener('click', () => this._openGame(card.dataset.game));
        });
    },

    async _openGame(gameId, opts = {}) {
        this._teardownCurrent();
        this.currentGame = gameId;
        const body = document.getElementById('casino-body');
        body.innerHTML = `
            <div class="casino-game-header">
                <button class="btn-cancel" id="casino-hub-back">← Wybór gry</button>
                <h3>${GAMES.find(g => g.id === gameId)?.title || gameId}</h3>
            </div>
            <div id="casino-game-mount" class="casino-game-mount"></div>`;
        document.getElementById('casino-hub-back').addEventListener('click', () => this._renderHub());
        const mount = document.getElementById('casino-game-mount');

        if (gameId === 'blackjack') {
            if (opts.tableId) {
                mount.innerHTML = `<div class="bj-mode-header">🤝 Gra ze znajomym</div><div id="bj-mount"></div>`;
                this.currentInstance = new MultiplayerBlackjack(document.getElementById('bj-mount'), opts.tableId);
                await this.currentInstance.start();
            } else {
                mount.innerHTML = `
                    <div class="bj-mode-header">
                        🤖 Gra solo (vs krupier-bot)
                        <button class="btn-primary bj-invite-btn" id="bj-invite-friend-btn">🤝 Zaproś znajomego zamiast tego</button>
                    </div>
                    <div id="bj-mount"></div>`;
                this.currentInstance = new SoloBlackjack(document.getElementById('bj-mount'));
                this.currentInstance.render();
                document.getElementById('bj-invite-friend-btn').addEventListener('click', () => this._openInviteFriendPicker('blackjack'));
            }
        } else if (gameId === 'roulette') {
            this.currentInstance = new Roulette(mount);
        } else if (gameId === 'slots') {
            this.currentInstance = new SlotMachine(mount);
        } else if (gameId === 'poker') {
            this.currentInstance = new SoloPoker(mount);
            this.currentInstance.start();
        } else if (gameId === 'cases') {
            this.currentInstance = new CaseOpening(mount);
        }

        this._refreshWalletLoop();
    },

    /** Odświeża widoczne saldo po każdej akcji w grze (proste polling co sekundę, gier nie ma wiele naraz). */
    _refreshWalletLoop() {
        if (this._walletInterval) clearInterval(this._walletInterval);
        this._walletInterval = setInterval(() => {
            if (!document.getElementById('casino-overlay') || document.getElementById('casino-overlay').style.display === 'none') {
                clearInterval(this._walletInterval);
                return;
            }
            document.getElementById('casino-balance').textContent = Wallet.balance.toLocaleString('pl-PL');
        }, 800);
    },

    async claimDailyBonus() {
        const amount = await Wallet.claimDailyBonus();
        const { UI } = await import('./ui.js');
        if (amount) {
            UI.showToast(`+${amount} żetonów bonusu dobowego!`, 'success');
        } else {
            UI.showToast('Bonus dobowy jeszcze niedostępny — wróć później.', 'error');
        }
        this._renderWalletBar();
    },

    /** Otwiera picker znajomego do zaproszenia (lista kontaktów z ChatApp) i wysyła zaproszenie jako wiadomość czatu. */
    async _openInviteFriendPicker(game) {
        const { ChatApp } = await import('./chat.js');
        const { UI } = await import('./ui.js');
        const contacts = Array.from(ChatApp.contacts.values());
        if (!contacts.length) {
            UI.showToast('Nie masz jeszcze żadnych znajomych do zaproszenia.', 'error');
            return;
        }

        const bet = 100; // stała stawka dla zaproszeń - prostsze niż negocjacja stawki w UI
        const picker = document.createElement('div');
        picker.className = 'modal-overlay';
        picker.style.display = 'flex';
        picker.innerHTML = `
            <div class="modal-card" style="text-align:left;">
                <h3 style="text-align:center;">Zaproś znajomego (stawka: ${bet} żetonów)</h3>
                <div class="fr-list">
                    ${contacts.map(c => `
                        <div class="fr-item" data-contact-id="${c.id}" style="cursor:pointer;">
                            <img class="fr-avatar" src="${c.avatar}" alt="">
                            <span class="fr-name">${c.display_name}</span>
                        </div>`).join('')}
                </div>
                <div class="modal-actions">
                    <button class="btn-cancel" id="invite-picker-cancel">Anuluj</button>
                </div>
            </div>`;
        document.body.appendChild(picker);
        picker.querySelector('#invite-picker-cancel').addEventListener('click', () => picker.remove());
        picker.querySelectorAll('[data-contact-id]').forEach(el => {
            el.addEventListener('click', async () => {
                picker.remove();
                await this._sendGameInvite(game, el.dataset.contactId, bet);
            });
        });
    },

    async _sendGameInvite(game, contactId, bet) {
        const { ChatApp } = await import('./chat.js');
        const { UI } = await import('./ui.js');
        try {
            const table = await createBlackjackInviteTable(contactId, bet);
            await ChatApp.sendGameInviteMessage(contactId, { game, tableId: table.id, bet });
            UI.showToast('Zaproszenie wysłane na czat!', 'success');
            this.close();
        } catch (e) {
            console.error(e);
            UI.showToast('Nie udało się wysłać zaproszenia.', 'error');
        }
    },

    /** Wołane z ui.js przy kliknięciu "Dołącz do gry" na wiadomości typu game_invite. */
    async joinFromInvite(game, tableId) {
        await this.open(game, { tableId });
    }
};

function wireCasinoNav() {
    const navBtn = document.getElementById('casino-nav-btn');
    const backBtn = document.getElementById('casino-back-btn');
    const bonusBtn = document.getElementById('casino-daily-bonus-btn');
    if (navBtn) navBtn.addEventListener('click', () => Casino.open());
    if (backBtn) backBtn.addEventListener('click', () => Casino.close());
    if (bonusBtn) bonusBtn.addEventListener('click', () => Casino.claimDailyBonus());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireCasinoNav);
} else {
    wireCasinoNav();
}
