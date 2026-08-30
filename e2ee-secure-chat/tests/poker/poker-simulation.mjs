import assert from 'node:assert/strict';
import { createPokerTable, startHand, applyAction, isBettingRoundOver, advanceStreet, settleShowdown, activePlayers, botDecision } from './src/poker-engine.js';

function runSim(numPlayers, numHands, buyIn) {
    const names = Array.from({length: numPlayers}, (_, i) => i === 0 ? 'Ty' : `Bot ${i}`);
    const t = createPokerTable({ playerNames: names, buyIn, smallBlind: 10, bigBlind: 20 });
    let maxIter = 0;

    for (let h = 0; h < numHands; h++) {
        for (const p of t.players) if (p.stack <= 0) p.stack = buyIn; // "rebuy"
        const totalBefore = t.players.reduce((s, p) => s + p.stack, 0);

        startHand(t);
        let iterations = 0;
        while (t.street !== 'showdown' && activePlayers(t).length > 1) {
            iterations++;
            if (iterations > 5000) throw new Error(`INFINITE LOOP hand #${h} players=${numPlayers}`);
            if (isBettingRoundOver(t)) { advanceStreet(t); continue; }
            const actor = t.players[t.actorIndex];
            if (actor.folded || actor.allIn) throw new Error(`bad actor state hand #${h}`);
            const decision = botDecision(t, actor);
            applyAction(t, actor.id, decision.action, decision.raiseTo);
            let next = -1;
            for (let step = 1; step <= t.players.length; step++) {
                const idx = (t.actorIndex + step) % t.players.length;
                if (!t.players[idx].folded && !t.players[idx].allIn) { next = idx; break; }
            }
            if (next === -1) break;
            t.actorIndex = next;
        }
        maxIter = Math.max(maxIter, iterations);
        while (t.street !== 'showdown') advanceStreet(t);

        settleShowdown(t);
        const totalAfter = t.players.reduce((s, p) => s + p.stack, 0);
        assert.equal(totalAfter, totalBefore, `players=${numPlayers} hand #${h}: chip leak ${totalBefore} -> ${totalAfter}`);
        t.dealerIndex = (t.dealerIndex + 1) % t.players.length;
    }
    console.log(`✅ ${numPlayers} graczy: ${numHands} rozdań OK, max iteracji/rozdanie=${maxIter}`);
}

runSim(2, 1000, 200);   // heads-up, mały stack -> częste all-iny
runSim(2, 500, 5000);   // heads-up, duży stack
runSim(3, 1000, 300);
runSim(6, 1000, 500);
runSim(9, 500, 1000);
console.log('\n✅ WSZYSTKIE SYMULACJE PRZESZŁY (brak infinite loop, brak wycieku żetonów)');
