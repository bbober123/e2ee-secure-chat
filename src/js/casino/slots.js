import { Wallet } from './wallet.js';
import { renderBetInput, wireBetInput } from './bet-input.js';

// Symbole ważone (rzadsze = większa wypłata) - suma wag nie musi być 100, liczy się proporcja.
const SYMBOLS = [
    { icon: '🍒', weight: 30, payout3: 4, payout2: 1 },
    { icon: '🍋', weight: 25, payout3: 6, payout2: 1.5 },
    { icon: '🔔', weight: 18, payout3: 10, payout2: 2 },
    { icon: '⭐', weight: 12, payout3: 20, payout2: 4 },
    { icon: '💎', weight: 8, payout3: 50, payout2: 8 },
    { icon: '7️⃣', weight: 4, payout3: 150, payout2: 20 },
    { icon: '🎰', weight: 3, payout3: 500, payout2: 50 }
];
const REELS = 3;
const ROWS = 3; // renderowane, ale wygrana liczona wyłącznie ze środkowego rzędu (klasyczny "1-line slot")

function weightedRandomSymbol() {
    const totalWeight = SYMBOLS.reduce((s, sym) => s + sym.weight, 0);
    let r = (crypto.getRandomValues(new Uint32Array(1))[0] / (0xFFFFFFFF + 1)) * totalWeight;
    for (const sym of SYMBOLS) {
        if (r < sym.weight) return sym;
        r -= sym.weight;
    }
    return SYMBOLS[0];
}

export class SlotMachine {
    constructor(container) {
        this.el = container;
        this.bet = 25;
        this.spinning = false;
        this.reels = Array.from({ length: REELS }, () => Array.from({ length: ROWS }, () => weightedRandomSymbol()));
        this.resultText = '';
        this.render();
    }

    async spin() {
        if (this.spinning) return;
        const ok = await Wallet.spend(this.bet);
        if (!ok) { this.resultText = 'Za mało żetonów!'; this.render(); return; }

        this.spinning = true;
        this.resultText = '';
        this.render();

        // Animacja: kilka szybkich "przebłysków" losowych symboli przed ostatecznym wynikiem, kolumna po kolumnie.
        const finalReels = Array.from({ length: REELS }, () => Array.from({ length: ROWS }, () => weightedRandomSymbol()));

        for (let flicker = 0; flicker < 8; flicker++) {
            this.reels = Array.from({ length: REELS }, () => Array.from({ length: ROWS }, () => weightedRandomSymbol()));
            this._renderReelsOnly();
            await new Promise(r => setTimeout(r, 70));
        }
        for (let col = 0; col < REELS; col++) {
            await new Promise(r => setTimeout(r, 180));
            this.reels[col] = finalReels[col];
            this._renderReelsOnly();
        }

        const middleRow = this.reels.map(col => col[1]);
        const payout = this._evaluate(middleRow);
        if (payout > 0) await Wallet.win(payout);

        this.resultText = payout > 0 ? `🎉 Wygrywasz ${payout} żetonów!` : 'Spróbuj ponownie!';
        this.spinning = false;
        this.render();
    }

    _evaluate(row) {
        const [a, b, c] = row;
        if (a.icon === b.icon && b.icon === c.icon) return Math.round(this.bet * a.payout3);
        if (a.icon === b.icon || b.icon === c.icon) {
            const matchSym = a.icon === b.icon ? a : b;
            return Math.round(this.bet * matchSym.payout2);
        }
        return 0;
    }

    setBet(amount, custom = false) {
        if (this.spinning) return;
        this.bet = amount;
        this.customBet = custom;
        this.render();
    }

    _renderReelsOnly() {
        const grid = this.el.querySelector('.slots-grid');
        if (!grid) return;
        grid.innerHTML = this.reels.map((col, ci) => `
            <div class="slots-reel">
                ${col.map((sym, ri) => `<div class="slots-symbol ${ri === 1 ? 'slots-symbol-mid' : ''}">${sym.icon}</div>`).join('')}
            </div>`).join('');
    }

    render() {
        this.el.innerHTML = `
            <div class="slots-machine">
                <div class="slots-cabinet">
                    <div class="slots-marquee">🎰 SZCZĘŚLIWY AUTOMAT 🎰</div>
                    <div class="slots-window">
                        <div class="slots-payline"></div>
                        <div class="slots-grid"></div>
                    </div>
                </div>
                ${this.resultText ? `<div class="bj-result">${this.resultText}</div>` : ''}
                <div class="roulette-controls">
                    <div class="roulette-chip-select">
                        Stawka: ${[10, 25, 100, 250].map(v => `<button class="chip-btn ${!this.customBet && v === this.bet ? 'chip-selected' : ''}" data-bet="${v}">${v}</button>`).join('')}
                        ${renderBetInput(this.bet, this.customBet, this.spinning)}
                    </div>
                    <button class="btn-primary slots-spin-btn" id="slots-spin" ${this.spinning ? 'disabled' : ''}>${this.spinning ? 'Kręcę…' : '🎲 ZAKRĘĆ'}</button>
                </div>
                <details class="slots-paytable">
                    <summary>Tabela wygranych (3 w rzędzie / 2 w rzędzie, mnożnik stawki)</summary>
                    <div class="slots-paytable-grid">
                        ${SYMBOLS.map(s => `<div>${s.icon} <span>×${s.payout3} / ×${s.payout2}</span></div>`).join('')}
                    </div>
                </details>
            </div>`;

        this._renderReelsOnly();
        this.el.querySelectorAll('[data-bet]').forEach(btn => btn.addEventListener('click', () => this.setBet(parseInt(btn.dataset.bet, 10))));
        wireBetInput(this.el, (amount) => this.setBet(amount, true));
        this.el.querySelector('#slots-spin')?.addEventListener('click', () => this.spin());
    }
}
