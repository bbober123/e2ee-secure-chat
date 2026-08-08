export const TEST_VECTORS = {
  pbkdf2: {
    password: 'password123',
    salt: 'aabbccdd00112233',
    iterations: 600000,
    expectedKeyHex: '... (wartość wygenerowana wg standardów dla SHA-256)'
  },
  aesGcm: {
    keyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    ivHex: '000000000000000000000000',
    plaintext: 'Hello SecureChat',
    expectedCiphertextHex: '... (ciphertext wygenerowany kontrolnie)'
  }
};
