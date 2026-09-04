import { supabase } from '../supabase.js';
import { AppState } from '../state.js';
import { Wallet } from './wallet.js';
import { createShuffledDeck, blackjackValue, renderHand } from './cards.js';
import { renderBetInput, wireBetInput } from './bet-input.js';

/** Suma ręki w blackjacku, z automatyczną redukcją Asów (11->1) przy przebiciu. */
export function handTotal(cards) {
    let total = cards.reduce((sum, c) => sum + blackjackValue(c.rank), 0);
    let aces = cards.filter(c => c.rank === 'A').length;
    let soft = aces > 0;
    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }
    if (aces === 0) soft = false;
    return { total, soft, bust: total > 21, blackjack: total === 21 && cards.length === 2 };
}

function dealerShouldHit(cards) {
    const { total, soft } = handTotal(cards);
    if (total < 17) return true;
    if (total === 17 && soft) return true; // dealer hits soft 17 (standardowa reguła kasynowa)
    return false;
}

// =====================================================================
// SOLO — gracz kontra krupier (bot)
// =====================================================================

export class SoloBlackjack {
    constructor(container) {
        this.el = container;
        this.deck = createShuffledDeck(4); // 4 talie, jak w większości kasyn - trudniej liczyć karty
        this.bet = 100;
        this.phase = 'betting'; // betting | player | dealer | result
        this.playerHand = [];
        this.dealerHand = [];
        this.doubledDown = false;
        this.resultText = '';
    }

    _drawCard() {
        if (this.deck.length < 10) this.deck = createShuffledDeck(4);
        return this.deck.pop();
    }

    async placeBet(amount) {
        if (this.phase !== 'betting') return;
        const ok = await Wallet.spend(amount);
        if (!ok) { this.resultText = 'Za mało żetonów!'; this.render(); return; }
        this.bet = amount;
        this.playerHand = [this._drawCard(), this._drawCard()];
        this.dealerHand = [this._drawCard(), this._drawCard()];
        this.doubledDown = false;
        this.phase = 'player';
        this.resultText = '';

        if (handTotal(this.playerHand).blackjack) {
            await this._settle();
        }
        this.render();
    }

    async hit() {
        if (this.phase !== 'player') return;
        this.playerHand.push(this._drawCard());
        if (handTotal(this.playerHand).bust) {
            await this._settle();
        }
        this.render();
    }

    async doubleDown() {
        if (this.phase !== 'player' || this.playerHand.length !== 2) return;
        const ok = await Wallet.spend(this.bet);
        if (!ok) return;
        this.bet *= 2;
        this.doubledDown = true;
        this.playerHand.push(this._drawCard());
        await this._settle();
        this.render();
    }

    async stand() {
        if (this.phase !== 'player') return;
        await this._settle();
        this.render();
    }

    async _settle() {
        this.phase = 'dealer';
        const player = handTotal(this.playerHand);

        if (!player.bust) {
            while (dealerShouldHit(this.dealerHand)) {
                this.dealerHand.push(this._drawCard());
            }
        }

        const dealer = handTotal(this.dealerHand);
        let payout = 0;

        if (player.bust) {
            this.resultText = `💥 Przebiłeś (${player.total}) — krupier wygrywa.`;
        } else if (player.blackjack && !dealer.blackjack) {
            payout = Math.floor(this.bet * 2.5); // 3:2 + zwrot stawki
            this.resultText = `🂡 Blackjack! Wygrywasz ${payout} żetonów.`;
        } else if (dealer.bust) {
            payout = this.bet * 2;
            this.resultText = `🎉 Krupier przebił (${dealer.total}) — wygrywasz ${payout} żetonów!`;
        } else if (player.total > dealer.total) {
            payout = this.bet * 2;
            this.resultText = `🎉 Wygrywasz ${player.total} vs ${dealer.total} — +${payout} żetonów!`;
        } else if (player.total === dealer.total) {
            payout = this.bet;
            this.resultText = `🤝 Remis (${player.total}) — stawka zwrócona.`;
        } else {
            this.resultText = `😔 Krupier wygrywa ${dealer.total} vs ${player.total}.`;
        }

        if (payout > 0) await Wallet.win(payout);
        this.phase = 'result';
    }

