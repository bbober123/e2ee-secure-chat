/**
 * casino/cases.js — "Skrzynki": klasyczny case-opening z poziomym pasem
 * przedmiotów, który zwalnia i zatrzymuje się na wylosowanej nagrodzie.
 * Mechanika żetonów identyczna jak w innych grach (Wallet.spend/win) -
 * przedmiot jest od razu "sprzedawany" za żetony (brak ekwipunku, prostsze).
 */
import { Wallet } from './wallet.js';

// Ikony broni: darmowe, wolne od cudzych praw (licencja CC BY 3.0, autorzy
// niżej), pobrane z https://game-icons.net (repo game-icons/icons na
// GitHubie) - NIE są to obrazy/skiny z CS:GO. Wymóg licencji: wzmianka
// o autorach - patrz src/assets/weapon-icons/ATTRIBUTION.txt.
import iconAk47 from '../../assets/weapon-icons/ak47.svg?raw';
import iconM4 from '../../assets/weapon-icons/m4.svg?raw';
import iconAwp from '../../assets/weapon-icons/awp.svg?raw';
import iconDeagle from '../../assets/weapon-icons/deagle.svg?raw';
import iconUsp from '../../assets/weapon-icons/usp.svg?raw';
import iconKarambit from '../../assets/weapon-icons/karambit.svg?raw';
import iconGlock from '../../assets/weapon-icons/glock.svg?raw';
import iconP90 from '../../assets/weapon-icons/p90.svg?raw';
import iconMp7 from '../../assets/weapon-icons/mp7.svg?raw';
import iconFiveseven from '../../assets/weapon-icons/fiveseven.svg?raw';
import iconButterfly from '../../assets/weapon-icons/butterfly-knife.svg?raw';
import iconGloves from '../../assets/weapon-icons/gloves.svg?raw';
import iconMac10 from '../../assets/weapon-icons/mac10.svg?raw';
import iconSawedoff from '../../assets/weapon-icons/sawedoff.svg?raw';
import iconNegev from '../../assets/weapon-icons/negev.svg?raw';
import iconP250 from '../../assets/weapon-icons/p250.svg?raw';
import iconBayonet from '../../assets/weapon-icons/bayonet.svg?raw';
import iconGutknife from '../../assets/weapon-icons/gutknife.svg?raw';
import iconStiletto from '../../assets/weapon-icons/stiletto.svg?raw';
import iconUrsus from '../../assets/weapon-icons/ursus.svg?raw';
import iconBoxingglove from '../../assets/weapon-icons/boxingglove.svg?raw';

const WEAPON_ICON = {
    'AK-47': iconAk47, 'M4A4': iconM4, 'AWP': iconAwp, 'Desert Eagle': iconDeagle,
    'USP': iconUsp, 'Karambit': iconKarambit, 'Glock-18': iconGlock, 'P90': iconP90,
    'M4A1-S': iconM4, 'MP7': iconMp7, 'Five-SeveN': iconFiveseven, 'Butterfly': iconButterfly,
    'MAC-10': iconMac10, 'Sawed-Off': iconSawedoff, 'Negev': iconNegev, 'P250': iconP250,
    'Bayonet': iconBayonet, 'Gut Knife': iconGutknife, 'Stiletto': iconStiletto,
    'Ursus': iconUrsus, 'Rękawice Bojowe': iconBoxingglove, 'Rękawice': iconGloves
};

// Wagi = dokładnie te same procenty, jakie Valve oficjalnie ujawniło dla
// szans na rzadkość w skrzynkach CS:GO/CS2 (Mil-Spec 79.92% / Restricted
// 15.98% / Classified 3.2% / Covert 0.64% / Rzadkie-Złote 0.26%) — suma
// = 100, więc `weight` można czytać wprost jako procent. To publiczna,
// jawna informacja liczbowa, nie grafika ani cudzy kod, więc mogę jej
// użyć - ale same przedmioty/nazwy są własne (patrz komentarz niżej).
const RARITIES = [
    { id: 'mil-spec', label: 'Mil-Spec', color: '#4b69ff', weight: 79.92 },
    { id: 'restricted', label: 'Restricted', color: '#8847ff', weight: 15.98 },
    { id: 'classified', label: 'Classified', color: '#d32ce6', weight: 3.2 },
    { id: 'covert', label: 'Covert', color: '#eb4b4b', weight: 0.64 },
    { id: 'rare-gold', label: 'Rzadkie Złoto', color: '#ffd700', weight: 0.26 }
];

