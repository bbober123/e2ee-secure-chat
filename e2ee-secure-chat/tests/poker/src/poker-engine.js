/**
 * poker-engine.js — czysta logika Texas Hold'em (bez DOM), testowalna osobno:
 * ocena układów (7 kart -> najlepsze 5), silnik zakładów z side-potami, i
 * prosta (heurystyczna) sztuczna inteligencja botów.
 */
import { createShuffledDeck } from './cards.js';

const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const HAND_NAMES = ['Wysoka karta', 'Para', 'Dwie pary', 'Trójka', 'Strit', 'Kolor', 'Full', 'Kareta', 'Strit w kolorze'];

function combinations(arr, k) {
    const results = [];
    const combo = [];
    function go(start) {
        if (combo.length === k) { results.push([...combo]); return; }
        for (let i = start; i < arr.length; i++) {
            combo.push(arr[i]);
            go(i + 1);
            combo.pop();
        }
    }
    go(0);
    return results;
}

/** Ocena DOKŁADNIE 5 kart. Zwraca {rank: 0-8, tie: [...], name}. Wyższe = lepsze, porównuj rank potem tie[] leksykograficznie. */
export function evaluate5(cards) {
    const values = cards.map(c => RANK_VALUES[c.rank]).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);

    const uniqueVals = [...new Set(values)].sort((a, b) => b - a);
    let straightHigh = null;
    if (uniqueVals.length === 5) {
        if (uniqueVals[0] - uniqueVals[4] === 4) straightHigh = uniqueVals[0];
        else if (uniqueVals.join(',') === '14,5,4,3,2') straightHigh = 5; // "koło" - A-2-3-4-5
    }

    const countMap = {};
    for (const v of values) countMap[v] = (countMap[v] || 0) + 1;
    const groups = Object.entries(countMap)
        .map(([v, c]) => ({ v: parseInt(v, 10), c }))
        .sort((a, b) => b.c - a.c || b.v - a.v);

    if (straightHigh && isFlush) {
        return { rank: 8, tie: [straightHigh], name: straightHigh === 14 ? 'Poker królewski' : HAND_NAMES[8] };
    }
    if (groups[0].c === 4) {
        const kicker = groups.find(g => g.c === 1).v;
        return { rank: 7, tie: [groups[0].v, kicker], name: HAND_NAMES[7] };
    }
    if (groups[0].c === 3 && groups[1]?.c === 2) {
        return { rank: 6, tie: [groups[0].v, groups[1].v], name: HAND_NAMES[6] };
    }
    if (isFlush) {
        return { rank: 5, tie: values, name: HAND_NAMES[5] };
    }
    if (straightHigh) {
        return { rank: 4, tie: [straightHigh], name: HAND_NAMES[4] };
    }
    if (groups[0].c === 3) {
        const kickers = groups.filter(g => g.c === 1).map(g => g.v).sort((a, b) => b - a);
        return { rank: 3, tie: [groups[0].v, ...kickers], name: HAND_NAMES[3] };
    }
    if (groups[0].c === 2 && groups[1]?.c === 2) {
        const pairVals = [groups[0].v, groups[1].v].sort((a, b) => b - a);
        const kicker = groups.find(g => g.c === 1).v;
        return { rank: 2, tie: [...pairVals, kicker], name: HAND_NAMES[2] };
    }
    if (groups[0].c === 2) {
        const kickers = groups.filter(g => g.c === 1).map(g => g.v).sort((a, b) => b - a);
        return { rank: 1, tie: [groups[0].v, ...kickers], name: HAND_NAMES[1] };
    }
    return { rank: 0, tie: values, name: HAND_NAMES[0] };
}

