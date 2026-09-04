/**
 * casino/admin-panel.js — Panel Admina: zarządzanie bronią (dodawanie z
 * własnym obrazkiem, usuwanie, włączanie/wyłączanie) i skrzynkami
 * (dodawanie nowych, edycja aktywności/ceny, usuwanie). RLS w bazie i tak
 * pilnuje, że zapis przejdzie tylko dla konta z is_admin=true - to UI jest
 * tylko wygodą, nie jedyną linią obrony.
 */
import { CaseAdmin, RARITIES, iconForWeapon } from './case-data.js';

const MAX_IMAGE_BYTES = 200 * 1024; // ~200KB po zdekodowaniu - obrazek trafia jako base64 do kolumny TEXT w bazie

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function slugify(text) {
    return text.toLowerCase()
        .replace(/[ąćęłńóśźż]/g, c => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c]))
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        || `case-${Date.now()}`;
}

export class AdminPanel {
    constructor(container) {
        this.el = container;
        this.loading = true;
        this.tab = 'weapons'; // 'weapons' | 'cases'
        this.weapons = [];
        this.cases = [];
        this.pendingIconData = null;
        this.error = null;
    }

    stop() {}

    async start() {
        this.loading = true;
        this.render();
        await this._reload();
        this.loading = false;
        this.render();
    }

    async _reload() {
        try {
            const [weapons, cases] = await Promise.all([CaseAdmin.listAllWeapons(), CaseAdmin.listAllCases()]);
            this.weapons = weapons;
            this.cases = cases;
        } catch (e) {
            console.error(e);
            this.error = 'Nie udało się wczytać danych (czy na pewno masz uprawnienia admina?).';
        }
    }

    setTab(tab) {
        this.tab = tab;
        this.pendingIconData = null;
        this.render();
    }

    async handleIconFile(file) {
        if (!file) { this.pendingIconData = null; return; }
        if (file.size > MAX_IMAGE_BYTES) {
            const { UI } = await import('../ui.js');
            UI.showToast(`Obrazek za duży (max ${Math.round(MAX_IMAGE_BYTES / 1024)}KB) - użyj mniejszej ikony.`, 'error');
            this.pendingIconData = null;
            this.render();
            return;
        }
        this.pendingIconData = await fileToDataUrl(file);
        this.render(); // pokaż podgląd
    }

    async addWeapon() {
        const name = this.el.querySelector('#admin-weapon-name')?.value.trim();
        const rarityId = this.el.querySelector('#admin-weapon-rarity')?.value;
        if (!name) return;
        try {
            await CaseAdmin.addWeapon({ name, rarityId, iconData: this.pendingIconData });
            this.pendingIconData = null;
            await this._reload();
            this.render();
        } catch (e) {
            console.error(e);
            const { UI } = await import('../ui.js');
            UI.showToast(e.message?.includes('duplicate') ? 'Broń o tej nazwie już istnieje.' : 'Nie udało się dodać broni.', 'error');
        }
    }

    async toggleWeapon(id, active) {
        await CaseAdmin.setWeaponActive(id, active);
        await this._reload();
        this.render();
    }

    async removeWeapon(id) {
        if (!confirm('Usunąć tę broń na stałe? (Skrzynki, które ją zawierały, po prostu przestaną jej losować.)')) return;
        await CaseAdmin.deleteWeapon(id);
        await this._reload();
        this.render();
    }

    async addCase() {
        const title = this.el.querySelector('#admin-case-title')?.value.trim();
        const price = Number(this.el.querySelector('#admin-case-price')?.value);
        if (!title || !price || price <= 0) return;
        try {
            await CaseAdmin.addCase({
                slug: slugify(title), title, price,
                seed: Math.floor(Math.random() * 1000),
                sortOrder: this.cases.length + 1
            });
            await this._reload();
            this.render();
        } catch (e) {
            console.error(e);
            const { UI } = await import('../ui.js');
            UI.showToast('Nie udało się dodać skrzynki.', 'error');
        }
    }

    async toggleCase(id, active) {
        await CaseAdmin.setCaseActive(id, active);
        await this._reload();
        this.render();
    }

    async removeCase(id) {
        if (!confirm('Usunąć tę skrzynkę na stałe?')) return;
        await CaseAdmin.deleteCase(id);
        await this._reload();
        this.render();
    }

