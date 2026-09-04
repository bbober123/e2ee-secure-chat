/**
 * casino/case-data.js — broń i definicje skrzynek jako dane z Supabase
 * (tabele casino_weapons / casino_case_defs), zamiast na sztywno w kodzie.
 * Pilnowanie kto może pisać (tylko admin) leży w RLS w database.sql -
 * ten plik tylko woła zwykłe operacje na tabelach.
 */
import { supabase } from '../supabase.js';
import { WEAPON_ICON, RARITIES } from './weapon-icons.js';

const FINISHES = [
    'Smoczy Ogień', 'Krwawy Kamuflaż', 'Neonowa Rewolucja', 'Cień Pustyni', 'Ultrafiolet',
    'Marmurkowy Splot', 'Elektryczny Puls', 'Złota Rypsówka', 'Stalowy Brzask', 'Szmaragdowy Wir',
    'Rdzawy Pył', 'Arktyczny Kamuflaż', 'Fioletowa Mgła', 'Piaskowa Burza', 'Krwista Otchłań',
    'Lodowy Odłam', 'Miedziany Rozbłysk', 'Nocny Łowca', 'Toksyczny Wyciek', 'Perłowy Połysk'
];

// Relatywne mnożniki wartości między rzadkościami (im rzadsza tym więcej) -
// stałe niezależnie od skrzynki. Rzeczywista wartość bazowa skaluje się
// z ceną skrzynki, żeby droższe skrzynki miały proporcjonalnie lepsze
// nagrody, a nie identyczne jak tańsze.
const VALUE_MULTIPLIER = { 'mil-spec': 1, restricted: 2.67, classified: 8, covert: 26.7, 'rare-gold': 133.3 };

function baseUnitForPrice(price) {
    return price * 0.425;
}

/** Zwraca ikonę przedmiotu: własny obrazek admina > wbudowana ikona SVG > emoji fallback. */
export function iconForWeapon(weapon) {
    if (weapon.icon_data) return `<img src="${weapon.icon_data}" alt="" />`;
    return WEAPON_ICON[weapon.name] || '🔫';
}

function buildPool(price, seedOffset, weaponsByRarity) {
    const baseUnit = baseUnitForPrice(price);
    const pool = [];
    let i = seedOffset;
    for (const rarity of RARITIES) {
        const weapons = weaponsByRarity[rarity.id] || [];
        if (!weapons.length) continue; // admin usunął całą rzadkość - po prostu pomiń (rzadsze wypadanie tej rzadkości w tej skrzynce)
        const count = rarity.id === 'rare-gold' ? Math.min(4, weapons.length * 2) : Math.min(7, weapons.length * 3);
        for (let n = 0; n < count; n++) {
            const weapon = weapons[(i * 7 + n) % weapons.length];
            const finish = FINISHES[(i * 3 + n * 2) % FINISHES.length];
            pool.push({
                name: `${weapon.name} | ${finish}`,
                weaponKey: weapon.name,
                rarity,
                icon: iconForWeapon(weapon),
                value: Math.max(1, Math.round(baseUnit * VALUE_MULTIPLIER[rarity.id] * (0.85 + 0.3 * ((n + 1) / count))))
            });
            i++;
        }
    }
    return pool;
}

export const CaseCatalog = {
    weapons: [],
    cases: [],

    /** Wczytuje aktywną broń i skrzynki z bazy i buduje pule przedmiotów dla każdej skrzynki. */
    async load() {
        const [{ data: weapons, error: wErr }, { data: cases, error: cErr }] = await Promise.all([
            supabase.from('casino_weapons').select('*').eq('active', true),
            supabase.from('casino_case_defs').select('*').eq('active', true).order('sort_order', { ascending: true })
        ]);
        if (wErr) console.error(wErr);
        if (cErr) console.error(cErr);

        this.weapons = weapons || [];
        const weaponsByRarity = {};
        for (const w of this.weapons) {
            (weaponsByRarity[w.rarity_id] ??= []).push(w);
        }

        this.cases = (cases || []).map(c => ({
            ...c,
            pool: buildPool(Number(c.price), c.seed || 0, weaponsByRarity)
        }));
        return this.cases;
    }
};

// --- Operacje admina (RLS w bazie i tak pilnuje, że tylko admin może zapisać) ---

export const CaseAdmin = {
    async listAllWeapons() {
        const { data, error } = await supabase.from('casino_weapons').select('*').order('rarity_id').order('name');
        if (error) throw error;
        return data;
    },

    async listAllCases() {
        const { data, error } = await supabase.from('casino_case_defs').select('*').order('sort_order');
        if (error) throw error;
        return data;
    },

    async addWeapon({ name, rarityId, iconData }) {
        const { error } = await supabase.from('casino_weapons').insert({
            name: name.trim(), rarity_id: rarityId, icon_data: iconData || null
        });
        if (error) throw error;
    },

    async setWeaponActive(id, active) {
        const { error } = await supabase.from('casino_weapons').update({ active }).eq('id', id);
        if (error) throw error;
    },

    async deleteWeapon(id) {
        const { error } = await supabase.from('casino_weapons').delete().eq('id', id);
        if (error) throw error;
    },

    async addCase({ slug, title, price, seed = 0, sortOrder = 0 }) {
        const { error } = await supabase.from('casino_case_defs').insert({
            slug: slug.trim(), title: title.trim(), price, seed, sort_order: sortOrder
        });
        if (error) throw error;
    },

    async setCaseActive(id, active) {
        const { error } = await supabase.from('casino_case_defs').update({ active }).eq('id', id);
        if (error) throw error;
    },

    async deleteCase(id) {
        const { error } = await supabase.from('casino_case_defs').delete().eq('id', id);
        if (error) throw error;
    }
};

export { RARITIES };