function compareEval(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    for (let i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
        const d = (a.tie[i] || 0) - (b.tie[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** Najlepszy układ z dowolnej liczby kart >= 5 (typowo 7: 2 własne + 5 wspólnych). */
export function evaluateBest(cards) {
    if (cards.length <= 5) return evaluate5(cards);
    let best = null;
    for (const combo of combinations(cards, 5)) {
        const ev = evaluate5(combo);
        if (!best || compareEval(ev, best) > 0) best = ev;
    }
    return best;
}

// =====================================================================
// Heurystyczna siła ręki bota (0..1) - nie jest to "solver", tylko rozsądne przybliżenie.
// =====================================================================

export function preflopStrength(hole) {
    const [a, b] = hole;
    const va = RANK_VALUES[a.rank], vb = RANK_VALUES[b.rank];
    const hi = Math.max(va, vb), lo = Math.min(va, vb);
    const suited = a.suit === b.suit;
    const pair = va === vb;

    let score = (hi - 2) / 12 * 0.55 + (lo - 2) / 12 * 0.25;
    if (pair) score += 0.25 + (hi / 14) * 0.15;
    if (suited) score += 0.08;
    if (hi - lo <= 3 && !pair) score += 0.05; // karty "łączące się" (potencjał na strita)
    return Math.max(0, Math.min(1, score));
}

export function postflopStrength(hole, community) {
    const ev = evaluateBest([...hole, ...community]);
    // rank 0..8 -> baza siły, plus mały wkład z tie-breakerów żeby rozróżnić karty w tej samej kategorii.
    const base = ev.rank / 8;
    const kicker = (ev.tie[0] || 0) / 14 * 0.08;
    return Math.max(0, Math.min(1, base * 0.85 + kicker + 0.07));
}

// =====================================================================
// Prosty silnik zakładów (blindy, call/raise/fold, side-poty)
// =====================================================================

export function createPokerTable({ playerNames, buyIn, smallBlind = 10, bigBlind = 20 }) {
    return {
        players: playerNames.map((name, i) => ({
            id: i, name, isBot: i !== 0, stack: buyIn, hole: [], folded: false, allIn: false,
            contributed: 0,       // suma wpłacona w CAŁYM rozdaniu (wszystkie ulice) - do side-potów przy rozliczeniu
            streetContributed: 0, // suma wpłacona na BIEŻĄCEJ ulicy - do porównań z currentBet w trakcie licytacji
            hasActed: false
        })),
        deck: [],
        community: [],
        pot: 0,
        street: 'preflop', // preflop | flop | turn | river | showdown
        dealerIndex: 0,
        currentBet: 0,
        actorIndex: 0,
        smallBlind, bigBlind,
        log: []
    };
}

export function startHand(table) {
    table.deck = createShuffledDeck(1);
    table.community = [];
    table.pot = 0;
    table.currentBet = 0;
    table.street = 'preflop';
    table.log = [];
    for (const p of table.players) {
        p.hole = [table.deck.pop(), table.deck.pop()];
        p.folded = p.stack <= 0;
        p.allIn = false;
        p.contributed = 0;
        p.streetContributed = 0;
        p.hasActed = false;
    }

    const n = table.players.length;
    const sbIdx = (table.dealerIndex + 1) % n;
    const bbIdx = (table.dealerIndex + 2) % n;
    postBet(table, table.players[sbIdx], table.smallBlind);
    postBet(table, table.players[bbIdx], table.bigBlind);
    table.currentBet = table.bigBlind;
    // WAŻNE: nie zakładamy na sztywno "gracz po BB działa pierwszy" - jeśli ktoś z
    // blindów wszedł all-in SAMYM blindem (stack mniejszy niż wysokość blinda), nie
    // może "działać" ponownie. nextActorIndex poprawnie pomija już all-in/spasowanych.
    table.actorIndex = nextActorIndex(table, bbIdx);
    table.log.push(`${table.players[sbIdx].name} stawia mały blind (${table.smallBlind})`);
    table.log.push(`${table.players[bbIdx].name} stawia duży blind (${table.bigBlind})`);
}

function postBet(table, player, amount) {
    const actual = Math.min(amount, player.stack);
    player.stack -= actual;
    player.contributed += actual;
    player.streetContributed += actual;
    table.pot += actual;
    if (player.stack === 0) player.allIn = true;
}

export function activePlayers(table) {
    return table.players.filter(p => !p.folded);
}

export function playersLeftToAct(table) {
    return table.players.filter(p => !p.folded && !p.allIn);
}

/** `action`: 'fold' | 'check' | 'call' | 'raise'; `raiseTo` wymagane dla 'raise' (docelowa wysokość zakładu gracza NA TEJ ULICY, nie w całym rozdaniu). */
export function applyAction(table, playerId, action, raiseTo = 0) {
    const player = table.players.find(p => p.id === playerId);
    if (!player || player.folded || player.allIn) return;

    if (action === 'fold') {
        player.folded = true;
        table.log.push(`${player.name} pasuje`);
    } else if (action === 'check') {
        table.log.push(`${player.name} czeka`);
    } else if (action === 'call') {
        const toCall = table.currentBet - player.streetContributed;
        postBet(table, player, Math.max(0, toCall));
        table.log.push(`${player.name} sprawdza`);
    } else if (action === 'raise') {
        const target = Math.max(raiseTo, table.currentBet + table.bigBlind);
        const delta = target - player.streetContributed;
        const previousBet = table.currentBet;
        postBet(table, player, Math.max(0, delta));

        if (player.streetContributed > previousBet) {
            // Prawdziwe podniesienie (ewentualnie częściowe, ale WCIĄŻ powyżej dotychczasowej
            // stawki) - dopiero to otwiera akcję na nowo dla pozostałych graczy.
            table.currentBet = player.streetContributed;
            table.log.push(`${player.name} podbija do ${player.streetContributed}`);
            table.players.forEach(p => { if (p.id !== player.id && !p.folded && !p.allIn) p.hasActed = false; });
        } else {
            // Za mało żetonów, żeby nawet dogonić bieżącą stawkę (all-in za mniej niż call).
            // KLUCZOWE: table.currentBet NIE MOŻE się zmniejszyć - inny gracz mógł już
            // legalnie wpłacić więcej. To efektywnie częściowy call, nie podniesienie,
            // więc NIE resetujemy hasActed pozostałym (nie "reopenujemy" akcji).
            table.log.push(`${player.name} idzie all-in za ${player.streetContributed} (za mało na podbicie)`);
        }
    }
    player.hasActed = true;
}

/** Czy ulica zakładów jest zamknięta (wszyscy albo spasowali/all-in, albo wyrównali bieżący zakład NA TEJ ULICY i już działali). */
export function isBettingRoundOver(table) {
    const contenders = table.players.filter(p => !p.folded && !p.allIn);
    if (contenders.length === 0) return true;
    return contenders.every(p => p.hasActed && p.streetContributed === table.currentBet);
}

export function nextActorIndex(table, fromIndex) {
    const n = table.players.length;
    for (let step = 1; step <= n; step++) {
        const idx = (fromIndex + step) % n;
        const p = table.players[idx];
        if (!p.folded && !p.allIn) return idx;
    }
    return -1;
}

export function advanceStreet(table) {
    table.players.forEach(p => { p.hasActed = false; p.streetContributed = 0; });
    table.currentBet = 0;
    if (table.street === 'preflop') {
        table.deck.pop(); // burn
        table.community.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
        table.street = 'flop';
    } else if (table.street === 'flop') {
        table.deck.pop();
        table.community.push(table.deck.pop());
        table.street = 'turn';
    } else if (table.street === 'turn') {
        table.deck.pop();
        table.community.push(table.deck.pop());
        table.street = 'river';
    } else {
        table.street = 'showdown';
    }
    const n = table.players.length;
    table.actorIndex = nextActorIndex(table, table.dealerIndex);
}

/** Rozlicza pulę (z side-potami) na koniec ręki. Zwraca listę {playerId, amount, handName}. */
export function settleShowdown(table) {
    const contenders = table.players.filter(p => !p.folded);
    const payouts = [];

    if (contenders.length === 1) {
        contenders[0].stack += table.pot;
        payouts.push({ playerId: contenders[0].id, amount: table.pot, handName: null });
        table.pot = 0;
        return payouts;
    }

    const evals = new Map(contenders.map(p => [p.id, evaluateBest([...p.hole, ...table.community])]));
    // Standardowy algorytm side-potów: warstwa po warstwie po rosnącym wkładzie.
    let remaining = table.players.map(p => ({ id: p.id, contributed: p.contributed, folded: p.folded }));
    while (remaining.some(r => r.contributed > 0)) {
        const layerAmount = Math.min(...remaining.filter(r => r.contributed > 0).map(r => r.contributed));
        const layerPot = layerAmount * remaining.filter(r => r.contributed > 0).length;
        const eligible = remaining.filter(r => r.contributed > 0 && !r.folded).map(r => r.id);

        if (eligible.length > 0) {
            let bestEval = null;
            for (const id of eligible) {
                const ev = evals.get(id);
                if (!bestEval || compareEval(ev, bestEval) > 0) bestEval = ev;
            }
            const winners = eligible.filter(id => compareEval(evals.get(id), bestEval) === 0);
            const share = Math.floor(layerPot / winners.length);
            let leftover = layerPot - share * winners.length;
            for (const id of winners) {
                const amt = share + (leftover > 0 ? 1 : 0);
                if (leftover > 0) leftover--;
                table.players.find(p => p.id === id).stack += amt;
                payouts.push({ playerId: id, amount: amt, handName: evals.get(id).name });
            }
        }

        remaining = remaining.map(r => ({ ...r, contributed: Math.max(0, r.contributed - layerAmount) }));
    }

    table.pot = 0;
    return payouts;
}

/** Decyzja bota: zwraca { action, raiseTo? }. */
export function botDecision(table, player) {
    const strength = table.street === 'preflop' ? preflopStrength(player.hole) : postflopStrength(player.hole, table.community);
    const toCall = table.currentBet - player.streetContributed;
    const potOdds = toCall > 0 ? toCall / (table.pot + toCall) : 0;
    const bluff = Math.random() < 0.06;

    if (toCall === 0) {
        if (strength > 0.62 || bluff) {
            return { action: 'raise', raiseTo: table.currentBet + table.bigBlind * (1 + Math.floor(strength * 3)) };
        }
        return { action: 'check' };
    }

    if (strength + (bluff ? 0.3 : 0) < potOdds * 1.15 && strength < 0.35) {
        return { action: 'fold' };
    }
    if (strength > 0.75 && Math.random() < 0.6) {
        return { action: 'raise', raiseTo: table.currentBet + table.bigBlind * (1 + Math.floor(strength * 3)) };
    }
    return { action: 'call' };
}
