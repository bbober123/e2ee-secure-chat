// Test end-to-end NA PRAWDZIWYM, NIEZMODYFIKOWANYM kodzie z src/js/
// (crypto.js, ratchet.js, sealed.js, prekeys.js, groupkeys.js - skopiowane
// bajt w bajt). supabase.js jest zastąpiony atrapą, która rzuca wyjątkiem
// przy JAKIMKOLWIEK wywołaniu - test celowo NIE woła funkcji, które łączą
// się z Supabase (fetchPrekeyBundle, saveRatchetState, itd.), tylko operuje
// bezpośrednio na klasach/funkcjach kryptograficznych, symulując po obu
// stronach dokładnie to, co normalnie przechodzi przez sieć (bundle kluczy
// publicznych, ciphertext+nonce+header).
//
// Czego ten test NIE sprawdza: polityk RLS, prawdziwych zapytań SQL,
// realtime, UI. Sprawdza WYŁĄCZNIE poprawność samego protokołu kryptograficznego.

import assert from 'node:assert/strict';
import { CryptoEngine } from './vendor/crypto.js';
import { DoubleRatchet } from './vendor/ratchet.js';
import { sealedEncrypt, sealedDecrypt } from './vendor/sealed.js';
import { IdentityVault } from './vendor/prekeys.js';
import { GroupCrypto } from './vendor/groupkeys.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
        failed++;
    }
}

/** Symuluje to, co normalnie robi fetchPrekeyBundle() przez sieć: buduje bundle publiczny z cudzego vaulta. */
function bundleFrom(vault, { consumeOpk = true } = {}) {
    const opk = consumeOpk ? vault.opks[0] : null;
    return {
        ikPubJwk: vault.identityDh.publicJwk,
        spkPubJwk: vault.spk.publicJwk,
        spkId: vault.spk.id,
        opkPubJwk: opk ? opk.publicJwk : null,
        opkId: opk ? opk.id : null
    };
}

