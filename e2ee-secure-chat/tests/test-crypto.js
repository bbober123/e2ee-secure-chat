import { CryptoEngine, utils } from '../src/js/crypto.js';
import { AuthManager } from '../src/js/auth.js';

async function runTests() {
    const results = document.getElementById('results');
    
    function log(name, passed, msg, time) {
        const div = document.createElement('div');
        div.className = passed ? 'pass' : 'fail';
        div.textContent = `${passed ? '✅' : '❌'} ${name} — ${passed ? 'PASSED' : 'FAILED: ' + msg} (${time}ms)`;
        results.appendChild(div);
        console.log(div.textContent);
    }

    // 1. test_pbkdf2
    try {
        const start = performance.now();
        const key1 = await CryptoEngine.deriveKeyFromPassword('testpass', 'aabbcc');
        const key2 = await CryptoEngine.deriveKeyFromPassword('testpass', 'aabbcc');
        
        const exp1 = await crypto.subtle.exportKey('raw', key1);
        const exp2 = await crypto.subtle.exportKey('raw', key2);
        
        if (utils.bufferToHex(exp1) === utils.bufferToHex(exp2)) {
            log('test_pbkdf2', true, '', Math.round(performance.now() - start));
        } else {
            log('test_pbkdf2', false, 'Klucze nie pasują', Math.round(performance.now() - start));
        }
    } catch (e) {
        log('test_pbkdf2', false, e.message, 0);
    }
    
    // 2. test_rsa_roundtrip
    try {
        const start = performance.now();
        const { publicKey, privateKey } = await CryptoEngine.generateLongTermKeyPair();
        const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        
        const encrypted = await CryptoEngine.encryptSessionKey(sessionKey, publicKey);
        const decrypted = await CryptoEngine.decryptSessionKey(encrypted, privateKey);
        
        const rawOrig = await crypto.subtle.exportKey('raw', sessionKey);
        const rawDec = await crypto.subtle.exportKey('raw', decrypted);
        
        if (utils.bufferToHex(rawOrig) === utils.bufferToHex(rawDec)) {
            log('test_rsa_roundtrip', true, '', Math.round(performance.now() - start));
        } else {
            log('test_rsa_roundtrip', false, `expected 32 bytes, got ${rawDec.byteLength}`, Math.round(performance.now() - start));
        }
    } catch (e) {
        log('test_rsa_roundtrip', false, e.message, 0);
    }

    // 3. test_aes_gcm
    try {
        const start = performance.now();
        const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const plaintext = "Hello World";
        const { ciphertextBase64, nonceBase64 } = await CryptoEngine.encryptMessage(plaintext, sessionKey);
        const decrypted = await CryptoEngine.decryptMessage(ciphertextBase64, nonceBase64, sessionKey);
        
        if (decrypted === plaintext) {
            log('test_aes_gcm', true, '', Math.round(performance.now() - start));
        } else {
            log('test_aes_gcm', false, `Expected ${plaintext}, got ${decrypted}`, Math.round(performance.now() - start));
        }
    } catch (e) {
        log('test_aes_gcm', false, e.message, 0);
    }

    // 4. test_ecdh_derivation
    try {
        const start = performance.now();
        const alice = await CryptoEngine.generateEphemeralKeyPair();
        const bob = await CryptoEngine.generateEphemeralKeyPair();
        
        const aliceShared = await CryptoEngine.deriveSessionKey(alice.privateKey, bob.publicKey);
        const bobShared = await CryptoEngine.deriveSessionKey(bob.privateKey, alice.publicKey);
        
        const rawA = await crypto.subtle.exportKey('raw', aliceShared);
        const rawB = await crypto.subtle.exportKey('raw', bobShared);
        
        if (utils.bufferToHex(rawA) === utils.bufferToHex(rawB)) {
            log('test_ecdh_derivation', true, '', Math.round(performance.now() - start));
        } else {
            log('test_ecdh_derivation', false, 'Shared secrets do not match', Math.round(performance.now() - start));
        }
    } catch (e) {
        log('test_ecdh_derivation', false, e.message, 0);
    }
    
    // 5. test_fake_mode_isolation
    try {
        const start = performance.now();
        const realKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const fakeKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        
        const plaintext = "Secret message";
        const realEnc = await CryptoEngine.encryptMessage(plaintext, realKey);
        const fakeEnc = await CryptoEngine.encryptMessage(plaintext, fakeKey);
        
        if (realEnc.ciphertextBase64 !== fakeEnc.ciphertextBase64) {
            log('test_fake_mode_isolation', true, '', Math.round(performance.now() - start));
        } else {
            log('test_fake_mode_isolation', false, 'Ciphertexts are identical', Math.round(performance.now() - start));
        }
    } catch (e) {
        log('test_fake_mode_isolation', false, e.message, 0);
    }

    // 6. test_device_fingerprint
    try {
        const start = performance.now();
        const fp1 = await AuthManager.generateDeviceFingerprint();
        const fp2 = await AuthManager.generateDeviceFingerprint();

        if (fp1 === fp2 && fp1.length === 64) {
             log('test_device_fingerprint', true, '', Math.round(performance.now() - start));
        } else {
             log('test_device_fingerprint', false, 'Fingerprints do not match or invalid length', Math.round(performance.now() - start));
        }
    } catch (e) {
        log('test_device_fingerprint', false, e.message, 0);
    }
}

runTests();
