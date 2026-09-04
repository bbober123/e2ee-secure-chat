/**
 * casino/exchange-data.js — warstwa danych dla gry "Giełda": ceny rynkowe
 * (CoinGecko, publiczne API bez klucza) + portfel krypto i historia
 * transakcji trzymane w Supabase (nie w localStorage — dzięki temu portfel
 * jest ten sam na każdym urządzeniu, tak jak reszta konta). Handel idzie
 * przez jedną atomową funkcję RPC (`casino_crypto_trade`), tym samym
 * mechanizmem co żetony w innych grach kazyna (patrz wallet.js) — więc
 * dwa szybkie kliknięcia "Kup" nie mogą wydać więcej żetonów niż jest na
 * koncie.
 */
import { supabase } from '../supabase.js';
import { AppState } from '../state.js';
import { Wallet } from './wallet.js';

const API_BASE = 'https://api.coingecko.com/api/v3';
const MARKET_CACHE_MS = 30000;

// Lista używana, gdy CoinGecko jest niedostępny (offline / zablokowany /
// limit zapytań) - żeby gra dalej działała, tylko z cenami które powoli
// "dryfują" losowo zamiast być prawdziwe.
const FALLBACK_COINS = [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 45000, price_change_percentage_24h: 2.1, market_cap: 880000000000, total_volume: 26000000000, image: null },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 3000, price_change_percentage_24h: -1.4, market_cap: 360000000000, total_volume: 14000000000, image: null },
    { id: 'binancecoin', symbol: 'bnb', name: 'BNB', current_price: 380, price_change_percentage_24h: 0.6, market_cap: 58000000000, total_volume: 1200000000, image: null },
    { id: 'solana', symbol: 'sol', name: 'Solana', current_price: 98, price_change_percentage_24h: 5.4, market_cap: 42000000000, total_volume: 2000000000, image: null },
    { id: 'ripple', symbol: 'xrp', name: 'XRP', current_price: 0.62, price_change_percentage_24h: -0.8, market_cap: 34000000000, total_volume: 900000000, image: null },
    { id: 'cardano', symbol: 'ada', name: 'Cardano', current_price: 0.55, price_change_percentage_24h: -0.3, market_cap: 19000000000, total_volume: 400000000, image: null },
    { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', current_price: 0.12, price_change_percentage_24h: 3.2, market_cap: 17000000000, total_volume: 700000000, image: null },
    { id: 'tron', symbol: 'trx', name: 'TRON', current_price: 0.11, price_change_percentage_24h: 0.4, market_cap: 9800000000, total_volume: 300000000, image: null }
];

function jitter(coins) {
    return coins.map(c => ({
        ...c,
        current_price: Math.max(0.0001, c.current_price * (1 + (Math.random() - 0.5) * 0.01)),
        price_change_percentage_24h: c.price_change_percentage_24h + (Math.random() - 0.5) * 0.3
    }));
}

export const MarketData = {
    _cache: null,
    _cacheAt: 0,
    _usingFallback: false,

    async getMarkets(force = false) {
        if (!force && this._cache && Date.now() - this._cacheAt < MARKET_CACHE_MS) {
            return this._cache;
        }
        try {
            const res = await fetch(`${API_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=true&price_change_percentage=24h`);
            if (!res.ok) throw new Error('bad status ' + res.status);
            const data = await res.json();
            if (!Array.isArray(data) || data.length === 0) throw new Error('empty response');
            this._cache = data;
            this._cacheAt = Date.now();
            this._usingFallback = false;
            return data;
        } catch (e) {
            this._usingFallback = true;
            this._cache = jitter(this._cache && this._cache.length ? this._cache : FALLBACK_COINS);
            this._cacheAt = Date.now();
            return this._cache;
        }
    },

    isUsingFallback() {
        return this._usingFallback;
    },

    async getChartData(coinId, days = 1) {
        try {
            const res = await fetch(`${API_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);
            if (!res.ok) throw new Error('bad status ' + res.status);
            const data = await res.json();
            if (!Array.isArray(data.prices) || data.prices.length < 2) throw new Error('no price series');
            return data.prices;
        } catch (e) {
            return this._fakeChart(coinId, days);
        }
    },

    _fakeChart(coinId, days) {
        const points = days === 1 ? 24 : days === 7 ? 28 : 30;
        const coin = (this._cache || FALLBACK_COINS).find(c => c.id === coinId);
        let price = coin?.current_price || 100;
        const now = Date.now();
        const out = [];
        for (let i = 0; i < points; i++) {
            price = Math.max(0.0001, price * (1 + (Math.random() - 0.5) * 0.02));
            out.push([now - (points - i) * (days * 86400000 / points), price]);
        }
        return out;
    }
};

export const Portfolio = {
    holdings: {}, // coin_id -> { coin_id, symbol, name, amount, cost_basis }
    trades: [],

    async load() {
        const userId = AppState.getUser().id;
        const [{ data: holdingsRows }, { data: tradeRows }] = await Promise.all([
            supabase.from('casino_crypto_holdings').select('*').eq('user_id', userId),
            supabase.from('casino_crypto_trades').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50)
        ]);
        this.holdings = {};
        (holdingsRows || []).forEach(row => { this.holdings[row.coin_id] = row; });
        this.trades = tradeRows || [];
    },

    getAmount(coinId) {
        return Number(this.holdings[coinId]?.amount || 0);
    },

    getCostBasis(coinId) {
        return Number(this.holdings[coinId]?.cost_basis || 0);
    },

    totalValue(coinsById) {
        return Object.values(this.holdings).reduce((sum, h) => {
            const price = coinsById[h.coin_id]?.current_price || 0;
            return sum + Number(h.amount) * price;
        }, 0);
    },

    /**
     * Wykonuje transakcję atomowo po stronie bazy (RPC) — zwraca
     * { ok: true } albo { ok: false, error } zamiast rzucać, żeby UI mógł
     * po prostu pokazać komunikat.
     */
    async trade(side, coin, amount) {
        const { data, error } = await supabase.rpc('casino_crypto_trade', {
            p_side: side,
            p_coin_id: coin.id,
            p_symbol: coin.symbol,
            p_name: coin.name,
            p_amount: amount,
            p_price: coin.current_price
        });
        if (error) {
            const msg = error.message?.includes('insufficient chips') ? 'Za mało żetonów.'
                : error.message?.includes('insufficient holdings') ? 'Nie posiadasz tyle tej kryptowaluty.'
                : 'Nie udało się wykonać transakcji.';
            return { ok: false, error: msg };
        }
        Wallet.balance = Number(data.new_chips);
        const newAmount = Number(data.new_amount);
        if (newAmount <= 0) {
            delete this.holdings[coin.id];
        } else {
            this.holdings[coin.id] = {
                ...(this.holdings[coin.id] || {}),
                coin_id: coin.id, symbol: coin.symbol, name: coin.name,
                amount: newAmount
            };
        }
        await this.load(); // odśwież cost_basis/historię z serwera (RPC jest źródłem prawdy)
        return { ok: true, newChips: Wallet.balance, newAmount };
    }
};