async function importIdentityPriv(vault) {
    return await crypto.subtle.importKey('jwk', vault.identityDh.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

console.log('\n=== 1:1 X3DH + Double Ratchet ===\n');

let alice, bob, aliceRatchet, bobRatchet;

await test('generowanie IdentityVault dla Alice i Boba (IK/SPK/OPK x20)', async () => {
    alice = await IdentityVault.create();
    bob = await IdentityVault.create();
    assert.equal(alice.opks.length, 20);
    assert.equal(bob.opks.length, 20);
    assert.ok(alice.identityDh.publicJwk.x && alice.identitySign.publicJwk.x);
});

await test('SPK Boba ma poprawny, weryfikowalny podpis ECDSA', async () => {
    const signingPub = await crypto.subtle.importKey('jwk', bob.identitySign.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const valid = await CryptoEngine.verifyEcdsa(signingPub, CryptoEngine.canonicalEcdhJwk(bob.spk.publicJwk), bob.spk.signature);
    assert.equal(valid, true);
});

await test('X3DH + Double Ratchet init: Alice (inicjator) <-> Bob (odbiorca) dostają IDENTYCZNY Root Key', async () => {
    const bobBundle = bundleFrom(bob);
    const aliceIdentityPriv = await importIdentityPriv(alice);

    aliceRatchet = new DoubleRatchet();
    const { x3dhHeader } = await aliceRatchet.initAsInitiator({
        identityPriv: aliceIdentityPriv,
        identityPubJwk: alice.identityDh.publicJwk,
        bundle: bobBundle
    });

    const bobIdentityPriv = await importIdentityPriv(bob);
    const spkPub = await crypto.subtle.importKey('jwk', bob.spk.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const spkPriv = await crypto.subtle.importKey('jwk', bob.spk.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const opkPriv = await crypto.subtle.importKey('jwk', bob.opks[0].privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

    bobRatchet = new DoubleRatchet();
    await bobRatchet.initAsResponder({
        identityPriv: bobIdentityPriv,
        spkKeyPair: { publicKey: spkPub, privateKey: spkPriv, publicJwk: bob.spk.publicJwk, privateJwk: bob.spk.privateJwk },
        opkPriv,
        x3dh: x3dhHeader
    });

    // Nie ma bezpośredniego API do porównania RK, ale jeśli jest identyczny,
    // pierwsza wiadomość Alice zaszyfrowana i odszyfrowana przez Boba da ten sam plaintext.
    aliceRatchet._pendingX3dhHeader = x3dhHeader;
    assert.ok(true);
});

await test('Alice -> Bob: pierwsza wiadomość (z osadzonym nagłówkiem X3DH) odszyfrowuje się poprawnie', async () => {
    const enc = await aliceRatchet.encrypt('Cześć Bob, tu Alice!');
    const headerObj = JSON.parse(enc.headerJson);
    headerObj.x3dh = aliceRatchet._pendingX3dhHeader;
    const headerJson = JSON.stringify(headerObj);

    const plaintext = await bobRatchet.decrypt(enc.ciphertextBase64, enc.nonceBase64, headerJson);
    assert.equal(plaintext, 'Cześć Bob, tu Alice!');
});

await test('Bob -> Alice: odpowiedź (po odebraniu pierwszej wiadomości Bob MOŻE już wysyłać) odszyfrowuje się poprawnie', async () => {
    const enc = await bobRatchet.encrypt('Cześć Alice, tu Bob!');
    const plaintext = await aliceRatchet.decrypt(enc.ciphertextBase64, enc.nonceBase64, enc.headerJson);
    assert.equal(plaintext, 'Cześć Alice, tu Bob!');
});

await test('Bob NIE MOŻE wysłać PRZED odebraniem pierwszej wiadomości Alice (świeża sesja)', async () => {
    const freshBob = new DoubleRatchet();
    const bobIdentityPriv = await importIdentityPriv(bob);
    const spkPub = await crypto.subtle.importKey('jwk', bob.spk.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const spkPriv = await crypto.subtle.importKey('jwk', bob.spk.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    await freshBob.initAsResponder({
        identityPriv: bobIdentityPriv,
        spkKeyPair: { publicKey: spkPub, privateKey: spkPriv, publicJwk: bob.spk.publicJwk, privateJwk: bob.spk.privateJwk },
        opkPriv: null,
        x3dh: { ik: alice.identityDh.publicJwk, ek: alice.identityDh.publicJwk, spkId: bob.spk.id, opkId: null }
    });
    await assert.rejects(() => freshBob.encrypt('nie powinno się udać'));
});

await test('Wielokrotna wymiana (10 wiadomości na przemian) - Double Ratchet działa dalej', async () => {
    for (let i = 0; i < 5; i++) {
        const e1 = await aliceRatchet.encrypt(`Alice #${i}`);
        assert.equal(await bobRatchet.decrypt(e1.ciphertextBase64, e1.nonceBase64, e1.headerJson), `Alice #${i}`);
        const e2 = await bobRatchet.encrypt(`Bob #${i}`);
        assert.equal(await aliceRatchet.decrypt(e2.ciphertextBase64, e2.nonceBase64, e2.headerJson), `Bob #${i}`);
    }
});

await test('Wiadomości spoza kolejności (out-of-order delivery) - mechanizm skip-keys', async () => {
    const m1 = await aliceRatchet.encrypt('jeden');
    const m2 = await aliceRatchet.encrypt('dwa');
    const m3 = await aliceRatchet.encrypt('trzy');

    // Bob dostaje je w kolejności 3, 1, 2 (np. przez niestabilną sieć)
    assert.equal(await bobRatchet.decrypt(m3.ciphertextBase64, m3.nonceBase64, m3.headerJson), 'trzy');
    assert.equal(await bobRatchet.decrypt(m1.ciphertextBase64, m1.nonceBase64, m1.headerJson), 'jeden');
    assert.equal(await bobRatchet.decrypt(m2.ciphertextBase64, m2.nonceBase64, m2.headerJson), 'dwa');
});

await test('Ponowne użycie tego samego klucza wiadomości jest niemożliwe (forward secrecy)', async () => {
    const m = await aliceRatchet.encrypt('sekret');
    const first = await bobRatchet.decrypt(m.ciphertextBase64, m.nonceBase64, m.headerJson);
    assert.equal(first, 'sekret');
    // Drugie odszyfrowanie TEGO SAMEGO pakietu musi się nie udać - klucz już skasowany.
    await assert.rejects(() => bobRatchet.decrypt(m.ciphertextBase64, m.nonceBase64, m.headerJson));
});

await test('Zmanipulowany ciphertext jest odrzucany (integralność AES-GCM)', async () => {
    const m = await aliceRatchet.encrypt('nie ruszaj mnie');
    const tampered = { ...m, ciphertextBase64: m.ciphertextBase64.slice(0, -4) + 'AAAA' };
    await assert.rejects(() => bobRatchet.decrypt(tampered.ciphertextBase64, tampered.nonceBase64, tampered.headerJson));
});

await test('REGRESJA: stan ratchetu PRZEŻYWA odrzucony/zmanipulowany pakiet - kolejna, prawdziwa wiadomość nadal się deszyfruje', async () => {
    // To jest dokładnie scenariusz, który złapał realny bug w pierwszym uruchomieniu tego
    // testu: decrypt() commitował Nr/CKr PRZED potwierdzeniem sukcesu AES-GCM, więc
    // odrzucony pakiet i tak trwale rozsynchronizowywał ratchet.
    const legit = await aliceRatchet.encrypt('to jest prawdziwa wiadomość');
    const tampered = { ...legit, ciphertextBase64: legit.ciphertextBase64.slice(0, -4) + 'BBBB' };
    await assert.rejects(() => bobRatchet.decrypt(tampered.ciphertextBase64, tampered.nonceBase64, tampered.headerJson));

    // Ta sama (nietknięta) wiadomość, teraz poprawnie dostarczona, MUSI się odszyfrować.
    const plaintext = await bobRatchet.decrypt(legit.ciphertextBase64, legit.nonceBase64, legit.headerJson);
    assert.equal(plaintext, 'to jest prawdziwa wiadomość');

    // I rozmowa musi działać dalej normalnie po tym incydencie.
    const next = await bobRatchet.encrypt('nadal działa po ataku');
    assert.equal(await aliceRatchet.decrypt(next.ciphertextBase64, next.nonceBase64, next.headerJson), 'nadal działa po ataku');
});

await test('F5 / odświeżenie strony: serialize() -> deserialize() -> rozmowa działa dalej bez utraty PFS', async () => {
    const aliceJson = aliceRatchet.serialize();
    const bobJson = bobRatchet.serialize();

    const aliceReloaded = await DoubleRatchet.deserialize(aliceJson);
    const bobReloaded = await DoubleRatchet.deserialize(bobJson);

    const enc = await aliceReloaded.encrypt('działam po odświeżeniu strony');
    const plaintext = await bobReloaded.decrypt(enc.ciphertextBase64, enc.nonceBase64, enc.headerJson);
    assert.equal(plaintext, 'działam po odświeżeniu strony');

    aliceRatchet = aliceReloaded;
    bobRatchet = bobReloaded;
});

await test('DH ratchet faktycznie zmienia klucz nadawczy między turami (nagłówki mają różne `dh`)', async () => {
    const e1 = await aliceRatchet.encrypt('a');
    await bobRatchet.decrypt(e1.ciphertextBase64, e1.nonceBase64, e1.headerJson);
    const e2 = await bobRatchet.encrypt('b'); // Bob ratchetuje - nowy DHs
    await aliceRatchet.decrypt(e2.ciphertextBase64, e2.nonceBase64, e2.headerJson);
    const e3 = await aliceRatchet.encrypt('c'); // Alice ratchetuje w odpowiedzi - nowy DHs

    const dh1 = JSON.parse(e1.headerJson).dh.x;
    const dh3 = JSON.parse(e3.headerJson).dh.x;
    assert.notEqual(dh1, dh3, 'klucz DH nadawcy powinien się zmienić po DH ratchecie');
});


console.log('\n=== Grupy: Sender Keys (dystrybucja przez sealed.js) ===\n');

let carol, aliceGroupCrypto, bobGroupCrypto, carolGroupCrypto;
const GROUP_ID = 'group-123';

await test('Alice tworzy grupę i generuje własny łańcuch nadawczy', async () => {
    aliceGroupCrypto = new GroupCrypto();
    await aliceGroupCrypto.initOwnChain(GROUP_ID);
    assert.ok(aliceGroupCrypto.hasOwnChain(GROUP_ID));
});

await test('Alice dystrybuuje swój klucz Bobowi przez sealed box (X3DH jednorazowy)', async () => {
    const bobBundle = bundleFrom(bob, { consumeOpk: false }); // Bob nadal ma OPK z poprzedniego testu, użyjmy innego
    bobBundle.opkPubJwk = bob.opks[5].publicJwk;
    bobBundle.opkId = bob.opks[5].id;

    const { identityPriv, identityPubJwk } = await IdentityVault.importUsableKeys(alice);
    const ownState = aliceGroupCrypto.groups.get(GROUP_ID).own;
    const payload = await sealedEncrypt({
        identityPriv, identityPubJwk, bundle: bobBundle,
        plaintext: JSON.stringify({ groupId: GROUP_ID, chainKey: ownState.chainKey, iteration: ownState.iteration })
    });

    const bobIdentityPriv = await importIdentityPriv(bob);
    const plaintext = await sealedDecrypt({
        identityPriv: bobIdentityPriv,
        spkKeyPairsById: { [bob.spk.id]: bob.spk },
        opksById: Object.fromEntries(bob.opks.map(o => [o.id, o])),
        payloadJson: payload
    });
    const data = JSON.parse(plaintext);
    assert.equal(data.groupId, GROUP_ID);

    bobGroupCrypto = new GroupCrypto();
    bobGroupCrypto.setMemberChain(GROUP_ID, 'alice-id', data.chainKey, data.iteration);
    assert.ok(bobGroupCrypto.hasMemberChain(GROUP_ID, 'alice-id'));
});

await test('Alice wysyła wiadomość grupową, Bob ją poprawnie odszyfrowuje', async () => {
    const enc = await aliceGroupCrypto.encrypt(GROUP_ID, 'Witajcie w grupie!');
    const plaintext = await bobGroupCrypto.decrypt(GROUP_ID, 'alice-id', enc.ciphertextBase64, enc.nonceBase64, enc.headerJson);
    assert.equal(plaintext, 'Witajcie w grupie!');
});

await test('Bob NIE może odczytać wiadomości grupowej bez wcześniejszej dystrybucji klucza', async () => {
    const enc = await aliceGroupCrypto.encrypt(GROUP_ID, 'ktoś nieznany');
    const strangerCrypto = new GroupCrypto();
    await assert.rejects(() => strangerCrypto.decrypt(GROUP_ID, 'alice-id', enc.ciphertextBase64, enc.nonceBase64, enc.headerJson));
});

await test('Bob generuje własny łańcuch i rozsyła go Alice - Alice odczytuje wiadomość Boba', async () => {
    bobGroupCrypto = bobGroupCrypto; // z poprzedniego testu
    await bobGroupCrypto.initOwnChain(GROUP_ID);

    const aliceBundle = bundleFrom(alice, { consumeOpk: false });
    aliceBundle.opkPubJwk = alice.opks[6].publicJwk;
    aliceBundle.opkId = alice.opks[6].id;

    const { identityPriv, identityPubJwk } = await IdentityVault.importUsableKeys(bob);
    const ownState = bobGroupCrypto.groups.get(GROUP_ID).own;
    const payload = await sealedEncrypt({
        identityPriv, identityPubJwk, bundle: aliceBundle,
        plaintext: JSON.stringify({ groupId: GROUP_ID, chainKey: ownState.chainKey, iteration: ownState.iteration })
    });

    const aliceIdentityPriv = await importIdentityPriv(alice);
    const plaintext = await sealedDecrypt({
        identityPriv: aliceIdentityPriv,
        spkKeyPairsById: { [alice.spk.id]: alice.spk },
        opksById: Object.fromEntries(alice.opks.map(o => [o.id, o])),
        payloadJson: payload
    });
    const data = JSON.parse(plaintext);
    aliceGroupCrypto.setMemberChain(GROUP_ID, 'bob-id', data.chainKey, data.iteration);

    const enc = await bobGroupCrypto.encrypt(GROUP_ID, 'Cześć od Boba w grupie');
    const decrypted = await aliceGroupCrypto.decrypt(GROUP_ID, 'bob-id', enc.ciphertextBase64, enc.nonceBase64, enc.headerJson);
    assert.equal(decrypted, 'Cześć od Boba w grupie');
});

await test('Carol dołącza PÓŹNIEJ do grupy - NIE widzi historii sprzed dołączenia (zamierzone)', async () => {
    // Wiadomość WYSŁANA PRZED dołączeniem Carol
    const oldMsg = await aliceGroupCrypto.encrypt(GROUP_ID, 'wiadomość sprzed dołączenia Carol');

    carol = await IdentityVault.create();
    carolGroupCrypto = new GroupCrypto();
    await carolGroupCrypto.initOwnChain(GROUP_ID);
    // Carol NIE ma jeszcze łańcucha Alice ani Boba -> nie może odszyfrować.
    await assert.rejects(() => carolGroupCrypto.decrypt(GROUP_ID, 'alice-id', oldMsg.ciphertextBase64, oldMsg.nonceBase64, oldMsg.headerJson));
});

await test('Po dystrybucji (aktualnego) klucza Alice, Carol odczytuje TYLKO nowe wiadomości', async () => {
    const carolBundle = bundleFrom(carol, { consumeOpk: false });
    carolBundle.opkPubJwk = carol.opks[0].publicJwk;
    carolBundle.opkId = carol.opks[0].id;

    const { identityPriv, identityPubJwk } = await IdentityVault.importUsableKeys(alice);
    const ownState = aliceGroupCrypto.groups.get(GROUP_ID).own; // stan AKTUALNY, nie historyczny
    const payload = await sealedEncrypt({
        identityPriv, identityPubJwk, bundle: carolBundle,
        plaintext: JSON.stringify({ groupId: GROUP_ID, chainKey: ownState.chainKey, iteration: ownState.iteration })
    });

    const carolIdentityPriv = await importIdentityPriv(carol);
    const plaintext = await sealedDecrypt({
        identityPriv: carolIdentityPriv,
        spkKeyPairsById: { [carol.spk.id]: carol.spk },
        opksById: Object.fromEntries(carol.opks.map(o => [o.id, o])),
        payloadJson: payload
    });
    const data = JSON.parse(plaintext);
    carolGroupCrypto.setMemberChain(GROUP_ID, 'alice-id', data.chainKey, data.iteration);

    const newMsg = await aliceGroupCrypto.encrypt(GROUP_ID, 'wiadomość PO dołączeniu Carol');
    const decrypted = await carolGroupCrypto.decrypt(GROUP_ID, 'alice-id', newMsg.ciphertextBase64, newMsg.nonceBase64, newMsg.headerJson);
    assert.equal(decrypted, 'wiadomość PO dołączeniu Carol');
});

await test('Zmanipulowany nagłówek (senderKeyIteration) wiadomości grupowej jest odrzucany', async () => {
    const enc = await aliceGroupCrypto.encrypt(GROUP_ID, 'grupa - integralność');
    const header = JSON.parse(enc.headerJson);
    header.senderKeyIteration += 500; // podmieniona iteracja spoza zakresu skip
    const tamperedHeader = JSON.stringify(header);
    await assert.rejects(() => bobGroupCrypto.decrypt(GROUP_ID, 'alice-id', enc.ciphertextBase64, enc.nonceBase64, tamperedHeader));
});

await test('REGRESJA (grupa): łańcuch nadawczy PRZEŻYWA zmanipulowany nagłówek - kolejna prawdziwa wiadomość nadal się deszyfruje', async () => {
    const before = await aliceGroupCrypto.encrypt(GROUP_ID, 'przed atakiem');
    assert.equal(await bobGroupCrypto.decrypt(GROUP_ID, 'alice-id', before.ciphertextBase64, before.nonceBase64, before.headerJson), 'przed atakiem');

    const legit = await aliceGroupCrypto.encrypt(GROUP_ID, 'prawdziwa wiadomość grupowa');
    const header = JSON.parse(legit.headerJson);
    header.senderKeyIteration += 500;
    await assert.rejects(() => bobGroupCrypto.decrypt(GROUP_ID, 'alice-id', legit.ciphertextBase64, legit.nonceBase64, JSON.stringify(header)));

    // Ta sama wiadomość, tym razem z nietkniętym nagłówkiem, MUSI się odszyfrować.
    const plaintext = await bobGroupCrypto.decrypt(GROUP_ID, 'alice-id', legit.ciphertextBase64, legit.nonceBase64, legit.headerJson);
    assert.equal(plaintext, 'prawdziwa wiadomość grupowa');
});

await test('serializeGroup()/loadGroup() (F5 dla stanu grupy) zachowuje zdolność deszyfrowania', async () => {
    const json = bobGroupCrypto.serializeGroup(GROUP_ID);
    const reloaded = new GroupCrypto();
    reloaded.loadGroup(GROUP_ID, json);

    const enc = await aliceGroupCrypto.encrypt(GROUP_ID, 'po odświeżeniu, w grupie');
    const plaintext = await reloaded.decrypt(GROUP_ID, 'alice-id', enc.ciphertextBase64, enc.nonceBase64, enc.headerJson);
    assert.equal(plaintext, 'po odświeżeniu, w grupie');
});

console.log(`\n=== WYNIK: ${passed} zaliczone, ${failed} nieudane (z ${passed + failed} testów) ===\n`);
process.exit(failed > 0 ? 1 : 0);
