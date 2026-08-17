/**
 * casino/cases.js — "Skrzynki": klasyczny case-opening z poziomym pasem
 * przedmiotów, który zwalnia i zatrzymuje się na wylosowanej nagrodzie.
 * Mechanika żetonów identyczna jak w innych grach (Wallet.spend/win) -
 * przedmiot jest od razu "sprzedawany" za żetony (brak ekwipunku, prostsze).
 */
import { Wallet } from './wallet.js';

// Rzadsze = mniejsza waga = większa wypłata. Nazwy własne, inspirowane
// klasycznym schematem kolorów rzadkości ze skrzynek w grach FPS, ale
// bez kopiowania konkretnego, cudzego katalogu przedmiotów.
const RARITIES = [
    { id: 'mil-spec', label: 'Mil-Spec', color: '#4b69ff', weight: 60 },
    { id: 'restricted', label: 'Restricted', color: '#8847ff', weight: 25 },
    { id: 'classified', label: 'Classified', color: '#d32ce6', weight: 10 },
    { id: 'covert', label: 'Covert', color: '#eb4b4b', weight: 4 },
    { id: 'rare-gold', label: 'Rzadkie Złoto', color: '#ffd700', weight: 1 }
];

const WEAPONS = ['AK-47', 'M4A4', 'AWP', 'Desert Eagle', 'USP', 'Karambit', 'Glock-18', 'P90'];
const FINISHES = ['Smoczy Ogień', 'Krwawy Kamuflaż', 'Neonowa Rewolucja', 'Cień Pustyni', 'Ultrafiolet', 'Marmurkowy Splot', 'Elektryczny Puls', 'Złota Rypsówka'];

function buildPool(seedOffset = 0) {
    // Deterministyczny (per case), ale zróżnicowany zestaw 18 przedmiotów - po kilka na rzadkość, wartości rosną z rzadkością.
    const pool = [];
    let i = seedOffset;
    for (const rarity of RARITIES) {
        const count = rarity.id === 'rare-gold' ? 1 : rarity.id === 'covert' ? 2 : 4;
        for (let n = 0; n < count; n++) {
            const weapon = WEAPONS[(i * 7 + n) % WEAPONS.length];
            const finish = FINISHES[(i * 3 + n * 2) % FINISHES.length];
            const baseValue = { 'mil-spec': 15, restricted: 40, classified: 120, covert: 400, 'rare-gold': 2000 }[rarity.id];
            pool.push({
                name: `${weapon} | ${finish}`,
                rarity,
                value: Math.round(baseValue * (0.85 + 0.3 * ((n + 1) / count)))
            });
            i++;
        }
    }
    return pool;
}

const CASES = [
    { id: 'street', title: 'Skrzynka Uliczna', price: 50, pool: buildPool(0) },
    { id: 'vault', title: 'Skrzynka Skarbca', price: 150, pool: buildPool(11) },
    { id: 'phantom', title: 'Skrzynka Widmo', price: 400, pool: buildPool(23) }
];

function weightedPick(pool) {
    const totalWeight = pool.reduce((s, item) => s + item.rarity.weight, 0);
    let r = (crypto.getRandomValues(new Uint32Array(1))[0] / (0xFFFFFFFF + 1)) * totalWeight;
    for (const item of pool) {
        if (r < item.rarity.weight) return item;
        r -= item.rarity.weight;
    }
    return pool[0];
}

const REEL_ITEM_WIDTH = 128; // px, musi zgadzać się z .case-reel-item w CSS
const REEL_VISIBLE_COUNT = 60; // ile przedmiotów renderujemy na pasku przed wynikiem

export class CaseOpening {
    constructor(container) {
        this.el = container;
        this.caseId = CASES[0].id;
        this.opening = false;
        this.lastResult = null;
        this.render();
    }

    stop() {} // brak timerów do sprzątania (animacja to jedno CSS transition)

    get currentCase() {
        return CASES.find(c => c.id === this.caseId) || CASES[0];
    }

    selectCase(id) {
        if (this.opening) return;
        this.caseId = id;
        this.lastResult = null;
        this.render();
    }

    async open() {
        if (this.opening) return;
        const cs = this.currentCase;
        const ok = await Wallet.spend(cs.price);
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

            const containerWidth = track.parentElement.clientWidth;
            // losowy mikro-offset w obrębie kafelka, żeby wskaźnik nie lądował za każdym razem idealnie centralnie (bardziej "żywe")
            const jitter = (Math.random() - 0.5) * (REEL_ITEM_WIDTH * 0.5);
            const targetX = targetIndex * REEL_ITEM_WIDTH + REEL_ITEM_WIDTH / 2 - containerWidth / 2 + jitter;

            track.style.transition = 'transform 5.2s cubic-bezier(0.12, 0.72, 0.15, 1)';
            track.style.transform = `translateX(-${targetX}px)`;

            await new Promise(r => setTimeout(r, 5300));
        }

        if (winner.value > 0) await Wallet.win(winner.value);
        this.lastResult = { item: winner };
        this.opening = false;
        this.render();
    }

    _itemHtml(item) {
        return `
            <div class="case-reel-item" style="border-color:${item.rarity.color}">
                <div class="case-reel-item-icon">🔫</div>
                <div class="case-reel-item-name">${item.name}</div>
                <div class="case-reel-item-value" style="color:${item.rarity.color}">${item.value} 🪙</div>
            </div>`;
    }

    render() {
        const cs = this.currentCase;
        this.el.innerHTML = `
            <div class="case-opening">
                <div class="case-picker">
                    ${CASES.map(c => `
                        <div class="case-picker-item ${c.id === this.caseId ? 'active' : ''}" data-case="${c.id}">
                            <div class="case-picker-icon">📦</div>
                            <div class="case-picker-title">${c.title}</div>
                            <div class="case-picker-price">${c.price} 🪙</div>
                        </div>`).join('')}
                </div>

                <div class="case-reel-viewport">
                    <div class="case-reel-pointer"></div>
                    <div class="case-reel-track">
                        ${Array.from({ length: 10 }, () => this._itemHtml(weightedPick(cs.pool))).join('')}
                    </div>
                </div>

                <button class="btn-primary case-open-btn" id="case-open-btn" ${this.opening ? 'disabled' : ''}>
                    ${this.opening ? 'Otwieranie…' : `Otwórz za ${cs.price} 🪙`}
                </button>

                <div class="case-result">
                    ${this.lastResult?.insufficient ? '<span class="case-result-error">Za mało żetonów!</span>' : ''}
                    ${this.lastResult?.item ? `
                        <span class="case-result-win" style="color:${this.lastResult.item.rarity.color}">
                            Wypadło: ${this.lastResult.item.name} (${this.lastResult.item.rarity.label}) — +${this.lastResult.item.value} 🪙
                        </span>` : ''}
                </div>

                <div class="case-contents">
                    <details>
                        <summary>Zawartość skrzynki</summary>
                        <div class="case-contents-grid">
                            ${cs.pool.map(item => `
                                <div class="case-contents-item" style="border-color:${item.rarity.color}">
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
    }
}
