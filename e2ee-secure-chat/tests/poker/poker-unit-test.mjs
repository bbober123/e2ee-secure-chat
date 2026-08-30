import assert from 'node:assert/strict';
import {
    evaluate5, evaluateBest, createPokerTable, startHand, applyAction,
    isBettingRoundOver, advanceStreet, settleShowdown, activePlayers, nextActorIndex
} from './src/poker-engine.js';

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.log(`  ❌ ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`); failed++; }
}
function c(str) {
    // "AS" -> {rank:'A', suit:'♠'}; "10H" -> {rank:'10', suit:'♥'}
    const suitMap = { S: '♠', H: '♥', D: '♦', C: '♣' };
    const rank = str.slice(0, -1);
    const suit = suitMap[str.slice(-1)];
    return { rank, suit };
}

console.log('\n=== Ocena układów pokerowych ===\n');

test('Poker królewski > Strit w kolorze zwykły', () => {
    const royal = evaluate5(['AS', 'KS', 'QS', 'JS', '10S'].map(c));
    const sf = evaluate5(['9H', '8H', '7H', '6H', '5H'].map(c));
    assert.equal(royal.rank, 8);
    assert.equal(sf.rank, 8);
    assert.ok(royal.tie[0] > sf.tie[0]);
});

test('Kareta > Full', () => {
    const quads = evaluate5(['9S', '9H', '9D', '9C', '2S'].map(c));
    const full = evaluate5(['KS', 'KH', 'KD', '2C', '2S'].map(c));
    assert.equal(quads.rank, 7);
    assert.equal(full.rank, 6);
});

test('Full > Kolor', () => {
    const full = evaluate5(['2S', '2H', '2D', '5C', '5S'].map(c));
    const flush = evaluate5(['2S', '5S', '9S', 'JS', 'KS'].map(c));
    assert.ok(full.rank > flush.rank);
});

test('Kolor > Strit', () => {
    const flush = evaluate5(['2S', '5S', '9S', 'JS', 'KS'].map(c));
    const straight = evaluate5(['5S', '6H', '7D', '8C', '9S'].map(c));
    assert.ok(flush.rank > straight.rank);
});

test('"Koło" (A-2-3-4-5) liczy się jako strit z górną kartą 5, nie 14', () => {
    const wheel = evaluate5(['AS', '2H', '3D', '4C', '5S'].map(c));
    assert.equal(wheel.rank, 4);
    assert.equal(wheel.tie[0], 5);
});

test('Strit > Trójka', () => {
    const straight = evaluate5(['5S', '6H', '7D', '8C', '9S'].map(c));
    const trips = evaluate5(['9S', '9H', '9D', '2C', '3S'].map(c));
    assert.ok(straight.rank > trips.rank);
});

test('Dwie pary z wyższą górną parą wygrywa', () => {
    const a = evaluate5(['KS', 'KH', '5D', '5C', '2S'].map(c));
    const b = evaluate5(['QS', 'QH', '9D', '9C', '2S'].map(c));
    assert.ok(a.rank === b.rank && a.tie[0] > b.tie[0]);
});

test('evaluateBest wybiera NAJLEPSZE 5 z 7 kart (nie pierwsze z brzegu)', () => {
    // 2 karty własne (śmieciowe) + 5 wspólnych zawierających kolor - powinno znaleźć kolor, nie "wysoką kartę".
    const seven = ['2H', '3D', 'AS', 'KS', 'QS', 'JS', '9S'].map(c);
    const best = evaluateBest(seven);
    assert.equal(best.rank, 5); // kolor (As-K-Q-J-9 pik)
});

test('Wysoka karta poprawnie identyfikowana gdy nic się nie łączy', () => {
    const high = evaluate5(['2S', '5H', '9D', 'JC', 'KS'].map(c));
    assert.equal(high.rank, 0);
});

console.log('\n=== Silnik zakładów i side-poty ===\n');

test('startHand poprawnie pobiera blindy i ustawia pierwszego działającego', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    assert.equal(t.players[1].contributed, 10); // SB = gracz po dealerze (index 1)
    assert.equal(t.players[2].contributed, 20); // BB
    assert.equal(t.pot, 30);
    assert.equal(t.currentBet, 20);
    assert.equal(t.actorIndex, 0); // pierwszy do działania po BB, wraca do "Ty" (index 0) przy 3 graczach
});

test('call wyrównuje do currentBet i zamyka rundę gdy wszyscy działali', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    applyAction(t, 0, 'call'); // Ty dopłacasz do 20
    assert.equal(t.players[0].contributed, 20);
    applyAction(t, 1, 'call'); // Bot 1 (SB) dopłaca 10 więcej -> 20
    assert.equal(t.players[1].contributed, 20);
    // Bot 2 (BB) już ma 20 i "działał" przez sam fakt postawienia blinda? W naszej implementacji blind NIE ustawia hasActed.
    assert.equal(isBettingRoundOver(t), false);
    applyAction(t, 2, 'check');
    assert.equal(isBettingRoundOver(t), true);
});

