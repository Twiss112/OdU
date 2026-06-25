// ==UserScript==
// @name         МТСБУ — пакетна перевірка полісів ОСЦПВ
// @namespace    universalna.mtsbu.batch
// @version      3.2.7
// @description  Пакетна перевірка чинності ОСЦПВ через policy.mtsbu.ua: черга, авто-заповнення форми, авто-проходження Turnstile, бінарний пошук дати початку (поточний поліс для reg/VIN), CSV-експорт. Стиль МТСБУ.
// @author       Twis
// @match        https://policy.mtsbu.ua/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const SEL = {
        innerTab: '#tab1-tab',
        tab:   { reg: '#carNumber-tab',          policy: '#policyNumber-tab',     vin: '#vinCode-tab' },
        value: { reg: '#RegNoModel_PlateNumber', policy: '#PolicyNumModel_Number', vin: '#PolicyVinModel_VinCode' },
        date:  { reg: '#numDate',                policy: '#policyDate',           vin: '#vinDate' },
        submit: '#submitBtn',
    };
    const CONFIG = {
        resultPathPrefix: '/Search/By', searchUrl: 'https://policy.mtsbu.ua/',
        autoAdvanceSec: 3, switchDelayMs: 260,
        bsMaxLookbackYears: 3, bsInitWindowDays: 365,
        bsAnchorOffsets: [30, 60, 120, 210, 330, 450, 600, 750, 900], bsMaxIter: 28,
        computeEndFromStart: true, policyTermYears: 1,
    };
    const K = { queue: 'mtsbu_q', results: 'mtsbu_r', ptr: 'mtsbu_p', flow: 'mtsbu_f', ui: 'mtsbu_ui' };
    const load = (k, d) => { try { return JSON.parse(GM_getValue(k, JSON.stringify(d))); } catch { return d; } };
    const save = (k, v) => GM_setValue(k, JSON.stringify(v));

    /* ===================== helpers (мають бути до стану) ===================== */
    const pad = (n) => String(n).padStart(2, '0');
    function today() { const d = new Date(); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
    function parseD(s) { const m = String(s).match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : new Date(); }
    function fmtD(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
    function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    function addYears(d, n) { const x = new Date(d); x.setFullYear(x.getFullYear() + n); return x; }
    function diffDays(a, b) { return Math.round((b - a) / 86400000); }
    function midDate(a, b) { const m = new Date((a.getTime() + b.getTime()) / 2); m.setHours(0, 0, 0, 0); return m; }
    function computeEnd(s) { return fmtD(addDays(addYears(parseD(s), CONFIG.policyTermYears), -1)); }
    function norm(s) { return String(s).toUpperCase().replace(/[\s\-]/g, ''); }
    function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    let queue = load(K.queue, []), results = load(K.results, {}), pointer = load(K.ptr, 0);
    let flow = GM_getValue(K.flow, 'idle');
    let ui = Object.assign({ text: '', date: today(), defType: 'policy', binSearch: false, collapsed: false }, load(K.ui, {}));
    let countdownTimer = null, captchaTimer = null, submitGuard = false;

    function guessType(v) {
        const s = norm(v);
        if (/^[A-ZА-ЯІЇЄҐ]{2}\d{6,8}$/.test(s) || /^\d{8,9}$/.test(s)) return 'policy';
        if (s.length >= 11 && /\d/.test(s) && /[A-Z]/.test(s)) return 'vin';
        return 'reg';
    }
    function parseInput(text, defType) {
        const out = [];
        text.split(/\r?\n/).forEach((line) => {
            const raw = line.trim(); if (!raw) return;
            let type = null, value = raw;
            const m = raw.match(/^(reg|vin|pol|policy)\s*[:;,]\s*(.+)$/i);
            if (m) { const t = m[1].toLowerCase(); type = (t === 'pol' || t === 'policy') ? 'policy' : t; value = m[2].trim(); }
            value = value.replace(/\s+/g, ''); if (!value) return;
            if (!type) type = (defType === 'auto') ? guessType(value) : defType;
            out.push({ raw, type, value, status: 'pending' });
        });
        return out;
    }
    function setNativeValue(el, val) {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, val); else el.value = val;
        ['input', 'change', 'keyup', 'blur'].forEach((ev) => el.dispatchEvent(new Event(ev, { bubbles: true })));
    }
    function isResultPage() { return location.pathname.startsWith(CONFIG.resultPathPrefix); }

    /* ===================== Cloudflare ===================== */
    function tokenFields() { return [...document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]')]; }
    function captchaPresent() { return !!document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') || tokenFields().length > 0; }
    function captchaSolved() { return tokenFields().some((e) => e && e.value && e.value.length >= 20); }
    function isCfChallenge() {
        // Справжня сторінка МТСБУ (форма/результат) — точно не челендж, навіть із віджетом Turnstile
        if (document.querySelector('#submitBtn, #tab1-tab, .page_headline_wrapper')) return false;
        if (isResultPage()) return false;
        const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 600) : '';
        if (/Перевірка чинності полісу|Оберіть критерій|Поліс\s*№/i.test(body)) return false;
        // Повноекранний інтерстишіал Cloudflare
        try { if (window._cf_chl_opt) return true; } catch (e) {}
        if (document.getElementById('challenge-form') || document.getElementById('challenge-running') || document.getElementById('cf-please-wait')) return true;
        return /just a moment|attention required|checking your browser|перевірка браузера/i.test(document.title || '');
    }

    /* ===================== заповнення форми ===================== */
    function fillForm(item) {
        submitGuard = false; clearCaptchaWatch();
        document.querySelector(SEL.innerTab)?.click();
        document.querySelector(SEL.tab[item.type])?.click();
        setTimeout(() => fillAndSubmit(item), CONFIG.switchDelayMs);
    }
    function fillAndSubmit(item) {
        const probeDate = item.probeDate || ui.date;
        const v = document.querySelector(SEL.value[item.type]);
        const d = document.querySelector(SEL.date[item.type]);
        if (!v) { flash('Поле вводу не знайдено — онови сторінку.', 'err'); return; }
        setNativeValue(v, item.value);
        if (d) setNativeValue(d, probeDate);
        const btn = document.querySelector(SEL.submit);
        if (!btn) { flash('Кнопку «Перевірити» не знайдено.', 'err'); return; }
        ensureTokenThenSubmit(btn, item, probeDate);
    }
    function doSubmit(btn, item, probeDate) { if (submitGuard) return; submitGuard = true; clearCaptchaWatch(); flash(`Відкриваю: ${item.value} · ${probeDate}`); btn.click(); }
    function ensureTokenThenSubmit(btn, item, probeDate) {
        const t0 = Date.now(); const GRACE = 1500, ESC = 9000, SAFE = 300000;
        clearInterval(captchaTimer);
        captchaTimer = setInterval(() => {
            const el = Date.now() - t0;
            if (captchaSolved()) return doSubmit(btn, item, probeDate);
            const p = captchaPresent();
            if (!p && el > GRACE) return doSubmit(btn, item, probeDate);
            if (p) captchaBanner(item.value, el > ESC ? 'manual' : 'auto');
            if (el > SAFE) { clearInterval(captchaTimer); captchaTimer = null; }
        }, 350);
    }
    function clearCaptchaWatch() { if (captchaTimer) { clearInterval(captchaTimer); captchaTimer = null; } document.getElementById('mtsbu-cap')?.remove(); }

    /* ===================== парсинг результату ===================== */
    function extractKeys(text) {
        const keys = new Set(); const t = text.toUpperCase(); let m;
        const r1 = /\b([A-ZА-ЯІЇЄҐ]{2})\s?(\d{6,8})\b/g; while ((m = r1.exec(t))) keys.add(m[1] + m[2]);
        const r2 = /(?<!\d)(\d{9})(?!\d)/g; while ((m = r2.exec(t))) keys.add(m[1]);
        return keys;
    }
    function pickPeriod(blockText, asOf) {
        const dates = (blockText.match(/\d{2}\.\d{2}\.\d{4}/g) || []).filter((d) => d !== asOf);
        const lab = (re) => { const m = blockText.match(new RegExp(re + '[^\\d]{0,40}(\\d{2}\\.\\d{2}\\.\\d{4})', 'i')); return m ? m[1] : ''; };
        let start = lab('початк|поча|діє\\s*з|чинн.{0,6}з'); let end = lab('закінч|кінц|діє\\s*по|чинн.{0,6}по');
        if (!start && dates.length) { const s = [...new Set(dates)].sort((a, b) => parseD(a) - parseD(b)); start = s[0]; end = end || (s.length > 1 ? s[s.length - 1] : ''); }
        return { start: start || '', end: end || '' };
    }
    function classify() {
        const text = document.body.innerText;
        const lines = text.split('\n').map((s) => s.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
        const asOf = (text.match(/на\s+(\d{2}\.\d{2}\.\d{4})/) || [])[1] || ui.date;
        const labIn = (arr, label) => { const k = arr.findIndex((l) => l.toLowerCase() === label.toLowerCase()); return (k >= 0 && k + 1 < arr.length) ? arr[k + 1] : ''; };

        const starts = []; lines.forEach((l, i) => { if (/^Поліс\b/i.test(l) && /№|\d/.test(l)) starts.push(i); });
        const policies = [];
        if (starts.length) {
            starts.forEach((s, si) => {
                const e = si + 1 < starts.length ? starts[si + 1] : lines.length;
                const block = lines.slice(s, e); const bt = block.join('\n');
                const num = (block[0].match(/([A-ZА-ЯІЇЄҐ]{2}\s?\d{6,8}|\d{8,9})/i) || [])[0] || '';
                let st = []; for (let k = 1; k < block.length; k++) { if (/^на\s+\d{2}\.\d{2}\.\d{4}/i.test(block[k])) break; if (st.length < 3) st.push(block[k]); }
                const statusText = st.join(' ').trim();
                const per = pickPeriod(bt, asOf);
                policies.push({
                    num: norm(num), statusText,
                    active: !/не\s*ДІЄ|недійсн|не\s*чинн|анульован|припинен/i.test(statusText),
                    start: per.start, end: per.end,
                    insurer: labIn(block, 'Найменування'),
                    vehicle: [labIn(block, 'Марка'), labIn(block, 'Модель'), labIn(block, 'Реєстраційний номер'), labIn(block, 'VIN (номер кузова, шасі, рами)')].filter(Boolean).join(' / '),
                });
            });
        }
        if (!policies.length) {
            const keys = extractKeys(text); const foundN = (text.match(/Знайдено\s+(\d+)/i) || [])[1];
            [...keys].forEach((k) => policies.push({ num: k, statusText: '', active: true, start: '', end: '', insurer: '', vehicle: '' }));
            if (!policies.length && foundN && +foundN > 0) policies.push({ num: '', statusText: `Знайдено ${foundN}`, active: true, start: '', end: '', insurer: '', vehicle: '' });
        }
        const notFound = /не\s+знайдено|відсутн|нічого не знайдено/i.test(text);
        const exists = policies.length > 0 && !(notFound && policies.every((p) => !p.num && !p.statusText));
        const primary = policies.find((p) => p.active) || policies[0] || {};
        return { exists, asOf, policies, keys: new Set(policies.map((p) => p.num).filter(Boolean)), active: policies.some((p) => p.active), statusText: primary.statusText || '', insurer: primary.insurer || '', vehicle: primary.vehicle || '' };
    }
    // поточний (останній) поліс: для reg/vin — з найпізнішим стартом серед активних
    function currentPolicy(item, c) {
        if (item.type === 'policy') return c.policies[0] || { num: item.value, active: c.active };
        const act = c.policies.filter((p) => p.active);
        const pool = act.length ? act : c.policies;
        return pool.slice().sort((a, b) => (b.start ? parseD(b.start) : 0) - (a.start ? parseD(a.start) : 0))[0] || {};
    }
    function cover(item, c) {
        if (item.type === 'policy') return c.active;
        return (item.bs && item.bs.targetKey) ? c.keys.has(item.bs.targetKey) : c.active;
    }

    /* ===================== бінарний пошук ===================== */
    function bsInit(item) { item.bs = { phase: 'init', iter: 0, log: [], startLo: null, startHi: null, endLo: null, endHi: null, oi: 0, prevInactive: ui.date }; item.probeDate = ui.date; item.startDate = ''; item.endDate = ''; item.policyKey = ''; item.statusText = ''; item.insurer = ''; item.vehicle = ''; }
    function finalize(item, note) { if (item.startDate) item.status = `діє: ${item.startDate} – ${item.endDate || '?'}`; else if (!item.status) item.status = 'оброблено'; if (note) item.status += ` (${note})`; }
    function afterStart(item) {
        const bs = item.bs; const sm = (item.startDate || '').match(/(\d{2}\.\d{2}\.\d{4})/);
        if (CONFIG.computeEndFromStart && sm) { item.endDate = (item.startDate.includes('≤') ? '≤ ' : '') + computeEnd(sm[1]); finalize(item); bs.phase = 'done'; return { done: true }; }
        if (bs.endLo && bs.endHi) {
            bs.phase = 'endSearch';
            if (diffDays(parseD(bs.endLo), parseD(bs.endHi)) <= 1) { item.endDate = bs.endLo; finalize(item); bs.phase = 'done'; return { done: true }; }
            const mid = fmtD(midDate(parseD(bs.endLo), parseD(bs.endHi))); item.probeDate = mid; return { probe: mid };
        }
        finalize(item); bs.phase = 'done'; return { done: true };
    }
    function bsStep(item, c) {
        const bs = item.bs; bs.iter++;
        const probed = item.probeDate, A = cover(item, c);
        bs.log.push(`${probed}:${A ? '+' : '-'}`);
        if (bs.iter > CONFIG.bsMaxIter) { finalize(item, 'ліміт'); bs.phase = 'done'; return { done: true }; }
        const minD = addDays(parseD(ui.date), -365 * CONFIG.bsMaxLookbackYears);
        const WIN = CONFIG.bsInitWindowDays, OFF = CONFIG.bsAnchorOffsets;

        if (bs.phase === 'init') {
            item.statusText = c.statusText || ''; item.insurer = c.insurer || ''; item.vehicle = c.vehicle || '';
            if (!c.exists) { item.status = 'поліс не знайдено'; bs.phase = 'done'; return { done: true }; }
            const cur = currentPolicy(item, c);
            item.policyKey = (cur && cur.num) || item.value;
            if (cur && cur.insurer) item.insurer = cur.insurer;
            if (cur && cur.vehicle) item.vehicle = cur.vehicle;
            if (cur && cur.start) { item.startDate = cur.start; item.endDate = cur.end || computeEnd(cur.start); item.status = `діє: ${item.startDate} – ${item.endDate}`; bs.phase = 'done'; return { done: true }; }
            bs.targetKey = (cur && cur.num) || null;
            const A0 = cover(item, c);
            if (A0) { bs.startHi = ui.date; bs.startLo = fmtD(addDays(parseD(ui.date), -WIN)); item.endDate = `≥ ${ui.date}`; bs.phase = 'startBracket'; item.probeDate = bs.startLo; return { probe: bs.startLo }; }
            bs.phase = 'anchor'; bs.prevInactive = ui.date; bs.oi = 0; const d0 = fmtD(addDays(parseD(ui.date), -OFF[0])); item.probeDate = d0; return { probe: d0 };
        }
        if (bs.phase === 'anchor') {
            if (A) { bs.startHi = probed; bs.endLo = probed; bs.endHi = bs.prevInactive; bs.startLo = fmtD(addDays(parseD(probed), -WIN)); bs.phase = 'startBracket'; item.probeDate = bs.startLo; return { probe: bs.startLo }; }
            bs.prevInactive = probed; bs.oi++;
            if (bs.oi >= OFF.length) { item.status = `не діє (нема періоду за ~${CONFIG.bsMaxLookbackYears} р.; ймовірно майбутній або давній)`; bs.phase = 'done'; return { done: true }; }
            const d = addDays(parseD(ui.date), -OFF[bs.oi]);
            if (d <= minD) { item.status = 'не діє (поза вікном)'; bs.phase = 'done'; return { done: true }; }
            item.probeDate = fmtD(d); return { probe: fmtD(d) };
        }
        if (bs.phase === 'startBracket') {
            if (A) {
                const span = Math.max(diffDays(parseD(bs.startLo), parseD(bs.startHi)), 30);
                const nl = addDays(parseD(bs.startLo), -span);
                if (nl <= minD) { item.startDate = `≤ ${bs.startLo}`; return afterStart(item); }
                bs.startHi = bs.startLo; bs.startLo = fmtD(nl); item.probeDate = bs.startLo; return { probe: bs.startLo };
            }
            bs.phase = 'startSearch';
        }
        if (bs.phase === 'startSearch') {
            if (A) bs.startHi = probed; else bs.startLo = probed;
            if (diffDays(parseD(bs.startLo), parseD(bs.startHi)) <= 1) { item.startDate = bs.startHi; return afterStart(item); }
            const mid = fmtD(midDate(parseD(bs.startLo), parseD(bs.startHi))); item.probeDate = mid; return { probe: mid };
        }
        if (bs.phase === 'endSearch') {
            if (A) bs.endLo = probed; else bs.endHi = probed;
            if (diffDays(parseD(bs.endLo), parseD(bs.endHi)) <= 1) { item.endDate = bs.endLo; finalize(item); bs.phase = 'done'; return { done: true }; }
            const mid = fmtD(midDate(parseD(bs.endLo), parseD(bs.endHi))); item.probeDate = mid; return { probe: mid };
        }
        return { done: true };
    }

    /* ===================== черга / потік ===================== */
    function startBatch() {
        queue = parseInput(ui.text, ui.defType);
        if (!queue.length) { flash('Список авто порожній.', 'err'); return; }
        results = {}; pointer = 0; save(K.queue, queue); save(K.results, results); save(K.ptr, pointer);
        GM_setValue(K.flow, 'filling'); flow = 'filling'; proceedFill();
    }
    function proceedFill() {
        if (pointer >= queue.length) { GM_setValue(K.flow, 'idle'); flow = 'idle'; renderPanel(); flash(`Готово. Перевірено ${queue.length} авто.`); return; }
        renderPanel();
        const item = queue[pointer];
        if (ui.binSearch && !item.bs) { bsInit(item); save(K.queue, queue); }
        setTimeout(() => fillForm(item), 320);
    }
    function goSearch() { location.href = CONFIG.searchUrl; }
    function advancePointer() { pointer++; save(K.ptr, pointer); goSearch(); }
    function skipCurrent() { if (queue[pointer]) queue[pointer].status = 'пропущено'; save(K.queue, queue); advancePointer(); }
    function resetBatch() { [K.queue, K.results, K.ptr].forEach(GM_deleteValue); GM_setValue(K.flow, 'idle'); queue = []; results = {}; pointer = 0; flow = 'idle'; clearCaptchaWatch(); renderPanel(); }

    function saveResult(item, c) {
        results[item.value] = { asOf: c.asOf || ui.date, validity: item.status, statusText: c.statusText || item.statusText || '', startDate: item.startDate || '', endDate: item.endDate || '', policyKey: item.policyKey || [...c.keys][0] || '', insurer: item.insurer || c.insurer || '', vehicle: item.vehicle || c.vehicle || '', count: c.policies.length };
        save(K.results, results); save(K.queue, queue);
    }
    function handleResultPage() {
        if (flow !== 'filling' || pointer >= queue.length) return;
        const item = queue[pointer], c = classify();
        if (ui.binSearch) {
            if (!item.bs) bsInit(item);
            const step = bsStep(item, c); saveResult(item, c);
            renderBar(item, c, !!step.done, step.probe);
            if (step.done) scheduleAdvance(); else scheduleProbe();
            return;
        }
        if (!c.exists) { item.status = 'не знайдено'; }
        else {
            const cur = currentPolicy(item, c);
            item.policyKey = cur.num || item.value; item.insurer = cur.insurer || c.insurer; item.vehicle = cur.vehicle || c.vehicle; item.statusText = cur.statusText || c.statusText;
            if (cur.start) { item.startDate = cur.start; item.endDate = cur.end || computeEnd(cur.start); item.status = `діє: ${cur.start} – ${item.endDate}`; }
            else item.status = c.active ? 'чинний на дату' : 'укладений, не діє на дату';
        }
        saveResult(item, c); renderBar(item, c, true); scheduleAdvance();
    }
    function scheduleAdvance() { startCountdown(CONFIG.autoAdvanceSec, advancePointer); }
    function scheduleProbe() { startCountdown(CONFIG.autoAdvanceSec, goSearch); }

    /* ===================== стилі (МТСБУ design system) ===================== */
    function styleOnce() {
        if (document.getElementById('mtsbu-style')) return;
        const s = document.createElement('style'); s.id = 'mtsbu-style';
        s.textContent = `
        #mtsbu-panel,#mtsbu-bar,#mtsbu-cap,#mtsbu-handle{--green:#398450;--green2:#0BAB64;--ghov:#5db778;--gtint:#eff5f1;--blue:#1d70c9;--ring:#66b1f8;--btint:rgba(29,112,201,.05);--red:#f50000;--rtint:rgba(245,0,0,.05);--ink:#333;--muted:#6d727c;--line:#dae0ea;--iline:#d2d2d7;--bline:#d6d6d6;--ok:#19be6f;
            font-family:Montserrat,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
        #mtsbu-panel{position:fixed;top:0;right:0;height:100vh;width:400px;max-width:92vw;z-index:2147483647;background:#fff;color:var(--ink);border-left:1px solid var(--line);box-shadow:-6px 0 24px rgba(51,51,51,.14);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1)}
        #mtsbu-panel.open{transform:translateX(0)}
        #mtsbu-handle{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:radial-gradient(140% 600% at 100% 100%,var(--green) 40%,var(--green2) 95%) !important;color:#fff !important;border:0 !important;border-radius:8px 0 0 8px;padding:0;width:36px;height:64px;cursor:pointer;box-shadow:-3px 0 12px rgba(51,51,51,.2);transition:right .28s cubic-bezier(.4,0,.2,1)}
        #mtsbu-handle:hover{filter:brightness(1.05)}
        #mtsbu-handle .chev{font-size:22px;font-weight:700;line-height:1;color:#fff !important;margin-top:2px}
        #mtsbu-handle .bdg{font:700 10px/1 Montserrat,Arial;background:rgba(255,255,255,.24) !important;border-radius:50px;padding:3px 0;width:26px;text-align:center;color:#fff !important;margin-bottom:4px}
        #mtsbu-panel .hd{background:radial-gradient(120% 25600% at 100% 100%,var(--green) 48.69%,var(--green2) 84.64%);color:#fff !important;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;flex:none}
        #mtsbu-panel .hd .t{font-weight:700;font-size:18px;line-height:1.2;color:#fff !important}
        #mtsbu-panel .hd .t small{display:block;font-weight:400;font-size:12px;opacity:.85;margin-top:2px;color:#fff !important}
        #mtsbu-panel .hd .c{font-size:12px;font-weight:700;background:rgba(255,255,255,.2);color:#fff !important;border-radius:50px;padding:3px 11px;flex:none}
        #mtsbu-panel .bd{padding:24px;overflow:auto;flex:1}
        #mtsbu-panel .lbl{font:500 16px/21px Montserrat,Arial;color:var(--ink);margin-bottom:5px}
        #mtsbu-panel .hint{font:400 14px/21px Montserrat,Arial;color:var(--muted);margin-bottom:12px}
        #mtsbu-panel textarea{width:100%;box-sizing:border-box;height:100px;resize:vertical;background:#fff;border:1px solid var(--iline);border-radius:4px;padding:15px;font:13px ui-monospace,Menlo,Consolas,monospace;color:var(--ink)}
        #mtsbu-panel input[type=text]{box-sizing:border-box;background:#fff;border:1px solid var(--iline);border-radius:4px;padding:15px;font:14px Montserrat,Arial;color:var(--ink)}
        #mtsbu-panel textarea:focus,#mtsbu-panel input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 2pt var(--ring)}
        #mtsbu-panel textarea::placeholder{color:#aab0ba}
        #mtsbu-panel .seg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0 8px}
        #mtsbu-panel .seg button{display:flex;align-items:center;gap:12px;background:#fff;border:2px solid var(--bline);border-radius:2px;padding:12px 16px;font:500 14px/20px Montserrat,Arial;color:var(--ink);cursor:pointer;transition:.2s ease-in-out;text-align:left}
        #mtsbu-panel .seg button .dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--bline);flex:none}
        #mtsbu-panel .seg button.on{background:var(--btint);border-color:var(--blue)}
        #mtsbu-panel .seg button.on .dot{border-color:var(--blue);background:var(--blue);box-shadow:inset 0 0 0 3px #fff}
        #mtsbu-panel .dater{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:20px 0;font:500 14px Montserrat,Arial;color:var(--ink)}
        #mtsbu-panel .dater input{width:140px;padding:12px 15px}
        #mtsbu-panel .sw{display:flex;align-items:center;gap:12px;border:2px solid var(--bline);border-radius:2px;padding:12px 16px;cursor:pointer;transition:.2s;margin-bottom:8px}
        #mtsbu-panel .sw.on{background:var(--btint);border-color:var(--blue)}
        #mtsbu-panel .sw .dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--bline);flex:none}
        #mtsbu-panel .sw.on .dot{border-color:var(--blue);background:var(--blue);box-shadow:inset 0 0 0 3px #fff}
        #mtsbu-panel .sw .txt{font:500 14px/20px Montserrat,Arial;color:var(--ink)}
        #mtsbu-panel .sw .txt small{display:block;font:400 12px/16px Montserrat,Arial;color:var(--muted);margin-top:2px}
        #mtsbu-panel .cta{width:100%;margin-top:24px;background:var(--green);color:#fff;border:1px solid transparent;border-radius:3px;padding:15px;font:700 16px/21px Montserrat,Arial;cursor:pointer;transition:.2s}
        #mtsbu-panel .cta:hover{background:var(--ghov)}
        #mtsbu-panel .cta:disabled{background:#c8c8c8;cursor:default}
        #mtsbu-panel .mini{display:flex;gap:10px;margin-top:12px}
        #mtsbu-panel .mini button{flex:1;background:#fff;color:var(--green);border:1px solid var(--bline);border-radius:3px;padding:12px;font:600 14px/20px Montserrat,Arial;cursor:pointer;transition:.2s}
        #mtsbu-panel .mini button:hover{background:var(--gtint)}
        #mtsbu-panel .mini button.dgr{color:var(--red);border-color:rgba(245,0,0,.35)}
        #mtsbu-panel .mini button.dgr:hover{background:var(--rtint)}
        #mtsbu-panel .link{display:inline-block;margin-top:16px;color:var(--green);font:600 14px Montserrat,Arial;cursor:pointer;text-decoration:none}
        #mtsbu-panel .link:hover{text-decoration:underline}
        #mtsbu-panel .prog{height:8px;background:#e9eef4;border-radius:50px;overflow:hidden;margin:4px 0 20px}
        #mtsbu-panel .prog>i{display:block;height:100%;background:var(--green);border-radius:50px;transition:width .3s}
        #mtsbu-panel .now{display:flex;align-items:center;gap:14px;border:1px solid var(--iline);border-radius:4px;padding:16px;min-width:0}
        #mtsbu-panel .now > span{min-width:0;flex:1}
        #mtsbu-panel .now .spin{width:20px;height:20px;border:2px solid #d8e6dd;border-top-color:var(--green);border-radius:50%;animation:mtsp .8s linear infinite;flex:none}
        @keyframes mtsp{to{transform:rotate(360deg)}}
        #mtsbu-panel .now .v{font:700 16px/24px Montserrat,Arial;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #mtsbu-panel .now small{display:block;color:var(--muted);font:400 12px/16px Montserrat,Arial;margin-top:2px}
        #mtsbu-panel .chips{display:flex;gap:10px;margin:4px 0 16px;flex-wrap:wrap}
        #mtsbu-panel .chip{display:flex;align-items:center;gap:6px;font:600 14px Montserrat,Arial;color:var(--ink)}
        #mtsbu-panel .chip .d{width:8px;height:8px;border-radius:50%}
        #mtsbu-panel ul{list-style:none;margin:12px 0 0;padding:0;max-height:280px;overflow:auto}
        #mtsbu-panel li{display:flex;flex-direction:column;gap:4px;padding:12px 0;border-top:1px solid var(--line)}
        #mtsbu-panel li .li-main{display:flex;align-items:center}
        #mtsbu-panel li .v{font:600 15px Montserrat,Arial;color:var(--ink);word-break:break-all}
        #mtsbu-panel li.cur .v{color:var(--green)}
        #mtsbu-panel li .tag{color:var(--muted);font:400 12px Montserrat,Arial;margin-left:8px;flex:none}
        #mtsbu-panel li .dot-wrap{margin-left:auto;padding-left:12px;flex:none;display:flex;align-items:center}
        #mtsbu-panel li .dot-wrap .d{width:8px;height:8px;border-radius:50%}
        #mtsbu-panel li .li-sub{font:400 13px/1.4 Montserrat,Arial;color:var(--muted)}
        #mtsbu-flash{position:fixed;bottom:24px;right:24px;z-index:2147483647;max-width:360px;background:#fff;color:var(--ink);border:1px solid var(--iline);border-left:4px solid var(--green);padding:16px 20px;border-radius:4px;font:500 14px/21px Montserrat,Arial;box-shadow:0 3px 12px rgba(51,51,51,.18)}
        #mtsbu-flash.err{border-left-color:var(--red)}
        #mtsbu-bar{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#fff;border:1px solid var(--iline);border-left:4px solid var(--green);border-radius:4px;padding:12px 16px 12px 20px;display:flex;align-items:center;gap:16px;box-shadow:0 3px 12px rgba(51,51,51,.16);width:380px;max-width:94vw;box-sizing:border-box;font:14px Montserrat,Arial;color:var(--ink)}
        #mtsbu-bar > span { display:flex; flex-direction:column; min-width:0; flex:1; gap:2px; }
        #mtsbu-bar .row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
        #mtsbu-bar .v{font:700 15px/22px Montserrat,Arial;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
        #mtsbu-bar .st{display:flex;align-items:center;gap:8px;font:600 14px/22px Montserrat,Arial;white-space:nowrap;color:var(--ink);flex:none}
        #mtsbu-bar .st .d{width:8px;height:8px;border-radius:50%}
        #mtsbu-bar .meta{color:var(--muted);font:400 13px/18px Montserrat,Arial;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #mtsbu-bar b, #mtsbu-cap b { font-weight:700 !important; color:var(--ink) !important; font-size:inherit !important; font-family:Montserrat,Arial,sans-serif !important; }
        #mtsbu-bar button{border:0;border-radius:3px;padding:10px 24px;background:var(--green);color:#fff;font:700 14px/21px Montserrat,Arial;cursor:pointer;transition:.2s;white-space:nowrap;flex:none}
        #mtsbu-bar button:hover{background:var(--ghov)}
        #mtsbu-bar .cd{color:var(--muted);font-size:13px;flex:none;width:24px;text-align:right}
        #mtsbu-cap{position:fixed;top:90px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#fff;color:var(--ink);border:1px solid var(--iline);border-left:4px solid var(--green);border-radius:4px;padding:12px 16px 12px 20px;text-align:left;font:14px/21px Montserrat,Arial;box-shadow:0 3px 12px rgba(51,51,51,.16);display:flex;flex-direction:column;gap:2px;width:380px;max-width:94vw;box-sizing:border-box}
        #mtsbu-cap.manual{border-left-color:var(--red)}
        #mtsbu-cap b{font:700 15px/22px Montserrat,Arial !important;display:block}
        #mtsbu-cap .sub{font:400 13px/18px Montserrat,Arial;color:var(--muted)}
        #mtsbu-panel .hd .x{background:rgba(255,255,255,.2);color:#fff !important;border:0;border-radius:50px;width:30px;height:30px;font-size:18px;line-height:1;cursor:pointer;margin-left:12px;flex:none;transition:background .2s}
        #mtsbu-panel .hd .x:hover{background:rgba(255,255,255,.32)}
        #mtsbu-panel .hd .right{display:flex;align-items:center;gap:0}`;
        document.head.appendChild(s);
    }

    /* ===================== UI ===================== */
    let panelEl, barEl;
    function dot(kind) { const c = kind === 'ok' ? 'var(--ok)' : (kind === 'no' ? 'var(--red)' : '#c8c8c8'); return `<span class="d" style="background:${c}"></span>`; }
    function statKind(s) { return /діє:|чинний/i.test(s) ? 'ok' : (/не діє|не знайд|^не |пропущ/i.test(s) ? 'no' : 'nt'); }
    function statShort(s) { if (/^діє:/.test(s)) return s; if (/чинний/i.test(s)) return 'чинний'; if (/не діє/i.test(s)) return 'не діє'; if (/не знайд/i.test(s)) return 'не знайдено'; if (/пропущ/i.test(s)) return 'пропущено'; return s; }

    function flash(msg, kind) { styleOnce(); let f = document.getElementById('mtsbu-flash'); if (!f) { f = document.createElement('div'); f.id = 'mtsbu-flash'; document.body.appendChild(f); } f.className = kind === 'err' ? 'err' : ''; f.textContent = msg; clearTimeout(f._t); f._t = setTimeout(() => f.remove(), kind === 'err' ? 6000 : 3200); }
    function captchaBanner(value, mode) { styleOnce(); let b = document.getElementById('mtsbu-cap'); if (!b) { b = document.createElement('div'); b.id = 'mtsbu-cap'; document.body.appendChild(b); } b.className = mode === 'manual' ? 'manual' : ''; b.innerHTML = `<b>Перевірка захисту${value ? ' · ' + esc(value) : ''}</b><div class="sub">${mode === 'manual' ? 'Схоже, потрібен клік — далі відкрию сам.' : 'Зачекай 1–3 с — відкрию автоматично.'}</div>`; }
    function cfWaitBanner(stuck) { styleOnce(); let b = document.getElementById('mtsbu-cap'); if (!b) { b = document.createElement('div'); b.id = 'mtsbu-cap'; document.body.appendChild(b); } b.className = stuck ? 'manual' : ''; b.innerHTML = `<b>Cloudflare перевіряє браузер…</b><div class="sub">${stuck ? 'Якщо просить — пройди перевірку.' : 'Зачекай 1–3 с, сторінка відкриється сама.'}</div>`; }

    function doneList(items) {
        return `<ul>${items.map((q) => {
            let sub = esc(statShort(q.status));
            if (q.startDate && !sub.includes(q.startDate)) sub += ' · ' + esc(q.startDate);
            return `<li class="${q.status === 'pending' ? 'cur' : ''}"><div class="li-main"><span class="v">${esc(q.value)}</span><span class="tag">${q.type}</span><span class="dot-wrap">${dot(statKind(q.status))}</span></div><div class="li-sub">${sub}</div></li>`;
        }).join('')}</ul>`;
    }
    function renderPanel() {
        styleOnce();
        let isNew = false;
        if (!panelEl) { 
            panelEl = document.createElement('div'); panelEl.id = 'mtsbu-panel'; 
            isNew = true;
        }
        const running = flow === 'filling' && pointer < queue.length;
        const hasResults = Object.keys(results).length > 0;
        const doneAll = !running && queue.length > 0 && hasResults;
        const doneN = queue.filter((q) => q.status !== 'pending').length;
        let title, sub, counter = '', body;

        if (running) {
            title = 'Перевіряю…'; sub = 'Не закривай вкладку'; counter = `<span class="c">${doneN}/${queue.length}</span>`;
            const pct = Math.round(doneN / queue.length * 100); const cur = queue[pointer] || {};
            body = `<div class="prog"><i style="width:${pct}%"></i></div>
              <div class="now"><span class="spin"></span><span><span class="v">${esc(cur.value || '')}</span><small>${esc(cur.type || '')}${ui.binSearch ? ' · пошук дати початку' : ''} — опрацьовую…</small></span></div>
              <div class="mini"><button id="skip">Пропустити</button><button class="dgr" id="stop">Зупинити</button></div>${doneList(queue.slice(0, pointer))}`;
        } else if (doneAll) {
            title = 'Готово'; sub = 'Результат можна експортувати'; counter = `<span class="c">${queue.length}</span>`;
            const ok = queue.filter((q) => /діє:|чинний/i.test(q.status)).length;
            const no = queue.filter((q) => /не діє|не знайд/i.test(q.status)).length; const other = queue.length - ok - no;
            body = `<div class="chips"><span class="chip">${dot('ok')} Чинні · ${ok}</span><span class="chip">${dot('no')} Не чинні · ${no}</span>${other ? `<span class="chip">${dot('nt')} Інше · ${other}</span>` : ''}</div>
              <button class="cta" id="csv">Експортувати CSV</button><div class="mini"><button id="newrun">Нова перевірка</button></div>${doneList(queue)}`;
        } else {
            title = 'Перевірка ОСЦПВ'; sub = 'Пакетна перевірка чинності полісів';
            const n = parseInput(ui.text, ui.defType).length;
            const types = [['policy', 'Номер полісу'], ['reg', 'Держномер'], ['vin', 'VIN-код'], ['auto', 'Авто']];
            const seg = types.map(([v, t]) => `<button data-v="${v}" class="${v === ui.defType ? 'on' : ''}"><span class="dot"></span>${t}</button>`).join('');
            body = `<div class="lbl">Список авто</div><div class="hint">Один на рядок. Префікс reg: / vin: / pol: за бажанням.</div>
              <textarea id="t" placeholder="223471595&#10;reg: AI5435MA&#10;vin: YV1382MS0A2489738">${esc(ui.text)}</textarea>
              <div class="seg" id="seg">${seg}</div>
              <div class="dater"><span>Перевіряти станом на</span><input type="text" id="dt" value="${ui.date}"></div>
              <label class="sw ${ui.binSearch ? 'on' : ''}" id="sw"><span class="dot"></span><span class="txt">Знайти дату початку полісу<small>Бінарний пошук — більше перевірок</small></span></label>
              <button class="cta" id="start" ${n ? '' : 'disabled'}>${n ? `Перевірити ${n} авто` : 'Додай авто вище'}</button>
              ${hasResults ? `<span class="link" id="csv">Експорт попереднього результату</span>` : ''}`;
        }
        panelEl.innerHTML = `<div class="hd"><span class="t">${title}<small>${sub}</small></span><span class="right">${counter}<button class="x" id="mt-close" title="Згорнути">×</button></span></div><div class="bd">${body}</div>`;
        if (isNew) {
            panelEl.style.transition = 'none';
            panelEl.classList.toggle('open', !ui.collapsed);
            document.body.appendChild(panelEl);
            void panelEl.offsetHeight; // force layout
            panelEl.style.transition = '';
        } else {
            panelEl.classList.toggle('open', !ui.collapsed);
        }
        const $ = (id) => panelEl.querySelector('#' + id);
        const persist = () => { const t = $('t'), dt = $('dt'); if (t) ui.text = t.value; if (dt) ui.date = dt.value.trim() || today(); save(K.ui, ui); };
        $('mt-close').onclick = () => { ui.collapsed = true; save(K.ui, ui); applyDrawer(); };
        if ($('t')) {
            $('t').addEventListener('input', () => { persist(); const n = parseInput(ui.text, ui.defType).length; const b = $('start'); if (b) { b.disabled = !n; b.textContent = n ? `Перевірити ${n} авто` : 'Додай авто вище'; } });
            $('dt').addEventListener('change', persist);
            $('seg').querySelectorAll('button').forEach((btn) => btn.onclick = () => { ui.defType = btn.dataset.v; save(K.ui, ui); renderPanel(); });
            $('sw').onclick = () => { ui.binSearch = !ui.binSearch; save(K.ui, ui); renderPanel(); };
            $('start').onclick = () => { persist(); startBatch(); };
        }
        if ($('skip')) $('skip').onclick = skipCurrent;
        if ($('stop')) $('stop').onclick = resetBatch;
        if ($('newrun')) $('newrun').onclick = resetBatch;
        if ($('csv')) $('csv').onclick = exportCSV;
        ensureHandle(); applyDrawer();
    }
    function ensureHandle() {
        styleOnce();
        let h = document.getElementById('mtsbu-handle');
        let isNew = false;
        if (!h) {
            h = document.createElement('button'); h.id = 'mtsbu-handle'; h.title = 'Пакетна перевірка ОСЦПВ';
            isNew = true;
        }
        const done = queue.filter((q) => q.status !== 'pending').length;
        const badge = queue.length ? `<span class="bdg">${done}/${queue.length}</span>` : '';
        h.innerHTML = `<span class="chev">${ui.collapsed ? '›' : '‹'}</span>${badge}`;
        if (isNew) {
            h.style.transition = 'none';
            h.style.right = ui.collapsed ? '0px' : '400px';
            document.body.appendChild(h);
            void h.offsetHeight; // force layout
            h.style.transition = '';
            h.onclick = () => { ui.collapsed = !ui.collapsed; save(K.ui, ui); applyDrawer(); };
        }
    }
    function applyDrawer() {
        if (panelEl) panelEl.classList.toggle('open', !ui.collapsed);
        const h = document.getElementById('mtsbu-handle');
        if (h) {
            const w = panelEl ? (panelEl.getBoundingClientRect().width || 400) : 384;
            h.style.right = ui.collapsed ? '0px' : w + 'px';
        }
    }
    function renderBar(item, c, done, nextProbe) {
        styleOnce(); if (barEl) barEl.remove();
        barEl = document.createElement('div'); barEl.id = 'mtsbu-bar';
        const next = pointer + 1 < queue.length ? queue[pointer + 1].value : '—';
        if (!ui.binSearch || done) {
            const k = statKind(item.status || (c ? c.statusText : '')); const meta = [item.insurer, item.vehicle].filter(Boolean).join(' · ');
            barEl.innerHTML = `<span><div class="row"><span class="v">${esc(item ? item.value : '')}</span><span class="st">${dot(k)} ${esc(item.status || (c ? c.statusText : ''))}</span></div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</span><span class="cd" id="cd"></span><button id="nx">Далі → ${esc(next)}</button>`;
            document.body.appendChild(barEl); barEl.querySelector('#nx').onclick = () => { clearInterval(countdownTimer); advancePointer(); };
        } else {
            barEl.innerHTML = `<span><div class="row"><span class="v">${esc(item.value)}</span></div><span class="meta">бінарний пошук, проба <b>${esc(nextProbe || '')}</b></span></span><span class="cd" id="cd"></span><button id="nx">Крок →</button>`;
            document.body.appendChild(barEl); barEl.querySelector('#nx').onclick = () => { clearInterval(countdownTimer); goSearch(); };
        }
    }
    function startCountdown(sec, fn) { let n = sec; const cd = () => { const el = document.getElementById('cd'); if (el) el.textContent = `${n}с`; }; cd(); clearInterval(countdownTimer); countdownTimer = setInterval(() => { n--; cd(); if (n <= 0) { clearInterval(countdownTimer); fn(); } }, 1000); }
    function exportCSV() {
        const head = ['Тип', 'Значення', 'Дата перевірки', 'Статус', 'Дата початку', 'Дата закінчення', 'Номер полісу', 'Страховик', 'ТЗ', 'Текст статусу'];
        const rows = [head];
        queue.forEach((it) => { const r = results[it.value] || {}; rows.push([it.type, it.value, r.asOf || ui.date, r.validity || it.status, r.startDate || '', r.endDate || '', r.policyKey || '', r.insurer || '', r.vehicle || '', r.statusText || '']); });
        const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `mtsbu_oscpv_${Date.now()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    function makeDraggable(box, handle) {
        let dx = 0, dy = 0, sx = 0, sy = 0, drag = false;
        handle.addEventListener('mousedown', (e) => { drag = true; sx = e.clientX; sy = e.clientY; const r = box.getBoundingClientRect(); dx = r.left; dy = r.top; e.preventDefault(); });
        document.addEventListener('mousemove', (e) => { if (!drag) return; box.style.left = (dx + e.clientX - sx) + 'px'; box.style.top = (dy + e.clientY - sy) + 'px'; box.style.right = 'auto'; });
        document.addEventListener('mouseup', () => { drag = false; });
    }

    function init() {
        try {
            if (isCfChallenge()) { cfWaitBanner(false); setTimeout(() => { if (isCfChallenge()) cfWaitBanner(true); }, 12000); return; }
            renderPanel();
            if (isResultPage()) { handleResultPage(); return; }
            if (flow === 'filling') proceedFill();
        } catch (e) {
            console.error('[МТСБУ скрипт]', e);
            try { renderPanel(); } catch (e2) { console.error('[МТСБУ скрипт] render', e2); }
        }
    }
    // запускаємо одразу і ще раз трохи згодом (на випадок пізнього рендеру форми / Turnstile)
    function boot() { init(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    setTimeout(() => { if (!document.getElementById('mtsbu-panel') && !document.getElementById('mtsbu-handle')) { try { renderPanel(); } catch (e) {} } }, 1500);
})();