    newRound() {
        this.phase = 'betting';
        this.playerHand = [];
        this.dealerHand = [];
        this.resultText = '';
        this.render();
    }

    render() {
        const player = handTotal(this.playerHand);
        const dealer = handTotal(this.dealerHand);
        const hideDealerHole = this.phase === 'player';

        this.el.innerHTML = `
            <div class="bj-table">
                <div class="bj-dealer-area">
                    <div class="bj-label">Krupier ${this.dealerHand.length ? (hideDealerHole ? '' : `· ${dealer.total}`) : ''}</div>
                    ${this.dealerHand.length ? renderHand(this.dealerHand, { hideFirst: hideDealerHole }) : '<div class="bj-empty-slot">Miejsce na karty krupiera</div>'}
                </div>

                <div class="bj-center">
                    ${this.resultText ? `<div class="bj-result">${this.resultText}</div>` : ''}
                </div>

                <div class="bj-player-area">
                    <div class="bj-label">Ty ${this.playerHand.length ? `· ${player.total}${player.soft ? ' (miękkie)' : ''}` : ''}</div>
                    ${this.playerHand.length ? renderHand(this.playerHand) : '<div class="bj-empty-slot">Postaw, żeby rozdać karty</div>'}
                </div>

                <div class="bj-controls">
                    ${this._renderControls()}
                </div>
            </div>`;

        this._wireControls();
    }

    _renderControls() {
        if (this.phase === 'betting') {
            return `
                <div class="bj-bet-row">
                    ${[25, 100, 250, 500].map(v => `<button class="chip-btn" data-bet="${v}">${v}</button>`).join('')}
                    ${renderBetInput(null, false, false)}
                </div>`;
        }
        if (this.phase === 'player') {
            return `
                <div class="bj-action-row">
                    <button class="btn-primary" id="bj-hit">Dobierz</button>
                    <button class="btn-cancel" id="bj-stand">Stój</button>
                    ${this.playerHand.length === 2 ? `<button class="btn-cancel" id="bj-double">Podwój</button>` : ''}
                </div>`;
        }
        if (this.phase === 'dealer') {
            return `<div class="bj-thinking">Krupier dobiera karty…</div>`;
        }
        return `<button class="btn-primary" id="bj-next">Nowa runda</button>`;
    }

    _wireControls() {
        this.el.querySelectorAll('[data-bet]').forEach(btn => {
            btn.addEventListener('click', () => this.placeBet(parseInt(btn.dataset.bet, 10)));
        });
        wireBetInput(this.el, (amount) => this.placeBet(amount));
        this.el.querySelector('#bj-hit')?.addEventListener('click', () => this.hit());
        this.el.querySelector('#bj-stand')?.addEventListener('click', () => this.stand());
        this.el.querySelector('#bj-double')?.addEventListener('click', () => this.doubleDown());
        this.el.querySelector('#bj-next')?.addEventListener('click', () => this.newRound());
    }
}

// =====================================================================
// MULTIPLAYER — gra ze znajomym przy tym samym stole (wspólny krupier-bot)
// =====================================================================
//
// UWAGA (uczciwie o granicach): stan stołu (w tym talia i karty obu graczy)
// leży w jednej, współdzielonej kolumnie JSONB (`casino_tables.state`),
// czytelnej dla obu uczestników od razu (bo oboje muszą widzieć swoje karty
// i mogą też - technicznie - podejrzeć całą resztę stanu wprost z bazy).
// To NIE jest zabezpieczone przed oszukiwaniem przez kogoś, kto celowo grzebie
// w danych przez konsolę deweloperską. Dla żetonów-zabawy między znajomymi
// to akceptowalny kompromis (brak osobnego serwera gry) - gdyby to miało być
// grane "na poważnie" o coś wartościowego, potrzebny byłby serwerowy dealer.