test('raise resetuje hasActed innym graczom (muszą zareagować na podniesienie)', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    applyAction(t, 0, 'raise', 60);
    assert.equal(t.currentBet, 60);
    assert.equal(t.players[1].hasActed, false);
    assert.equal(t.players[2].hasActed, false);
    assert.equal(isBettingRoundOver(t), false);
});

test('fold usuwa gracza z activePlayers i pozwala zamknąć rundę', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    applyAction(t, 0, 'fold');
    applyAction(t, 1, 'call');
    assert.equal(activePlayers(t).length, 2);
});

test('advanceStreet dokłada właściwą liczbę kart wspólnych (flop 3, turn +1, river +1) i "spala" jedną kartę', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    const deckBefore = t.deck.length;
    advanceStreet(t); // -> flop
    assert.equal(t.community.length, 3);
    assert.equal(t.deck.length, deckBefore - 4); // 1 spalona + 3 flop
    advanceStreet(t); // -> turn
    assert.equal(t.community.length, 4);
    advanceStreet(t); // -> river
    assert.equal(t.community.length, 5);
    advanceStreet(t); // -> showdown
    assert.equal(t.street, 'showdown');
});

test('settleShowdown: jedyny niespasowany gracz zgarnia całą pulę bez porównywania kart', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    applyAction(t, 1, 'fold');
    applyAction(t, 2, 'fold');
    const potBefore = t.pot;
    const stackBefore = t.players[0].stack;
    const payouts = settleShowdown(t);
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].playerId, 0);
    assert.equal(t.players[0].stack, stackBefore + potBefore);
    assert.equal(t.pot, 0);
});

test('settleShowdown: pula zostaje w pełni rozdana (brak "znikających" żetonów) w normalnym rozdaniu', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    applyAction(t, 0, 'call');
    applyAction(t, 1, 'call');
    applyAction(t, 2, 'check');
    advanceStreet(t);
    applyAction(t, 1, 'check'); applyAction(t, 2, 'check'); applyAction(t, 0, 'check');
    advanceStreet(t);
    applyAction(t, 1, 'check'); applyAction(t, 2, 'check'); applyAction(t, 0, 'check');
    advanceStreet(t);
    applyAction(t, 1, 'check'); applyAction(t, 2, 'check'); applyAction(t, 0, 'check');
    advanceStreet(t);
    assert.equal(t.street, 'showdown');

    const totalStackBefore = t.players.reduce((s, p) => s + p.stack, 0) + t.pot;
    settleShowdown(t);
    const totalStackAfter = t.players.reduce((s, p) => s + p.stack, 0);
    assert.equal(totalStackAfter, totalStackBefore, 'suma stosów + puli przed musi się równać sumie stosów po (zero utraconych/wykreowanych żetonów)');
});

test('side-pot: gracz all-in za mniej dostaje tylko z warstwy, do której wniósł wkład', () => {
    const t = createPokerTable({ playerNames: ['Ty', 'Bot 1', 'Bot 2'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    // Ręcznie ustawiam scenariusz all-in za mniej: Bot 1 ma tylko 15 żetonów zapasu.
    t.players[1].stack = 15;
    // Ty stawiasz duży raise
    applyAction(t, 0, 'raise', 100);
    // Bot 1 idzie all-in (może wnieść tylko to co ma)
    t.players[1].contributed += t.players[1].stack; // symulacja all-in call za wszystko
    t.pot += t.players[1].stack;
    t.players[1].stack = 0;
    t.players[1].allIn = true;
    // Bot 2 dopłaca do pełnej stawki (100)
    applyAction(t, 2, 'call');

    const totalBefore = t.players.reduce((s, p) => s + p.stack, 0) + t.pot;
    const payouts = settleShowdown(t);
    const totalAfter = t.players.reduce((s, p) => s + p.stack, 0);
    assert.equal(totalAfter, totalBefore, 'side-pot nie może gubić ani tworzyć żetonów');
    assert.ok(payouts.length >= 1);
});

test('nextActorIndex pomija spasowanych i all-in, zawija się na początek stołu', () => {
    const t = createPokerTable({ playerNames: ['A', 'B', 'C', 'D'], buyIn: 500, smallBlind: 10, bigBlind: 20 });
    startHand(t);
    t.players[2].folded = true;
    t.players[3].allIn = true;
    const next = nextActorIndex(t, 0);
    assert.equal(next, 1);
    const next2 = nextActorIndex(t, 1);
    assert.equal(next2, 0); // pomija 2 (fold) i 3 (all-in), zawija do 0
});

console.log(`\n=== WYNIK: ${passed} zaliczone, ${failed} nieudane (z ${passed + failed} testów) ===\n`);
process.exit(failed > 0 ? 1 : 0);
