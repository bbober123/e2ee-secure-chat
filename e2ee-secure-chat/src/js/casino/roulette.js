import { Wallet } from './wallet.js';
import { renderBetInput, wireBetInput } from './bet-input.js';

// Koło europejskie (pojedyncze zero) - kolejność kieszeni jak na prawdziwym stole.
const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function colorOf(n) {
    if (n === 0) return 'green';
    return RED_NUMBERS.has(n) ? 'red' : 'black';
}

const PAYOUTS = {
    straight: 35,  // pojedynczy numer
    red: 1, black: 1, even: 1, odd: 1, low: 1, high: 1, // 1:1 (1-18/19-36)
    dozen: 2       // 2:1 (1-12, 13-24, 25-36)
};

export class Roulette {
    constructor(container) {
        this.el = container;
        this.bets = []; // { kind, value, amount }
        this.spinning = false;
        this.lastResult = null;
        this.render();
    }

    get totalStaked() {
        return this.bets.reduce((s, b) => s + b.amount, 0);
    }

    async addBet(kind, value, amount) {
        if (this.spinning) return;
        const ok = await Wallet.spend(amount);
        if (!ok) return;
        this.bets.push({ kind, value, amount });
        this.render();
    }

    async clearBets() {
        if (this.spinning) return;
        if (this.bets.length) await Wallet.win(this.totalStaked); // zwrot niezagranych stawek
        this.bets = [];
        this.render();
    }

    async spin() {
        if (this.spinning || this.bets.length === 0) return;
        this.spinning = true;
        this.lastResult = null;
        this.render();

        const winningNumber = WHEEL_ORDER[crypto.getRandomValues(new Uint32Array(1))[0] % WHEEL_ORDER.length];
        const winningColor = colorOf(winningNumber);
        const pocketIndex = WHEEL_ORDER.indexOf(winningNumber);
        const anglePerPocket = 360 / WHEEL_ORDER.length;
        // Kilka pełnych obrotów + trafienie w konkretną kieszeń, z lekkim losowym driftem żeby nie było mechanicznie identyczne za każdym razem.
        const extraSpins = 4 + Math.floor(Math.random() * 3);
        const targetAngle = extraSpins * 360 + (360 - pocketIndex * anglePerPocket) + (Math.random() * anglePerPocket * 0.6 - anglePerPocket * 0.3);

        const wheelEl = this.el.querySelector('.roulette-wheel-spin');
        if (wheelEl) {
            wheelEl.style.transition = 'transform 4.2s cubic-bezier(0.15, 0.85, 0.25, 1)';
            wheelEl.style.transform = `rotate(${targetAngle}deg)`;
        }

        await new Promise(r => setTimeout(r, 4300));

        let totalPayout = 0;
        for (const bet of this.bets) {
            totalPayout += this._evaluateBet(bet, winningNumber, winningColor);
        }
        if (totalPayout > 0) await Wallet.win(totalPayout);

        this.lastResult = { number: winningNumber, color: winningColor, payout: totalPayout, staked: this.totalStaked };
        this.bets = [];
        this.spinning = false;
        this.render();
    }

    _evaluateBet(bet, number, color) {
        const won = (() => {
            switch (bet.kind) {
                case 'straight': return bet.value === number;
                case 'red': return color === 'red';
                case 'black': return color === 'black';
                case 'even': return number !== 0 && number % 2 === 0;
                case 'odd': return number !== 0 && number % 2 === 1;
                case 'low': return number >= 1 && number <= 18;
                case 'high': return number >= 19 && number <= 36;
                case 'dozen': {
                    const [lo, hi] = bet.value;
                    return number >= lo && number <= hi;
                }
                default: return false;
            }
        })();
        if (!won) return 0;
        const mult = PAYOUTS[bet.kind];
        return bet.amount * (mult + 1); // wypłata + zwrot własnej stawki
    }