export async function createBlackjackInviteTable(friendUserId, bet) {
    const userId = AppState.getUser().id;
    const { data, error } = await supabase.from('casino_tables').insert({
        game: 'blackjack',
        creator_id: userId,
        participant_ids: [userId, friendUserId],
        status: 'waiting',
        state: { bet, players: {}, phase: 'waiting', deck: [], dealerHand: [], turnOrder: [], currentTurn: null, settledBy: [] }
    }).select().single();
    if (error) throw error;
    return data;
}

export class MultiplayerBlackjack {
    constructor(container, tableId) {
        this.el = container;
        this.tableId = tableId;
        this.channel = null;
        this.table = null;
    }

    async start() {
        const { data, error } = await supabase.from('casino_tables').select('*').eq('id', this.tableId).single();
        if (error || !data) { this.el.innerHTML = `<p class="empty-hint">Nie znaleziono stołu (może gra już się zakończyła).</p>`; return; }
        this.table = data;
        await this._maybeJoin();
        this.render();

        this.channel = supabase.channel(`casino-table-${this.tableId}`)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'casino_tables', filter: `id=eq.${this.tableId}` }, (payload) => {
                this.table = payload.new;
                this._maybeSettle();
                this.render();
            })
            .subscribe();
    }

    stop() {
        if (this.channel) supabase.removeChannel(this.channel);
    }

    get myId() { return AppState.getUser().id; }

    async _maybeJoin() {
        const s = this.table.state;
        if (s.players[this.myId]) return; // już dołączyłem wcześniej

        const ok = await Wallet.spend(s.bet);
        if (!ok) { this.el.innerHTML = `<p class="empty-hint">Za mało żetonów, żeby dołączyć (stawka: ${s.bet}).</p>`; throw new Error('insufficient funds'); }

        const next = structuredClone(s);
        next.players[this.myId] = { hand: [], status: 'waiting', bet: s.bet };

        const bothJoined = this.table.participant_ids.every(id => next.players[id]);
        if (bothJoined) {
            const deck = createShuffledDeck(4);
            for (const id of this.table.participant_ids) {
                next.players[id].hand = [deck.pop(), deck.pop()];
                next.players[id].status = 'playing';
            }
            next.deck = deck;
            next.dealerHand = [deck.pop(), deck.pop()];
            next.turnOrder = [...this.table.participant_ids];
            next.currentTurn = next.turnOrder[0];
            next.phase = 'playing';
        }

        await this._push(next, bothJoined ? 'playing' : 'waiting');
    }

    async _push(nextState, status) {
        const { data, error } = await supabase.from('casino_tables')
            .update({ state: nextState, status, updated_at: new Date().toISOString() })
            .eq('id', this.tableId).select().single();
        if (!error && data) this.table = data;
    }

    async hit() {
        const s = structuredClone(this.table.state);
        if (s.currentTurn !== this.myId) return;
        const me = s.players[this.myId];
        me.hand.push(s.deck.pop());
        if (handTotal(me.hand).bust) {
            me.status = 'busted';
            this._advanceTurn(s);
        }
        await this._push(s, this.table.status);
    }

    async stand() {
        const s = structuredClone(this.table.state);
        if (s.currentTurn !== this.myId) return;
        s.players[this.myId].status = 'stood';
        this._advanceTurn(s);
        await this._push(s, this.table.status);
    }

    _advanceTurn(s) {
        const idx = s.turnOrder.indexOf(this.myId);
        const next = s.turnOrder[idx + 1];
        if (next) {
            s.currentTurn = next;
        } else {
            // Wszyscy skończyli - krupier dobiera, jeśli ktokolwiek jeszcze nie przebił.
            const anyoneAlive = Object.values(s.players).some(p => p.status !== 'busted');
            if (anyoneAlive) {
                while (dealerShouldHit(s.dealerHand)) s.dealerHand.push(s.deck.pop());
            }
            s.currentTurn = null;
            s.phase = 'finished';
        }
    }

    /** Każdy klient rozlicza WYŁĄCZNIE własną wygraną (Wallet.win dotyka tylko własnego wiersza) - idempotentnie, przez `settledBy`. */
    async _maybeSettle() {
        const s = this.table.state;
        if (s.phase !== 'finished') return;
        if ((s.settledBy || []).includes(this.myId)) return;

        const me = s.players[this.myId];
        if (!me) return;
        const dealer = handTotal(s.dealerHand);
        const player = handTotal(me.hand);

        let payout = 0;
        if (player.bust) payout = 0;
        else if (player.blackjack && !dealer.blackjack) payout = Math.floor(me.bet * 2.5);
        else if (dealer.bust || player.total > dealer.total) payout = me.bet * 2;
        else if (player.total === dealer.total) payout = me.bet;

        if (payout > 0) await Wallet.win(payout);

        const next = structuredClone(s);
        next.settledBy = [...(next.settledBy || []), this.myId];
        await this._push(next, 'finished');
    }

    render() {
        const s = this.table.state;
        const me = s.players[this.myId];
        const otherId = this.table.participant_ids.find(id => id !== this.myId);
        const other = s.players[otherId];
        const myTurn = s.currentTurn === this.myId;

        this.el.innerHTML = `
            <div class="bj-table bj-multiplayer">
                <div class="bj-dealer-area">
                    <div class="bj-label">Krupier ${s.dealerHand?.length ? (s.phase === 'finished' ? `· ${handTotal(s.dealerHand).total}` : '') : ''}</div>
                    ${s.dealerHand?.length ? renderHand(s.dealerHand, { hideFirst: s.phase !== 'finished' }) : '<div class="bj-empty-slot">Czekam na obu graczy…</div>'}
                </div>

                <div class="bj-mp-players">
                    <div class="bj-mp-seat">
                        <div class="bj-label">Znajomy ${other?.hand?.length ? `· ${handTotal(other.hand).total}` : ''} ${s.currentTurn === otherId ? '👈 tura' : ''}</div>
                        ${other?.hand?.length ? renderHand(other.hand, { small: true }) : '<div class="bj-empty-slot">Czeka…</div>'}
                    </div>
                    <div class="bj-mp-seat bj-mp-me">
                        <div class="bj-label">Ty ${me?.hand?.length ? `· ${handTotal(me.hand).total}` : ''}</div>
                        ${me?.hand?.length ? renderHand(me.hand, { small: true }) : '<div class="bj-empty-slot">Czekam na rozdanie…</div>'}
                    </div>
                </div>

                <div class="bj-controls">
                    ${s.phase === 'waiting' ? `<div class="bj-thinking">Czekam, aż znajomy dołączy do stołu (stawka: ${s.bet} żetonów)…</div>` : ''}
                    ${s.phase === 'playing' && myTurn ? `
                        <div class="bj-action-row">
                            <button class="btn-primary" id="bj-hit">Dobierz</button>
                            <button class="btn-cancel" id="bj-stand">Stój</button>
                        </div>` : ''}
                    ${s.phase === 'playing' && !myTurn ? `<div class="bj-thinking">Tura znajomego…</div>` : ''}
                    ${s.phase === 'finished' ? `<div class="bj-result">Runda zakończona. ${me?.status === 'busted' ? 'Przebiłeś.' : ''}</div>` : ''}
                </div>
            </div>`;

        this.el.querySelector('#bj-hit')?.addEventListener('click', () => this.hit());
        this.el.querySelector('#bj-stand')?.addEventListener('click', () => this.stand());
    }
}
