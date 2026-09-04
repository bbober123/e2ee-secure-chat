/**
 * casino/exchange.js — gra "Giełda": handluj żetonami z kazyna na
 * kryptowalutach po prawdziwych cenach rynkowych (CoinGecko). To jest
 * kolejna gra kazyna, nie osobna appka — dzieli ten sam portfel żetonów
 * (Wallet) co ruletka/blackjack/sloty/skrzynki, więc wygrana na slotach
 * może zostać "zainwestowana" tutaj i odwrotnie.
 *
 * 1 żeton = symboliczny 1 USD przy przeliczaniu cen kryptowalut - to nie
 * są prawdziwe pieniądze w żadną stronę, tak jak reszta kazyna.
 */
import { MarketData, Portfolio } from './exchange-data.js';
import { Wallet } from './wallet.js';

const TIMEFRAMES = [
    { label: '24H', days: 1 },
    { label: '7D', days: 7 },
    { label: '30D', days: 30 }
];

function fmtPrice(p) {
    if (p == null) return '-';
    if (p >= 1) return '$' + p.toLocaleString('pl-PL', { maximumFractionDigits: 2 });
    return '$' + p.toLocaleString('pl-PL', { maximumFractionDigits: 6 });
}
function fmtChips(n) {
    return Math.round(n).toLocaleString('pl-PL') + ' 🪙';
}
function fmtAmount(a) {
    return Number(a).toLocaleString('pl-PL', { maximumFractionDigits: 8 });
}
function sparklineSvg(prices) {
    if (!prices || prices.length < 2) return '<span class="exchange-no-data">–</span>';
    const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
    const w = 100, h = 30;
    const pts = prices.map((p, i) => `${(i / (prices.length - 1)) * w},${h - ((p - min) / range) * h}`).join(' ');
    const up = prices[prices.length - 1] >= prices[0];
    const color = up ? 'var(--casino-gold)' : 'var(--casino-red)';
    return `<svg width="${w}" height="${h}" class="exchange-spark"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

export class Exchange {
    constructor(container) {
        this.el = container;
        this.view = 'market';
        this.coins = [];
        this.currentCoin = null;
        this.orderSide = 'buy';
        this.search = '';
        this.chartDays = 1;
        this.loading = true;
        this._refreshTimer = null;
    }

    stop() {
        if (this._refreshTimer) clearInterval(this._refreshTimer);
    }

    async start() {
        this.render();
        await Promise.all([this._loadMarkets(), Portfolio.load()]);
        this.loading = false;
        this.render();
        this._refreshTimer = setInterval(() => this._tick(), 30000);
    }

    async _loadMarkets() {
        this.coins = await MarketData.getMarkets();
    }

    async _tick() {
        await this._loadMarkets();
        if (this.view === 'trade' && this.currentCoin) {
            this.currentCoin = this.coins.find(c => c.id === this.currentCoin.id) || this.currentCoin;
        }
        this.render();
    }

    _coinsById() {
        return Object.fromEntries(this.coins.map(c => [c.id, c]));
    }

    _setView(view) {
        this.view = view;
        this.render();
    }

    async _openTrade(coinId) {
        const coin = this.coins.find(c => c.id === coinId);
        if (!coin) return;
        this.currentCoin = coin;
        this.orderSide = 'buy';
        this.chartDays = 1;
        this.view = 'trade';
        this.render();
        const prices = await MarketData.getChartData(coinId, 1);
        if (this.currentCoin?.id === coinId) {
            this._chartPrices = prices;
            this._drawChart();
        }
    }

    async _changeTimeframe(days) {
        this.chartDays = days;
        this.render();
        const prices = await MarketData.getChartData(this.currentCoin.id, days);
        this._chartPrices = prices;
        this._drawChart();
    }

    _drawChart() {
        const canvas = this.el.querySelector('#exchange-chart');
        if (!canvas || !this._chartPrices?.length) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = 220;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const padding = { top: 12, right: 8, bottom: 8, left: 8 };
        const prices = this._chartPrices.map(d => d[1]);
        const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
        const x = i => padding.left + (i / (prices.length - 1)) * (w - padding.left - padding.right);
        const y = p => padding.top + (1 - (p - min) / range) * (h - padding.top - padding.bottom);

        ctx.clearRect(0, 0, w, h);
        const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
        gradient.addColorStop(0, 'rgba(226,185,59,0.28)');
        gradient.addColorStop(1, 'rgba(226,185,59,0)');

        ctx.beginPath();
        ctx.moveTo(x(0), y(prices[0]));
        prices.forEach((p, i) => ctx.lineTo(x(i), y(p)));
        ctx.lineTo(x(prices.length - 1), h - padding.bottom);
        ctx.lineTo(x(0), h - padding.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x(0), y(prices[0]));
        prices.forEach((p, i) => ctx.lineTo(x(i), y(p)));
        ctx.strokeStyle = '#e2b93b';
        ctx.lineWidth = 2;
        ctx.stroke();

        const lastY = y(prices[prices.length - 1]);
        ctx.beginPath();
        ctx.arc(x(prices.length - 1), lastY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#e2b93b';
        ctx.fill();
    }

    async _executeTrade() {
        const amountInput = this.el.querySelector('#exchange-amount');
        const amount = parseFloat(amountInput.value);
        const errEl = this.el.querySelector('#exchange-trade-error');
        errEl.textContent = '';
        if (!amount || amount <= 0) {
            errEl.textContent = 'Wprowadź ilość większą od zera.';
            return;
        }
        const btn = this.el.querySelector('#exchange-execute-btn');
        btn.disabled = true;
        const result = await Portfolio.trade(this.orderSide, this.currentCoin, amount);
        btn.disabled = false;
        if (!result.ok) {
            errEl.textContent = result.error;
            return;
        }
        const { UI } = await import('../ui.js');
        UI.showToast(
            `${this.orderSide === 'buy' ? 'Kupiono' : 'Sprzedano'} ${fmtAmount(amount)} ${this.currentCoin.symbol.toUpperCase()}`,
            'success'
        );
        this.render();
    }

    render() {
        this.el.innerHTML = `
            <div class="exchange">
                ${this._navHtml()}
                ${this.loading ? '<div class="exchange-loading">Wczytywanie rynku…</div>' : this._viewHtml()}
            </div>`;
        this._wireEvents();
        if (this.view === 'trade' && this._chartPrices?.length) this._drawChart();
    }

    _navHtml() {
        if (this.view === 'trade') return '';
        const tabs = [
            { id: 'market', label: '📊 Rynek' },
            { id: 'portfolio', label: '💼 Portfel' },
            { id: 'history', label: '📜 Historia' }
        ];
        return `<div class="exchange-nav">
            ${tabs.map(t => `<button class="exchange-nav-btn ${this.view === t.id ? 'active' : ''}" data-view="${t.id}">${t.label}</button>`).join('')}
            ${MarketData.isUsingFallback() ? '<span class="exchange-offline-badge" title="Brak połączenia z API cen na żywo — ceny symulowane.">⚠ symulowane ceny</span>' : ''}
        </div>`;
    }

    _viewHtml() {
        if (this.view === 'trade') return this._tradeHtml();
        if (this.view === 'portfolio') return this._portfolioHtml();
        if (this.view === 'history') return this._historyHtml();
        return this._marketHtml();
    }

    _marketHtml() {
        const term = this.search.toLowerCase();
        const rows = this.coins.filter(c => !term || c.name.toLowerCase().includes(term) || c.symbol.toLowerCase().includes(term));
        return `
            <div class="exchange-search-row">
                <input type="text" id="exchange-search" class="exchange-search" placeholder="Szukaj kryptowaluty…" value="${this.search}">
            </div>
            <div class="exchange-table-wrap">
                <table class="exchange-table">
                    <thead><tr><th>#</th><th>Nazwa</th><th>Cena</th><th>24h</th><th>Wykres</th><th></th></tr></thead>
                    <tbody>
                    ${rows.map((c, i) => {
                        const change = c.price_change_percentage_24h || 0;
                        const cls = change >= 0 ? 'exchange-up' : 'exchange-down';
                        return `<tr class="exchange-row" data-coin="${c.id}">
                            <td>${i + 1}</td>
                            <td class="exchange-coin-cell">
                                ${c.image ? `<img src="${c.image}" width="22" height="22" style="border-radius:50%" onerror="this.style.display='none'">` : ''}
                                <span class="exchange-coin-name">${c.name}</span>
                                <span class="exchange-coin-symbol">${c.symbol.toUpperCase()}</span>
                            </td>
                            <td>${fmtPrice(c.current_price)}</td>
                            <td class="${cls}">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</td>
                            <td>${sparklineSvg(c.sparkline_in_7d?.price)}</td>
                            <td><button class="btn-primary exchange-trade-btn" data-coin="${c.id}">Handluj</button></td>
                        </tr>`;
                    }).join('') || '<tr><td colspan="6" class="exchange-empty">Brak wyników.</td></tr>'}
                    </tbody>
                </table>
            </div>`;
    }

    _tradeHtml() {
        const coin = this.currentCoin;
        const change = coin.price_change_percentage_24h || 0;
        const owned = Portfolio.getAmount(coin.id);
        const chipsAvailable = Wallet.balance;
        return `
            <div class="exchange-trade">
                <button class="btn-cancel exchange-back-btn" id="exchange-back">← Rynek</button>
                <div class="exchange-trade-header">
                    <div>
                        <h4>${coin.name} <span class="exchange-coin-symbol">${coin.symbol.toUpperCase()}</span></h4>
                        <div class="exchange-trade-price-row">
                            <span class="exchange-trade-price">${fmtPrice(coin.current_price)}</span>
                            <span class="${change >= 0 ? 'exchange-up' : 'exchange-down'}">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</span>
                        </div>
                    </div>
                    <div class="exchange-timeframes">
                        ${TIMEFRAMES.map(t => `<button class="exchange-tf-btn ${this.chartDays === t.days ? 'active' : ''}" data-days="${t.days}">${t.label}</button>`).join('')}
                    </div>
                </div>
                <div class="exchange-chart-wrap"><canvas id="exchange-chart"></canvas></div>

                <div class="exchange-order-panel">
                    <div class="exchange-order-tabs">
                        <button class="exchange-order-tab ${this.orderSide === 'buy' ? 'active buy' : ''}" data-side="buy">Kup</button>
                        <button class="exchange-order-tab ${this.orderSide === 'sell' ? 'active sell' : ''}" data-side="sell">Sprzedaj</button>
                    </div>
                    <div class="exchange-order-form">
                        <label>Ilość (${coin.symbol.toUpperCase()})</label>
                        <input type="number" id="exchange-amount" step="0.00000001" min="0" placeholder="0.00">
                        <div class="exchange-available">
                            ${this.orderSide === 'buy'
                                ? `Dostępne: ${fmtChips(chipsAvailable)}`
                                : `Posiadasz: ${fmtAmount(owned)} ${coin.symbol.toUpperCase()}`}
                        </div>
                        <div class="exchange-order-summary" id="exchange-order-summary"></div>
                        <div class="exchange-trade-error" id="exchange-trade-error"></div>
                        <button class="btn-primary exchange-execute-btn" id="exchange-execute-btn">${this.orderSide === 'buy' ? 'Kup teraz' : 'Sprzedaj teraz'}</button>
                    </div>
                </div>
            </div>`;
    }

    _portfolioHtml() {
        const coinsById = this._coinsById();
        const holdings = Object.values(Portfolio.holdings);
        const cryptoValue = Portfolio.totalValue(coinsById);
        const total = Wallet.balance + cryptoValue;
        return `
            <div class="exchange-portfolio">
                <div class="exchange-portfolio-summary">
                    <div><span>Wartość całkowita</span><strong>${fmtChips(total)}</strong></div>
                    <div><span>Żetony (gotówka)</span><strong>${fmtChips(Wallet.balance)}</strong></div>
                    <div><span>Kryptowaluty</span><strong>${fmtChips(cryptoValue)}</strong></div>
                </div>
                ${holdings.length === 0 ? '<div class="exchange-empty">Nie posiadasz jeszcze żadnej kryptowaluty. Wejdź w Rynek i kup coś.</div>' : `
                <div class="exchange-holdings-list">
                    ${holdings.map(h => {
                        const coin = coinsById[h.coin_id];
                        const price = coin?.current_price || 0;
                        const value = Number(h.amount) * price;
                        const cost = Number(h.cost_basis);
                        const pl = value - cost;
                        const plCls = pl >= 0 ? 'exchange-up' : 'exchange-down';
                        return `<div class="exchange-holding-row" data-coin="${h.coin_id}">
                            <div>
                                <div class="exchange-coin-name">${h.name}</div>
                                <div class="exchange-coin-symbol">${fmtAmount(h.amount)} ${h.symbol.toUpperCase()}</div>
                            </div>
                            <div class="exchange-holding-right">
                                <div>${fmtChips(value)}</div>
                                <div class="${plCls}">${pl >= 0 ? '+' : ''}${fmtChips(pl)}</div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>`}
            </div>`;
    }

    _historyHtml() {
        const trades = Portfolio.trades;
        if (!trades.length) return '<div class="exchange-empty">Brak transakcji.</div>';
        return `<div class="exchange-history-list">
            ${trades.map(t => `
                <div class="exchange-history-row">
                    <span class="exchange-history-side ${t.side}">${t.side === 'buy' ? 'KUPNO' : 'SPRZEDAŻ'}</span>
                    <div class="exchange-history-info">
                        <div>${t.name} (${t.symbol.toUpperCase()})</div>
                        <div class="exchange-history-date">${new Date(t.created_at).toLocaleString('pl-PL')}</div>
                    </div>
                    <div class="exchange-history-amounts">
                        <div>${fmtAmount(t.amount)} ${t.symbol.toUpperCase()}</div>
                        <div>${fmtChips(t.total)}</div>
                    </div>
                </div>`).join('')}
        </div>`;
    }

    _updateOrderSummary() {
        const summaryEl = this.el.querySelector('#exchange-order-summary');
        if (!summaryEl || !this.currentCoin) return;
        const amount = parseFloat(this.el.querySelector('#exchange-amount')?.value) || 0;
        const price = this.currentCoin.current_price;
        const gross = amount * price;
        const fee = Math.max(gross * 0.001, amount > 0 ? 1 : 0);
        const grand = this.orderSide === 'buy' ? gross + fee : gross - fee;
        summaryEl.innerHTML = `
            <div class="exchange-summary-row"><span>Wartość</span><span>${fmtChips(gross)}</span></div>
            <div class="exchange-summary-row"><span>Prowizja (0.1%)</span><span>${fmtChips(fee)}</span></div>
            <div class="exchange-summary-row exchange-summary-total"><span>${this.orderSide === 'buy' ? 'Łącznie do zapłaty' : 'Otrzymasz'}</span><span>${fmtChips(grand)}</span></div>`;
    }

    _wireEvents() {
        this.el.querySelectorAll('[data-view]').forEach(btn => {
            btn.addEventListener('click', () => this._setView(btn.dataset.view));
        });
        const search = this.el.querySelector('#exchange-search');
        if (search) {
            search.addEventListener('input', (e) => { this.search = e.target.value; this.render(); this.el.querySelector('#exchange-search')?.focus(); });
        }
        this.el.querySelectorAll('.exchange-row, .exchange-trade-btn').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openTrade(el.dataset.coin || el.closest('[data-coin]')?.dataset.coin);
            });
        });
        const back = this.el.querySelector('#exchange-back');
        if (back) back.addEventListener('click', () => { this.currentCoin = null; this._setView('market'); });

        this.el.querySelectorAll('.exchange-order-tab').forEach(btn => {
            btn.addEventListener('click', () => { this.orderSide = btn.dataset.side; this.render(); });
        });
        this.el.querySelectorAll('.exchange-tf-btn').forEach(btn => {
            btn.addEventListener('click', () => this._changeTimeframe(parseInt(btn.dataset.days)));
        });
        const amountInput = this.el.querySelector('#exchange-amount');
        if (amountInput) amountInput.addEventListener('input', () => this._updateOrderSummary());
        const execBtn = this.el.querySelector('#exchange-execute-btn');
        if (execBtn) execBtn.addEventListener('click', () => this._executeTrade());

        if (this.view === 'trade') this._updateOrderSummary();
    }
}
