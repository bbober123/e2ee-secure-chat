import { supabase } from '../supabase.js';
import { AppState } from '../state.js';

const DAILY_BONUS_CHIPS = 500;
const DAILY_BONUS_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20h (trochę luzu, nie sztywne 24h)

export const Wallet = {
    balance: 0,
    lastBonusAt: null,

    async load() {
        const userId = AppState.getUser().id;
        let { data, error } = await supabase.from('casino_balances').select('*').eq('user_id', userId).maybeSingle();

        if (!data) {
            const { data: created, error: insertErr } = await supabase.from('casino_balances')
                .insert({ user_id: userId, chips: 1000 })
                .select().single();
            if (insertErr) { console.error(insertErr); this.balance = 0; return this.balance; }
            data = created;
        }

        this.balance = Number(data.chips);
        this.lastBonusAt = data.last_daily_bonus_at ? new Date(data.last_daily_bonus_at) : null;
        return this.balance;
    },

    canClaimDailyBonus() {
        if (!this.lastBonusAt) return true;
        return (Date.now() - this.lastBonusAt.getTime()) > DAILY_BONUS_COOLDOWN_MS;
    },

    async claimDailyBonus() {
        if (!this.canClaimDailyBonus()) return null;
        const { data, error } = await supabase.rpc('casino_adjust_chips', { delta: DAILY_BONUS_CHIPS, claim_bonus: true });
        if (error) { console.error(error); return null; }
        this.balance = Number(data);
        this.lastBonusAt = new Date();
        return DAILY_BONUS_CHIPS;
    },

    /** Zwraca `true` i odejmuje żetony jeśli starczyło salda; `false` (bez zmian) jeśli nie starczyło - operacja atomowa (RPC), bezpieczna nawet przy kilku otwartych kartach. */
    async spend(amount) {
        if (amount <= 0) return true;
        const { data, error } = await supabase.rpc('casino_adjust_chips', { delta: -amount, claim_bonus: false });
        if (error) {
            if (error.message?.includes('insufficient')) return false;
            console.error(error);
            return false;
        }
        this.balance = Number(data);
        return true;
    },

    async win(amount) {
        if (amount <= 0) return this.balance;
        const { data, error } = await supabase.rpc('casino_adjust_chips', { delta: amount, claim_bonus: false });
        if (error) { console.error(error); return this.balance; }
        this.balance = Number(data);
        return this.balance;
    }
};
