// Stub used only to satisfy static imports in prekeys.js/groupkeys.js during
// standalone crypto testing. The test below never actually calls anything on
// this object - it exercises DoubleRatchet, GroupCrypto, sealedEncrypt/Decrypt
// and IdentityVault directly, which is exactly the code that touches real
// crypto. If the test somehow DID call into this stub, throwing loudly is
// better than silently pretending a network round-trip succeeded.
function unexpectedCall(prop) {
    throw new Error(`[test stub] unexpected supabase.${String(prop)}() call - this test should never touch the network layer`);
}
export const supabase = new Proxy({}, {
    get(_target, prop) {
        return (..._args) => unexpectedCall(prop);
    }
});
