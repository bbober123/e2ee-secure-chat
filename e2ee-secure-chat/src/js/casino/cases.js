/**
 * casino/cases.js — "Skrzynki": klasyczny case-opening z poziomym pasem
 * przedmiotów, który zwalnia i zatrzymuje się na wylosowanej nagrodzie.
 * Broń i skrzynki pochodzą z bazy (casino/case-data.js) - admin może je
 * edytować w Panelu Admina bez wdrażania nowej wersji kodu.
 * Po otwarciu gracz wybiera: sprzedać od razu za żetony, albo zachować
 * w ekwipunku (max. 30 przedmiotów, patrz casino/inventory.js).
 */
import { Wallet } from './wallet.js';
import { Inventory } from './inventory.js';
import { CaseCatalog, RARITIES } from './case-data.js';

function weightedPick(pool) {
    const totalWeight = pool.reduce((s, item) => s + item.rarity.weight, 0);
    let r = (crypto.getRandomValues(new Uint32Array(1))[0] / (0xFFFFFFFF + 1)) * totalWeight;
    for (const item of pool) {
        if (r < item.rarity.weight) return item;
        r -= item.rarity.weight;
    }
    return pool[0];
}

const REEL_VISIBLE_COUNT = 60; // ile przedmiotów renderujemy na pasku przed wynikiem

export class CaseOpening {
    constructor(container) {
        this.el = container;
        this.caseId = null;
        this.opening = false;
        this.loading = true;
        this.lastResult = null;
    }

    stop() {} // brak timerów do sprzątania (animacja to jedno CSS transition)

    async start() {
        this.loading = true;
        this.render();
        await CaseCatalog.load();
        this.caseId = CaseCatalog.cases[0]?.id || null;
        this.loading = false;
        this.render();
    }

    get cases() {
        return CaseCatalog.cases;
    }

    get currentCase() {
        return this.cases.find(c => c.id === this.caseId) || this.cases[0];
    }

    selectCase(id) {
        if (this.opening || this.lastResult?.deciding) return;
        this.caseId = id;
        this.lastResult = null;
        this.render();
    }

    async open() {
        if (this.opening) return;
        const cs = this.currentCase;
        if (!cs || !cs.pool.length) return;
        const ok = await Wallet.spend(Number(cs.price));
        if (!ok) {
            this.lastResult = { insufficient: true };
            this.render();
            return;
        }

        this.opening = true;
        this.lastResult = null;
        this.render();

        const winner = weightedPick(cs.pool);

        // Pasek: losowe przedmioty + zwycięzca wstawiony na stałej pozycji (index docelowy),
        // żeby transform mógł precyzyjnie wylądować dokładnie na jego środku.
        const targetIndex = REEL_VISIBLE_COUNT - 6 + Math.floor(Math.random() * 3);
        const strip = Array.from({ length: REEL_VISIBLE_COUNT }, (_, idx) =>
            idx === targetIndex ? winner : weightedPick(cs.pool)
        );

        const track = this.el.querySelector('.case-reel-track');
        if (track) {
            track.style.transition = 'none';
            track.style.transform = 'translateX(0px)';
            track.innerHTML = strip.map(item => this._itemHtml(item)).join('');
            // wymuś reflow, żeby przeglądarka zarejestrowała stan startowy przed animacją
            void track.offsetWidth;

            // rzeczywista, wyrenderowana szerokość kafelka (różna wg breakpointu w CSS) zamiast sztywnej stałej w JS
            const itemWidth = track.firstElementChild?.getBoundingClientRect().width || 128;
            const containerWidth = track.parentElement.clientWidth;
            // losowy mikro-offset w obrębie kafelka, żeby wskaźnik nie lądował za każdym razem idealnie centralnie (bardziej "żywe")
            const jitter = (Math.random() - 0.5) * (itemWidth * 0.5);
            const targetX = targetIndex * itemWidth + itemWidth / 2 - containerWidth / 2 + jitter;

            track.style.transition = 'transform 5.2s cubic-bezier(0.12, 0.72, 0.15, 1)';
            track.style.transform = `translateX(-${targetX}px)`;

            await new Promise(r => setTimeout(r, 5300));
        }

        this.lastResult = { item: winner, deciding: true };
        this.opening = false;
        this.render();
    }

    async sellResult() {
        if (!this.lastResult?.item || !this.lastResult.deciding) return;
        await Wallet.win(this.lastResult.item.value);
        this.lastResult = { item: this.lastResult.item, sold: true };
        this.render();
    }

    async keepResult() {
        if (!this.lastResult?.item || !this.lastResult.deciding) return;
        const item = this.lastResult.item;
        const res = await Inventory.keep({
            name: item.name, weaponKey: item.weaponKey, rarityId: item.rarity.id,
            value: item.value, caseTitle: this.currentCase.title, iconSnapshot: item.icon
        });
        if (!res.ok) {
            if (res.reason === 'full') {
                this.lastResult = { item, deciding: true, fullWarning: true };
            } else {
                const { UI } = await import('../ui.js');
                UI.showToast('Nie udało się zapisać przedmiotu w ekwipunku.', 'error');
            }
            this.render();
            return;
        }
        this.lastResult = { item, kept: true };
        this.render();
    }