    render() {
        if (this.loading) {
            this.el.innerHTML = `<div class="admin-panel"><div class="inventory-empty">Wczytywanie…</div></div>`;
            return;
        }
        if (this.error) {
            this.el.innerHTML = `<div class="admin-panel"><div class="case-result-error">${this.error}</div></div>`;
            return;
        }

        this.el.innerHTML = `
            <div class="admin-panel">
                <div class="admin-tabs">
                    <button class="admin-tab-btn ${this.tab === 'weapons' ? 'active' : ''}" data-tab="weapons">Broń (${this.weapons.length})</button>
                    <button class="admin-tab-btn ${this.tab === 'cases' ? 'active' : ''}" data-tab="cases">Skrzynki (${this.cases.length})</button>
                </div>
                ${this.tab === 'weapons' ? this._weaponsTabHtml() : this._casesTabHtml()}
            </div>`;

        this.el.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => this.setTab(btn.dataset.tab));
        });

        if (this.tab === 'weapons') {
            this.el.querySelector('#admin-weapon-icon')?.addEventListener('change', (e) => this.handleIconFile(e.target.files[0]));
            this.el.querySelector('#admin-add-weapon-btn')?.addEventListener('click', () => this.addWeapon());
            this.el.querySelectorAll('[data-toggle-weapon]').forEach(btn => {
                btn.addEventListener('click', () => this.toggleWeapon(btn.dataset.toggleWeapon, btn.dataset.next === 'true'));
            });
            this.el.querySelectorAll('[data-remove-weapon]').forEach(btn => {
                btn.addEventListener('click', () => this.removeWeapon(btn.dataset.removeWeapon));
            });
        } else {
            this.el.querySelector('#admin-add-case-btn')?.addEventListener('click', () => this.addCase());
            this.el.querySelectorAll('[data-toggle-case]').forEach(btn => {
                btn.addEventListener('click', () => this.toggleCase(btn.dataset.toggleCase, btn.dataset.next === 'true'));
            });
            this.el.querySelectorAll('[data-remove-case]').forEach(btn => {
                btn.addEventListener('click', () => this.removeCase(btn.dataset.removeCase));
            });
        }
    }

    _weaponsTabHtml() {
        return `
            <div class="admin-add-form">
                <h4>Dodaj broń</h4>
                <input type="text" id="admin-weapon-name" placeholder="Nazwa (np. AK-47)" maxlength="60">
                <select id="admin-weapon-rarity">
                    ${RARITIES.map(r => `<option value="${r.id}">${r.label} (${r.weight}% szansy)</option>`).join('')}
                </select>
                <label class="admin-file-label">
                    ${this.pendingIconData ? `<img src="${this.pendingIconData}" class="admin-icon-preview" alt="">` : '🖼️ Wybierz obrazek (opcjonalnie, max 200KB)'}
                    <input type="file" id="admin-weapon-icon" accept="image/*" hidden>
                </label>
                <button class="btn-primary" id="admin-add-weapon-btn">Dodaj broń</button>
            </div>
            <div class="admin-list">
                ${RARITIES.map(r => {
                    const items = this.weapons.filter(w => w.rarity_id === r.id);
                    if (!items.length) return '';
                    return `
                        <div class="admin-list-group">
                            <div class="admin-list-group-title" style="color:${r.color}">${r.label} — ${r.weight}% szansy</div>
                            ${items.map(w => `
                                <div class="admin-list-item ${w.active ? '' : 'admin-list-item-inactive'}">
                                    <span class="admin-list-item-icon">${iconForWeapon(w)}</span>
                                    <span class="admin-list-item-name">${w.name}</span>
                                    <span class="admin-list-item-actions">
                                        <button class="btn-cancel" data-toggle-weapon="${w.id}" data-next="${!w.active}">${w.active ? 'Wyłącz' : 'Włącz'}</button>
                                        <button class="btn-cancel admin-danger-btn" data-remove-weapon="${w.id}">Usuń</button>
                                    </span>
                                </div>`).join('')}
                        </div>`;
                }).join('')}
                ${!this.weapons.length ? '<div class="inventory-empty">Brak broni.</div>' : ''}
            </div>`;
    }

    _casesTabHtml() {
        return `
            <div class="admin-add-form">
                <h4>Dodaj skrzynkę</h4>
                <input type="text" id="admin-case-title" placeholder="Nazwa skrzynki" maxlength="60">
                <input type="number" id="admin-case-price" placeholder="Cena w żetonach" min="1" step="1">
                <button class="btn-primary" id="admin-add-case-btn">Dodaj skrzynkę</button>
                <p class="admin-hint">Zawartość i wartości nagród liczą się automatycznie z aktywnej broni i ceny skrzynki — nie trzeba ustawiać ręcznie.</p>
            </div>
            <div class="admin-list">
                ${this.cases.map(c => `
                    <div class="admin-list-item ${c.active ? '' : 'admin-list-item-inactive'}">
                        <span class="admin-list-item-icon">📦</span>
                        <span class="admin-list-item-name">${c.title} — ${c.price} 🪙</span>
                        <span class="admin-list-item-actions">
                            <button class="btn-cancel" data-toggle-case="${c.id}" data-next="${!c.active}">${c.active ? 'Wyłącz' : 'Włącz'}</button>
                            <button class="btn-cancel admin-danger-btn" data-remove-case="${c.id}">Usuń</button>
                        </span>
                    </div>`).join('')}
                ${!this.cases.length ? '<div class="inventory-empty">Brak skrzynek.</div>' : ''}
            </div>`;
    }
}