    render() {
        const numbersGrid = [];
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 12; col++) {
                const n = col * 3 + (3 - row);
                numbersGrid.push(n);
            }
        }

        this.el.innerHTML = `
            <div class="roulette-layout">
                <div class="roulette-wheel-wrap">
                    <div class="roulette-wheel-spin" style="transform: rotate(0deg);">
                        ${this._renderWheelSvg()}
                    </div>
                    <div class="roulette-ball-pointer">▼</div>
                    ${this.lastResult ? `
                        <div class="roulette-result pocket-${this.lastResult.color}">
                            ${this.lastResult.number} ${this.lastResult.color === 'red' ? '🔴' : this.lastResult.color === 'black' ? '⚫' : '🟢'}
                            ${this.lastResult.payout > 0 ? `<span class="roulette-win">+${this.lastResult.payout}</span>` : `<span class="roulette-lose">bez wygranej</span>`}
                        </div>` : ''}
                </div>

                <div class="roulette-board">
                    <div class="roulette-zero-cell" data-kind="straight" data-value="0">0</div>
                    <div class="roulette-numbers-grid">
                        ${numbersGrid.map(n => `<div class="roulette-cell pocket-${colorOf(n)}" data-kind="straight" data-value="${n}">${n}</div>`).join('')}
                    </div>
                    <div class="roulette-outside-bets">
                        <div class="roulette-cell wide" data-kind="dozen" data-value="1,12">1-12</div>
                        <div class="roulette-cell wide" data-kind="dozen" data-value="13,24">13-24</div>
                        <div class="roulette-cell wide" data-kind="dozen" data-value="25,36">25-36</div>
                        <div class="roulette-cell wide" data-kind="low">1-18</div>
                        <div class="roulette-cell wide" data-kind="even">PARZYSTE</div>
                        <div class="roulette-cell wide pocket-red" data-kind="red">CZERWONE</div>
                        <div class="roulette-cell wide pocket-black" data-kind="black">CZARNE</div>
                        <div class="roulette-cell wide" data-kind="odd">NIEPARZYSTE</div>
                        <div class="roulette-cell wide" data-kind="high">19-36</div>
                    </div>
                </div>

                <div class="roulette-controls">
                    <div class="roulette-chip-select">
                        Żeton: ${[5, 25, 100, 500].map(v => `<button class="chip-btn ${!this.customChip && v === (this.selectedChip || 25) ? 'chip-selected' : ''}" data-chip="${v}">${v}</button>`).join('')}
                        ${renderBetInput(this.selectedChip, this.customChip, this.spinning)}                    </div>
                    <div class="roulette-staked">Postawione: <strong>${this.totalStaked}</strong> żetonów — aktywny żeton: <strong>${this.selectedChip || 25}</strong></div>
                    <div class="bj-action-row">
                        <button class="btn-cancel" id="rl-clear" ${this.spinning ? 'disabled' : ''}>Wyczyść</button>
                        <button class="btn-primary" id="rl-spin" ${this.spinning || this.bets.length === 0 ? 'disabled' : ''}>${this.spinning ? 'Kręci się…' : 'Zakręć kołem'}</button>
                    </div>
                </div>
            </div>`;

        this.selectedChip = this.selectedChip || 25;
        this._wire();
    }

    _renderWheelSvg() {
        const n = WHEEL_ORDER.length;
        const r = 110, cx = 120, cy = 120;
        let slices = '';
        WHEEL_ORDER.forEach((num, i) => {
            const a0 = (i / n) * 2 * Math.PI - Math.PI / 2;
            const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
            const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
            const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
            const color = colorOf(num) === 'red' ? '#b91c1c' : colorOf(num) === 'black' ? '#18181b' : '#15803d';
            slices += `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0,1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${color}" stroke="#e2b93b" stroke-width="0.5"/>`;
        });
        return `<svg width="240" height="240" viewBox="0 0 240 240">${slices}<circle cx="120" cy="120" r="28" fill="#0e4b38" stroke="#e2b93b" stroke-width="2"/></svg>`;
    }

    _wire() {
        this.el.querySelectorAll('[data-chip]').forEach(btn => {
            btn.addEventListener('click', () => { this.selectedChip = parseInt(btn.dataset.chip, 10); this.customChip = false; this.render(); });
        });
        wireBetInput(this.el, (amount) => { this.selectedChip = amount; this.customChip = true; this.render(); });
        this.el.querySelectorAll('[data-kind]').forEach(cell => {
            cell.addEventListener('click', () => {
                const kind = cell.dataset.kind;
                const raw = cell.dataset.value;
                const value = raw ? (raw.includes(',') ? raw.split(',').map(Number) : parseInt(raw, 10)) : undefined;
                this.addBet(kind, value, this.selectedChip || 25);
            });
        });
        this.el.querySelector('#rl-spin')?.addEventListener('click', () => this.spin());
        this.el.querySelector('#rl-clear')?.addEventListener('click', () => this.clearBets());
    }
}