// 16 modeli broni (więcej = mniej powtarzalności w puli każdej skrzynki).
const WEAPONS = [
    'AK-47', 'M4A4', 'M4A1-S', 'AWP', 'Desert Eagle', 'USP', 'Glock-18', 'P90',
    'MP7', 'Five-SeveN', 'MAC-10', 'Sawed-Off', 'Negev', 'P250', 'Karambit', 'Butterfly'
];
// Osobna pula na rzadkość "złotą" - w prawdziwych skrzynkach to zawsze noże/rękawice, nigdy zwykła broń.
const GOLD_ITEMS = ['Karambit', 'Butterfly', 'Bayonet', 'Gut Knife', 'Stiletto', 'Ursus', 'Rękawice Bojowe', 'Rękawice'];

const FINISHES = [
    'Smoczy Ogień', 'Krwawy Kamuflaż', 'Neonowa Rewolucja', 'Cień Pustyni', 'Ultrafiolet',
    'Marmurkowy Splot', 'Elektryczny Puls', 'Złota Rypsówka', 'Stalowy Brzask', 'Szmaragdowy Wir',
    'Rdzawy Pył', 'Arktyczny Kamuflaż', 'Fioletowa Mgła', 'Piaskowa Burza', 'Krwista Otchłań',
    'Lodowy Odłam', 'Miedziany Rozbłysk', 'Nocny Łowca', 'Toksyczny Wyciek', 'Perłowy Połysk'
];

// Relatywne mnożniki wartości między rzadkościami (im rzadsza tym więcej) -
// stałe niezależnie od skrzynki. Rzeczywista wartość bazowa skaluje się
// z ceną skrzynki (patrz baseUnitForPrice), żeby droższe skrzynki miały
// proporcjonalnie lepsze nagrody, a nie identyczne jak tańsze.
const VALUE_MULTIPLIER = { 'mil-spec': 1, restricted: 2.67, classified: 8, covert: 26.7, 'rare-gold': 133.3 };

// Suma ważona mnożników (z wag rzadkości powyżej) ≈ 2.0, więc EV jednego
// otwarcia ≈ baseUnit * 2. Mnożnik 0.425 daje ~85% zwrotu ceny skrzynki
// w oczekiwanej wartości (15% "marży kasyna", tak jak w innych grach tutaj).
function baseUnitForPrice(price) {
    return price * 0.425;
}

function buildPool(price, seedOffset = 0) {
    // Deterministyczny (per case), ale zróżnicowany zestaw ~34 przedmiotów - po kilka na rzadkość, wartości skalowane ceną skrzynki.
    const baseUnit = baseUnitForPrice(price);
    const pool = [];
    let i = seedOffset;
    for (const rarity of RARITIES) {
        const count = rarity.id === 'rare-gold' ? 4 : rarity.id === 'covert' ? 4 : 7;
        for (let n = 0; n < count; n++) {
            // rzadkość "złota" tematycznie to noże/rękawice (jak w prawdziwych skrzynkach) - reszta losowana normalnie z puli broni
            const weapon = rarity.id === 'rare-gold'
                ? GOLD_ITEMS[(i * 5 + n) % GOLD_ITEMS.length]
                : WEAPONS[(i * 7 + n) % WEAPONS.length];
            const finish = FINISHES[(i * 3 + n * 2) % FINISHES.length];
            pool.push({
                name: `${weapon} | ${finish}`,
                rarity,
                icon: WEAPON_ICON[weapon],
                value: Math.max(1, Math.round(baseUnit * VALUE_MULTIPLIER[rarity.id] * (0.85 + 0.3 * ((n + 1) / count))))
            });
            i++;
        }
    }
    return pool;
}

const CASE_DEFS = [
    { id: 'street', title: 'Skrzynka Uliczna', price: 50, seed: 0 },
    { id: 'vault', title: 'Skrzynka Skarbca', price: 100, seed: 11 },
    { id: 'phantom', title: 'Skrzynka Widmo', price: 200, seed: 23 },
    { id: 'neon', title: 'Skrzynka Neonowa', price: 350, seed: 37 },
    { id: 'obsidian', title: 'Skrzynka Obsydianowa', price: 600, seed: 51 },
    { id: 'crimson', title: 'Skrzynka Purpurowa', price: 1000, seed: 67 },
    { id: 'titan', title: 'Skrzynka Tytanowa', price: 1750, seed: 83 },
    { id: 'legend', title: 'Skrzynka Legendarna', price: 3000, seed: 101 }
];

const CASES = CASE_DEFS.map(c => ({ ...c, pool: buildPool(c.price, c.seed) }));

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

        if (winner.value > 0) await Wallet.win(winner.value);
        this.lastResult = { item: winner };
        this.opening = false;
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
    }
}
