/**
 * cards.js — talia kart i generator ładnych, w pełni wektorowych (SVG) kart
 * do gry, bez żadnych zewnętrznych obrazków (mniej zależności, brak wątpliwości
 * licencyjnych, ostre w każdej rozdzielczości).
 */

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const RED_SUITS = new Set(['♥', '♦']);

/** Tworzy pełną, potasowaną talię 52 kart (opcjonalnie kilka talii naraz - standard w blackjacku). */
export function createShuffledDeck(numDecks = 1) {
    const deck = [];
    for (let d = 0; d < numDecks; d++) {
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                deck.push({ rank, suit, id: `${rank}${suit}-${d}` });
            }
        }
    }
    // Fisher-Yates z crypto.getRandomValues (nie Math.random - to gra o (wirtualne) pieniądze).
    for (let i = deck.length - 1; i > 0; i--) {
        const r = crypto.getRandomValues(new Uint32Array(1))[0] / (0xFFFFFFFF + 1);
        const j = Math.floor(r * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

export function cardColor(card) {
    return RED_SUITS.has(card.suit) ? 'var(--casino-red, #dc2626)' : 'var(--casino-ink, #1a1a1a)';
}

/** Wartość karty w blackjacku (As liczony jako 11, korygowany na poziomie sumy ręki). */
export function blackjackValue(rank) {
    if (rank === 'A') return 11;
    if (['J', 'Q', 'K'].includes(rank)) return 10;
    return parseInt(rank, 10);
}

/**
 * Zwraca znacznik SVG pojedynczej karty. `faceDown=true` renderuje rewers
 * (złota siatka na zielonym suknie) - używane dla zakrytej karty krupiera.
 */
export function renderCard(card, { faceDown = false, small = false } = {}) {
    const w = small ? 64 : 88;
    const h = small ? 90 : 124;
    if (faceDown) {
        return `
        <svg class="playing-card card-back" width="${w}" height="${h}" viewBox="0 0 88 124" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="86" height="122" rx="8" fill="#0e4b38" stroke="#e2b93b" stroke-width="2"/>
            <rect x="7" y="7" width="74" height="110" rx="5" fill="none" stroke="#e2b93b" stroke-width="1" opacity="0.55"/>
            <g stroke="#e2b93b" stroke-width="1" opacity="0.35">
                ${Array.from({length: 6}).map((_, i) => `<line x1="${10 + i*13}" y1="7" x2="${10 + i*13}" y2="117"/>`).join('')}
                ${Array.from({length: 8}).map((_, i) => `<line x1="7" y1="${10 + i*13}" x2="81" y2="${10 + i*13}"/>`).join('')}
            </g>
            <circle cx="44" cy="62" r="16" fill="none" stroke="#e2b93b" stroke-width="1.5" opacity="0.8"/>
            <text x="44" y="69" text-anchor="middle" font-size="18" fill="#e2b93b" font-family="Georgia, serif">♠</text>
        </svg>`;
    }

    const color = cardColor(card);
    const isFace = ['J', 'Q', 'K'].includes(card.rank);
    const isAce = card.rank === 'A';

    let centerArt;
    if (isAce) {
        centerArt = `<text x="44" y="76" text-anchor="middle" font-size="40" fill="${color}" font-family="Georgia, serif">${card.suit}</text>`;
    } else if (isFace) {
        centerArt = `
            <text x="44" y="70" text-anchor="middle" font-size="30" fill="${color}" font-family="Georgia, serif" font-weight="bold">${card.rank}</text>
            <text x="44" y="90" text-anchor="middle" font-size="20" fill="${color}" font-family="Georgia, serif">${card.suit}</text>`;
    } else {
        const n = parseInt(card.rank, 10);
        const cols = n <= 2 ? [44] : [30, 58];
        const rows = 5;
        const pips = [];
        const pattern = PIP_LAYOUTS[n] || [];
        for (const [cx, cy] of pattern) {
            pips.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-size="14" fill="${color}" font-family="Georgia, serif">${card.suit}</text>`);
        }
        centerArt = pips.join('');
    }

    return `
    <svg class="playing-card" width="${w}" height="${h}" viewBox="0 0 88 124" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="86" height="122" rx="8" fill="#fdfaf1" stroke="#d8d0bb" stroke-width="1.5"/>
        <text x="8" y="20" font-size="14" fill="${color}" font-family="Georgia, serif" font-weight="bold">${card.rank}</text>
        <text x="8" y="34" font-size="12" fill="${color}" font-family="Georgia, serif">${card.suit}</text>
        <g transform="rotate(180 44 62)">
            <text x="8" y="20" font-size="14" fill="${color}" font-family="Georgia, serif" font-weight="bold">${card.rank}</text>
            <text x="8" y="34" font-size="12" fill="${color}" font-family="Georgia, serif">${card.suit}</text>
        </g>
        ${centerArt}
    </svg>`;
}

// Przybliżone układy oczek dla kart 2-10 (nieheraldyczne, ale czytelne i eleganckie).
const PIP_LAYOUTS = {
    2: [[44, 40], [44, 96]],
    3: [[44, 34], [44, 68], [44, 102]],
    4: [[30, 40], [58, 40], [30, 96], [58, 96]],
    5: [[30, 40], [58, 40], [44, 68], [30, 96], [58, 96]],
    6: [[30, 36], [58, 36], [30, 68], [58, 68], [30, 100], [58, 100]],
    7: [[30, 36], [58, 36], [44, 52], [30, 68], [58, 68], [30, 100], [58, 100]],
    8: [[30, 32], [58, 32], [44, 50], [30, 68], [58, 68], [44, 86], [30, 104], [58, 104]],
    9: [[30, 28], [58, 28], [30, 56], [58, 56], [44, 68], [30, 80], [58, 80], [30, 108], [58, 108]],
    10: [[30, 26], [58, 26], [30, 50], [58, 50], [30, 74], [58, 74], [44, 62], [30, 98], [58, 98], [44, 86]]
};

/** Renderuje rząd kart (dłoń) jako HTML string gotowy do wstrzyknięcia. */
export function renderHand(cards, { hideFirst = false, small = false } = {}) {
    return `<div class="card-hand">${cards.map((c, i) =>
        renderCard(c, { faceDown: hideFirst && i === 0, small })
    ).join('')}</div>`;
}
