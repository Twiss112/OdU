// ==UserScript==
// @name         OSCPV B2C — Пошук полісів (Odoo + Universalna)
// @namespace    universalna.oscpv.b2c
// @version      2.13.0-b2c
// @description  B2C: ОСЦПВ + дані авто (carplates) + дата початку полісу (бінарний пошук через dict/import-tool)
// @author       Universalna Baza
// @match        https://odoo.icu.int/*
// @match        https://odoo.universalna.com/*
// @match        https://dict.universalna.com/*
// @match        https://ua.carplates.app/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        unsafeWindow
// @connect      import-tool.universalna.com
// @connect      dict.universalna.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // =====================================================================
    //                          КОНФІГУРАЦІЯ
    // =====================================================================
    const CONFIG = {
        TABLE_URL: 'https://dict.universalna.com/table/444',
        INSERT_URL: 'https://dict.universalna.com/api/24/insert/InsuredLoss?zip=true&idtbl=444',
        RUN_URL: 'https://import-tool.universalna.com/api/task/MtsbuInsuredLoss_PROD/run',
        DELAY_AFTER_RUN: 1500,
        DELAY_BETWEEN_IPN: 1500,
        ROW_WAIT_TIMEOUT: 30000,
        ROW_WAIT_INTERVAL: 500,

        // Carplates налаштування
        CARPLATES_VIN_URL: 'https://ua.carplates.app/vin/',  // куди відкривати вкладку
        CARPLATES_API_URL: 'https://api.carplates.app/summary', // що перехоплювати у вкладці
        CARPLATES_TIMEOUT: 25000,   // мс - макс. час очікування у вкладці carplates
        CARPLATES_DELAY: 800,       // мс - пауза між VIN-запитами

    };

    // Глобальне сховище актуального токена — оновлюється при кожному запиті сайту
    let LIVE_TOKEN = null;

    // ВАЖЛИВО: ставимо перехоплювач токена ДО будь-якої логіки,
    // щоб гарантовано побачити запити які сайт робить при завантаженні
    if (location.hostname === 'dict.universalna.com') {
        installTokenSniffer();
    }

    function installTokenSniffer() {
        try {
            const origFetch = window.fetch;
            window.fetch = function(input, init) {
                try {
                    const headers = (init && init.headers) || (input && input.headers) || {};
                    let auth = null;
                    if (headers instanceof Headers) {
                        auth = headers.get('Authorization') || headers.get('authorization');
                    } else if (typeof headers === 'object') {
                        auth = headers['Authorization'] || headers['authorization'];
                    }
                    if (auth && auth.startsWith('Bearer ')) {
                        LIVE_TOKEN = auth.slice(7);
                    }
                } catch(e) {}
                const result = origFetch.apply(this, arguments);
                // Capture SELECT/export API responses + auto-discover working URL
                try {
                    const url = typeof input === 'string' ? input : (input?.url ?? '');
                    if (url && url.includes('InsuredLoss') && !url.includes('/insert')) {
                        result.then(resp => {
                            if (!resp.ok) return;
                            const ct = resp.headers.get('content-type') || '';
                            if (ct.includes('json')) {
                                resp.clone().json().then(data => {
                                    _storeTableCache(data, url);
                                }).catch(() => {});
                            } else if (ct.includes('spreadsheet') || ct.includes('octet') || ct.includes('xlsx')) {
                                // Binary XLSX from download button — store URL for GM_xmlhttpRequest
                                GM_setValue('dict444_dl_url', url.split('?')[0]);
                            }
                        }).catch(() => {});
                    }
                } catch(e) {}
                return result;
            };

            const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                try {
                    if (name && name.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ')) {
                        LIVE_TOKEN = value.slice(7);
                    }
                } catch(e) {}
                return origSetHeader.apply(this, arguments);
            };

            // Capture XHR responses too (in case page uses XHR instead of fetch)
            const origXHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                if (url && typeof url === 'string' && url.includes('InsuredLoss') && !url.includes('/insert')) {
                    this._oscpv_capture = true;
                }
                return origXHROpen.apply(this, arguments);
            };
            const origXHRSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function() {
                if (this._oscpv_capture) {
                    this.addEventListener('load', () => {
                        if (this.status === 200) {
                            try { _storeTableCache(JSON.parse(this.responseText)); } catch(e) {}
                        }
                    });
                }
                return origXHRSend.apply(this, arguments);
            };

            console.log('[OSCPV] Token sniffer + table cache interceptor installed');
        } catch(e) {
            console.warn('[OSCPV] Could not install sniffer:', e);
        }
    }

    function _storeTableCache(data, sourceUrl) {
        try {
            const rows = Array.isArray(data) ? data :
                         Array.isArray(data?.data) ? data.data :
                         Array.isArray(data?.rows) ? data.rows :
                         Array.isArray(data?.items) ? data.items : null;
            if (!rows || !rows.length) return;
            // Store only id + response to keep size small
            const minimal = rows
                .map(r => ({ id: parseInt(r.id ?? r.ID ?? 0), resp: (r.response ?? r.resp ?? r.RESPONSE ?? '').toString() }))
                .filter(r => r.id > 0)
                .sort((a, b) => a.id - b.id)
                .slice(-600);
            GM_setValue('dict444_api_cache', JSON.stringify({ ts: Date.now(), rows: minimal }));
            // Auto-save the working JSON endpoint URL for direct GM_xmlhttpRequest access
            if (sourceUrl && !GM_getValue('dict444_dl_url', '')) {
                GM_setValue('dict444_dl_url', sourceUrl.split('?')[0]);
            }
        } catch(e) {}
    }

    // ─── GM_xmlhttpRequest promise wrapper ───────────────────────────────────
    function gmXHR(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest(Object.assign({}, opts, {
                onload:   resolve,
                onerror:  () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout'))
            }));
        });
    }

    // Parse XLSX arraybuffer → [{id, resp}], using header row or fallback to COL positions
    function parseXLSXRows(buffer) {
        try {
            const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
            if (!wb.SheetNames.length) return null;
            const ws = wb.Sheets[wb.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (data.length < 2) return null;
            const hdr = data[0].map(h => (h || '').toString().toLowerCase().trim());
            let idCol   = hdr.findIndex(h => h === 'id');
            let respCol = hdr.findIndex(h => h === 'response');
            if (idCol   < 0) idCol   = COL.ID;       // fallback: col 0
            if (respCol < 0) respCol = COL.RESPONSE;  // fallback: col 18
            return data.slice(1)
                .map(r => ({ id: parseInt(r[idCol] || 0) || 0, resp: (r[respCol] || '').toString().trim() }))
                .filter(r => r.id > 0);
        } catch(e) {
            console.warn('[OSCPV] parseXLSXRows:', e);
            return null;
        }
    }

    // Direct table fetch via GM_xmlhttpRequest (no iframe needed).
    // Tries cached URL first, then common patterns. Supports JSON and XLSX.
    // Returns [{id, resp}] or null on failure.
    async function fetchTableRowsDirect() {
        const token = getCurrentToken();
        if (!token) return null;

        const saved = GM_getValue('dict444_dl_url', '');
        const base  = 'https://dict.universalna.com/api/24/';
        const candidates = [
            ...(saved ? [saved] : []),
            base + 'select/InsuredLoss',
            base + 'export/InsuredLoss',
            base + 'download/InsuredLoss',
        ].filter((u, i, a) => a.indexOf(u) === i); // deduplicate

        for (const url of candidates) {
            const full = url.includes('idtbl') ? url : url + '?idtbl=444';
            try {
                // Try JSON
                const rj = await gmXHR({
                    method: 'GET', url: full,
                    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                    timeout: 15000
                });
                if (rj.status === 200) {
                    const ct = (rj.responseHeaders || '').toLowerCase();
                    if (!ct.includes('spreadsheet') && !ct.includes('octet')) {
                        const data = JSON.parse(rj.responseText);
                        const rows = Array.isArray(data) ? data :
                                     Array.isArray(data?.data) ? data.data :
                                     Array.isArray(data?.rows) ? data.rows : null;
                        if (rows?.length) {
                            GM_setValue('dict444_dl_url', url);
                            return rows.map(r => ({
                                id:   parseInt(r.id ?? r.ID ?? 0) || 0,
                                resp: (r.response ?? r.resp ?? r.RESPONSE ?? '').toString()
                            })).filter(r => r.id > 0);
                        }
                    }
                }

                // Try XLSX (arraybuffer)
                const rx = await gmXHR({
                    method: 'GET', url: full,
                    headers: { 'Authorization': 'Bearer ' + token },
                    responseType: 'arraybuffer',
                    timeout: 20000
                });
                if (rx.status === 200 && rx.response) {
                    const rows = parseXLSXRows(rx.response);
                    if (rows?.length) {
                        GM_setValue('dict444_dl_url', url);
                        return rows;
                    }
                }
            } catch(e) {
                console.log('[OSCPV] fetchTableRowsDirect failed:', url, e.message);
            }
        }
        return null;
    }

    // ====== Колонки таблиці (порядок з HTML el-table_1_column_N) ======
    // 1=id, 2=label_, 3=ident_code, 4=plate_no, 5=vin,
    // 6=surname, 7=given_name, 8=middle_name, 9=start_date, 10=end_date,
    // 11=policy_type, 12=server_, 13=status, 14=processDate,
    // 15=errorCode, 16=errorMsg, 17=url, 18=request, 19=response,
    // 20=DateCreate, 21=DateModify, 22=UserCreate, 23=UserModify
    const COL = {
        ID: 0, LABEL: 1, IDENT_CODE: 2,
        STATUS: 12, RESPONSE: 18
    };

    // =====================================================================
    //                    РОУТИНГ ПО САЙТАМ
    // =====================================================================
    const host = location.hostname;
    // Обидва домени Odoo - старий і новий
    const isOdooHost = (host === 'odoo.icu.int' || host === 'odoo.universalna.com');

    if (isOdooHost) {
        initOdooSide();
    } else if (host === 'dict.universalna.com') {
        initDictSide();
    } else if (host === 'ua.carplates.app') {
        initCarplatesSide();
    }


    // =====================================================================
    //                    СТОРОНА ODOO (UI + керування)
    // =====================================================================
    function initOdooSide() {
        // Чекаємо появи навігаційної панелі Odoo і вставляємо кнопку
        const tryInsertButton = () => {
            if (document.getElementById('oscpv-fab')) return;
            if (!document.body) {
                setTimeout(tryInsertButton, 500);
                return;
            }
            createFloatingButton();
        };

        setTimeout(tryInsertButton, 1500);
        // Vue/Odoo може перерендерювати — періодично перевіряємо
        setInterval(() => {
            if (!document.getElementById('oscpv-fab')) tryInsertButton();
        }, 3000);
    }

    function createFloatingButton() {
        const btn = document.createElement('button');
        btn.id = 'oscpv-fab';
        btn.title = 'Пошук полісів ОСЦПВ';
        btn.innerHTML = '<span class="oscpv-fab-ico">🔍</span><span>Пошук ОСЦПВ</span>';
        btn.style.cssText = `
            position: fixed; bottom: 24px; right: 24px;
            z-index: 2147483646;
            background: linear-gradient(135deg, #9a7eb0, #83639D);
            color: #fff;
            border: none; border-radius: 999px;
            padding: 14px 22px;
            font-size: 14px; font-weight: 600;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(131, 99, 157, 0.35), 0 2px 6px rgba(131, 99, 157, 0.2);
            display: flex; align-items: center; gap: 8px;
            transition: transform 0.15s, box-shadow 0.15s;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        `;
        btn.onmouseenter = () => {
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 12px 32px rgba(131, 99, 157, 0.4), 0 2px 6px rgba(131, 99, 157, 0.25)';
        };
        btn.onmouseleave = () => {
            btn.style.transform = '';
            btn.style.boxShadow = '0 8px 24px rgba(131, 99, 157, 0.35), 0 2px 6px rgba(131, 99, 157, 0.2)';
        };
        btn.onclick = openModal;
        document.body.appendChild(btn);

        // Стиль для іконки в FAB
        if (!document.getElementById('oscpv-fab-style')) {
            const s = document.createElement('style');
            s.id = 'oscpv-fab-style';
            s.textContent = `
                #oscpv-fab .oscpv-fab-ico {
                    width: 22px; height: 22px;
                    display: inline-flex; align-items: center; justify-content: center;
                    background: rgba(255,255,255,0.25);
                    border-radius: 50%; font-size: 14px;
                }
            `;
            document.head.appendChild(s);
        }
        console.log('[OSCPV B2C] FAB додано в Odoo');
    }

    let modalEl = null;
    let results = [];
    let statsFound = 0;
    let statsEmpty = 0;

    function openModal() {
        if (modalEl) {
            modalEl.style.display = 'flex';
            return;
        }
        modalEl = document.createElement('div');
        modalEl.id = 'oscpv-modal';
        modalEl.innerHTML = `
            <div class="oscpv-overlay"></div>
            <div class="oscpv-dialog">

                <div class="oscpv-header">
                    <div class="oscpv-h-left">
                        <div class="oscpv-h-icon">🛡️</div>
                        <div>
                            <h2>Пошук полісів ОСЦПВ <span class="oscpv-badge-b2c">B2C</span></h2>
                            <div class="oscpv-subtitle">Перевірка наявності страхових полісів за ІПН</div>
                        </div>
                    </div>
                    <button class="oscpv-close">×</button>
                </div>

                <div class="oscpv-body">

                    <div class="oscpv-card">
                        <div class="oscpv-card-title">
                            <span><span class="oscpv-icon">📋</span>Дані для пошуку</span>
                            <button class="oscpv-auto-btn" id="oscpv-auto" title="Знайти ІПН клієнта з поточного ліда">
                                <span class="oscpv-ico-sm">🔵</span>
                                Авто-ІПН з ліда
                            </button>
                        </div>
                        <div class="oscpv-input-block">
                            <textarea class="oscpv-ipn-textarea" id="oscpv-ipns"
                                placeholder="2099205955&#10;3237517719&#10;ІПН по одному в рядку..."></textarea>
                            <span class="oscpv-ipn-counter" id="oscpv-counter">0 ІПН</span>
                        </div>

                        <div class="oscpv-settings-grid">
                            <div class="oscpv-setting">
                                <label>⏱ Очікування обробки</label>
                                <div class="oscpv-setting-row">
                                    <input type="number" id="oscpv-delay-run" value="${CONFIG.DELAY_AFTER_RUN}" min="1000" step="500">
                                    <span class="oscpv-unit">мс</span>
                                </div>
                            </div>
                            <div class="oscpv-setting">
                                <label>⏸ Пауза між ІПН</label>
                                <div class="oscpv-setting-row">
                                    <input type="number" id="oscpv-delay-ipn" value="${CONFIG.DELAY_BETWEEN_IPN}" min="0" step="500">
                                    <span class="oscpv-unit">мс</span>
                                </div>
                            </div>
                        </div>

                        <label class="oscpv-toggle">
                            <input type="checkbox" id="oscpv-carplates-enable" checked>
                            <span class="oscpv-toggle-slider"></span>
                            <span class="oscpv-toggle-text">
                                <span>🚗 Парсити дані авто з carplates.app</span>
                                <span class="oscpv-toggle-hint">Додає марку, модель, рік, паливо, об'єм двигуна, масу, місць, регіон</span>
                            </span>
                        </label>

                        <label class="oscpv-toggle">
                            <input type="checkbox" id="oscpv-mtsbu-enable">
                            <span class="oscpv-toggle-slider"></span>
                            <span class="oscpv-toggle-text">
                                <span>📅 Початок полісу</span>
                                <span class="oscpv-toggle-hint">Бінарний пошук дати початку полісу через dict/import-tool. 1 запит за крок, ~9 кроків на авто.</span>
                            </span>
                        </label>
                    </div>

                    <div class="oscpv-card oscpv-progress-card" id="oscpv-progress-card" style="display:none">
                        <div class="oscpv-progress-status">
                            <div class="oscpv-stage" id="oscpv-stage">
                                <div class="oscpv-spinner"></div>
                                <span>Обробка...</span>
                            </div>
                            <div class="oscpv-count" id="oscpv-progress-text">0 / 0</div>
                        </div>
                        <div class="oscpv-progress-bar">
                            <div class="oscpv-progress-fill" id="oscpv-fill"></div>
                        </div>
                    </div>

                    <div class="oscpv-stats" id="oscpv-stats" style="display:none">
                        <div class="oscpv-stat oscpv-success">
                            <div class="oscpv-num" id="oscpv-stat-found">0</div>
                            <div class="oscpv-stat-label">Знайдено</div>
                        </div>
                        <div class="oscpv-stat oscpv-warn">
                            <div class="oscpv-num" id="oscpv-stat-empty">0</div>
                            <div class="oscpv-stat-label">Без полісу</div>
                        </div>
                        <div class="oscpv-stat oscpv-info">
                            <div class="oscpv-num" id="oscpv-stat-total">0</div>
                            <div class="oscpv-stat-label">Опрацьовано</div>
                        </div>
                    </div>

                    <div class="oscpv-card oscpv-log-card" id="oscpv-log-card" style="display:none">
                        <div class="oscpv-card-title">
                            <span><span class="oscpv-icon">📜</span>Лог обробки</span>
                        </div>
                        <div class="oscpv-log-content" id="oscpv-log"></div>
                    </div>

                    <div class="oscpv-card oscpv-results-card">
                        <div class="oscpv-card-title">
                            <span><span class="oscpv-icon">📑</span>Результати</span>
                        </div>
                        <div id="oscpv-results-area">
                            <div class="oscpv-empty-state">
                                <div class="oscpv-empty-ico">📋</div>
                                <div class="oscpv-empty-txt">Введіть ІПН і натисніть «Старт пошуку»</div>
                            </div>
                        </div>
                    </div>

                </div>

                <div class="oscpv-footer">
                    <div class="oscpv-footer-info" id="oscpv-info">Готовий до пошуку</div>
                    <button class="oscpv-btn oscpv-btn-secondary" id="oscpv-toggle-log" title="Показати/сховати лог">
                        <span>📜</span> Лог
                    </button>
                    <button class="oscpv-btn oscpv-btn-secondary" id="oscpv-import-odoo" disabled title="Вставити дані як примітку до поточного ліда">
                        <span>📝</span> В Odoo
                    </button>
                    <button class="oscpv-btn oscpv-btn-secondary" id="oscpv-export" disabled>
                        <span>📥</span> Excel
                    </button>
                    <button class="oscpv-btn oscpv-btn-primary" id="oscpv-start">
                        <span>▶</span> Старт пошуку
                    </button>
                </div>

            </div>
        `;
        injectStyles();
        document.body.appendChild(modalEl);

        // Прив'язка подій
        modalEl.querySelector('.oscpv-close').onclick = closeModal;
        modalEl.querySelector('.oscpv-overlay').onclick = closeModal;
        modalEl.querySelector('#oscpv-start').onclick = startBatch;
        modalEl.querySelector('#oscpv-export').onclick = exportExcel;
        modalEl.querySelector('#oscpv-import-odoo').onclick = importToOdoo;
        modalEl.querySelector('#oscpv-auto').onclick = autoFillIpnFromLead;
        modalEl.querySelector('#oscpv-toggle-log').onclick = toggleLog;

        // Лічильник ІПН в textarea
        const ta = modalEl.querySelector('#oscpv-ipns');
        ta.addEventListener('input', () => {
            const n = ta.value.split('\n').map(s => s.trim()).filter(Boolean).length;
            modalEl.querySelector('#oscpv-counter').textContent = n + ' ІПН';
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && modalEl && modalEl.style.display !== 'none') closeModal();
        });
    }

    function toggleLog() {
        const card = document.getElementById('oscpv-log-card');
        const btn = document.getElementById('oscpv-toggle-log');
        if (!card || !btn) return;
        const isVisible = card.style.display !== 'none';
        card.style.display = isVisible ? 'none' : 'block';
        btn.classList.toggle('oscpv-btn-active', !isVisible);
    }

    /**
     * Витягує ІПН клієнта зі сторінки ліда CRM.
     * Просто читаємо значення з input#partner_id_1 (поле "Клієнт" у формі).
     * Очікуваний формат: "Прізвище Ім'я По-батькові ‒ 1234567890"
     *
     * ЗМІНА (v2.8): при автопошуку старий ІПН у полі ЗАМІНЮЄТЬСЯ новим,
     * а не дописується (зручно на новій картці клієнта).
     */
    async function autoFillIpnFromLead() {
        const btn = document.getElementById('oscpv-auto');
        const textarea = document.getElementById('oscpv-ipns');
        const origText = btn.textContent;

        try {
            btn.disabled = true;
            btn.textContent = '⏳ Шукаю...';

            // 1. Шукаємо поле "Клієнт" на сторінці ліда
            let partnerInput = document.getElementById('partner_id_1');
            if (!partnerInput || !partnerInput.value) {
                const wrap = document.querySelector('[name="partner_id"]');
                if (wrap) {
                    partnerInput = wrap.querySelector('input.o-autocomplete--input') || wrap.querySelector('input');
                }
            }

            if (!partnerInput) {
                alert('Не знайдено поле клієнта на сторінці. Відкрийте сторінку ліда.');
                return;
            }

            const displayName = (partnerInput.value || '').trim();
            console.log('[OSCPV] partner display_name з DOM:', displayName);

            if (!displayName) {
                alert('Поле клієнта порожнє');
                return;
            }

            // 2. Витягуємо 10-значний ІПН (остання послідовність з 10 цифр у рядку)
            const matches = displayName.match(/\b\d{10}\b/g);
            if (!matches || !matches.length) {
                alert(`У імені клієнта не знайдено 10-значного ІПН.\n\nЗначення: "${displayName}"`);
                return;
            }
            const ipn = matches[matches.length - 1];

            // 3. ЗАМІНЮЄМО вміст поля новим ІПН (не дописуємо)
            textarea.value = ipn;
            const counter = document.getElementById('oscpv-counter');
            if (counter) counter.textContent = '1 ІПН';
            // Кидаємо input event щоб лічильник/слухачі оновились
            textarea.dispatchEvent(new Event('input', { bubbles: true }));

            // 4. Автоматично запускаємо пошук
            await sleep(300);
            startBatch();
        } catch (e) {
            console.error('[OSCPV] Auto IPN error:', e);
            alert('Помилка автопошуку ІПН: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }

    function closeModal() {
        if (modalEl) modalEl.style.display = 'none';
    }

    function injectStyles() {
        if (document.getElementById('oscpv-styles')) return;
        const s = document.createElement('style');
        s.id = 'oscpv-styles';
        s.textContent = `
            @keyframes oscpv-fadeIn { from { opacity: 0 } to { opacity: 1 } }
            @keyframes oscpv-slideUp { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
            @keyframes oscpv-spin { to { transform: rotate(360deg); } }

            #oscpv-modal { position: fixed; inset: 0; z-index: 2147483647;
                display: flex; align-items: center; justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Arial, sans-serif;
                color: #2d3748; font-size: 13px;
                animation: oscpv-fadeIn 0.2s ease; }
            #oscpv-modal * { box-sizing: border-box; }
            #oscpv-modal .oscpv-overlay { position: absolute; inset: 0;
                background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(4px); }
            #oscpv-modal .oscpv-dialog { position: relative; background: #fff;
                border-radius: 16px; width: 92%; max-width: 820px; max-height: 92vh;
                display: flex; flex-direction: column; overflow: hidden;
                box-shadow: 0 25px 70px rgba(15, 23, 42, 0.25);
                animation: oscpv-slideUp 0.25s ease; }

            /* HEADER */
            #oscpv-modal .oscpv-header { padding: 20px 24px;
                background: linear-gradient(135deg, #f5f0fa 0%, #faf7fc 100%);
                border-bottom: 1px solid #e2e8f0;
                display: flex; justify-content: space-between; align-items: center; }
            #oscpv-modal .oscpv-h-left { display: flex; align-items: center; gap: 12px; }
            #oscpv-modal .oscpv-h-icon { width: 40px; height: 40px;
                background: linear-gradient(135deg, #9a7eb0, #83639D); color: #fff;
                border-radius: 12px; display: flex; align-items: center; justify-content: center;
                font-size: 18px; box-shadow: 0 4px 12px rgba(131, 99, 157, 0.3); }
            #oscpv-modal h2 { margin: 0; font-size: 17px; font-weight: 600; color: #0f172a;
                display: flex; align-items: center; gap: 8px; }
            #oscpv-modal .oscpv-subtitle { font-size: 12px; color: #64748b; margin-top: 2px; }
            #oscpv-modal .oscpv-badge-b2c { background: #fce7f3; color: #be185d;
                font-size: 11px; font-weight: 700; padding: 3px 8px;
                border-radius: 6px; letter-spacing: 0.5px; }
            #oscpv-modal .oscpv-close { background: transparent; border: none; color: #64748b;
                width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
                font-size: 20px; transition: background 0.15s; padding: 0; }
            #oscpv-modal .oscpv-close:hover { background: rgba(15, 23, 42, 0.06); }

            /* BODY */
            #oscpv-modal .oscpv-body { padding: 20px 24px; overflow-y: auto; flex: 1; }

            /* CARDS */
            #oscpv-modal .oscpv-card { background: #fff; border: 1px solid #e2e8f0;
                border-radius: 12px; padding: 16px; margin-bottom: 14px; }
            #oscpv-modal .oscpv-card-title { font-size: 12px; font-weight: 600;
                color: #475569; text-transform: uppercase; letter-spacing: 0.5px;
                margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
            #oscpv-modal .oscpv-icon { margin-right: 6px; color: #83639D; }

            /* AUTO BUTTON */
            #oscpv-modal .oscpv-auto-btn { background: #f5f0fa; border: 1px dashed #9a7eb0;
                color: #5c3e72; border-radius: 10px; padding: 7px 12px; cursor: pointer;
                font-weight: 600; font-size: 12px;
                display: inline-flex; align-items: center; gap: 6px;
                transition: all 0.15s; font-family: inherit; }
            #oscpv-modal .oscpv-auto-btn:hover { background: #e8e0ef; border-color: #83639D; }
            #oscpv-modal .oscpv-auto-btn:disabled { opacity: 0.6; cursor: not-allowed; }
            #oscpv-modal .oscpv-ico-sm { font-size: 13px; }

            /* TEXTAREA */
            #oscpv-modal .oscpv-input-block { position: relative; }
            #oscpv-modal .oscpv-ipn-textarea { width: 100%; min-height: 90px;
                padding: 12px 14px; border: 1.5px solid #e2e8f0; border-radius: 10px;
                font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
                font-size: 14px; color: #1e293b;
                transition: border 0.15s, box-shadow 0.15s; resize: vertical; }
            #oscpv-modal .oscpv-ipn-textarea:focus { outline: none; border-color: #83639D;
                box-shadow: 0 0 0 3px rgba(131, 99, 157, 0.12); }
            #oscpv-modal .oscpv-ipn-counter { position: absolute; bottom: 8px; right: 12px;
                background: #f1f5f9; color: #64748b; font-size: 11px;
                padding: 2px 8px; border-radius: 6px; font-weight: 600; }

            /* SETTINGS */
            #oscpv-modal .oscpv-settings-grid { display: grid; grid-template-columns: 1fr 1fr;
                gap: 10px; margin-top: 10px; }
            #oscpv-modal .oscpv-setting { background: #f8fafc; border: 1px solid #e2e8f0;
                border-radius: 10px; padding: 10px 12px; }
            #oscpv-modal .oscpv-setting label { display: block; font-size: 11px; color: #64748b;
                margin-bottom: 4px; font-weight: 500; }
            #oscpv-modal .oscpv-setting-row { display: flex; align-items: baseline; gap: 4px; }
            #oscpv-modal .oscpv-setting input { flex: 1; border: none; background: transparent;
                font-size: 14px; font-weight: 600; color: #0f172a; padding: 0; font-family: inherit; }
            #oscpv-modal .oscpv-setting input:focus { outline: none; }
            #oscpv-modal .oscpv-unit { font-size: 11px; color: #94a3b8; }

            /* PROGRESS CARD */
            #oscpv-modal .oscpv-progress-card { background: linear-gradient(135deg, #f5f0fa, #faf7fc);
                border: 1px solid #d4c4dd; }
            #oscpv-modal .oscpv-progress-status { display: flex; justify-content: space-between;
                margin-bottom: 8px; font-size: 13px; }
            #oscpv-modal .oscpv-stage { color: #5c3e72; font-weight: 600;
                display: flex; align-items: center; gap: 8px; }
            #oscpv-modal .oscpv-spinner { width: 14px; height: 14px;
                border: 2px solid #d4c4dd; border-top-color: #83639D;
                border-radius: 50%; animation: oscpv-spin 0.6s linear infinite; }
            #oscpv-modal .oscpv-count { color: #64748b; font-size: 12px; font-weight: 600; }
            #oscpv-modal .oscpv-progress-bar { height: 8px;
                background: rgba(131, 99, 157, 0.15); border-radius: 999px; overflow: hidden; }
            #oscpv-modal .oscpv-progress-fill { height: 100%;
                background: linear-gradient(90deg, #9a7eb0, #83639D);
                width: 0; transition: width 0.3s; border-radius: 999px; }

            /* STATS */
            #oscpv-modal .oscpv-stats { display: grid; grid-template-columns: repeat(3, 1fr);
                gap: 10px; margin-bottom: 14px; }
            #oscpv-modal .oscpv-stat { background: #fff; border: 1px solid #e2e8f0;
                border-radius: 12px; padding: 12px; text-align: center; }
            #oscpv-modal .oscpv-num { font-size: 24px; font-weight: 700;
                color: #0f172a; line-height: 1.1; }
            #oscpv-modal .oscpv-stat-label { font-size: 11px; color: #64748b;
                margin-top: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
            #oscpv-modal .oscpv-stat.oscpv-success .oscpv-num { color: #059669; }
            #oscpv-modal .oscpv-stat.oscpv-warn .oscpv-num { color: #d97706; }
            #oscpv-modal .oscpv-stat.oscpv-info .oscpv-num { color: #0891b2; }

            /* RESULTS TABLE */
            #oscpv-modal .oscpv-results-card { padding: 0; overflow: hidden; }
            #oscpv-modal .oscpv-results-card .oscpv-card-title {
                padding: 14px 16px 8px; margin-bottom: 0; }
            #oscpv-modal .oscpv-results-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            #oscpv-modal .oscpv-results-table th { background: #f8fafc; color: #475569;
                padding: 10px 14px; text-align: left; font-weight: 600; font-size: 11px;
                text-transform: uppercase; letter-spacing: 0.4px;
                border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; }
            #oscpv-modal .oscpv-results-table td { padding: 11px 14px;
                border-bottom: 1px solid #f1f5f9; color: #1e293b; vertical-align: top; }
            #oscpv-modal .oscpv-results-table tbody tr:last-child td { border-bottom: none; }
            #oscpv-modal .oscpv-results-table tbody tr:hover td { background: #f8fafc; }
            #oscpv-modal .oscpv-pill { display: inline-block; padding: 2px 8px;
                border-radius: 6px; font-size: 11px; font-weight: 600; }
            #oscpv-modal .oscpv-pill-ins { background: #fef3c7; color: #92400e; }
            #oscpv-modal .oscpv-pill-empty { background: #fee2e2; color: #991b1b; }
            #oscpv-modal .oscpv-pill-loss { background: #fee2e2; color: #991b1b; cursor: help; }
            #oscpv-modal .oscpv-pill-ok { background: #d1fae5; color: #065f46; }
            #oscpv-modal .oscpv-birth {
                font-size: 11px; color: #64748b; margin-top: 2px;
            }

            /* sub-badge у колонці "Початок" */
            #oscpv-modal .oscpv-mtsbu-cell { margin-top: 4px; }
            #oscpv-modal .oscpv-mtsbu-badge { display: inline-block; padding: 2px 7px;
                border-radius: 6px; font-size: 10px; font-weight: 600;
                background: #ede9fe; color: #5b21b6; white-space: nowrap; }

            /* EMPTY STATE */
            #oscpv-modal .oscpv-empty-state { padding: 32px 16px; text-align: center; color: #94a3b8; }
            #oscpv-modal .oscpv-empty-ico { font-size: 36px; opacity: 0.5; margin-bottom: 8px; }
            #oscpv-modal .oscpv-empty-txt { font-size: 13px; }

            /* LOG */
            #oscpv-modal .oscpv-log-content { background: #0f172a; color: #cbd5e1;
                border-radius: 10px; padding: 12px;
                font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
                font-size: 12px; max-height: 220px; overflow-y: auto; white-space: pre-wrap; }
            #oscpv-modal .oscpv-log-content .ok { color: #86efac; }
            #oscpv-modal .oscpv-log-content .err { color: #fca5a5; }
            #oscpv-modal .oscpv-log-content .info { color: #93c5fd; }
            #oscpv-modal .oscpv-log-content .dim { color: #64748b; }

            /* FOOTER */
            #oscpv-modal .oscpv-footer { padding: 16px 24px; background: #f8fafc;
                border-top: 1px solid #e2e8f0; display: flex; gap: 10px; align-items: center; }
            #oscpv-modal .oscpv-footer-info { flex: 1; font-size: 12px; color: #64748b; }
            #oscpv-modal .oscpv-btn { border: none; padding: 9px 18px; border-radius: 10px;
                cursor: pointer; font-weight: 600; font-size: 13px;
                display: inline-flex; align-items: center; gap: 6px;
                transition: all 0.15s; font-family: inherit; }
            #oscpv-modal .oscpv-btn-primary { background: linear-gradient(135deg, #83639D, #6b4c84);
                color: #fff; box-shadow: 0 4px 12px rgba(131, 99, 157, 0.3); }
            #oscpv-modal .oscpv-btn-primary:hover {
                box-shadow: 0 6px 16px rgba(131, 99, 157, 0.4); transform: translateY(-1px); }
            #oscpv-modal .oscpv-btn-primary:disabled {
                background: #cbd5e1; box-shadow: none; cursor: not-allowed; transform: none; }
            #oscpv-modal .oscpv-btn-secondary { background: #fff; color: #475569;
                border: 1px solid #e2e8f0; }
            #oscpv-modal .oscpv-btn-secondary:hover { background: #f8fafc; }
            #oscpv-modal .oscpv-btn-secondary:disabled { color: #cbd5e1; cursor: not-allowed; }
            #oscpv-modal .oscpv-btn-secondary.oscpv-btn-active {
                background: #f5f0fa; color: #83639D; border-color: #d4c4dd; }

            /* TOGGLE */
            #oscpv-modal .oscpv-toggle { display: flex; align-items: flex-start; gap: 10px;
                margin-top: 12px; padding: 10px 12px; background: #f8fafc;
                border: 1px solid #e2e8f0; border-radius: 10px; cursor: pointer;
                transition: all 0.15s; }
            #oscpv-modal .oscpv-toggle:hover { background: #f1f5f9; }
            #oscpv-modal .oscpv-toggle input { position: absolute; opacity: 0; pointer-events: none; }
            #oscpv-modal .oscpv-toggle-slider {
                width: 36px; height: 20px; background: #cbd5e1;
                border-radius: 999px; position: relative; flex-shrink: 0;
                transition: background 0.2s; margin-top: 2px; }
            #oscpv-modal .oscpv-toggle-slider::after {
                content: ''; position: absolute; left: 2px; top: 2px;
                width: 16px; height: 16px; background: #fff;
                border-radius: 50%; transition: transform 0.2s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
            #oscpv-modal .oscpv-toggle input:checked + .oscpv-toggle-slider {
                background: #83639D; }
            #oscpv-modal .oscpv-toggle input:checked + .oscpv-toggle-slider::after {
                transform: translateX(16px); }
            #oscpv-modal .oscpv-toggle-text { display: flex; flex-direction: column;
                gap: 2px; font-size: 13px; color: #1e293b; font-weight: 500; }
            #oscpv-modal .oscpv-toggle-hint { font-size: 11px; color: #64748b; font-weight: 400; }

            /* Copy button у рядку результатів */
            #oscpv-modal .oscpv-copy-btn {
                background: #f5f0fa; border: 1px solid #d4c4dd;
                color: #5c3e72; width: 28px; height: 28px;
                border-radius: 6px; cursor: pointer;
                display: inline-flex; align-items: center; justify-content: center;
                font-size: 13px; transition: all 0.15s;
                font-family: inherit; padding: 0;
            }
            #oscpv-modal .oscpv-copy-btn:hover {
                background: #e8e0ef; border-color: #83639D; }
            #oscpv-modal .oscpv-copy-btn.loading {
                background: #fef3c7; border-color: #fcd34d; color: #92400e;
                animation: oscpv-spin 1s linear infinite;
            }
            #oscpv-modal .oscpv-copy-btn.error {
                background: #fee2e2; border-color: #fca5a5; color: #991b1b;
                cursor: not-allowed; animation: none;
            }
            #oscpv-modal .oscpv-copy-btn.success {
                background: #d1fae5; border-color: #6ee7b7; color: #065f46;
                animation: none;
            }
        `;
        document.head.appendChild(s);
    }

    function log(msg, type='') {
        const l = document.getElementById('oscpv-log');
        if (!l) return;
        const t = new Date().toLocaleTimeString();
        const div = document.createElement('div');
        div.className = type;
        div.textContent = `[${t}] ${msg}`;
        l.appendChild(div);
        l.scrollTop = l.scrollHeight;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function startBatch() {
        const ipns = document.getElementById('oscpv-ipns').value
            .split('\n').map(s => s.trim()).filter(Boolean);
        if (!ipns.length) { alert('Введіть хоча б один ІПН'); return; }

        const delayRun = parseInt(document.getElementById('oscpv-delay-run').value) || CONFIG.DELAY_AFTER_RUN;
        const delayIpn = parseInt(document.getElementById('oscpv-delay-ipn').value) || CONFIG.DELAY_BETWEEN_IPN;

        // Готуємо UI для обробки
        document.getElementById('oscpv-start').disabled = true;
        document.getElementById('oscpv-export').disabled = true;
        document.getElementById('oscpv-import-odoo').disabled = true;
        document.getElementById('oscpv-progress-card').style.display = 'block';
        document.getElementById('oscpv-stats').style.display = 'grid';
        document.getElementById('oscpv-info').textContent = 'Йде обробка...';

        // Скидаємо лічильники
        results = [];
        statsFound = 0;
        statsEmpty = 0;

        // Скидаємо carplates стан
        CARPLATES_CACHE.clear();
        CARPLATES_PENDING.clear();
        carplatesQueue = Promise.resolve();

        document.getElementById('oscpv-stat-found').textContent = '0';
        document.getElementById('oscpv-stat-empty').textContent = '0';
        document.getElementById('oscpv-stat-total').textContent = '0';
        document.getElementById('oscpv-fill').style.width = '0%';
        document.getElementById('oscpv-progress-text').textContent = `0 / ${ipns.length}`;

        // Підготовка таблиці результатів
        const resArea = document.getElementById('oscpv-results-area');
        resArea.innerHTML = `
            <table class="oscpv-results-table">
                <thead>
                    <tr>
                        <th>ІПН</th><th>№ полісу</th><th>ПІБ</th>
                        <th>Авто</th><th>Страховик</th><th>Початок</th><th>Збитки</th><th style="width:50px">Дані</th>
                    </tr>
                </thead>
                <tbody id="oscpv-rbody"></tbody>
            </table>
        `;

        // Скинути стан спінера у "Обробка..."
        const stage = document.getElementById('oscpv-stage');
        if (stage) stage.innerHTML = '<div class="oscpv-spinner"></div><span>Обробка...</span>';

        log(`Старт обробки: ${ipns.length} ІПН`, 'info');
        log(`Відкриваю dict.universalna.com у фоновій вкладці...`, 'dim');

        const policyStart = document.getElementById('oscpv-mtsbu-enable')?.checked || false;
        if (policyStart) log('Увімкнено пошук дати початку полісу (бінарний пошук, ~2-3 хв на авто)', 'info');

        const sessionId = 'oscpv_' + Date.now();
        GM_setValue('oscpv_request_' + sessionId, JSON.stringify({
            ipns, delayRun, delayIpn, policyStart,
            time: Date.now()
        }));

        // Відкриваємо dict як popup-вікно щоб не красти фокус з Odoo
        const dictFeatures = [
            'popup=yes',
            'width=500',
            'height=400',
            'left=' + (screen.width - 100),
            'top=' + (screen.height - 100),
            'menubar=no', 'toolbar=no', 'location=no', 'status=no'
        ].join(',');
        const win = window.open(CONFIG.TABLE_URL + '#oscpv_session=' + sessionId, '_blank', dictFeatures);
        if (!win) {
            log('ПОМИЛКА: спливаючі вікна заблоковані. Дозвольте їх для цього домену Odoo', 'err');
            document.getElementById('oscpv-start').disabled = false;
            document.getElementById('oscpv-info').textContent = 'Помилка: спливаючі вікна заблоковані';
            return;
        }

        // Повертаємо фокус на нашу вкладку Odoo
        try {
            win.blur();
            window.focus();
            let attempts = 0;
            const focusInt = setInterval(() => {
                try { window.focus(); } catch(e) {}
                if (++attempts > 10) clearInterval(focusInt);
            }, 100);
        } catch(e) {}

        const progressKey = 'oscpv_progress_' + sessionId;
        const resultKey = 'oscpv_result_' + sessionId;

        GM_addValueChangeListener(progressKey, (name, oldV, newV) => {
            if (!newV) return;
            try {
                const data = JSON.parse(newV);
                handleProgressUpdate(data, ipns.length);
            } catch(e) {}
        });

        GM_addValueChangeListener(resultKey, (name, oldV, newV) => {
            if (!newV) return;
            try {
                const data = JSON.parse(newV);
                finishBatch(data);
                GM_deleteValue('oscpv_request_' + sessionId);
                GM_deleteValue(progressKey);
                GM_deleteValue(resultKey);
            } catch(e) {}
        });
    }

    function handleProgressUpdate(data, total) {
        if (data.log) log(data.log, data.logType || '');

        if (data.progress !== undefined) {
            const pct = (data.progress / total) * 100;
            document.getElementById('oscpv-fill').style.width = pct + '%';
            document.getElementById('oscpv-progress-text').textContent = `${data.progress} / ${total}`;
            document.getElementById('oscpv-stat-total').textContent = data.progress;

            // Оновлюємо текст у стадії
            const stage = document.getElementById('oscpv-stage');
            if (stage && data.progress < total) {
                stage.innerHTML = `<div class="oscpv-spinner"></div><span>Обробка ${data.progress + 1} з ${total}...</span>`;
            }
        }

        if (data.newResults && data.newResults.length) {
            const tbody = document.getElementById('oscpv-rbody');
            const carplatesEnabled = document.getElementById('oscpv-carplates-enable')?.checked;

            data.newResults.forEach(r => {
                const rowIdx = results.length;
                results.push(r);
                const tr = document.createElement('tr');
                tr.dataset.rowIdx = rowIdx;

                const birthDate = ipnToBirthDate(r.ipn);
                // Зберігаємо у самому результаті щоб потрапило в Excel і в "Імпорт у Odoo"
                r.birth_date = birthDate;
                const ipnCell = `
                    <td>
                        <div>${escapeHtml(r.ipn || '')}</div>
                        ${birthDate ? `<div class="oscpv-birth">📅 ${escapeHtml(birthDate)}</div>` : ''}
                    </td>
                `;

                if (r._notFound) {
                    statsEmpty++;
                    tr.innerHTML = `
                        ${ipnCell}
                        <td>—</td>
                        <td colspan="2" style="color:#94a3b8;font-style:italic">${escapeHtml(r.full_name)}</td>
                        <td><span class="oscpv-pill oscpv-pill-empty">немає</span></td>
                        <td>—</td>
                        <td>—</td>
                        <td></td>
                    `;
                } else {
                    statsFound++;
                    const carText = [(r.vehicle_brand||''), (r.vehicle_title||'')].filter(Boolean).join(' ') +
                                    (r.plate_no ? ' / ' + r.plate_no : '');
                    const needCarplates = carplatesEnabled && r.vin;
                    const copyBtn = needCarplates
                        ? `<button class="oscpv-copy-btn loading" data-row="${rowIdx}" title="Йде запит до carplates.app...">🔄</button>`
                        : (r.vin ? `<button class="oscpv-copy-btn" data-row="${rowIdx}" data-disabled="1" title="Парсинг авто вимкнено">📋</button>` : '');

                    const exactStart = r.policy_start_exact || '';
                    const coarseStart = r.start_date || '';
                    const startMain = exactStart || coarseStart || '—';
                    const startSub = exactStart
                        ? `<div class="oscpv-mtsbu-cell"><span class="oscpv-mtsbu-badge" title="Дата початку полісу (бінарний пошук)">початок</span></div>`
                        : '';
                    const startCell = `
                        <td>
                            <div>${escapeHtml(startMain)}</div>
                            ${startSub}
                        </td>
                    `;

                    // Збитки: показуємо pill з сумою
                    const lossAmount = parseFloat(r.total_loss_amount) || 0;
                    const eventsCount = parseInt(r.insured_events_count) || 0;
                    const paidAmount = parseFloat(r.paid_loss_amount) || 0;
                    const reservedAmount = parseFloat(r.reserved_loss_amount) || 0;
                    let lossCell = '';
                    if (lossAmount > 0 || eventsCount > 0) {
                        const tooltip = `Подій: ${eventsCount}\nЗаг. сума: ${lossAmount}\nВиплачено: ${paidAmount}\nРезерв: ${reservedAmount}`;
                        lossCell = `<span class="oscpv-pill oscpv-pill-loss" title="${escapeHtml(tooltip)}">${formatMoney(lossAmount)} грн</span>`;
                    } else {
                        lossCell = `<span class="oscpv-pill oscpv-pill-ok">немає</span>`;
                    }

                    tr.innerHTML = `
                        ${ipnCell}
                        <td>${escapeHtml(r.policy_no || '')}</td>
                        <td>${escapeHtml(r.full_name || '')}</td>
                        <td>${escapeHtml(carText)}</td>
                        <td><span class="oscpv-pill oscpv-pill-ins">${escapeHtml(r.insurer_name || '')}</span></td>
                        ${startCell}
                        <td>${lossCell}</td>
                        <td>${copyBtn}</td>
                    `;
                }
                tbody.appendChild(tr);

                // Запускаємо парсинг carplates у фоні якщо увімкнено і є VIN
                if (carplatesEnabled && !r._notFound && r.vin) {
                    queueCarplatesParse(rowIdx, r.vin);
                }
            });
            document.getElementById('oscpv-stat-found').textContent = statsFound;
            document.getElementById('oscpv-stat-empty').textContent = statsEmpty;

            // Прив'язуємо обробник кліку на нові кнопки копіювання
            tbody.querySelectorAll('.oscpv-copy-btn:not([data-bound])').forEach(b => {
                b.dataset.bound = '1';
                b.onclick = () => onCopyBtnClick(b);
            });
        }
    }

    // ====== Carplates: черга, кеш, парсинг ======
    const CARPLATES_CACHE = new Map();   // vin -> data
    const CARPLATES_PENDING = new Map(); // vin -> Promise (для уникнення дублів)
    let carplatesQueue = Promise.resolve(); // послідовна черга для НОВИХ VIN

    function queueCarplatesParse(rowIdx, vin) {
        // Якщо вже є в кеші — застосовуємо одразу, не ставимо в чергу
        if (CARPLATES_CACHE.has(vin)) {
            const data = CARPLATES_CACHE.get(vin);
            log(`carplates: ${vin} — з кешу`, 'dim');
            applyCarplatesToRow(rowIdx, data, vin);
            return;
        }

        // Якщо вже виконується запит з тим самим VIN — просто підпишемось на той же Promise
        if (CARPLATES_PENDING.has(vin)) {
            CARPLATES_PENDING.get(vin).then(data => {
                applyCarplatesToRow(rowIdx, data, vin);
            }).catch(() => {
                applyCarplatesToRow(rowIdx, null, vin);
            });
            return;
        }

        // Новий VIN — ставимо в чергу, реєструємо PENDING
        const promise = new Promise(resolve => {
            carplatesQueue = carplatesQueue.then(async () => {
                log(`carplates: запит ${vin}...`, 'dim');
                let data = null;
                try {
                    data = await parseCarplates(vin);
                    if (data && data.brand) CARPLATES_CACHE.set(vin, data);
                    else data = null;
                } catch(e) {
                    console.warn('[OSCPV] carplates error:', e);
                    data = null;
                }
                await sleep(CONFIG.CARPLATES_DELAY);
                resolve(data);
            });
        });

        CARPLATES_PENDING.set(vin, promise);
        promise.then(data => {
            CARPLATES_PENDING.delete(vin);
            applyCarplatesToRow(rowIdx, data, vin);
        });
    }

    function applyCarplatesToRow(rowIdx, data, vin) {
        // Зберігаємо у самому результаті щоб потрапило в Excel
        if (results[rowIdx]) {
            if (data) {
                results[rowIdx].cp_brand = data.brand || '';
                results[rowIdx].cp_model = data.model || '';
                results[rowIdx].cp_year = data.year || '';
                results[rowIdx].cp_fuel = data.fuel || '';
                results[rowIdx].cp_engine = data.engine || '';
                results[rowIdx].cp_weight = data.weight || '';
                results[rowIdx].cp_seats = data.seats || '';
                results[rowIdx].cp_region = data.region || '';
            } else {
                results[rowIdx].cp_brand = '';
                results[rowIdx].cp_error = 'не знайдено';
            }
        }

        // Оновлюємо кнопку у рядку
        const btn = document.querySelector(`.oscpv-copy-btn[data-row="${rowIdx}"]`);
        if (!btn) return;

        if (data) {
            btn.classList.remove('loading', 'error');
            btn.textContent = '📋';
            const text = buildClipboardText(data);
            btn.title = 'Копіювати дані авто:\n' + text;
            log(`carplates: ${vin} → ${data.brand} ${data.model} ${data.year}`, 'ok');
        } else {
            btn.classList.remove('loading');
            btn.classList.add('error');
            btn.textContent = '❌';
            btn.title = 'Дані по авто не знайдено';
            log(`carplates: ${vin} — дані не знайдено`, 'err');
        }
    }

    function buildClipboardText(d) {
        // Формат з лейблами для зручної вставки в коментар/документ
        const brandModel = [d.brand || '', d.model || ''].filter(Boolean).join(' ');
        const engine = [d.fuel || '', d.engine || ''].filter(Boolean).join(' ');
        const lines = [];
        if (brandModel) lines.push(`Авто: ${brandModel}`);
        if (d.year) lines.push(`Рік: ${d.year}`);
        if (engine) lines.push(`Двигун: ${engine}`);
        if (d.weight) lines.push(`Маса: ${d.weight}`);
        if (d.seats) lines.push(`Сидячих місць: ${d.seats}`);
        if (d.region) lines.push(`Регіон реєстрації: ${d.region}`);
        return lines.join('\n');
    }

    async function onCopyBtnClick(btn) {
        if (btn.dataset.disabled || btn.classList.contains('loading') || btn.classList.contains('error')) {
            return;
        }
        const rowIdx = parseInt(btn.dataset.row);
        const r = results[rowIdx];
        if (!r || !r.cp_brand) return;

        const text = buildClipboardText({
            brand: r.cp_brand, model: r.cp_model, year: r.cp_year,
            fuel: r.cp_fuel, engine: r.cp_engine, weight: r.cp_weight,
            seats: r.cp_seats, region: r.cp_region
        });

        try {
            await navigator.clipboard.writeText(text);
            btn.classList.add('success');
            const origText = btn.textContent;
            btn.textContent = '✓';
            setTimeout(() => {
                btn.classList.remove('success');
                btn.textContent = '📋';
            }, 2000);
        } catch(e) {
            console.warn('[OSCPV] clipboard error:', e);
            // Фолбек на старий API
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch(_) {}
            ta.remove();
            btn.classList.add('success');
            btn.textContent = '✓';
            setTimeout(() => { btn.classList.remove('success'); btn.textContent = '📋'; }, 2000);
        }
    }

    /**
     * Парсинг даних авто з carplates через тимчасову вкладку.
     */
    function parseCarplates(vin) {
        return new Promise((resolve, reject) => {
            const sessId = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const resKey = 'oscpv_cp_res_' + sessId;
            const startedAt = Date.now();

            const url = CONFIG.CARPLATES_VIN_URL + encodeURIComponent(vin) + '#cp_session=' + sessId;
            console.log('[OSCPV] Open carplates popup:', url);

            const features = [
                'popup=yes',
                'width=500',
                'height=400',
                'left=' + (screen.width - 100),
                'top=' + (screen.height - 100),
                'menubar=no',
                'toolbar=no',
                'location=no',
                'status=no',
                'noopener=no',
                'noreferrer=no'
            ].join(',');

            const win = window.open(url, '_blank', features);
            if (!win) {
                console.warn('[OSCPV] window.open повернув null - popup заблокований');
                reject(new Error('popup blocked'));
                return;
            }

            // Одразу повертаємо фокус на нашу вкладку Odoo
            try {
                win.blur();
                window.focus();
                let focusAttempts = 0;
                const focusInterval = setInterval(() => {
                    try { window.focus(); } catch(e) {}
                    if (++focusAttempts > 10) clearInterval(focusInterval);
                }, 100);
            } catch(e) {}

            let finished = false;
            let listenerId = null;

            const finish = (result, isError) => {
                if (finished) return;
                finished = true;
                const elapsed = ((Date.now() - startedAt)/1000).toFixed(1);
                console.log(`[OSCPV] carplates ${vin}: завершено за ${elapsed}с`,
                    isError ? 'ERROR' : 'OK', result);
                if (listenerId !== null) {
                    try { GM_removeValueChangeListener(listenerId); } catch(e) {}
                }
                GM_deleteValue(resKey);
                try { win.close(); } catch(e) {}
                if (isError) reject(result);
                else resolve(result);
            };

            listenerId = GM_addValueChangeListener(resKey, (name, oldV, newV) => {
                if (!newV || finished) return;
                try {
                    const payload = JSON.parse(newV);
                    if (payload && payload.error) {
                        console.warn(`[OSCPV] carplates ${vin}: помилка від вкладки -`, payload.error);
                        log(`carplates: ${vin} — ${payload.error}`, 'err');
                        finish(null, false);
                    } else if (payload) {
                        finish(payload, false);
                    }
                } catch(e) {
                    console.warn('[OSCPV] parseCarplates JSON error:', e);
                    finish(null, false);
                }
            });

            setTimeout(() => {
                if (!finished) {
                    console.warn(`[OSCPV] carplates ${vin}: TIMEOUT - вкладка не відповіла за ${CONFIG.CARPLATES_TIMEOUT}мс`);
                    log(`carplates: ${vin} — timeout (вкладка не відповіла)`, 'err');
                    finish(new Error('timeout'), true);
                }
            }, CONFIG.CARPLATES_TIMEOUT);
        });
    }

    // =====================================================================
    //         СТОРОНА UA.CARPLATES.APP — перехоплення API запиту
    // =====================================================================
    function initCarplatesSide() {
        const m = (location.hash || '').match(/cp_session=([\w]+)/);
        if (!m) {
            console.log('[OSCPV] carplates: звичайний візит, скрипт пасивний');
            return;
        }

        const sessId = m[1];
        const resKey = 'oscpv_cp_res_' + sessId;
        const DEBUG_KEEP_OPEN = false;
        console.log('[OSCPV] ===== CARPLATES SESSION (DOM parsing) =====');
        console.log('[OSCPV] sessId:', sessId);

        // Банер
        let bannerEl = null;
        const updateBanner = (text, color) => {
            if (!bannerEl) {
                if (!document.body) { setTimeout(() => updateBanner(text, color), 100); return; }
                bannerEl = document.createElement('div');
                bannerEl.id = 'oscpv-cp-banner';
                bannerEl.style.cssText = `
                    position: fixed; top: 0; left: 0; right: 0;
                    color: #fff; padding: 10px 20px; text-align: center;
                    font-family: Arial, sans-serif; font-size: 14px; font-weight: 600;
                    z-index: 2147483647; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                `;
                document.body.appendChild(bannerEl);
            }
            bannerEl.style.background = color || '#83639D';
            bannerEl.innerHTML = '🤖 OSCPV B2C: ' + text;
        };
        updateBanner('очікую рендер сторінки...');

        let finished = false;
        const finish = (data, errorMsg) => {
            if (finished) return;
            finished = true;
            if (data && data.brand) {
                console.log('[OSCPV] DOM extracted:', data);
                GM_setValue(resKey, JSON.stringify(data));
                updateBanner(`✓ ${data.brand} ${data.model} ${data.year}`, '#059669');
            } else {
                console.warn('[OSCPV] DOM extract failed:', errorMsg || 'no brand');
                GM_setValue(resKey, JSON.stringify({error: errorMsg || 'no_brand'}));
                updateBanner('⚠ Не вдалося спарсити: ' + (errorMsg || 'no_brand'), '#dc2626');
            }
            try {
                if (window.opener && !window.opener.closed) {
                    window.opener.focus();
                }
            } catch(e) {}
            if (!DEBUG_KEEP_OPEN) {
                setTimeout(() => { try { window.close(); } catch(_) {} }, 300);
            }
        };

        try {
            window.moveTo(screen.width - 100, screen.height - 100);
            window.resizeTo(200, 100);
        } catch(e) {}
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.focus();
            }
        } catch(e) {}

        const startedAt = Date.now();
        const tryParse = () => {
            if (finished) return;
            try {
                const data = extractCarplatesDataFromDOM(document);
                if (data && data.brand) {
                    finish(data);
                    return;
                }
            } catch(e) {
                console.warn('[OSCPV] DOM parse error:', e);
            }
            if (Date.now() - startedAt > CONFIG.CARPLATES_TIMEOUT) {
                finish(null, 'dom_timeout');
                return;
            }
            setTimeout(tryParse, 500);
        };
        setTimeout(tryParse, 500);
    }

    /**
     * Парсимо DOM сторінки carplates.app.
     */
    function extractCarplatesDataFromDOM(doc) {
        const result = {
            brand: '', model: '', year: '',
            fuel: '', engine: '', weight: '', seats: '', region: ''
        };

        const icons = doc.querySelectorAll('img[src*="/ic_"]');
        for (const ico of icons) {
            const src = ico.getAttribute('src') || '';
            const parent = ico.parentElement;
            if (!parent) continue;
            const spans = parent.querySelectorAll('span');
            if (spans.length < 2) continue;
            const value = (spans[spans.length - 1].textContent || '').trim();
            if (!value) continue;

            if (src.includes('ic_fuel') && !result.fuel) result.fuel = value;
            else if (src.includes('ic_engine') && !result.engine) result.engine = value;
            else if (src.includes('ic_weight') && !result.weight) result.weight = value;
            else if (src.includes('ic_seating') && !result.seats) result.seats = value;
        }

        const allDivs = doc.querySelectorAll('div');
        for (const div of allDivs) {
            const text = (div.textContent || '').trim();
            if (!text || text.length > 30 || div.children.length > 0) continue;
            if (/^[A-Z][A-Z0-9 \-]{1,28}$/.test(text) && text === text.toUpperCase()) {
                const next = div.nextElementSibling;
                const nextText = next ? (next.textContent || '').trim() : '';
                const yearEl = next ? next.nextElementSibling : null;
                const yearText = yearEl ? (yearEl.textContent || '').trim() : '';
                const yearMatch = yearText.match(/^(19|20)\d{2}/);
                if (nextText && nextText.length < 60 && yearMatch) {
                    result.brand = text;
                    result.model = nextText;
                    result.year = yearMatch[0];
                    break;
                }
            }
        }

        const allSpans = doc.querySelectorAll('span');
        for (const sp of allSpans) {
            if ((sp.textContent || '').trim() === 'Регіон') {
                const next = sp.nextElementSibling;
                if (next && next.tagName === 'SPAN') {
                    result.region = (next.textContent || '').trim();
                    break;
                }
            }
        }

        return result;
    }




    async function finishBatch(data) {
        log(`Готово! Зібрано ${results.length} записів`, 'ok');

        const stage = document.getElementById('oscpv-stage');
        const info = document.getElementById('oscpv-info');

        // Якщо є активні carplates-запити - чекаємо їх
        if (CARPLATES_PENDING.size > 0) {
            if (stage) stage.innerHTML = '<div class="oscpv-spinner"></div><span>Дочікую дані авто...</span>';
            if (info) info.textContent = `Опрацьовано ОСЦПВ, чекаю carplates (${CARPLATES_PENDING.size} в роботі)...`;
            try {
                await carplatesQueue;
                await Promise.all([...CARPLATES_PENDING.values()].map(p => p.catch(() => null)));
            } catch(e) {
                console.warn('[OSCPV] carplates queue завершилась з помилкою:', e);
            }
            log(`carplates: всі запити завершено`, 'ok');
        }

        document.getElementById('oscpv-start').disabled = false;
        document.getElementById('oscpv-export').disabled = results.length === 0;
        document.getElementById('oscpv-import-odoo').disabled = results.length === 0;

        if (stage) stage.innerHTML = '<span style="color:#059669">✓ Завершено</span>';
        if (info) info.textContent = `Готово: ${statsFound} полісів, ${statsEmpty} без даних`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function formatMoney(n) {
        return Number(n).toLocaleString('uk-UA').replace(/,/g, ' ');
    }

    /**
     * Розраховує дату народження з українського ІПН (РНОКПП).
     * Перші 5 цифр — кількість днів від 31.12.1899.
     */
    function ipnToBirthDate(ipn) {
        if (!ipn || !/^\d{10}$/.test(String(ipn))) return '';
        const days = parseInt(String(ipn).slice(0, 5));
        if (!days) return '';
        const base = new Date(Date.UTC(1899, 11, 31));
        base.setUTCDate(base.getUTCDate() + days);
        const dd = String(base.getUTCDate()).padStart(2, '0');
        const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = base.getUTCFullYear();
        return `${dd}.${mm}.${yyyy}`;
    }

    /**
     * Будує текст примітки для імпорту в Odoo.
     *
     * ЗМІНА (v2.8): якщо авто не знайдено (немає жодного знайденого полісу),
     * крім дати народження додаємо рядок
     *   "Авто відсутнє або зареєстровано на іншу людину".
     * Також для знайдених авто додаємо рядок з початком полісу (бінарний пошук).
     */
    function buildOdooNoteText() {
        if (!results.length) return '';

        // Беремо ПЕРШИЙ ІПН - саме його дата народження йде на початку
        const firstIpn = results[0] && results[0].ipn;
        const birthDate = firstIpn ? ipnToBirthDate(firstIpn) : '';

        const lines = [];
        if (birthDate) {
            lines.push(`Дата народження: ${birthDate}`);
            lines.push('');
        }

        // Для кожного VIN беремо поліс з найбільшим номером (найновіший)
        const byVin = new Map();
        for (const r of results) {
            if (r._notFound) continue;
            const key = r.vin || `${r.vehicle_brand}-${r.plate_no}`;
            const prev = byVin.get(key);
            if (!prev || parseInt(r.policy_no || 0) > parseInt(prev.policy_no || 0)) {
                byVin.set(key, r);
            }
        }
        const cars = [...byVin.values()];

        // Жодного авто не знайдено — пишемо про відсутність
        if (cars.length === 0) {
            lines.push('Авто відсутнє або зареєстровано на іншу людину');
            return lines.join('\n').trim();
        }

        cars.forEach((r, idx) => {
            const carTitle = cars.length > 1 ? `Авто ${idx + 1}:` : 'Авто:';
            lines.push(carTitle);

            // Якщо є дані з carplates - використовуємо їх (точніші)
            const brand = r.cp_brand || r.vehicle_brand || '';
            const model = r.cp_model || r.vehicle_title || '';
            const year = r.cp_year || r.start_date || '';
            const fuel = r.cp_fuel || '';
            const engine = r.cp_engine || '';
            const weight = r.cp_weight || '';
            const seats = r.cp_seats || '';
            const region = r.cp_region || '';

            const brandModel = [brand, model].filter(Boolean).join(' ');
            const engineLine = [fuel, engine].filter(Boolean).join(' ');

            if (brandModel) lines.push(`  Авто: ${brandModel}`);
            if (r.plate_no) lines.push(`  Номер: ${r.plate_no}`);
            if (r.vin) lines.push(`  VIN: ${r.vin}`);
            if (year) lines.push(`  Рік: ${year}`);
            if (engineLine) lines.push(`  Двигун: ${engineLine}`);
            if (weight) lines.push(`  Маса: ${weight}`);
            if (seats) lines.push(`  Сидячих місць: ${seats}`);
            if (region) lines.push(`  Регіон реєстрації: ${region}`);

            // Інформація про поліс
            if (r.policy_no) lines.push(`  Поліс №: ${r.policy_no}`);
            if (r.insurer_name) lines.push(`  Страховик: ${r.insurer_name}`);

            if (r.policy_start_exact) lines.push(`  Початок полісу: ${r.policy_start_exact}`);

            // Збитки
            const lossAmount = parseFloat(r.total_loss_amount) || 0;
            const eventsCount = parseInt(r.insured_events_count) || 0;
            if (eventsCount > 0 || lossAmount > 0) {
                lines.push(`  Збитки: ${formatMoney(lossAmount)} грн (подій: ${eventsCount})`);
            } else {
                lines.push(`  Збитки: немає`);
            }

            lines.push(''); // порожній рядок між авто
        });

        return lines.join('\n').trim();
    }

    /**
     * Імпортує текст в поле "Примітка" поточного ліда в Odoo.
     */
    async function importToOdoo() {
        const btn = document.getElementById('oscpv-import-odoo');
        const text = buildOdooNoteText();
        if (!text) {
            alert('Немає даних для імпорту');
            return;
        }

        const origLabel = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span> Імпорт...';

        try {
            let noteBtn = document.querySelector('button.o-mail-Chatter-logNote');
            if (!noteBtn) {
                const buttons = Array.from(document.querySelectorAll('button'));
                noteBtn = buttons.find(b => (b.textContent || '').trim() === 'Примітка'
                    || (b.textContent || '').trim() === 'Log note');
            }
            if (!noteBtn) {
                throw new Error('Не знайдено кнопку "Примітка" на сторінці');
            }
            console.log('[OSCPV] Клік на кнопку Примітка');
            noteBtn.click();

            const textarea = await waitForElement('textarea.o-mail-Composer-input', 5000);
            if (!textarea) {
                throw new Error('Не з\'явилось поле введення примітки');
            }

            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(textarea, text);

            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));

            textarea.focus();
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(400, textarea.scrollHeight) + 'px';

            btn.innerHTML = '<span>✓</span> Вставлено';
            setTimeout(() => { btn.innerHTML = origLabel; btn.disabled = false; }, 2000);

            setTimeout(() => closeModal(), 500);
        } catch (e) {
            console.warn('[OSCPV] importToOdoo error:', e);
            alert('Помилка імпорту: ' + e.message);
            btn.innerHTML = origLabel;
            btn.disabled = false;
        }
    }

    // Допоміжна функція: чекаємо появи елемента
    function waitForElement(selector, maxMs) {
        return new Promise(resolve => {
            const found = document.querySelector(selector);
            if (found) return resolve(found);

            const start = Date.now();
            const interval = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(interval);
                    resolve(el);
                    return;
                }
                if (Date.now() - start > maxMs) {
                    clearInterval(interval);
                    resolve(null);
                }
            }, 100);
        });
    }

    function exportExcel() {
        if (!results.length) return alert('Немає даних для експорту');
        // У Excel виключаємо технічне поле _notFound
        const cleanResults = results.map(r => {
            const c = {...r};
            delete c._notFound;
            return c;
        });
        const ws = XLSX.utils.json_to_sheet(cleanResults);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'OSCPV');
        XLSX.writeFile(wb, `oscpv_b2c_${new Date().toISOString().slice(0,10)}_${Date.now()}.xlsx`);
    }


    // =====================================================================
    //                СТОРОНА DICT.UNIVERSALNA.COM (вся робота)
    // =====================================================================

    function initDictSide() {
        const hash = location.hash;
        const m = hash.match(/oscpv_session=(\w+)/);
        if (!m) return; // звичайний візит, нічого не робимо

        const sessionId = m[1];
        const reqRaw = GM_getValue('oscpv_request_' + sessionId);
        if (!reqRaw) {
            console.warn('[OSCPV] Сесію не знайдено:', sessionId);
            return;
        }

        const req = JSON.parse(reqRaw);
        console.log('[OSCPV] Запуск обробки в dict-вкладці', req);

        try {
            if (window.opener && !window.opener.closed) {
                window.opener.focus();
            }
        } catch(e) {}
        try {
            window.moveTo(screen.width - 100, screen.height - 100);
            window.resizeTo(200, 100);
        } catch(e) {}

        showDictBanner();

        waitForLiveToken(20000).then(token => {
            if (!token) {
                token = localStorage.getItem('token');
            }
            if (!token) {
                pushProgress(sessionId, {log: 'НЕ ЗНАЙДЕНО актуальний токен', logType: 'err'});
                pushResult(sessionId, {error: 'no_token'});
                return;
            }
            console.log('[OSCPV] Стартую batch з токеном довжиною', token.length);
            processBatch(sessionId, req);
        });
    }

    async function waitForLiveToken(maxMs) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            if (LIVE_TOKEN) return LIVE_TOKEN;
            await sleep(300);
        }
        return null;
    }

    function getCurrentToken() {
        return LIVE_TOKEN || localStorage.getItem('token');
    }

    function pushProgress(sessionId, payload) {
        payload._ts = Date.now() + Math.random();
        GM_setValue('oscpv_progress_' + sessionId, JSON.stringify(payload));
    }

    function pushResult(sessionId, payload) {
        GM_setValue('oscpv_result_' + sessionId, JSON.stringify(payload));
    }

    function showDictBanner() {
        const b = document.createElement('div');
        b.id = 'oscpv-banner';
        b.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0;
            background: #28a745; color: #fff;
            padding: 10px 20px; text-align: center;
            font-family: Arial, sans-serif; font-size: 14px;
            z-index: 2147483647; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        `;
        b.innerHTML = '🤖 OSCPV скрипт обробляє ІПН — не закривайте цю вкладку <span id="oscpv-banner-status"></span>';
        document.body.appendChild(b);
    }

    function updateBanner(text) {
        const s = document.getElementById('oscpv-banner-status');
        if (s) s.textContent = ' — ' + text;
    }

    async function processBatch(sessionId, req) {
        const { ipns, delayRun, delayIpn } = req;
        const today = new Date().toISOString().slice(0, 10);

        for (let i = 0; i < ipns.length; i++) {
            const ipn = ipns[i];
            const prefix = `[${i+1}/${ipns.length}] ${ipn}`;
            updateBanner(`${i+1}/${ipns.length}`);

            try {
                pushProgress(sessionId, {log: `${prefix}: INSERT в dict...`, logType: 'dim'});
                const inserted = await dictInsert(ipn, today);
                const newId = extractIdFromInsert(inserted);
                pushProgress(sessionId, {log: `${prefix}: створено id=${newId || '?'}`, logType: 'dim'});

                pushProgress(sessionId, {log: `${prefix}: RUN на import-tool...`, logType: 'dim'});
                await importToolRun(ipn);

                pushProgress(sessionId, {log: `${prefix}: чекаю ${delayRun}мс обробку...`, logType: 'info'});
                await sleep(delayRun);

                pushProgress(sessionId, {log: `${prefix}: парсинг таблиці...`, logType: 'dim'});
                const responseJson = await parseTableForIpn(ipn, newId, sessionId);

                if (!responseJson) {
                    pushProgress(sessionId, {log: `${prefix}: ✗ не знайдено response в таблиці`, logType: 'err'});
                } else if (responseJson.oscpv === null || (Array.isArray(responseJson.oscpv) && responseJson.oscpv.length === 0)) {
                    pushProgress(sessionId, {
                        log: `${prefix}: ⚠ Авто відсутнє або страхування не на клієнті`,
                        logType: 'err',
                        progress: i + 1,
                        newResults: [{
                            ipn,
                            policy_no: '—',
                            full_name: 'Авто відсутнє або страхування не на клієнті',
                            vehicle_brand: '',
                            vehicle_title: '',
                            plate_no: '',
                            insurer_name: '',
                            _notFound: true
                        }]
                    });
                } else {
                    const oscpvList = responseJson.oscpv.map(p => ({ipn, ...p}));

                    // Дата початку полісу (бінарний пошук через dict/import-tool)
                    if (req.policyStart) {
                        await enrichPolicyStart(oscpvList, ipn, sessionId, delayRun, prefix);
                    }

                    pushProgress(sessionId, {
                        log: `${prefix}: ✓ знайдено ${oscpvList.length} полісів`,
                        logType: 'ok',
                        progress: i + 1,
                        newResults: oscpvList
                    });
                }

                if (i < ipns.length - 1) await sleep(delayIpn);
            } catch(e) {
                console.error(e);
                pushProgress(sessionId, {
                    log: `${prefix}: ПОМИЛКА ${e.message}`,
                    logType: 'err',
                    progress: i + 1
                });
            }
        }

        pushResult(sessionId, {done: true});
        updateBanner('завершено ✓');
        setTimeout(() => window.close(), 3000);
    }

    function dictInsert(ipn, today) {
        const payload = {
            label_: ipn,
            ident_code: ipn,
            plate_no: null, vin: null,
            surname: null, given_name: null, middle_name: null,
            start_date: "2025-01-01",
            end_date: today,
            policy_type: "OSCPV",
            server_: "P",
            status: 0
        };
        const token = getCurrentToken();
        return fetch(CONFIG.INSERT_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(payload)
        }).then(r => {
            if (!r.ok) throw new Error('INSERT HTTP ' + r.status);
            return r.json();
        });
    }

    // ====== ДАТА ПОЧАТКУ ПОЛІСУ (бінарний пошук через dict) ======
    // Для поточного VIN: бінарний пошук дає точну дату поточного полісу.
    // Попередні полісу: дата = дата_поточного - N*365 (без додаткових запитів).
    async function enrichPolicyStart(oscpvList, ipn, sessionId, delayRun, prefix) {
        const seen = new Set();
        for (const pol of oscpvList) {
            const vin = (pol.vin || '').trim();
            if (!vin || seen.has(vin)) continue;
            seen.add(vin);
            try {
                // All these are already known from the main MTSBU response — no range probe needed
                const vinPolicies = oscpvList
                    .filter(q => (q.vin || '').trim() === vin)
                    .sort((a, b) => parseInt(b.policy_no || 0) - parseInt(a.policy_no || 0));
                const newest    = vinPolicies[0];
                const knownP0        = (newest.policy_no || '').toString();
                const knownEnd       = newest.end_date   || '';
                const knownPrev      = vinPolicies[1] ? (vinPolicies[1].policy_no || '').toString() : '';
                const knownPrevEnd   = vinPolicies[1] ? (vinPolicies[1].end_date  || '') : '';
                const startYearRaw   = parseInt(newest.start_date || '');
                const knownStartYear = (startYearRaw >= 2000 && startYearRaw <= 2100) ? startYearRaw : 0;

                pushProgress(sessionId, {log: `${prefix}: початок полісу для VIN ${vin}...`, logType: 'info'});
                const result = await findPolicyStartByDate(ipn, vin, sessionId, delayRun, knownP0, knownEnd, knownPrev, knownPrevEnd, knownStartYear);
                if (result) {
                    const startDate = result.startDate || '';
                    const p0 = (result.policyNum || '').toString();
                    const curIdx = Math.max(0, vinPolicies.findIndex(
                        q => (q.policy_no || '').toString() === p0
                    ));
                    vinPolicies.forEach((q, i) => {
                        const stepsBack = i - curIdx;
                        if (stepsBack === 0) {
                            q.policy_start_exact = startDate;
                        } else if (stepsBack > 0 && result.startDateRaw) {
                            q.policy_start_exact = '≈ ' + uaDate(addDaysD(result.startDateRaw, stepsBack * -365));
                        }
                    });
                    const prevDate = result.startDateRaw ? uaDate(addDaysD(result.startDateRaw, -365)) : '';
                    pushProgress(sessionId, {log: `${prefix}: VIN ${vin} → початок ${startDate}` +
                        (result.prevPolicy && prevDate ? ` (попередній ${result.prevPolicy}: ≈ ${prevDate})` : ''),
                        logType: 'ok'});
                } else {
                    pushProgress(sessionId, {log: `${prefix}: VIN ${vin} — дату початку не визначено`, logType: 'err'});
                }
            } catch(e) {
                console.warn('[OSCPV] enrichPolicyStart error', e);
                pushProgress(sessionId, {log: `${prefix}: VIN ${vin} — помилка: ${e.message}`, logType: 'err'});
            }
        }
    }

    // All known* params come from the main MTSBU response (oscpvList) — zero extra requests to derive them.
    // Fast path (knownPrevEnd set): 2 INSERTs + 1 RUN — handles consecutive policies in 1 step.
    // Fallback: K=2 search (2 INSERTs per RUN, window ÷3 per step) — optimal request count.
    async function findPolicyStartByDate(ipn, vin, sessionId, delayRun, knownP0 = '', knownEnd = '', knownPrev = '', knownPrevEnd = '', knownStartYear = 0) {
        const today = new Date();
        const todayISO = isoDate(today);

        let P0, prevPolicy, endDate;

        if (knownP0) {
            P0 = knownP0;
            prevPolicy = knownPrev;
            endDate = knownEnd;
        } else {
            // Range probe fallback (only when called without P0 — should not happen in normal flow)
            const lo400 = addDaysD(today, -400);
            const lo400ISO = isoDate(lo400);
            pushProgress(sessionId, {log: `   VIN ${vin}: діапазон ${lo400ISO}–${todayISO}...`, logType: 'dim'});
            const allPols = await probeRangeDates(ipn, vin, lo400ISO, todayISO, delayRun, sessionId);
            if (!allPols || !allPols.length) {
                pushProgress(sessionId, {log: `   VIN ${vin}: на сьогодні полісу немає`, logType: 'dim'});
                return null;
            }
            const sorted = allPols.slice().sort((a, b) => (b.end || '').localeCompare(a.end || ''));
            const current = sorted.find(p => !p.end || p.end >= todayISO) || sorted[0];
            if (!current || !current.policyNo) return null;
            P0 = current.policyNo;
            endDate = current.end;
            const prevPol = sorted.find(p => p.policyNo !== P0);
            prevPolicy = prevPol ? prevPol.policyNo : '';
            const fullStart = uaFullDate(current.start);
            if (fullStart) {
                pushProgress(sessionId, {log: `   VIN ${vin}: № ${P0}, початок ${fullStart} (з діапазону)`, logType: 'dim'});
                return { startDate: fullStart, startDateRaw: new Date(current.start), policyNum: P0, endDate, prevPolicy };
            }
        }

        // Upper bound: day before policy end (or today).
        const hiRef = endDate ? new Date(endDate) : new Date(today);
        let hiD = hiRef > today ? new Date(today) : new Date(hiRef);
        // Lower bound: start of known start_year (or 400 days back as fallback).
        let loD = (knownStartYear >= 2000 && knownStartYear <= 2100)
            ? new Date(`${knownStartYear}-01-01`)
            : addDaysD(hiD, -400);
        if (loD > hiD) loD = addDaysD(hiD, -400); // safety: year boundary edge case

        const vu = vin ? vin.toUpperCase() : '';

        // Fast path: 1 range INSERT [prevEnd, prevEnd+1] + 1 RUN.
        // Range covers the boundary between prevPolicy and P0 — MTSBU returns both when start = prevEnd+1.
        //   Both P0 + prevPolicy found → consecutive: start = d1.
        //   Only P0 found → overlap: start = d0.
        //   P0 not found → gap: fall through to K=2 range.
        if (knownPrevEnd) {
            const prevEndDate = new Date(knownPrevEnd);
            const d0 = isoDate(prevEndDate);
            const d1 = isoDate(addDaysD(prevEndDate, 1));
            pushProgress(sessionId, {log: `   VIN ${vin}: № ${P0}, швидка проба [${d0}–${d1}]...`, logType: 'dim'});
            const ins = await dictInsertProbe(ipn, d0, d1, ipn);
            await importToolRun(ipn);
            await sleep(delayRun);
            const fastPols = await tryParseAllForId(extractIdFromInsert(ins), vu, sessionId);
            const fp0   = fastPols?.find(p => p.policyNo === P0);
            const fprev = prevPolicy ? fastPols?.find(p => p.policyNo === prevPolicy) : null;
            pushProgress(sessionId, {log: `   VIN ${vin} [${d0}–${d1}] → P0:${fp0 ? P0 : '—'} prev:${fprev ? prevPolicy : '—'}`, logType: 'dim'});

            if (fp0) {
                const fullStart = uaFullDate(fp0.start || '');
                // Both found → consecutive (d1); only P0 → overlap (d0); full date → exact.
                const startISO = fullStart ? fp0.start : (fprev ? d1 : d0);
                const startDateRaw = new Date(startISO);
                const res = { startDate: fullStart || uaDate(startDateRaw), startDateRaw, policyNum: P0, endDate };
                if (prevPolicy) res.prevPolicy = prevPolicy;
                return res;
            }
            // P0 not in [d0, d1] — gap; narrow lower bound.
            const afterGap = addDaysD(prevEndDate, 2);
            if (afterGap > loD) loD = afterGap;
            pushProgress(sessionId, {log: `   VIN ${vin}: розрив, пошук [${isoDate(loD)}–${isoDate(hiD)}]...`, logType: 'dim'});
        } else {
            pushProgress(sessionId, {log: `   VIN ${vin}: № ${P0}, пошук [${isoDate(loD)}–${isoDate(hiD)}]...`, logType: 'dim'});
        }

        // K=2 range: 1 INSERT [m1, m2] per RUN — half the dict requests vs 2 separate INSERTs.
        // Presence of P0 and prevPolicy in the range response gives the same 3-way split as K=2:
        //   only P0 → start ≤ m1 (hiD = m1);  both → start in (m1, m2] (middle third);
        //   only prev / neither → start > m2 (loD = m2).
        // Also terminates early if MTSBU returns the exact start_date for P0.
        while (daysDiffD(loD, hiD) > 1) {
            const span = daysDiffD(loD, hiD);
            if (span <= 2) {
                const mid = isoDate(addDaysD(loD, 1));
                const ins = await dictInsertProbe(ipn, mid, mid, ipn);
                await importToolRun(ipn);
                await sleep(delayRun);
                const r = await tryParseMultipleIds(ipn, vin, [extractIdFromInsert(ins)], sessionId);
                pushProgress(sessionId, {log: `   VIN ${vin} @ ${mid} [${span}д] → ${r?.[0]?.policyNo || '—'}`, logType: 'dim'});
                if (r?.[0]?.policyNo === P0) hiD = new Date(mid); else loD = new Date(mid);
                break;
            }
            const m1 = isoDate(addDaysD(loD, Math.floor(span / 3)));
            const m2 = isoDate(addDaysD(loD, Math.floor(2 * span / 3)));
            const ins = await dictInsertProbe(ipn, m1, m2, ipn);
            await importToolRun(ipn);
            await sleep(delayRun);
            const allPols  = await tryParseAllForId(extractIdFromInsert(ins), vu, sessionId);
            const p0data   = allPols?.find(p => p.policyNo === P0);
            const foundP0  = !!p0data;
            const foundPrev = prevPolicy ? allPols?.some(p => p.policyNo === prevPolicy) : false;
            pushProgress(sessionId, {log: `   VIN ${vin} [${m1}–${m2}] [${span}д] → ${foundP0 ? P0 : '—'}${foundPrev ? '+'+prevPolicy : ''}`, logType: 'dim'});
            if (p0data) {
                const fullStart = uaFullDate(p0data.start || '');
                if (fullStart) {
                    const res = { startDate: fullStart, startDateRaw: new Date(p0data.start), policyNum: P0, endDate };
                    if (prevPolicy) res.prevPolicy = prevPolicy;
                    return res;
                }
            }
            if (foundP0 && !foundPrev) {
                hiD = new Date(m1);     // P0 covers all of [m1,m2] → start ≤ m1
            } else if (foundP0) {
                loD = new Date(m1);
                hiD = new Date(m2);     // boundary in (m1,m2] → middle third
            } else {
                loD = new Date(m2);     // P0 not in range → start > m2
            }
        }

        const res = { startDate: uaDate(hiD), startDateRaw: new Date(hiD), policyNum: P0, endDate };
        if (prevPolicy) res.prevPolicy = prevPolicy;
        return res;
    }

    // Polls GM cache (populated by dict page fetch interceptor) until fresh rows appear.
    // afterTs: cache entries older than this are ignored (stale from prev run).
    async function tryParseFromApiCache(pendingIds, extractFn, afterTs, maxWaitMs) {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const raw = GM_getValue('dict444_api_cache', '');
            if (raw) {
                try {
                    const { ts, rows } = JSON.parse(raw);
                    if (ts > afterTs && Array.isArray(rows) && rows.length) {
                        const found = new Map();
                        for (const r of rows) {
                            if (!pendingIds.includes(r.id)) continue;
                            const parsed = extractFn(r.resp || '');
                            if (parsed !== null) found.set(r.id, parsed);
                        }
                        if (found.size > 0) return found;
                    }
                } catch(e) {}
            }
            await sleep(600);
        }
        return null;
    }

    // Один або кілька ID. Три рівні швидкості:
    // 1) fetchTableRowsDirect (GM_xmlhttpRequest, без iframe)
    // 2) iframe tiny + GM cache (fetch interceptor в dict-контексті)
    // 3) iframe full + DOM parsing
    async function tryParseMultipleIds(ipn, vin, ids, sessionId) {
        const ATTEMPT_DELAY = 3000;
        const vu = vin ? vin.toUpperCase() : '';

        const extractPol = (respText) => {
            if (!respText) return null;
            try {
                const parsed = JSON.parse(respText);
                if (!Array.isArray(parsed.oscpv) || !parsed.oscpv.length) return { policyNo: null };
                const pol = (vu && parsed.oscpv.find(p => (p.vin || '').toUpperCase() === vu)) || parsed.oscpv[0];
                return { policyNo: (pol.policy_no || '').toString(), start: pol.start_date || '', end: pol.end_date || '' };
            } catch(e) { return null; }
        };

        const applyRows = (allRows, pending, results) => {
            for (const r of allRows) {
                if (!pending.includes(r.id) || results.has(r.id)) continue;
                const pol = extractPol(r.resp);
                if (pol !== null) results.set(r.id, pol);
            }
        };

        const results = new Map();

        // === Рівень 1: прямий запит (немає iframe) ===
        let directWorked = false;
        for (let attempt = 1; attempt <= 6 && !ids.every(id => results.has(id)); attempt++) {
            const pending = ids.filter(id => !results.has(id));
            try {
                const allRows = await fetchTableRowsDirect();
                if (allRows) {
                    directWorked = true;
                    applyRows(allRows, pending, results);
                    if (ids.every(id => results.has(id))) break;
                }
            } catch(e) { console.log('[OSCPV] direct fetch err:', e.message); }
            if (!directWorked) break; // URL не знайдено — одразу до iframe
            if (attempt < 6) await sleep(ATTEMPT_DELAY);
        }
        if (ids.every(id => results.has(id))) return ids.map(id => results.get(id));

        // === Рівень 2: iframe tiny + GM cache ===
        for (let attempt = 1; attempt <= 8 && !ids.every(id => results.has(id)); attempt++) {
            const pending = ids.filter(id => !results.has(id));
            const beforeTs = Date.now();
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:400px;height:300px;border:0;';
            iframe.src = CONFIG.TABLE_URL + '?_=' + Date.now();
            document.body.appendChild(iframe);
            try {
                const cacheHit = await tryParseFromApiCache(pending, extractPol, beforeTs, 18000);
                if (cacheHit) {
                    for (const [id, pol] of cacheHit) results.set(id, pol);
                    if (ids.every(id => results.has(id))) break;
                    if (attempt < 8) await sleep(ATTEMPT_DELAY);
                    continue;
                }
                // Cache didn't fire — escalate to DOM for this attempt
                iframe.style.width = '1800px'; iframe.style.height = '1000px';
                const rows = await waitForRows(iframe, CONFIG.ROW_WAIT_TIMEOUT);
                if (rows.length) {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    const sorted = await clickSortAsc(doc);
                    if (sorted) await sleep(1500);
                    for (const row of Array.from(doc.querySelectorAll('tr.el-table__row'))) {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 19) continue;
                        const cellId = parseInt((cells[COL.ID].textContent || '').trim());
                        if (!pending.includes(cellId) || results.has(cellId)) continue;
                        const respCell = cells[COL.RESPONSE];
                        const respSpan = respCell && respCell.querySelector('span');
                        const pol = extractPol(((respSpan ? respSpan.textContent : respCell?.textContent) || '').trim());
                        if (pol !== null) results.set(cellId, pol);
                    }
                }
            } finally { iframe.remove(); }
            if (ids.every(id => results.has(id))) break;
            if (attempt < 8) await sleep(ATTEMPT_DELAY);
        }

        return ids.map(id => results.get(id) || { policyNo: null });
    }

    // Для одного ID повертає ВСІ полісу з response-колонки (для діапазонної проби).
    // Три рівні: fetchTableRowsDirect → iframe+cache → iframe+DOM
    async function tryParseAllForId(id, vu, sessionId) {
        const ATTEMPT_DELAY = 3000;

        const extractAll = (respText) => {
            if (!respText) return null;
            try {
                const parsed = JSON.parse(respText);
                if (!Array.isArray(parsed.oscpv) || !parsed.oscpv.length) return [];
                const all = parsed.oscpv.map(p => ({
                    policyNo: (p.policy_no || '').toString(),
                    start:    p.start_date || '',
                    end:      p.end_date   || '',
                    vin:      (p.vin || '').toUpperCase()
                }));
                return vu ? all.filter(p => !p.vin || p.vin === vu) : all;
            } catch(e) { return null; }
        };

        // === Рівень 1: прямий запит (немає iframe) ===
        let directWorked = false;
        for (let attempt = 1; attempt <= 6; attempt++) {
            try {
                const allRows = await fetchTableRowsDirect();
                if (allRows) {
                    directWorked = true;
                    const row = allRows.find(r => r.id === id);
                    if (row?.resp) {
                        const pols = extractAll(row.resp);
                        if (pols !== null) return pols;
                    }
                }
            } catch(e) { console.log('[OSCPV] direct fetch err:', e.message); }
            if (!directWorked) break;
            if (attempt < 6) await sleep(ATTEMPT_DELAY);
        }

        // === Рівень 2 + 3: iframe (cache → DOM fallback) ===
        for (let attempt = 1; attempt <= 8; attempt++) {
            const beforeTs = Date.now();
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:400px;height:300px;border:0;';
            iframe.src = CONFIG.TABLE_URL + '?_=' + Date.now();
            document.body.appendChild(iframe);
            try {
                const cacheHit = await tryParseFromApiCache([id], extractAll, beforeTs, 18000);
                if (cacheHit && cacheHit.has(id)) return cacheHit.get(id);

                // DOM fallback
                iframe.style.width = '1800px'; iframe.style.height = '1000px';
                const rows = await waitForRows(iframe, CONFIG.ROW_WAIT_TIMEOUT);
                if (rows.length) {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    const sorted = await clickSortAsc(doc);
                    if (sorted) await sleep(1500);
                    for (const row of Array.from(doc.querySelectorAll('tr.el-table__row'))) {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 19) continue;
                        if (parseInt((cells[COL.ID].textContent || '').trim()) !== id) continue;
                        const respCell = cells[COL.RESPONSE];
                        const respSpan = respCell && respCell.querySelector('span');
                        const pols = extractAll(((respSpan ? respSpan.textContent : respCell?.textContent) || '').trim());
                        if (pols !== null) return pols;
                    }
                }
            } finally { iframe.remove(); }
            if (attempt < 8) await sleep(ATTEMPT_DELAY);
        }
        return null;
    }

    // Один INSERT з діапазоном дат → 1 RUN → всі полісу за діапазон
    async function probeRangeDates(ipn, vin, startISO, endISO, delayRun, sessionId) {
        const inserted = await dictInsertProbe(ipn, startISO, endISO, ipn);
        const id = extractIdFromInsert(inserted);
        await importToolRun(ipn);
        await sleep(delayRun);
        const vu = vin ? vin.toUpperCase() : '';
        return tryParseAllForId(id, vu, sessionId);
    }

    // INSERT проби: ident_code=ІПН, start_date/end_date — діапазон або точна дата
    function dictInsertProbe(ipn, startISO, endISO, label) {
        const payload = {
            label_: label,
            ident_code: ipn,
            plate_no: null, vin: null,
            surname: null, given_name: null, middle_name: null,
            start_date: startISO,
            end_date: endISO,
            policy_type: "OSCPV",
            server_: "P",
            status: 0
        };
        const token = getCurrentToken();
        return fetch(CONFIG.INSERT_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(payload)
        }).then(r => {
            if (!r.ok) throw new Error('PROBE INSERT HTTP ' + r.status);
            return r.json();
        });
    }

    // ── Дата-утиліти ──
    function isoDate(d) { return d.toISOString().slice(0, 10); }                 // YYYY-MM-DD
    function uaDate(d) {
        return [d.getDate(), d.getMonth() + 1, d.getFullYear()]
            .map(n => String(n).padStart(2, '0')).join('.');                      // DD.MM.YYYY
    }
    function addDaysD(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
    function daysDiffD(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000); }

    // Повертає DD.MM.YYYY лише якщо рядок — ПОВНА дата (а не рік). Інакше ''.
    function uaFullDate(s) {
        if (!s) return '';
        s = String(s).trim();
        let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // YYYY-MM-DD
        if (m) return `${m[3]}.${m[2]}.${m[1]}`;
        m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);              // DD.MM.YYYY
        if (m) return `${m[1]}.${m[2]}.${m[3]}`;
        return '';
    }


    function extractIdFromInsert(response) {
        if (!response) return null;
        if (typeof response === 'number') return response;
        if (response.id) return response.id;
        if (response.data && response.data.id) return response.data.id;
        if (Array.isArray(response) && response[0] && response[0].id) return response[0].id;
        return null;
    }

    function importToolRun(ipn) {
        const token = getCurrentToken();
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.RUN_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                data: JSON.stringify({ ImportLabel: ipn }),
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        resolve(r.responseText);
                    } else {
                        reject(new Error('RUN HTTP ' + r.status));
                    }
                },
                onerror: () => reject(new Error('RUN network error'))
            });
        });
    }

    // Tier 1: direct HTTP fetch; Tier 2: iframe DOM fallback.
    async function parseTableForIpn(ipn, expectedId, sessionId) {
        const MAX_ATTEMPTS = 12;
        const ATTEMPT_DELAY = 3000;
        let directKnown = null; // null=not tried, true=URL works, false=URL unavailable

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (sessionId) pushProgress(sessionId, {
                log: `   спроба ${attempt}/${MAX_ATTEMPTS} (id=${expectedId})...`,
                logType: 'dim'
            });

            if (directKnown !== false) {
                try {
                    const allRows = await fetchTableRowsDirect();
                    if (allRows !== null) {
                        directKnown = true;
                        const row = expectedId ? allRows.find(r => r.id === expectedId) : null;
                        if (row?.resp) {
                            try {
                                const parsed = JSON.parse(row.resp);
                                if (sessionId) pushProgress(sessionId, {log: `   ✓ id=${expectedId} знайдено`, logType: 'ok'});
                                return parsed;
                            } catch(e) {
                                if (sessionId) pushProgress(sessionId, {log: `   ⚠ response не JSON`, logType: 'err'});
                                return null;
                            }
                        }
                        if (sessionId) pushProgress(sessionId, {
                            log: row ? `   id=${expectedId} є, resp порожній — чекаю...`
                                     : `   id=${expectedId} ще не з'явився — чекаю...`,
                            logType: 'dim'
                        });
                        if (attempt < MAX_ATTEMPTS) await sleep(ATTEMPT_DELAY);
                        continue;
                    }
                    directKnown = false; // URL not cached yet — fall through to iframe
                } catch(e) {
                    directKnown = false;
                }
            }

            // Iframe fallback (used when direct fetch URL is not yet cached)
            const result = await tryParseOnce(ipn, expectedId);

            if (result.found && result.responseText) {
                try {
                    const parsed = JSON.parse(result.responseText);
                    if (sessionId) pushProgress(sessionId, {log: `   ✓ знайдено id=${result.foundId}`, logType: 'ok'});
                    return parsed;
                } catch(e) {
                    console.warn('[OSCPV] response не JSON:', result.responseText.slice(0, 300));
                    if (sessionId) pushProgress(sessionId, {
                        log: `   ⚠ response не JSON: ${result.responseText.slice(0,80)}...`,
                        logType: 'err'
                    });
                    return null;
                }
            }

            if (result.found && !result.responseText) {
                if (sessionId) pushProgress(sessionId, {log: `   рядок id=${result.foundId} є, але response ще порожній — чекаю...`, logType: 'dim'});
            } else if (!result.found) {
                if (sessionId) pushProgress(sessionId, {log: `   рядок з id=${expectedId} ще не з'явився — чекаю...`, logType: 'dim'});
            }

            if (attempt < MAX_ATTEMPTS) await sleep(ATTEMPT_DELAY);
        }

        return null;
    }

    /**
     * Одна спроба парсингу через свіжий iframe.
     */
    async function tryParseOnce(ipn, expectedId) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1800px;height:1000px;border:0;';
        iframe.src = CONFIG.TABLE_URL + '?_=' + Date.now();
        document.body.appendChild(iframe);

        try {
            let rows = await waitForRows(iframe, CONFIG.ROW_WAIT_TIMEOUT);
            if (!rows.length) return { found: false };

            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const sorted = await clickSortAsc(doc);

            if (sorted) {
                await sleep(1500);
            }

            rows = Array.from(doc.querySelectorAll('tr.el-table__row'));
            if (!rows.length) return { found: false };

            if (expectedId) {
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 19) continue;
                    const cellId = parseInt((cells[COL.ID].textContent || '').trim());
                    if (cellId === expectedId) {
                        const respCell = cells[COL.RESPONSE];
                        const respSpan = respCell && respCell.querySelector('span');
                        const respText = ((respSpan ? respSpan.textContent : respCell?.textContent) || '').trim();
                        return { found: true, foundId: expectedId, responseText: respText };
                    }
                }
                return { found: false };
            }

            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 19) continue;
                const idText = (cells[COL.ID].textContent || '').trim();
                const identText = (cells[COL.IDENT_CODE].textContent || '').trim();
                const labelText = cells[COL.LABEL] ? (cells[COL.LABEL].textContent || '').trim() : '';
                if (identText === String(ipn) || labelText === String(ipn)) {
                    const respCell = cells[COL.RESPONSE];
                    const respSpan = respCell && respCell.querySelector('span');
                    const respText = ((respSpan ? respSpan.textContent : respCell?.textContent) || '').trim();
                    return {
                        found: true,
                        foundId: parseInt(idText) || 0,
                        responseText: respText
                    };
                }
            }
            return { found: false };
        } finally {
            iframe.remove();
        }
    }

    /**
     * Знаходить у заголовку таблиці колонку id та клікає на стрілку sort-caret.ascending.
     */
    async function clickSortAsc(doc) {
        try {
            const idHeader = doc.querySelector('th.el-table_1_column_1');
            if (!idHeader) {
                console.warn('[OSCPV] th колонки id не знайдено');
                return false;
            }
            const ascCaret = idHeader.querySelector('i.sort-caret.ascending');
            if (!ascCaret) {
                console.warn('[OSCPV] sort-caret.ascending не знайдено');
                return false;
            }

            if (ascCaret.classList.contains('active')) {
                console.log('[OSCPV] ASC сортування вже активне');
                return true;
            }

            ['mousedown', 'mouseup', 'click'].forEach(type => {
                ascCaret.dispatchEvent(new MouseEvent(type, {
                    bubbles: true, cancelable: true, view: doc.defaultView
                }));
            });
            console.log('[OSCPV] Клік на сортування ASC виконано');
            return true;
        } catch(e) {
            console.warn('[OSCPV] Помилка кліку на сортування:', e);
            return false;
        }
    }


    function waitForRows(iframe, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                let rows = [];
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    rows = Array.from(doc.querySelectorAll('tr.el-table__row'));
                } catch(e) { /* ще не готовий */ }

                if (rows.length > 0) {
                    setTimeout(() => {
                        try {
                            const doc = iframe.contentDocument || iframe.contentWindow.document;
                            resolve(Array.from(doc.querySelectorAll('tr.el-table__row')));
                        } catch(e) { resolve([]); }
                    }, 800);
                    return;
                }
                if (Date.now() - start > timeoutMs) { resolve([]); return; }
                setTimeout(check, CONFIG.ROW_WAIT_INTERVAL);
            };
            check();
        });
    }

})();
