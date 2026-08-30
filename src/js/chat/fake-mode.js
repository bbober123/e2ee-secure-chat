/**
 * chat/fake-mode.js — ciche zaseedowanie przykładowych wiadomości w trybie 'fake'
 * (plausible deniability), żeby pusta rozmowa nie wyglądała podejrzanie.
 */
import { supabase } from '../supabase.js';
import { keyManager } from '../auth.js';
import { AppState } from '../state.js';
import { cachePlaintext } from '../plaintext-cache.js';

export const FakeModeMixin = {
    async ensureFakeMessages(convId, contactId) {
        const { data } = await supabase.from('messages').select('id').eq('conversation_id', convId).eq('mode', 'fake').limit(1);
        if (data && data.length === 0) {
            const fakeMsgs = ["Bezpieczna sesja nawiązana.", "Historia została wyczyszczona."];

            const ratchet = await this.prepareOutgoingRatchet(convId, contactId);
            if (!ratchet) return; // brak kluczy X3DH kontaktu w trybie fake - pomiń ciche seedowanie

            for (const text of fakeMsgs) {
                const enc = await this.encryptOutgoing(ratchet, text);
                const { data: inserted } = await supabase.from('messages').insert({
                    conversation_id: convId,
                    sender_id: AppState.getUser().id,
                    ciphertext: enc.ciphertextBase64,
                    nonce: enc.nonceBase64,
                    header: enc.headerJson,
                    mode: 'fake',
                    status: 'delivered',
                    type: 'text'
                }).select().single();

                if (inserted) {
                    await cachePlaintext(AppState.getUser().id, 'fake', inserted.id, text, keyManager.passwordKey);
                }
            }
            await this.persistRatchet(convId, ratchet);
            this.loadMessages(convId);
        }
    },
};