    _itemHtml(item) {
        return `
            <div class="case-reel-item" style="border-color:${item.rarity.color}">
                <div class="case-reel-item-icon" style="color:${item.rarity.color}">${item.icon}</div>
                <div class="case-reel-item-name">${item.name}</div>
                <div class="case-reel-item-value" style="color:${item.rarity.color}">${item.value} 🪙</div>
            </div>`;
    }

    render() {
        if (this.loading) {
            this.el.innerHTML = `<div class="case-opening"><div class="inventory-empty">Wczytywanie skrzynek…</div></div>`;
            return;
        }
        if (!this.cases.length) {
            this.el.innerHTML = `<div class="case-opening"><div class="inventory-empty">Brak aktywnych skrzynek. Admin może je dodać w Panelu Admina.</div></div>`;
            return;
        }

        const cs = this.currentCase;
        this.el.innerHTML = `
            <div class="case-opening">
                <div class="case-picker">
                    ${this.cases.map(c => `
                        <div class="case-picker-item ${c.id === this.caseId ? 'active' : ''}" data-case="${c.id}">
                            <div class="case-picker-icon">📦</div>
                            <div class="case-picker-title">${c.title}</div>
                            <div class="case-picker-price">${c.price} 🪙</div>
                        </div>`).join('')}
                </div>

                <div class="case-reel-viewport">
                    <div class="case-reel-pointer"></div>
                    <div class="case-reel-track">
                        ${cs.pool.length ? Array.from({ length: 10 }, () => this._itemHtml(weightedPick(cs.pool))).join('') : ''}
                    </div>
                </div>

                <button class="btn-primary case-open-btn" id="case-open-btn" ${this.opening || this.lastResult?.deciding || !cs.pool.length ? 'disabled' : ''}>
                    ${this.opening ? 'Otwieranie…' : this.lastResult?.deciding ? 'Zdecyduj co zrobić z przedmiotem ↓' : !cs.pool.length ? 'Ta skrzynka jest pusta (brak broni)' : `Otwórz za ${cs.price} 🪙`}
                </button>

                <div class="case-result">
                    ${this.lastResult?.insufficient ? '<span class="case-result-error">Za mało żetonów!</span>' : ''}
                    ${this.lastResult?.deciding ? `
                        <div class="case-decision">
                            <span class="case-result-win" style="color:${this.lastResult.item.rarity.color}">
                                Wypadło: ${this.lastResult.item.name} (${this.lastResult.item.rarity.label})
                            </span>
                            ${this.lastResult.fullWarning ? '<div class="case-result-error">Ekwipunek pełny (30/30) — sprzedaj coś albo sprzedaj ten przedmiot.</div>' : ''}
                            <div class="case-decision-actions">
                                <button class="btn-primary" id="case-keep-btn">🎒 Zachowaj</button>
                                <button class="btn-cancel" id="case-sell-btn">Sprzedaj za ${this.lastResult.item.value} 🪙</button>
                            </div>
                        </div>` : ''}
                    ${this.lastResult?.sold ? `
                        <span class="case-result-win" style="color:${this.lastResult.item.rarity.color}">
                            Sprzedano: ${this.lastResult.item.name} — +${this.lastResult.item.value} 🪙
                        </span>` : ''}
                    ${this.lastResult?.kept ? `
                        <span class="case-result-win" style="color:${this.lastResult.item.rarity.color}">
                            Zachowano w ekwipunku: ${this.lastResult.item.name} — zajrzyj do 🎒 Ekwipunku, żeby się pochwalić!
                        </span>` : ''}
                </div>

                <div class="case-contents">
                    <details>
                        <summary>Zawartość skrzynki i szanse (prawdziwe procenty Valve)</summary>
                        <div class="case-contents-rarity-legend">
                            ${RARITIES.map(r => `<span style="color:${r.color}">${r.label}: ${r.weight}%</span>`).join(' · ')}
                        </div>
                        <div class="case-contents-grid">
                            ${cs.pool.map(item => `
                                <div class="case-contents-item" style="border-color:${item.rarity.color}">
                                    <span class="case-contents-item-icon" style="color:${item.rarity.color}">${item.icon}</span>
                                    <span style="color:${item.rarity.color}">${item.name}</span>
                                    <span class="case-contents-value">${item.value} 🪙</span>
                                </div>`).join('')}
                        </div>
                    </details>
                </div>
            </div>`;

        this.el.querySelectorAll('[data-case]').forEach(el => {
            el.addEventListener('click', () => this.selectCase(el.dataset.case));
        });
        this.el.querySelector('#case-open-btn')?.addEventListener('click', () => this.open());
        this.el.querySelector('#case-keep-btn')?.addEventListener('click', () => this.keepResult());
        this.el.querySelector('#case-sell-btn')?.addEventListener('click', () => this.sellResult());
    }
}
