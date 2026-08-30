import { Wallet } from './wallet.js';
import { renderHand } from './cards.js';
import { renderBetInput, wireBetInput } from './bet-input.js';
import {
    createPokerTable, startHand, applyAction, isBettingRoundOver,
    nextActorIndex, advanceStreet, settleShowdown, activePlayers, botDecision
} from './poker-engine.js';

const BUY_IN = 500;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const BOT_NAMES = ['Bot Krzysiek', 'Bot Ania', 'Bot Tomek'];

export class SoloPoker {
    constructor(container) {
        this.el = container;
        this.table = null;
        this.lastPayouts = [];
        this.handOver = false;
    }

    async start() {
        const ok = await Wallet.spend(BUY_IN);
        if (!ok) {
            this.el.innerHTML = `<p class="empty-hint">Za mało żetonów na wejście do gry (potrzeba ${BUY_IN}).</p>`;
            return;
        }
        this.table = createPokerTable({
            playerNames: ['Ty', ...BOT_NAMES],
            buyIn: BUY_IN, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND
        });
        this._startHand();
    }

    _startHand() {
        for (const p of this.table.players) {
            if (p.stack <= 0 && p.isBot) p.stack = BUY_IN; // boty "dokupują" za darmo (NPC), Ty dokupujesz z portfela w nextHand()
        }
        startHand(this.table);
        this.handOver = false;
        this.lastPayouts = [];
        this.render();
        this._maybeAdvanceBots();
    }

    get me() { return this.table.players[0]; }

    async _playerAction(action, raiseTo) {
        if (this.table.actorIndex !== 0 || this.handOver) return;
        applyAction(this.table, 0, action, raiseTo);
        this._advanceTurn();
    }

    _advanceTurn() {
        if (activePlayers(this.table).length <= 1) { this._finishHand(); return; }
        if (isBettingRoundOver(this.table)) {
            if (this.table.street === 'river') { advanceStreet(this.table); this._finishHand(); return; }
            advanceStreet(this.table);
            this.render();
            this._maybeAdvanceBots();
            return;
        }
        const next = nextActorIndex(this.table, this.table.actorIndex);
        if (next === -1) { this._finishHand(); return; }
        this.table.actorIndex = next;
        this.render();
        this._maybeAdvanceBots();
    }

    _maybeAdvanceBots() {
        if (this.handOver) return;
        if (activePlayers(this.table).length <= 1) { this._finishHand(); return; }
        if (isBettingRoundOver(this.table)) {
            if (this.table.street === 'river') { advanceStreet(this.table); this._finishHand(); return; }
            advanceStreet(this.table);
            this.render();
            this._maybeAdvanceBots();
            return;
        }
        const actor = this.table.players[this.table.actorIndex];
        if (!actor.isBot) { this.render(); return; }

        setTimeout(() => {
            if (this.handOver) return;
            const decision = botDecision(this.table, actor);
            applyAction(this.table, actor.id, decision.action, decision.raiseTo);
            this.render();
            this._advanceTurn();
        }, 550);
    }

    async _finishHand() {
        this.handOver = true;
        while (this.table.street !== 'showdown') advanceStreet(this.table);
        this.lastPayouts = settleShowdown(this.table);

        const myPayout = this.lastPayouts.find(p => p.playerId === 0);
        if (myPayout) await Wallet.win(myPayout.amount);

        this.render();
    }

    nextHand() {
        this.table.dealerIndex = (this.table.dealerIndex + 1) % this.table.players.length;
        if (this.me.stack <= 0) {
            Wallet.spend(BUY_IN).then(ok => {
                if (ok) { this.me.stack = BUY_IN; this._startHand(); }
                else this.el.innerHTML = `<p class="empty-hint">Za mało żetonów na dokupienie. Wróć, gdy zdobędziesz więcej.</p>`;
            });
            return;
        }
        this._startHand();
    }

