// ==UserScript==
// @name         OSCPV B2C — Пошук полісів (Odoo + Universalna)
// @namespace    universalna.oscpv.b2c
// @version      2.7.1-b2c
// @description  B2C: ОСЦПВ + дані авто через вкладку-проксі carplates.app
// @author       custom
// @match        https://odoo.icu.int/*
// @match        https://dict.universalna.com/*
// @match        https://ua.carplates.app/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
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
        DELAY_AFTER_RUN: 6000,
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
                return origFetch.apply(this, arguments);
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
            console.log('[OSCPV] Token sniffer installed');
        } catch(e) {
            console.warn('[OSCPV] Could not install sniffer:', e);
        }
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

    if (host === 'odoo.icu.int') {
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
                                <span class="oscpv-ico-sm">🪄</span>
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
     * Витягує ІПН клієнта з поточного ліда CRM через Odoo web_read API.
     * URL поточного ліда має формат:
     *   odoo.icu.int/web#id=366339&model=crm.lead&...
     * Робимо POST на /web/dataset/call_kw з model=crm.lead, method=web_read.
     * З partner_id.display_name витягуємо останню послідовність з 10 цифр.
     */
    /**
     * Витягує ІПН клієнта зі сторінки ліда CRM.
     * Просто читаємо значення з input#partner_id_1 (поле "Клієнт" у формі).
     * Очікуваний формат: "Прізвище Ім'я По-батькові ‒ 1234567890"
     */
    async function autoFillIpnFromLead() {
        const btn = document.getElementById('oscpv-auto');
        const textarea = document.getElementById('oscpv-ipns');
        const origText = btn.textContent;

        try {
            btn.disabled = true;
            btn.textContent = '⏳ Шукаю...';

            // 1. Шукаємо поле "Клієнт" на сторінці ліда
            // Спершу пробуємо точний id, потім ширше — будь-який input всередині name="partner_id"
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
            // Формат: "Прізвище Ім'я По-батькові ‒ 2099205955"
            const matches = displayName.match(/\b\d{10}\b/g);
            if (!matches || !matches.length) {
                alert(`У імені клієнта не знайдено 10-значного ІПН.\n\nЗначення: "${displayName}"`);
                return;
            }
            const ipn = matches[matches.length - 1];

            // 3. Підставляємо у textarea
            const cur = textarea.value.trim();
            if (cur && !cur.split('\n').includes(ipn)) {
                textarea.value = cur + '\n' + ipn;
            } else if (!cur) {
                textarea.value = ipn;
            }

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
                border-radius: 16px; width: 90%; max-width: 760px; max-height: 92vh;
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
                        <th>Авто</th><th>Страховик</th><th>Рік</th><th>Збитки</th><th style="width:50px">Дані</th>
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

        const sessionId = 'oscpv_' + Date.now();
        GM_setValue('oscpv_request_' + sessionId, JSON.stringify({
            ipns, delayRun, delayIpn,
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
            log('ПОМИЛКА: спливаючі вікна заблоковані. Дозвольте їх для odoo.icu.int', 'err');
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

                    // Рік укладання поліса
                    const policyYear = r.start_date || '';

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
                        <td>${escapeHtml(policyYear)}</td>
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
     * Логіка:
     *   1. Відкриваємо https://ua.carplates.app/vin/{VIN}#cp_session=X
     *   2. У тій вкладці працює наш же скрипт (initCarplatesSide)
     *   3. Він перехоплює нативний запит сайту до api.carplates.app/summary
     *   4. Витягує дані, шле назад через GM_setValue, закриває вкладку
     */
    function parseCarplates(vin) {
        return new Promise((resolve, reject) => {
            const sessId = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const resKey = 'oscpv_cp_res_' + sessId;
            const startedAt = Date.now();

            const url = CONFIG.CARPLATES_VIN_URL + encodeURIComponent(vin) + '#cp_session=' + sessId;
            console.log('[OSCPV] Open carplates popup:', url);

            // Відкриваємо як POPUP WINDOW (окреме маленьке вікно), а НЕ вкладку.
            // Це залишає головне вікно браузера у фокусі.
            // Маленьке вікно ховаємо за межами видимої області екрана.
            const features = [
                'popup=yes',
                'width=500',
                'height=400',
                'left=' + (screen.width - 100),  // майже за межами справа
                'top=' + (screen.height - 100),  // майже за межами знизу
                'menubar=no',
                'toolbar=no',
                'location=no',
                'status=no',
                'noopener=no',  // потрібно для window.close() з нашого боку
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
                // Деякі браузери ігнорують blur з popup, тому ставимо інтервал
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
            // Повертаємо фокус на відкривачку (Odoo) перед закриттям
            try {
                if (window.opener && !window.opener.closed) {
                    window.opener.focus();
                }
            } catch(e) {}
            if (!DEBUG_KEEP_OPEN) {
                setTimeout(() => { try { window.close(); } catch(_) {} }, 300);
            }
        };

        // Одразу при старті ховаємо своє вікно за межами екрана
        // (popup не дає рухати без user action, але спробуємо)
        try {
            window.moveTo(screen.width - 100, screen.height - 100);
            window.resizeTo(200, 100);
        } catch(e) {}
        // Повертаємо фокус на opener одразу як запустились
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.focus();
            }
        } catch(e) {}

        // Періодично пробуємо парсити DOM поки не отримаємо марку
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
        // Стартуємо через 500мс щоб дати React відрендерити
        setTimeout(tryParse, 500);
    }

    /**
     * Парсимо DOM сторінки carplates.app.
     * Структура (з HTML що ти раніше кидав):
     *   <div>CITROEN</div><div>C5 AIRCROSS</div><div>2020</div>
     *   <img src=".../ic_fuel.svg"><span>Паливо</span><span>ДИЗЕЛЬНЕ</span>
     *   <img src=".../ic_engine.svg"><span>Двигун</span><span>2.0</span>     ← УВАГА: тут округлено!
     *   <img src=".../ic_weight.svg"><span>Маса/Макс. маса</span><span>1540 / 2080</span>
     *   <img src=".../ic_seating.svg"><span>Сидячих місць</span><span>5</span>
     *   <span>AP</span><span>Регіон</span><span>Запорізька область</span>
     *
     * ВАЖЛИВО: ic_engine на сайті показує "2.0" замість "1998" - округлено.
     * Якщо хочеш точне значення - треба з API, але з DOM беремо як є.
     */
    function extractCarplatesDataFromDOM(doc) {
        const result = {
            brand: '', model: '', year: '',
            fuel: '', engine: '', weight: '', seats: '', region: ''
        };

        // Характеристики через іконки SVG.
        // ВАЖЛИВО: на сайті дані дублюються — зверху точний блок (e.g. "Об'єм двигуна: 1598"),
        // знизу округлений ("Двигун: 2.0"). Беремо ПЕРШЕ знайдене значення (верхній блок).
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

        // Марка/модель/рік — 3 послідовні div'и. Беремо ПЕРШЕ входження (зверху точний блок).
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
                    break;  // ПЕРШЕ входження = верхній точний блок
                }
            }
        }

        // Регіон — ПЕРШЕ входження
        const allSpans = doc.querySelectorAll('span');
        for (const sp of allSpans) {
            if ((sp.textContent || '').trim() === 'Регіон') {
                const next = sp.nextElementSibling;
                if (next && next.tagName === 'SPAN') {
                    result.region = (next.textContent || '').trim();
                    break;  // ПЕРШЕ входження
                }
            }
        }

        return result;
    }


    /**
     * Витягуємо потрібні поля з відповіді API.
     * Структура: { unicards: [{ id:"gov_registration", brand, model, make_year,
     *   properties:[{label:"Регіон",value:"..."}],
     *   properties_horizontal:[{icon:"ic_fuel",value:"БЕНЗИН"},
     *                          {icon:"ic_engine",value:"1998"},
     *                          {icon:"ic_weight",value:"1543 / 2035"},
     *                          {icon:"ic_seating",value:"5"}] }] }
     */
    function extractCarplatesData(json) {
        const result = {
            brand: '', model: '', year: '',
            fuel: '', engine: '', weight: '', seats: '', region: ''
        };
        if (!json || !Array.isArray(json.unicards)) return result;

        // Шукаємо картку gov_registration (там основні дані)
        let gov = json.unicards.find(u => u && u.id === 'gov_registration');
        // Якщо її немає — пробуємо vin_decode як фолбек
        if (!gov || !gov.brand) {
            gov = json.unicards.find(u => u && u.id === 'vin_decode') || gov;
        }
        if (!gov) gov = json.unicards[0] || {};

        result.brand = (gov.brand || '').toString();
        result.model = (gov.model || '').toString();
        result.year = (gov.make_year !== undefined && gov.make_year !== null)
            ? String(gov.make_year) : '';

        // Горизонтальні параметри: паливо, двигун, маса, місця
        const horiz = Array.isArray(gov.properties_horizontal) ? gov.properties_horizontal : [];
        for (const p of horiz) {
            const ico = (p && p.icon) || '';
            const val = (p && p.value !== undefined && p.value !== null) ? String(p.value).trim() : '';
            if (!val) continue;
            if (ico === 'ic_fuel') result.fuel = val;
            else if (ico === 'ic_engine') result.engine = val;       // ВАЖЛИВО: без округлення, як є з API
            else if (ico === 'ic_weight') result.weight = val;
            else if (ico === 'ic_seating') result.seats = val;
        }

        // Місць може бути в горизонтальних або у vin_decode
        if (!result.seats) {
            const decode = json.unicards.find(u => u && u.id === 'vin_decode');
            if (decode && Array.isArray(decode.properties_horizontal)) {
                for (const p of decode.properties_horizontal) {
                    if (p && p.icon === 'ic_seating' && p.value) {
                        result.seats = String(p.value).trim();
                        break;
                    }
                }
            }
        }

        // Регіон — у вертикальних properties
        const vert = Array.isArray(gov.properties) ? gov.properties : [];
        for (const p of vert) {
            if (p && p.label === 'Регіон' && p.value) {
                result.region = String(p.value).trim();
                break;
            }
        }

        return result;
    }

    /**
     * Парсимо дані з DOM сторінки carplates.app.
     * Структура:
     *   <div>CITROEN</div><div>C5 AIRCROSS</div><div>2020</div>
     *   <img src=".../ic_fuel.svg"><span>Паливо</span><span>ДИЗЕЛЬНЕ</span>
     *   <img src=".../ic_engine.svg"><span>Двигун</span><span>2.0</span>
     *   <img src=".../ic_weight.svg"><span>Маса/Макс. маса</span><span>1540 / 2080</span>
     *   <img src=".../ic_seating.svg"><span>Сидячих місць</span><span>5</span>
     *   <span>AP</span><span>Регіон</span><span>Запорізька область</span>
     */
    function extractCarplatesData(doc) {
        const result = {
            brand: '', model: '', year: '',
            fuel: '', engine: '', weight: '', seats: '', region: ''
        };

        // Знаходимо характеристики через іконки SVG
        // Кожна іконка має парою <span>label</span><span>value</span> в одному батьку
        const icons = doc.querySelectorAll('img[src*="/ic_"]');
        for (const ico of icons) {
            const src = ico.getAttribute('src') || '';
            const parent = ico.parentElement;
            if (!parent) continue;
            // Значення — останній span у батьку, label — передостанній
            const spans = parent.querySelectorAll('span');
            if (spans.length < 2) continue;
            const value = (spans[spans.length - 1].textContent || '').trim();
            if (!value) continue;

            if (src.includes('ic_fuel')) result.fuel = value;
            else if (src.includes('ic_engine')) result.engine = value;
            else if (src.includes('ic_weight')) result.weight = value;
            else if (src.includes('ic_seating')) result.seats = value;
        }

        // Марка/модель/рік — це 3 послідовні div'и в заголовку картки авто.
        // Шукаємо через структуру: один з div містить великими літерами марку,
        // наступний div - модель, наступний - рік (4 цифри).
        const allDivs = doc.querySelectorAll('div');
        for (const div of allDivs) {
            // Шукаємо div зі звичайним текстом-маркою (UPPERCASE, без додаткових елементів)
            const text = (div.textContent || '').trim();
            if (!text || text.length > 30 || div.children.length > 0) continue;
            // Перевіряємо чи це марка (велика латиниця, мін 3 символи)
            if (/^[A-Z][A-Z0-9 \-]{1,28}$/.test(text) && text === text.toUpperCase()) {
                // знаходимо наступні два <div> сіблінги
                let next = div.nextElementSibling;
                const nextText = next ? (next.textContent || '').trim() : '';
                let yearEl = next ? next.nextElementSibling : null;
                let yearText = yearEl ? (yearEl.textContent || '').trim() : '';
                // Витягуємо рік (4 цифри) з третього div або з його початку
                const yearMatch = yearText.match(/^(19|20)\d{2}/);
                if (nextText && nextText.length < 60 && yearMatch) {
                    result.brand = text;
                    result.model = nextText;
                    result.year = yearMatch[0];
                    break;
                }
            }
        }

        // Регіон — шукаємо span з текстом "Регіон" і беремо наступний span
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
        if (CARPLATES_PENDING.size > 0 || carplatesQueue !== Promise.resolve()) {
            if (stage) stage.innerHTML = '<div class="oscpv-spinner"></div><span>Дочікую дані авто...</span>';
            if (info) info.textContent = `Опрацьовано ОСЦПВ, чекаю carplates (${CARPLATES_PENDING.size} в роботі)...`;
            try {
                // Чекаємо чергу (нові VIN) + всі PENDING-проміси (дублікати)
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
        // Розділяємо тисячі пробілами для зручного читання: 12500 → "12 500"
        return Number(n).toLocaleString('uk-UA').replace(/,/g, ' ');
    }

    /**
     * Розраховує дату народження з українського ІПН (РНОКПП).
     * Перші 5 цифр — кількість днів від 31.12.1899.
     * Повертає у форматі DD.MM.YYYY або '' якщо ІПН невалідний.
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
     * Формат:
     *   Дата народження: 21.08.1988
     *
     *   Авто 1:
     *   Авто: KIA SPORTAGE
     *   Рік: 2020
     *   Двигун: БЕНЗИН 1598
     *   ...
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

        // Збираємо унікальні авто (за VIN) щоб не дублювати
        const seenVins = new Set();
        const cars = [];
        for (const r of results) {
            if (r._notFound) continue;
            const key = r.vin || `${r.vehicle_brand}-${r.plate_no}-${r.policy_no}`;
            if (seenVins.has(key)) continue;
            seenVins.add(key);
            cars.push(r);
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
     * Послідовність:
     *   1. Будуємо текст
     *   2. Шукаємо кнопку "Примітка" → клікаємо
     *   3. Чекаємо поки з'явиться textarea
     *   4. Вписуємо текст
     *   5. Кидаємо input event щоб Owl/React побачив
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
            // Шукаємо кнопку "Примітка" - є кілька варіантів селекторів
            let noteBtn = document.querySelector('button.o-mail-Chatter-logNote');
            if (!noteBtn) {
                // Альтернативний пошук по тексту
                const buttons = Array.from(document.querySelectorAll('button'));
                noteBtn = buttons.find(b => (b.textContent || '').trim() === 'Примітка'
                    || (b.textContent || '').trim() === 'Log note');
            }
            if (!noteBtn) {
                throw new Error('Не знайдено кнопку "Примітка" на сторінці');
            }
            console.log('[OSCPV] Клік на кнопку Примітка');
            noteBtn.click();

            // Чекаємо textarea
            const textarea = await waitForElement('textarea.o-mail-Composer-input', 5000);
            if (!textarea) {
                throw new Error('Не з\'явилось поле введення примітки');
            }

            // Вставляємо текст через нативний setter (інакше Owl/Vue/React не побачить)
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(textarea, text);

            // Кидаємо input event щоб фреймворк побачив зміну
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));

            // Фокус на поле (щоб користувач одразу побачив)
            textarea.focus();

            // Розширюємо висоту автоматично
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(400, textarea.scrollHeight) + 'px';

            btn.innerHTML = '<span>✓</span> Вставлено';
            setTimeout(() => { btn.innerHTML = origLabel; btn.disabled = false; }, 2000);

            // Закриваємо нашу модалку щоб користувач побачив поле в Odoo
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

    // Глобальне сховище актуального токена — оновлюється при кожному запиті сайту
    // (Sniffer вже встановлений зверху, до DOMContentLoaded)

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

        // Одразу повертаємо фокус на opener (Odoo) і пробуємо мінімізувати своє вікно
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.focus();
            }
        } catch(e) {}
        try {
            window.moveTo(screen.width - 100, screen.height - 100);
            window.resizeTo(200, 100);
        } catch(e) {}

        // Показуємо банер що скрипт працює
        showDictBanner();

        // Чекаємо щоб сторінка зробила хоча б один запит і ми перехопили токен
        waitForLiveToken(20000).then(token => {
            if (!token) {
                // fallback на localStorage
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

    // Завжди повертає НАЙСВІЖІШИЙ токен
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
                    // ОСЦПВ не знайдено для цього ІПН
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

    /**
     * Парсимо таблицю через iframe з поллінгом:
     * перезавантажуємо iframe декілька разів поки не знайдемо рядок
     * з потрібним id ТА заповненим полем response.
     */
    async function parseTableForIpn(ipn, expectedId, sessionId) {
        const MAX_ATTEMPTS = 12;        // максимум спроб
        const ATTEMPT_DELAY = 3000;     // мс між спробами

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (sessionId) {
                pushProgress(sessionId, {
                    log: `   спроба ${attempt}/${MAX_ATTEMPTS} (id=${expectedId})...`,
                    logType: 'dim'
                });
            }

            const result = await tryParseOnce(ipn, expectedId);

            if (result.found && result.responseText) {
                // знайшли рядок і поле response непорожнє
                try {
                    const parsed = JSON.parse(result.responseText);
                    if (sessionId) {
                        pushProgress(sessionId, {
                            log: `   ✓ знайдено id=${result.foundId}, response довжина=${result.responseText.length}`,
                            logType: 'ok'
                        });
                    }
                    return parsed;
                } catch(e) {
                    console.warn('[OSCPV] response не JSON:', result.responseText.slice(0, 300));
                    if (sessionId) {
                        pushProgress(sessionId, {
                            log: `   ⚠ response не JSON: ${result.responseText.slice(0,80)}...`,
                            logType: 'err'
                        });
                    }
                    return null;
                }
            }

            if (result.found && !result.responseText) {
                if (sessionId) {
                    pushProgress(sessionId, {
                        log: `   рядок id=${result.foundId} є, але response ще порожній — чекаю...`,
                        logType: 'dim'
                    });
                }
            } else if (!result.found) {
                if (sessionId) {
                    pushProgress(sessionId, {
                        log: `   рядок з id=${expectedId} ще не з'явився — чекаю...`,
                        logType: 'dim'
                    });
                }
            }

            if (attempt < MAX_ATTEMPTS) {
                await sleep(ATTEMPT_DELAY);
            }
        }

        return null;
    }

    /**
     * Одна спроба парсингу:
     * відкриваємо свіжий iframe, чекаємо рендеру таблиці,
     * клікаємо на сортування ASC по колонці id (це у цій таблиці дає найбільший id зверху),
     * чекаємо перерендеру, знаходимо рядок з потрібним id.
     */
    async function tryParseOnce(ipn, expectedId) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1800px;height:1000px;border:0;';
        iframe.src = CONFIG.TABLE_URL + '?_=' + Date.now();
        document.body.appendChild(iframe);

        try {
            // 1. Чекаємо щоб з'явились хоч якісь рядки
            let rows = await waitForRows(iframe, CONFIG.ROW_WAIT_TIMEOUT);
            if (!rows.length) return { found: false };

            // 2. Клікаємо на стрілку ascending у заголовку колонки id
            //    (в цій таблиці ASC = від більшого до меншого, тобто найсвіжіший зверху)
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const sorted = await clickSortAsc(doc);

            // 3. Чекаємо щоб таблиця перерендерилась після сортування
            if (sorted) {
                await sleep(1500);
            }

            // 4. Перечитуємо рядки після сортування
            rows = Array.from(doc.querySelectorAll('tr.el-table__row'));
            if (!rows.length) return { found: false };

            // 5. Якщо знаємо id — шукаємо точно по ньому через span.cell-number
            if (expectedId) {
                const idSpans = doc.querySelectorAll('span.cell-number');
                let targetRow = null;
                for (const span of idSpans) {
                    const v = parseInt((span.textContent || '').trim());
                    if (v === expectedId) {
                        targetRow = span.closest('tr.el-table__row');
                        break;
                    }
                }

                if (targetRow) {
                    const cells = targetRow.querySelectorAll('td');
                    if (cells.length >= 19) {
                        const respCell = cells[COL.RESPONSE];
                        const respSpan = respCell && respCell.querySelector('span');
                        const respText = ((respSpan ? respSpan.textContent : respCell?.textContent) || '').trim();
                        return { found: true, foundId: expectedId, responseText: respText };
                    }
                }
                // не знайшли по id — повертаємо not found щоб поллер спробував ще
                return { found: false };
            }

            // Фолбек на випадок без expectedId — беремо ПЕРШИЙ рядок з потрібним ident_code
            // (після ASC-сортування він буде найсвіжіший)
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 19) continue;
                const idText = (cells[COL.ID].textContent || '').trim();
                const identText = (cells[COL.IDENT_CODE].textContent || '').trim();
                if (identText === String(ipn)) {
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
     * Повертає true якщо клік виконано.
     */
    async function clickSortAsc(doc) {
        try {
            // Колонка id — перший th (el-table_1_column_1)
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

            // Якщо стрілка вже активна — не клікаємо
            if (ascCaret.classList.contains('active')) {
                console.log('[OSCPV] ASC сортування вже активне');
                return true;
            }

            // Клікаємо. Element UI слухає клік на батьківському <span class="head-sort">,
            // тому імітуємо нативний клік через MouseEvent.
            const clickTarget = ascCaret.closest('.head-sort') || ascCaret;
            // деякі версії Element UI реагують на клік саме по caret, тому клікаємо обидва
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

    // Фолбек на випадок якщо ми не знаємо id (insert не повернув його) —
    // шукаємо за ident_code і беремо рядок з найбільшим id
    function findByIdentCode(rows, ipn) {
        const matches = [];
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 19) continue;
            const idText = (cells[COL.ID].textContent || '').trim();
            const identText = (cells[COL.IDENT_CODE].textContent || '').trim();
            if (identText === String(ipn)) {
                const respCell = cells[COL.RESPONSE];
                const respSpan = respCell && respCell.querySelector('span');
                const respText = ((respSpan ? respSpan.textContent : respCell?.textContent) || '').trim();
                matches.push({ id: parseInt(idText) || 0, responseText: respText });
            }
        }
        if (!matches.length) return { found: false };
        matches.sort((a, b) => b.id - a.id);
        return { found: true, foundId: matches[0].id, responseText: matches[0].responseText };
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
                    // дочекаємось ще трохи щоб response повністю прорендерився
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
