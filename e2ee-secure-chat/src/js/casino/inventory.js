/**
 * casino/inventory.js — ekwipunek przedmiotów zachowanych ze skrzynek
 * (zamiast od razu "sprzedanych" za żetony). Limit 30 sztuk pilnowany
 * atomowo w RPC po stronie bazy (casino_keep_item) - nie tylko w UI.
 */
import { supabase } from '../supabase.js';
import { AppState } from '../state.js';

export const MAX_INVENTORY = 30;

export const Inventory = {
    items: [],

    async load() {
        const userId = AppState.getUser().id;
        const { data, error } = await supabase.from('casino_inventory')
            .select('*').eq('user_id', userId).order('obtained_at', { ascending: false });
        if (error) { console.error(error); this.items = []; return this.items; }
        this.items = data;
        return this.items;
    },

    get count() { return this.items.length; },
    get isFull() { return this.items.length >= MAX_INVENTORY; },

    /** Dodaje przedmiot do ekwipunku. Zwraca {ok:true} albo {ok:false, reason:'full'|'error'}. */
    async keep({ name, weaponKey, rarityId, value, caseTitle, iconSnapshot }) {
        const { data, error } = await supabase.rpc('casino_keep_item', {
            p_item_name: name, p_weapon_key: weaponKey, p_rarity_id: rarityId,
            p_value: value, p_case_title: caseTitle, p_icon_snapshot: iconSnapshot || null
        });
        if (error) {
            if (error.message?.includes('inventory full')) return { ok: false, reason: 'full' };
            console.error(error);
            return { ok: false, reason: 'error' };
        }
        await this.load();
        return { ok: true, id: data };
    },

    /** Sprzedaje przedmiot z powrotem za żetony. Zwraca nowe saldo albo null przy błędzie. */
    async sell(itemId) {
        const { data, error } = await supabase.rpc('casino_sell_item', { p_item_id: itemId });
        if (error) { console.error(error); return null; }
        this.items = this.items.filter(i => i.id !== itemId);
        return Number(data);
    }
};
