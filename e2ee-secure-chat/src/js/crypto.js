/**
 * crypto.js — punkt wejścia dla warstwy kryptograficznej.
 *
 * Ten plik był kiedyś jednym dużym plikiem (~670 linii). Żeby było łatwiej
 * się w nim odnaleźć, kod podzielono na mniejsze moduły w folderze `crypto/`:
 *
 *   crypto/utils.js         — Hex/Base64, stałoczasowe porównanie, losowe bajty
 *   crypto/engine.js        — CryptoEngine (AES-GCM, RSA-OAEP, X3DH/Double Ratchet)
 *   crypto/key-manager.js   — KeyManager (klucze wyłącznie w RAM)
 *   crypto/double-vault.js  — DoubleVault (tworzenie użytkownika, plausible deniability)
 *   crypto/trust-store.js   — KeyTrustStore (TOFU pinning / wykrywanie zmiany klucza)
 *
 * Ten plik re-eksportuje wszystko z powrotem, więc reszta aplikacji (i testy)
 * dalej robi `import { CryptoEngine } from './crypto.js'` bez żadnych zmian.
 */
export { utils } from './crypto/utils.js';
export { CryptoEngine } from './crypto/engine.js';
export { KeyManager } from './crypto/key-manager.js';
export { DoubleVault } from './crypto/double-vault.js';
export { KeyTrustStore } from './crypto/trust-store.js';