    render() {
        const t = this.table;
        const me = this.me;
        const others = t.players.slice(1);

        this.el.innerHTML = `
            <div class="poker-table">
                <div class="poker-bots-row">
                    ${others.map(b => `
                        <div class="poker-seat ${t.actorIndex === b.id && !this.handOver ? 'poker-seat-active' : ''} ${b.folded ? 'poker-seat-folded' : ''}">
                            <div class="poker-seat-name">${b.name} ${b.allIn ? '(all-in)' : ''}</div>
                            ${renderHand(b.hole, { hideFirst: !this.handOver && !b.folded, small: true })}
                            <div class="poker-seat-stack">🪙 ${b.stack}</div>
                            ${b.streetContributed > 0 ? `<div class="poker-seat-bet">Zakład: ${b.streetContributed}</div>` : ''}
                        </div>`).join('')}
                </div>

                <div class="poker-community">
                    <div class="poker-pot">Pula: 🪙 ${t.pot}</div>
                    <div class="card-hand">${t.community.map(c => renderHand([c])).join('')}</div>
                    ${this.handOver ? `<div class="poker-result">${this._resultText()}</div>` : ''}
                </div>

                <div class="poker-seat poker-seat-me ${t.actorIndex === 0 && !this.handOver ? 'poker-seat-active' : ''}">
                    <div class="poker-seat-name">Ty ${me.allIn ? '(all-in)' : ''} ${me.folded ? '(spasowałeś)' : ''}</div>
                    ${renderHand(me.hole)}
                    <div class="poker-seat-stack">🪙 ${me.stack}</div>
                    ${me.streetContributed > 0 ? `<div class="poker-seat-bet">Zakład: ${me.streetContributed}</div>` : ''}
                </div>

                <div class="poker-controls">
                    ${this._renderControls()}
                </div>
            </div>`;

        this._wire();
    }

    _resultText() {
        if (!this.lastPayouts.length) return '';
        return this.lastPayouts.map(p => {
            const name = this.table.players.find(pl => pl.id === p.playerId)?.name;
            return `${name} wygrywa ${p.amount}${p.handName ? ` (${p.handName})` : ''}`;
        }).join(' · ');
    }

    _renderControls() {
        if (this.handOver) {
            return `<button class="btn-primary" id="poker-next">Kolejne rozdanie</button>`;
        }
        if (this.table.actorIndex !== 0 || this.me.folded || this.me.allIn) {
            return `<div class="bj-thinking">${this.me.folded ? 'Czekasz na koniec rozdania…' : 'Tura przeciwnika…'}</div>`;
        }
        const toCall = this.table.currentBet - this.me.streetContributed;
        return `
            <div class="bj-action-row">
                <button class="btn-cancel" id="poker-fold">Pas</button>
                ${toCall > 0 ? `<button class="btn-primary" id="poker-call">Sprawdź (${toCall})</button>` : `<button class="btn-primary" id="poker-check">Czekaj</button>`}
                <button class="btn-primary" id="poker-raise">Podbij (+${this.table.bigBlind * 2})</button>
            </div>
            <div class="roulette-chip-select poker-custom-raise">
                Własne podbicie: ${renderBetInput(null, false, false)}
            </div>`;
    }

    _wire() {
        this.el.querySelector('#poker-fold')?.addEventListener('click', () => this._playerAction('fold'));
        this.el.querySelector('#poker-check')?.addEventListener('click', () => this._playerAction('check'));
        this.el.querySelector('#poker-call')?.addEventListener('click', () => this._playerAction('call'));
        this.el.querySelector('#poker-raise')?.addEventListener('click', () => this._playerAction('raise', this.table.currentBet + this.table.bigBlind * 2));
        wireBetInput(this.el, (amount) => this._playerAction('raise', this.table.currentBet + amount));
        this.el.querySelector('#poker-next')?.addEventListener('click', () => this.nextHand());
    }
}
