// 私密相簿：需要密碼才能打開，影片存在這支裝置的瀏覽器資料庫（IndexedDB），
// 不會上傳到任何地方。可以分資料夾，選好的影片一鍵放進影片牆播放。
(function () {
    'use strict';

    // 預設密碼 9527（只存雜湊值，不存明碼）；在相簿裡改過密碼後以裝置上的設定為準
    const DEFAULT_PIN_HASH = '36a71a5bca2513f92fc85544531b1605c3515ee5f6039882db0b17b05082652f';
    const PIN_KEY = 'vaultPinHash';
    const AUTO_LOCK_MS = 5 * 60 * 1000;
    const ALL = '__all__';
    const UNFILED = '未分類';

    let db = null;
    let unlocked = false;
    let lastActive = 0;
    let currentFolder = ALL;
    let selectMode = false;
    let selected = new Set();
    let items = [];          // 目前資料夾的項目（不含影片本體）
    let folders = [];
    let thumbUrls = [];
    let pinBuffer = '';
    let pinPurpose = 'unlock'; // unlock | change-old | change-new | change-confirm
    let pinNewTemp = '';

    // ---------- 資料庫 ----------
    function openDB() {
        if (db) return Promise.resolve(db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('privateVault', 1);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('items')) {
                    const s = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('folder', 'folder');
                }
                if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
                if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'name' });
            };
            req.onsuccess = () => { db = req.result; resolve(db); };
            req.onerror = () => reject(req.error);
        });
    }
    function tx(stores, mode = 'readonly') { return db.transaction(stores, mode); }
    function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
    function doneP(t) { return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

    async function loadFolders() {
        const f = await reqP(tx('folders').objectStore('folders').getAll());
        const names = new Set(f.map(x => x.name));
        const all = await reqP(tx('items').objectStore('items').getAll());
        all.forEach(it => names.add(it.folder || UNFILED));
        folders = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true }));
        return all;
    }

    // ---------- 密碼 ----------
    async function sha256(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function pinHash() {
        try { return localStorage.getItem(PIN_KEY) || DEFAULT_PIN_HASH; } catch (e) { return DEFAULT_PIN_HASH; }
    }

    // ---------- 介面 ----------
    const css = `
    #vault { position: fixed; inset: 0; z-index: 500; background: #07070a; color: #f8fafc; display: none; flex-direction: column;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
        font-family: ui-sans-serif, system-ui, -apple-system, "PingFang TC", sans-serif; -webkit-user-select: none; user-select: none; }
    #vault.open { display: flex; }
    #toast { z-index: 600 !important; }
    #vault * { cursor: auto !important; box-sizing: border-box; }
    #vault button { cursor: pointer !important; font: inherit; color: inherit; }
    .v-lock { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 24px; }
    .v-lock h2 { font-size: 18px; font-weight: 800; letter-spacing: .1em; margin: 0; }
    .v-lock p { margin: 0; font-size: 13px; color: rgba(255,255,255,.5); min-height: 18px; }
    .v-lock p.err { color: #f87171; }
    .v-dots { display: flex; gap: 16px; }
    .v-dots span { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(168,85,247,.8); }
    .v-dots span.on { background: #a855f7; }
    .v-dots.shake { animation: vshake .35s; }
    @keyframes vshake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-10px)} 75%{transform:translateX(10px)} }
    .v-pad { display: grid; grid-template-columns: repeat(3, 72px); gap: 16px; }
    .v-pad button { height: 72px; border-radius: 50%; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); font-size: 26px; font-weight: 600; }
    .v-pad button:active { background: rgba(168,85,247,.45); }
    .v-pad .v-ghost { background: transparent; border-color: transparent; font-size: 14px; color: rgba(255,255,255,.6); }
    .v-album { flex: 1; display: none; flex-direction: column; min-height: 0; }
    #vault.unlocked .v-lock { display: none; }
    #vault.unlocked .v-album { display: flex; }
    .v-top { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
    .v-top h2 { flex: 1; margin: 0; font-size: 17px; font-weight: 800; }
    .v-btn { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); border-radius: 10px; padding: 8px 12px; font-size: 13px; font-weight: 700; white-space: nowrap; }
    .v-btn.primary { background: #9333ea; border-color: #a855f7; }
    .v-btn.danger { color: #fca5a5; border-color: rgba(248,113,113,.4); }
    .v-btn:disabled { opacity: .35; }
    .v-folders { display: flex; gap: 8px; overflow-x: auto; padding: 4px 14px 10px; scrollbar-width: none; }
    .v-folders::-webkit-scrollbar { display: none; }
    .v-chip { flex: none; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); border-radius: 999px; padding: 6px 14px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,.7); }
    .v-chip.on { background: rgba(168,85,247,.55); border-color: #a855f7; color: #fff; }
    .v-grid { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 4px; padding: 0 4px 12px; align-content: start; }
    .v-item { position: relative; aspect-ratio: 9/16; background: #15151c; border-radius: 6px; overflow: hidden; border: none; padding: 0; }
    .v-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 28px; color: rgba(255,255,255,.35); background: linear-gradient(160deg, #1d1b2e, #0d0d14); }
    .v-item img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
    .v-item .v-dur { position: absolute; right: 5px; bottom: 4px; font-size: 11px; font-weight: 700; text-shadow: 0 1px 3px #000; }
    .v-item .v-name { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 5px 4px; font-size: 10px; text-align: left; background: linear-gradient(transparent, rgba(0,0,0,.75)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 36px; }
    .v-item .v-check { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; background: rgba(0,0,0,.35); display: none; align-items: center; justify-content: center; font-size: 14px; font-weight: 900; }
    .v-select .v-item .v-check { display: flex; color: transparent; }
    .v-item.sel .v-check { color: #fff; }
    .v-item.sel { outline: 3px solid #a855f7; outline-offset: -3px; }
    .v-item.sel .v-check { background: #a855f7; border-color: #a855f7; }
    .v-empty { grid-column: 1 / -1; text-align: center; color: rgba(255,255,255,.45); font-size: 14px; padding: 60px 20px; line-height: 1.8; }
    .v-bar { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08); background: rgba(10,15,25,.9); flex-wrap: wrap; }
    .v-bar .v-btn { flex: 1 1 auto; }
    .v-progress { padding: 0 14px 8px; font-size: 12px; color: #c4b5fd; display: none; }
    .v-progress.on { display: block; }
    .v-cloud { position: absolute; inset: 0; z-index: 5; background: #07070a; display: none; flex-direction: column;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .v-cloud.open { display: flex; }
    .v-cloud-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; min-height: 0; }
    .v-cloud-body .v-grid { overflow: visible; }
    .v-select-grid .v-check { display: flex; color: transparent; }
    .v-select-grid .v-item.sel .v-check { color: #fff; }
    .v-item.got { opacity: .45; }
    .v-crumb { padding: 4px 14px 10px; font-size: 13px; color: rgba(255,255,255,.6); }
    .v-crumb button { background: none; border: none; color: #c4b5fd; padding: 2px 0; font-weight: 700; }
    .v-row { text-align: left; display: flex; gap: 8px; align-items: center; margin: 0 14px; }
    .v-setup { padding: 8px 16px; display: flex; flex-direction: column; gap: 12px; font-size: 14px; line-height: 1.6; color: rgba(255,255,255,.8); }
    .v-setup p { margin: 0; }
    .v-setup input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); background: #000; color: #fff; font-size: 15px; -webkit-user-select: text; user-select: text; }
    .v-hint { font-size: 12px; color: rgba(255,255,255,.5); }
    .v-hint code, .v-setup code { color: #c4b5fd; word-break: break-all; -webkit-user-select: text; user-select: text; }
    .v-sheet { position: fixed; inset: 0; z-index: 510; background: rgba(0,0,0,.55); display: none; align-items: flex-end; justify-content: center; }
    .v-sheet.open { display: flex; }
    .v-sheet > div { width: 100%; max-width: 480px; background: #12121a; border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px; }
    .v-sheet h3 { margin: 0 0 4px; font-size: 15px; }
    .v-sheet input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); background: #000; color: #fff; font-size: 16px; -webkit-user-select: text; user-select: text; }
    .v-sheet .v-list { display: flex; flex-direction: column; gap: 6px; max-height: 45vh; overflow-y: auto; }
    `;

    function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

    function build() {
        if (document.getElementById('vault')) return;
        const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
        const root = el(`
        <div id="vault" aria-hidden="true">
            <div class="v-lock">
                <h2>🔒 App</h2>
                <p id="vPinMsg">請輸入密碼</p>
                <div class="v-dots" id="vDots"><span></span><span></span><span></span><span></span></div>
                <div class="v-pad" id="vPad">
                    ${[1,2,3,4,5,6,7,8,9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join('')}
                    <button type="button" class="v-ghost" data-k="close">關閉</button>
                    <button type="button" data-k="0">0</button>
                    <button type="button" class="v-ghost" data-k="del">刪除</button>
                </div>
            </div>
            <div class="v-album" id="vAlbum">
                <div class="v-top">
                    <h2>App</h2>
                    <button type="button" class="v-btn" id="vSelectBtn">選取</button>
                    <button type="button" class="v-btn" id="vCloudBtn">☁ 雲端</button>
                    <button type="button" class="v-btn" id="vMoreBtn">⋯</button>
                    <button type="button" class="v-btn" id="vLockBtn">鎖上</button>
                </div>
                <div class="v-folders" id="vFolders"></div>
                <div class="v-progress" id="vProgress"></div>
                <div class="v-grid" id="vGrid"></div>
                <div class="v-bar" id="vBarNormal">
                    <button type="button" class="v-btn" id="vImportBtn">＋ 匯入影片</button>
                    <button type="button" class="v-btn primary" id="vPlayFolderBtn">▶ 播放這個資料夾</button>
                </div>
                <div class="v-bar" id="vBarSelect" style="display:none">
                    <button type="button" class="v-btn" id="vSelAllBtn">全選</button>
                    <button type="button" class="v-btn" id="vMoveBtn">移動</button>
                    <button type="button" class="v-btn danger" id="vDeleteBtn">刪除</button>
                    <button type="button" class="v-btn primary" id="vPlaySelBtn">▶ 播放所選</button>
                </div>
                <input type="file" id="vFileInput" accept="video/*,image/*" multiple hidden>
            </div>
            <div class="v-sheet" id="vSheet"><div id="vSheetBody"></div></div>
        </div>`);
        document.body.appendChild(root);

        root.querySelector('#vPad').addEventListener('click', e => {
            const b = e.target.closest('button'); if (!b) return;
            onPinKey(b.dataset.k);
        });
        root.querySelector('#vLockBtn').onclick = lock;
        root.querySelector('#vSelectBtn').onclick = () => setSelectMode(!selectMode);
        root.querySelector('#vImportBtn').onclick = () => root.querySelector('#vFileInput').click();
        root.querySelector('#vFileInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
        root.querySelector('#vPlayFolderBtn').onclick = () => play(items.map(i => i.id));
        root.querySelector('#vPlaySelBtn').onclick = () => play([...selected]);
        root.querySelector('#vSelAllBtn').onclick = () => {
            if (selected.size === items.length) selected.clear(); else items.forEach(i => selected.add(i.id));
            renderGrid();
        };
        root.querySelector('#vDeleteBtn').onclick = deleteSelected;
        root.querySelector('#vMoveBtn').onclick = moveSheet;
        root.querySelector('#vMoreBtn').onclick = moreSheet;
        root.querySelector('#vCloudBtn').onclick = () => Cloud.show();
        root.querySelector('#vSheet').addEventListener('click', e => { if (e.target.id === 'vSheet') closeSheet(); });
        root.querySelector('#vGrid').addEventListener('click', e => {
            const b = e.target.closest('.v-item'); if (!b) return;
            const id = Number(b.dataset.id);
            if (selectMode) {
                selected.has(id) ? selected.delete(id) : selected.add(id);
                renderGrid();
            } else {
                play([id]);
            }
        });
        // 實體鍵盤輸入密碼
        window.addEventListener('keydown', e => {
            if (!isOpen() || unlocked || document.getElementById('vSheet').classList.contains('open')) return;
            if (/^[0-9]$/.test(e.key)) onPinKey(e.key);
            else if (e.key === 'Backspace') onPinKey('del');
            else if (e.key === 'Escape') onPinKey('close');
        }, true);
        ['pointerdown', 'touchstart', 'keydown'].forEach(t => root.addEventListener(t, () => { lastActive = Date.now(); }, { passive: true }));
        document.addEventListener('visibilitychange', () => { if (document.hidden) lock(); });
        setInterval(() => { if (unlocked && Date.now() - lastActive > AUTO_LOCK_MS) lock(); }, 15000);
    }

    function isOpen() { const v = document.getElementById('vault'); return !!v && v.classList.contains('open'); }

    // ---------- 開關與上鎖 ----------
    function open() {
        build();
        const v = document.getElementById('vault');
        v.classList.add('open'); v.setAttribute('aria-hidden', 'false');
        // 每次打開都要重新輸入密碼
        unlocked = false; v.classList.remove('unlocked'); startPin('unlock');
    }
    function close() {
        const v = document.getElementById('vault'); if (!v) return;
        v.classList.remove('open'); v.setAttribute('aria-hidden', 'true');
        closeSheet();
        if (unlocked) lock();   // 關閉（包含播放後自動關閉）就上鎖
    }
    function lock() {
        unlocked = false;
        selected.clear(); setSelectMode(false);
        thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = [];
        items = [];
        const g = document.getElementById('vGrid'); if (g) g.innerHTML = '';
        const cp = document.getElementById('vCloud'); if (cp) cp.classList.remove('open');
        const v = document.getElementById('vault');
        if (v) { v.classList.remove('unlocked'); if (v.classList.contains('open')) close(); }
    }

    // ---------- 密碼鍵盤 ----------
    function startPin(purpose, msg) {
        pinPurpose = purpose; pinBuffer = '';
        const v = document.getElementById('vault'); v.classList.remove('unlocked');
        setPinMsg(msg || { 'unlock': '請輸入密碼', 'change-old': '請輸入目前的密碼', 'change-new': '請輸入新的 4 位數密碼', 'change-confirm': '再輸入一次新密碼' }[purpose]);
        drawDots();
    }
    function setPinMsg(t, err) { const p = document.getElementById('vPinMsg'); p.innerText = t; p.classList.toggle('err', !!err); }
    function drawDots() { document.querySelectorAll('#vDots span').forEach((s, i) => s.classList.toggle('on', i < pinBuffer.length)); }
    function shake() { const d = document.getElementById('vDots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }

    async function onPinKey(k) {
        if (k === 'close') {
            if (pinPurpose === 'unlock') close();
            else { unlocked = true; document.getElementById('vault').classList.add('unlocked'); refresh(); }
            return;
        }
        if (k === 'del') { pinBuffer = pinBuffer.slice(0, -1); drawDots(); return; }
        if (pinBuffer.length >= 4) return;
        pinBuffer += k; drawDots();
        if (pinBuffer.length < 4) return;
        const entered = pinBuffer;
        await new Promise(r => setTimeout(r, 120));
        if (pinPurpose === 'unlock' || pinPurpose === 'change-old') {
            const ok = (await sha256(entered)) === pinHash();
            if (!ok) { pinBuffer = ''; drawDots(); shake(); setPinMsg('密碼錯誤，請再試一次', true); return; }
            if (pinPurpose === 'unlock') {
                unlocked = true; lastActive = Date.now();
                document.getElementById('vault').classList.add('unlocked');
                try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
                refresh();
                if (Cloud.pendingOpen) { Cloud.pendingOpen = false; Cloud.show(); }
            } else startPin('change-new');
        } else if (pinPurpose === 'change-new') {
            pinNewTemp = entered; startPin('change-confirm');
        } else if (pinPurpose === 'change-confirm') {
            if (entered !== pinNewTemp) { startPin('change-new', '兩次輸入不一樣，請重新設定'); shake(); return; }
            try { localStorage.setItem(PIN_KEY, await sha256(entered)); } catch (e) {}
            unlocked = true; lastActive = Date.now();
            document.getElementById('vault').classList.add('unlocked');
            refresh(); toast('密碼已更新');
        }
    }

    // ---------- 相簿內容 ----------
    async function refresh() {
        await openDB();
        const all = await loadFolders();
        if (currentFolder !== ALL && !folders.includes(currentFolder)) currentFolder = ALL;
        items = all.filter(i => currentFolder === ALL || (i.folder || UNFILED) === currentFolder)
                   .sort((a, b) => a.added - b.added || a.id - b.id);
        [...selected].forEach(id => { if (!items.some(i => i.id === id)) selected.delete(id); });
        renderFolders(all);
        renderGrid();
        if (all.some(i => !i.thumb && !i.thumbFailed)) fixMissingThumbs();
    }

    function renderFolders(all) {
        const wrap = document.getElementById('vFolders');
        const count = name => all.filter(i => (i.folder || UNFILED) === name).length;
        wrap.innerHTML = '';
        const mk = (name, label) => {
            const b = el(`<button type="button" class="v-chip${currentFolder === name ? ' on' : ''}"></button>`);
            b.textContent = label; b.onclick = () => { currentFolder = name; selected.clear(); refresh(); };
            wrap.appendChild(b);
        };
        mk(ALL, `全部 ${all.length}`);
        folders.forEach(f => mk(f, `${f} ${count(f)}`));
        const add = el(`<button type="button" class="v-chip">＋ 資料夾</button>`);
        add.onclick = () => newFolderSheet();
        wrap.appendChild(add);
        document.getElementById('vPlayFolderBtn').innerText = currentFolder === ALL ? '▶ 播放全部' : '▶ 播放這個資料夾';
    }

    function fmtDur(s) { if (!s || !isFinite(s)) return ''; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

    function renderGrid() {
        const g = document.getElementById('vGrid');
        thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = [];
        g.innerHTML = '';
        if (!items.length) {
            g.innerHTML = `<div class="v-empty">這裡還沒有影片<br>點下方「＋ 匯入影片」從手機相簿或雲端硬碟加入</div>`;
        }
        items.forEach(it => {
            const b = el(`<button type="button" class="v-item${selected.has(it.id) ? ' sel' : ''}" data-id="${it.id}"><span class="v-check">✓</span></button>`);
            if (it.thumb) setTileThumb(b, it.thumb);
            else b.prepend(el(`<span class="v-ph">${it.type === 'video' ? '▶' : '🖼'}</span>`));
            const n = document.createElement('span'); n.className = 'v-name'; n.textContent = it.name; b.appendChild(n);
            const d = document.createElement('span'); d.className = 'v-dur'; d.textContent = it.type === 'video' ? fmtDur(it.duration) : '圖'; b.appendChild(d);
            g.appendChild(b);
        });
        const n = selected.size;
        document.getElementById('vPlaySelBtn').innerText = n ? `▶ 播放所選 (${n})` : '▶ 播放所選';
        ['vPlaySelBtn', 'vMoveBtn', 'vDeleteBtn'].forEach(id => document.getElementById(id).disabled = n === 0);
        document.getElementById('vSelAllBtn').innerText = items.length && n === items.length ? '取消全選' : '全選';
        document.getElementById('vPlayFolderBtn').disabled = items.length === 0;
    }

    function setSelectMode(on) {
        selectMode = on; if (!on) selected.clear();
        const a = document.getElementById('vAlbum'); if (!a) return;
        a.classList.toggle('v-select', on);
        document.getElementById('vSelectBtn').innerText = on ? '完成' : '選取';
        document.getElementById('vBarNormal').style.display = on ? 'none' : '';
        document.getElementById('vBarSelect').style.display = on ? '' : 'none';
        if (unlocked) renderGrid();
    }

    // ---------- 匯入 ----------
    const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv|3gp|mkv)$/i;
    const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i;
    function kindOf(f) {
        if ((f.type || '').startsWith('video/') || VIDEO_EXT.test(f.name || '')) return 'video';
        if ((f.type || '').startsWith('image/') || IMAGE_EXT.test(f.name || '')) return 'img';
        return null;
    }

    // 把畫面縮成 240px 寬的 JPEG 預覽圖；全黑的畫面視為失敗（iPhone 有時會先給黑畫面）
    function snapshot(src, w, h) {
        return new Promise(resolve => {
            try {
                if (!w || !h) return resolve(null);
                const W = 240, H = Math.max(1, Math.round(W * (h / w)));
                const c = document.createElement('canvas'); c.width = W; c.height = H;
                const ctx = c.getContext('2d');
                ctx.drawImage(src, 0, 0, W, H);
                const px = ctx.getImageData(0, 0, W, H).data;
                let sum = 0; for (let i = 0; i < px.length; i += 400) sum += px[i] + px[i + 1] + px[i + 2];
                if (sum < 30) return resolve(null);
                c.toBlob(b => resolve(b), 'image/jpeg', 0.75);
            } catch (e) { resolve(null); }
        });
    }

    // iPhone 的 Safari 不播放就不解碼畫面，所以：放進畫面外、靜音播放一下、跳到 1 秒附近再截圖
    function videoThumb(blob) {
        return new Promise(resolve => {
            const url = URL.createObjectURL(blob);
            const v = document.createElement('video');
            v.muted = true; v.defaultMuted = true; v.playsInline = true;
            v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
            v.preload = 'auto';
            v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:-1';
            document.body.appendChild(v);
            let done = false, tries = 0;
            const finish = thumb => {
                if (done) return; done = true;
                const duration = isFinite(v.duration) ? v.duration : 0;
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
                v.remove(); URL.revokeObjectURL(url);
                resolve({ thumb, duration });
            };
            const targets = () => { const d = isFinite(v.duration) && v.duration > 0 ? v.duration : 3; return [Math.min(1, d / 3), Math.min(2.5, d / 2), d * 0.75, 0.05]; };
            const grab = async () => {
                if (done) return;
                const t = await snapshot(v, v.videoWidth, v.videoHeight);
                if (t) return finish(t);
                tries++;
                const next = targets()[tries];
                if (next === undefined) return finish(null);
                try { v.currentTime = next; } catch (e) { finish(null); }
            };
            v.addEventListener('seeked', () => setTimeout(grab, 80));
            v.addEventListener('loadeddata', () => {
                const go = () => { try { v.currentTime = targets()[0]; } catch (e) { grab(); } };
                const p = v.play();
                if (p && p.then) p.then(() => { v.pause(); go(); }).catch(go); else go();
            }, { once: true });
            v.addEventListener('error', () => finish(null));
            setTimeout(() => finish(null), 15000);
            v.src = url;
            v.load();
        });
    }

    function imageThumb(blob) {
        return new Promise(resolve => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            const end = t => { URL.revokeObjectURL(url); resolve({ thumb: t, duration: 0 }); };
            img.onload = async () => end(await snapshot(img, img.naturalWidth, img.naturalHeight));
            img.onerror = () => end(null);
            setTimeout(() => end(null), 10000);
            img.src = url;
        });
    }

    function makeThumb(file, kind) { return (kind || kindOf(file)) === 'video' ? videoThumb(file) : imageThumb(file); }

    // 解鎖後，替還沒有預覽圖的舊檔案補做預覽圖（一次一個，做好就更新畫面）
    let fixing = false;
    async function fixMissingThumbs() {
        if (fixing) return; fixing = true;
        try {
            const all = await reqP(tx('items').objectStore('items').getAll());
            for (const it of all.filter(i => !i.thumb && !i.thumbFailed)) {
                if (!unlocked) break;
                const blob = await reqP(tx('blobs').objectStore('blobs').get(it.id));
                if (!blob) continue;
                const { thumb, duration } = await makeThumb(blob, it.type);
                const t = tx('items', 'readwrite'); const s = t.objectStore('items');
                const cur = await reqP(s.get(it.id));
                if (cur) { if (thumb) cur.thumb = thumb; else cur.thumbFailed = true; if (!cur.duration && duration) cur.duration = duration; s.put(cur); }
                await doneP(t);
                const tile = document.querySelector(`.v-item[data-id="${it.id}"]`);
                if (tile && thumb) setTileThumb(tile, thumb);
                const mi = items.find(x => x.id === it.id); if (mi && thumb) mi.thumb = thumb;
            }
        } catch (e) { console.error(e); }
        fixing = false;
    }

    function setTileThumb(tile, thumb) {
        tile.querySelectorAll('img, .v-ph').forEach(x => x.remove());
        const u = URL.createObjectURL(thumb); thumbUrls.push(u);
        const img = document.createElement('img'); img.src = u; img.alt = ''; tile.prepend(img);
    }

    async function importFiles(files, opts = {}) {
        files = files.filter(f => kindOf(f));
        if (!files.length) return 0;
        await openDB();
        const folder = opts.folder || (currentFolder === ALL ? UNFILED : currentFolder);
        if (opts.folder) { const ft = tx('folders', 'readwrite'); ft.objectStore('folders').put({ name: folder }); await doneP(ft); }
        const prog = document.getElementById('vProgress');
        prog.classList.add('on');
        let ok = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            prog.innerText = `匯入中 ${i + 1} / ${files.length}：${f.name}`;
            try {
                prog.innerText = `匯入中 ${i + 1} / ${files.length}：${f.name}（製作預覽圖）`;
                const { thumb, duration } = await makeThumb(f);
                const t = tx(['items', 'blobs'], 'readwrite');
                const kind = kindOf(f);
                const mime = f.type || (kind === 'video' ? (/\.mov$/i.test(f.name) ? 'video/quicktime' : 'video/mp4') : 'image/jpeg');
                const meta = { name: f.name, type: kind, mime, size: f.size, folder, added: Date.now() + i, duration: duration || 0, thumb, thumbFailed: !thumb };
                if (opts.extra) Object.assign(meta, opts.extra(f, i));
                const idReq = t.objectStore('items').add(meta);
                idReq.onsuccess = () => t.objectStore('blobs').put(f, idReq.result);
                await doneP(t);
                ok++;
            } catch (e) {
                console.error(e);
                toast(`「${f.name}」匯入失敗，可能是手機空間不足`);
            }
            lastActive = Date.now();
        }
        prog.classList.remove('on');
        if (!opts.silent) toast(`已匯入 ${ok} 個檔案到「${folder}」`);
        refresh();
        return ok;
    }

    // ---------- 播放到影片牆 ----------
    async function play(ids) {
        if (!ids.length) return;
        await openDB();
        const t = tx(['items', 'blobs']);
        const files = [];
        for (const id of ids) {
            const meta = await reqP(t.objectStore('items').get(id));
            const blob = await reqP(t.objectStore('blobs').get(id));
            if (meta && blob) files.push(new File([blob], meta.name, { type: meta.mime || blob.type }));
        }
        if (!files.length) { toast('找不到影片檔，可能已被刪除'); return; }
        if (typeof clearAllChannels === 'function') clearAllChannels();
        if (typeof distributeLoadedFiles === 'function') distributeLoadedFiles(files, 0);
        close();
        const n = (typeof visibleChannelCount === 'number' && visibleChannelCount) || files.length;
        toast(files.length > n ? `已載入 ${files.length} 部，按「下一輪」換下一批` : `已載入 ${files.length} 部`);
    }

    // ---------- 刪除 / 移動 / 資料夾 ----------
    function sheet(html) {
        const s = document.getElementById('vSheet');
        document.getElementById('vSheetBody').innerHTML = html;
        s.classList.add('open');
        return document.getElementById('vSheetBody');
    }
    function closeSheet() { const s = document.getElementById('vSheet'); if (s) s.classList.remove('open'); }

    function deleteSelected() {
        const n = selected.size; if (!n) return;
        const body = sheet(`<h3>確定要刪除 ${n} 個檔案？</h3><p style="margin:0;font-size:13px;color:rgba(255,255,255,.55)">刪除後無法復原。</p>
            <button type="button" class="v-btn danger" id="vDelYes">刪除</button><button type="button" class="v-btn" id="vDelNo">取消</button>`);
        body.querySelector('#vDelNo').onclick = closeSheet;
        body.querySelector('#vDelYes').onclick = async () => {
            const t = tx(['items', 'blobs'], 'readwrite');
            selected.forEach(id => { t.objectStore('items').delete(id); t.objectStore('blobs').delete(id); });
            await doneP(t);
            closeSheet(); selected.clear(); toast(`已刪除 ${n} 個檔案`); refresh();
        };
    }

    function moveSheet() {
        if (!selected.size) return;
        const list = [...new Set([UNFILED, ...folders])];
        const body = sheet(`<h3>移動到資料夾</h3><div class="v-list" id="vMoveList"></div>
            <button type="button" class="v-btn" id="vMoveNew">＋ 新資料夾</button><button type="button" class="v-btn" id="vMoveNo">取消</button>`);
        const wrap = body.querySelector('#vMoveList');
        list.forEach(f => { const b = el(`<button type="button" class="v-btn"></button>`); b.textContent = f; b.onclick = () => moveTo(f); wrap.appendChild(b); });
        body.querySelector('#vMoveNo').onclick = closeSheet;
        body.querySelector('#vMoveNew').onclick = () => newFolderSheet(name => moveTo(name));
    }
    async function moveTo(folder) {
        const t = tx(['items', 'folders'], 'readwrite');
        const s = t.objectStore('items');
        t.objectStore('folders').put({ name: folder });
        for (const id of selected) {
            const it = await reqP(s.get(id));
            if (it) { it.folder = folder; s.put(it); }
        }
        await doneP(t);
        closeSheet(); toast(`已移動 ${selected.size} 個檔案到「${folder}」`); selected.clear(); refresh();
    }

    function newFolderSheet(after) {
        const body = sheet(`<h3>新增資料夾</h3><input id="vFolderName" maxlength="20" placeholder="資料夾名稱">
            <button type="button" class="v-btn primary" id="vFolderOk">建立</button><button type="button" class="v-btn" id="vFolderNo">取消</button>`);
        const input = body.querySelector('#vFolderName');
        setTimeout(() => input.focus(), 50);
        body.querySelector('#vFolderNo').onclick = closeSheet;
        const ok = async () => {
            const name = input.value.trim();
            if (!name || name === ALL) { input.focus(); return; }
            await openDB();
            const t = tx('folders', 'readwrite'); t.objectStore('folders').put({ name }); await doneP(t);
            closeSheet();
            if (after) after(name); else { currentFolder = name; refresh(); }
        };
        body.querySelector('#vFolderOk').onclick = ok;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    }

    async function moreSheet() {
        let usage = '';
        try {
            const est = await navigator.storage.estimate();
            usage = `已使用 ${(est.usage / 1048576).toFixed(0)} MB，可用約 ${((est.quota - est.usage) / 1073741824).toFixed(1)} GB`;
        } catch (e) {}
        const canDeleteFolder = currentFolder !== ALL && currentFolder !== UNFILED;
        const body = sheet(`<h3>更多</h3><p style="margin:0;font-size:12px;color:rgba(255,255,255,.5)">${usage}</p>
            <button type="button" class="v-btn" id="vChangePin">更改密碼</button>
            ${canDeleteFolder ? `<button type="button" class="v-btn" id="vRenameFolder">重新命名「${currentFolder}」</button>
            <button type="button" class="v-btn danger" id="vDelFolder">刪除資料夾「${currentFolder}」（影片移到未分類）</button>` : ''}
            <button type="button" class="v-btn" id="vMoreClose">關閉</button>`);
        body.querySelector('#vMoreClose').onclick = closeSheet;
        body.querySelector('#vChangePin').onclick = () => { closeSheet(); startPin('change-old'); };
        if (canDeleteFolder) {
            body.querySelector('#vDelFolder').onclick = () => renameFolder(currentFolder, UNFILED, true);
            body.querySelector('#vRenameFolder').onclick = () => {
                const b2 = sheet(`<h3>重新命名資料夾</h3><input id="vRename" maxlength="20">
                    <button type="button" class="v-btn primary" id="vRenameOk">確定</button><button type="button" class="v-btn" id="vRenameNo">取消</button>`);
                const inp = b2.querySelector('#vRename'); inp.value = currentFolder;
                b2.querySelector('#vRenameNo').onclick = closeSheet;
                b2.querySelector('#vRenameOk').onclick = () => { const v = inp.value.trim(); if (v && v !== ALL) renameFolder(currentFolder, v, false); };
            };
        }
    }
    async function renameFolder(from, to, removing) {
        const t = tx(['items', 'folders'], 'readwrite');
        const s = t.objectStore('items');
        const all = await reqP(s.getAll());
        all.filter(i => (i.folder || UNFILED) === from).forEach(i => { i.folder = to; s.put(i); });
        t.objectStore('folders').delete(from);
        if (to !== UNFILED) t.objectStore('folders').put({ name: to });
        await doneP(t);
        closeSheet(); currentFolder = removing ? ALL : to;
        toast(removing ? `已刪除資料夾，影片移到「${UNFILED}」` : `已改名為「${to}」`);
        refresh();
    }

    function toast(t) { if (typeof showToast === 'function') showToast(t); }


    // ======================================================================
    // 雲端硬碟：用自己的 Google 帳號登入，讀取指定資料夾的影片並下載到 App
    // （只讀取，不會修改或刪除雲端上的檔案）
    // ======================================================================
    const Cloud = (() => {
        const CID_KEY = 'driveClientId', TOKEN_KEY = 'driveToken', FOLDER_KEY = 'driveFolder';
        const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
        const API = 'https://www.googleapis.com/drive/v3';
        const ls = {
            get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
            set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
        };
        const state = { pendingOpen: false, files: [], picked: new Set(), path: [], busy: false };

        const clientId = () => (ls.get(CID_KEY) || '').trim();
        function token() {
            try { const t = JSON.parse(ls.get(TOKEN_KEY) || 'null'); if (t && t.exp > Date.now() + 60000) return t.v; } catch (e) {}
            return null;
        }
        const folder = () => { try { return JSON.parse(ls.get(FOLDER_KEY) || 'null'); } catch (e) { return null; } };
        const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

        // 從 Google 登入回來時，網址後面會帶著通行碼，存起來並清掉網址
        function captureRedirect() {
            if (!location.hash || location.hash.indexOf('access_token=') < 0) return;
            const q = new URLSearchParams(location.hash.slice(1));
            const tk = q.get('access_token'), exp = parseInt(q.get('expires_in') || '3600', 10);
            const st = q.get('state') || '';
            if (tk && st === ls.get('driveState')) {
                ls.set(TOKEN_KEY, JSON.stringify({ v: tk, exp: Date.now() + exp * 1000 }));
                state.pendingOpen = true;
            }
            ls.set('driveState', null);
            history.replaceState(null, '', location.pathname + location.search);
            if (state.pendingOpen) setTimeout(() => { toast('已登入 Google，輸入密碼後會打開雲端資料夾'); open(); }, 600);
        }
        function login() {
            const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
            ls.set('driveState', st);
            const u = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
                client_id: clientId(), redirect_uri: redirectUri(), response_type: 'token',
                scope: SCOPE, include_granted_scopes: 'true', prompt: 'select_account', state: st,
            });
            location.href = u;
        }
        function logout() {
            const t = token();
            if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => {});
            ls.set(TOKEN_KEY, null); render();
        }

        async function api(path, params) {
            const t = token(); if (!t) { render(); throw new Error('login'); }
            const r = await fetch(API + path + (params ? '?' + new URLSearchParams(params) : ''), { headers: { Authorization: 'Bearer ' + t } });
            if (r.status === 401) { ls.set(TOKEN_KEY, null); render(); throw new Error('login'); }
            if (!r.ok) throw new Error('Google 回應錯誤 ' + r.status);
            return r.json();
        }
        async function listAll(q, fields) {
            let out = [], pageToken;
            do {
                const p = { q, fields: 'nextPageToken,files(' + fields + ')', pageSize: 1000, orderBy: 'name_natural',
                            supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };
                if (pageToken) p.pageToken = pageToken;
                const d = await api('/files', p);
                out = out.concat(d.files || []); pageToken = d.nextPageToken;
            } while (pageToken);
            return out;
        }

        // ---------- 介面 ----------
        function panel() {
            let el2 = document.getElementById('vCloud');
            if (!el2) {
                el2 = el(`<div id="vCloud" class="v-cloud">
                    <div class="v-top"><button type="button" class="v-btn" id="vCloudBack">‹ 返回</button><h2 id="vCloudTitle">雲端硬碟</h2></div>
                    <div class="v-progress" id="vCloudProg"></div>
                    <div class="v-cloud-body" id="vCloudBody"></div>
                    <div class="v-bar" id="vCloudBar"></div>
                </div>`);
                document.getElementById('vault').appendChild(el2);
                el2.querySelector('#vCloudBack').onclick = () => { if (state.busy) return; el2.classList.remove('open'); refresh(); };
            }
            return el2;
        }
        function show() { panel().classList.add('open'); render(); }
        function setBar(html) { const b = document.getElementById('vCloudBar'); b.innerHTML = html; b.style.display = html ? '' : 'none'; return b; }
        function setProg(t) { const p = document.getElementById('vCloudProg'); p.innerText = t || ''; p.classList.toggle('on', !!t); }
        const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        function fmtSize(b) { b = +b || 0; return b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB'; }

        function render() {
            if (!document.getElementById('vCloud') || !panel().classList.contains('open')) return;
            const body = document.getElementById('vCloudBody');
            document.getElementById('vCloudTitle').innerText = '雲端硬碟';
            if (!clientId()) return renderSetup(body);
            if (!token()) {
                body.innerHTML = `<div class="v-empty">要先登入你的 Google 帳號，<br>App 才能讀取雲端硬碟裡的影片。<br><span style="font-size:12px">只會讀取，不會修改或刪除雲端上的檔案。</span></div>`;
                setBar(`<button type="button" class="v-btn primary" id="vGLogin">用 Google 登入</button>`).querySelector('#vGLogin').onclick = login;
                return;
            }
            const f = folder();
            if (!f) { state.path = [{ id: 'root', name: '我的雲端硬碟' }]; return browse(); }
            renderFolder(f);
        }

        function renderSetup(body) {
            body.innerHTML = `<div class="v-setup">
                <p>第一次使用要貼上 Google 的「OAuth 用戶端 ID」（照設定步驟做完就會拿到，長得像 <code>123…apps.googleusercontent.com</code>）。</p>
                <input id="vCidInput" placeholder="貼上用戶端 ID" autocapitalize="off" autocomplete="off" spellcheck="false">
                <p class="v-hint">設定時「已授權的 JavaScript 來源」填：<br><code>${esc(location.origin)}</code><br>「已授權的重新導向 URI」填：<br><code>${esc(redirectUri())}</code></p>
            </div>`;
            setBar(`<button type="button" class="v-btn primary" id="vCidSave">儲存</button>`).querySelector('#vCidSave').onclick = () => {
                const v = document.getElementById('vCidInput').value.trim();
                if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('看起來不像用戶端 ID，結尾應該是 .apps.googleusercontent.com'); return; }
                ls.set(CID_KEY, v); render();
            };
        }

        // 選資料夾
        async function browse() {
            const body = document.getElementById('vCloudBody');
            const cur = state.path[state.path.length - 1];
            document.getElementById('vCloudTitle').innerText = '選擇資料夾';
            body.innerHTML = `<div class="v-crumb">${state.path.map((p, i) => `<button type="button" data-i="${i}">${esc(p.name)}</button>`).join(' › ')}</div><div class="v-list" id="vFolderList"><div class="v-empty">讀取中…</div></div>`;
            body.querySelectorAll('.v-crumb button').forEach(b => b.onclick = () => { state.path = state.path.slice(0, +b.dataset.i + 1); browse(); });
            setBar(cur.id === 'root' ? '' : `<button type="button" class="v-btn primary" id="vUseFolder">使用「${esc(cur.name)}」</button>`);
            const use = document.getElementById('vUseFolder');
            if (use) use.onclick = () => { ls.set(FOLDER_KEY, JSON.stringify({ id: cur.id, name: cur.name })); state.files = []; state.picked.clear(); render(); };
            try {
                const subs = await listAll(`'${cur.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'id,name');
                const list = document.getElementById('vFolderList'); if (!list) return;
                list.innerHTML = subs.length ? '' : `<div class="v-empty">這裡沒有子資料夾${cur.id === 'root' ? '' : '，可以直接按下方「使用」'}</div>`;
                subs.forEach(sf => {
                    const b = el(`<button type="button" class="v-btn v-row">📁 <span></span></button>`);
                    b.querySelector('span').textContent = sf.name;
                    b.onclick = () => { state.path.push({ id: sf.id, name: sf.name }); browse(); };
                    list.appendChild(b);
                });
            } catch (e) { if (e.message !== 'login') body.querySelector('#vFolderList').innerHTML = `<div class="v-empty">讀取失敗：${esc(e.message)}</div>`; }
        }

        async function downloadedIds() {
            await openDB();
            const all = await reqP(tx('items').objectStore('items').getAll());
            return new Set(all.filter(i => i.driveId).map(i => i.driveId));
        }

        async function renderFolder(f) {
            const body = document.getElementById('vCloudBody');
            document.getElementById('vCloudTitle').innerText = '☁ ' + f.name;
            body.innerHTML = `<div class="v-empty">讀取中…</div>`;
            setBar('');
            try {
                state.files = await listAll(`'${f.id}' in parents and trashed=false and (mimeType contains 'video/' or mimeType contains 'image/')`,
                    'id,name,mimeType,size,thumbnailLink,videoMediaMetadata(durationMillis)');
            } catch (e) {
                if (e.message !== 'login') body.innerHTML = `<div class="v-empty">讀取失敗：${esc(e.message)}</div>`;
                return;
            }
            const have = await downloadedIds();
            const fresh = state.files.filter(x => !have.has(x.id));
            state.picked.forEach(id => { if (!state.files.some(x => x.id === id)) state.picked.delete(id); });
            body.innerHTML = `<p class="v-hint" style="padding:0 14px">共 ${state.files.length} 個檔案，${fresh.length} 個還沒下載。點選要下載的檔案。</p><div class="v-grid" id="vCloudGrid"></div>`;
            const grid = document.getElementById('vCloudGrid');
            if (!state.files.length) grid.innerHTML = `<div class="v-empty">這個資料夾裡沒有影片或照片</div>`;
            state.files.forEach(x => {
                const got = have.has(x.id);
                const b = el(`<button type="button" class="v-item${state.picked.has(x.id) ? ' sel' : ''}${got ? ' got' : ''}" data-id="${esc(x.id)}">
                    <span class="v-ph">${(x.mimeType || '').startsWith('video/') ? '▶' : '🖼'}</span>
                    <span class="v-check">✓</span><span class="v-name"></span><span class="v-dur"></span></button>`);
                b.querySelector('.v-name').textContent = x.name;
                const ms = x.videoMediaMetadata && x.videoMediaMetadata.durationMillis;
                b.querySelector('.v-dur').textContent = got ? '已下載' : (ms ? fmtDur(ms / 1000) : fmtSize(x.size));
                if (x.thumbnailLink) {
                    const img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer';
                    img.onload = () => b.querySelector('.v-ph') && b.querySelector('.v-ph').remove();
                    img.onerror = () => img.remove();
                    img.src = x.thumbnailLink; b.prepend(img);
                }
                b.onclick = () => { if (got) return; state.picked.has(x.id) ? state.picked.delete(x.id) : state.picked.add(x.id); b.classList.toggle('sel'); updateBar(fresh); };
                grid.appendChild(b);
            });
            grid.classList.add('v-select-grid');
            updateBar(fresh);
        }
        function updateBar(fresh) {
            const n = state.picked.size;
            const bar = setBar(`<button type="button" class="v-btn" id="vCloudMore">⋯</button>
                <button type="button" class="v-btn" id="vDlSel" ${n ? '' : 'disabled'}>下載所選${n ? ` (${n})` : ''}</button>
                <button type="button" class="v-btn primary" id="vDlAll" ${fresh.length ? '' : 'disabled'}>同步${fresh.length ? `（${fresh.length} 個新檔）` : '：已是最新'}</button>`);
            bar.querySelector('#vDlSel').onclick = () => download(state.files.filter(x => state.picked.has(x.id)));
            bar.querySelector('#vDlAll').onclick = () => download(fresh);
            bar.querySelector('#vCloudMore').onclick = cloudMore;
        }
        function cloudMore() {
            const b = sheet(`<h3>雲端設定</h3>
                <button type="button" class="v-btn" id="vCMChange">換資料夾</button>
                <button type="button" class="v-btn" id="vCMLogout">登出 Google</button>
                <button type="button" class="v-btn" id="vCMCid">更改用戶端 ID</button>
                <button type="button" class="v-btn" id="vCMClose">關閉</button>`);
            b.querySelector('#vCMClose').onclick = closeSheet;
            b.querySelector('#vCMChange').onclick = () => { closeSheet(); ls.set(FOLDER_KEY, null); render(); };
            b.querySelector('#vCMLogout').onclick = () => { closeSheet(); logout(); };
            b.querySelector('#vCMCid').onclick = () => { closeSheet(); ls.set(CID_KEY, null); ls.set(TOKEN_KEY, null); render(); };
        }

        async function fetchFile(x, onProgress) {
            const r = await fetch(`${API}/files/${encodeURIComponent(x.id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + token() } });
            if (r.status === 401) { ls.set(TOKEN_KEY, null); throw new Error('login'); }
            if (!r.ok) throw new Error('下載失敗 ' + r.status);
            const total = +x.size || +r.headers.get('content-length') || 0;
            if (!r.body || !r.body.getReader) return r.blob();
            const reader = r.body.getReader(); const parts = []; let got = 0;
            for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                parts.push(value); got += value.length; onProgress(got, total);
            }
            return new Blob(parts, { type: x.mimeType });
        }

        async function download(list) {
            if (!list.length || state.busy) return;
            if (!token()) { render(); return; }
            const f = folder();
            state.busy = true; let ok = 0;
            setBar('<button type="button" class="v-btn" disabled>下載中，請不要關閉 App…</button>');
            try {
                for (let i = 0; i < list.length; i++) {
                    const x = list[i];
                    const head = `下載 ${i + 1} / ${list.length}：${x.name}`;
                    setProg(head);
                    let blob;
                    try {
                        blob = await fetchFile(x, (g, t) => { lastActive = Date.now(); setProg(`${head}　${t ? Math.floor(g / t * 100) + '%' : fmtSize(g)}`); });
                    } catch (e) {
                        if (e.message === 'login') { toast('Google 登入已過期，請重新登入'); break; }
                        toast(`「${x.name}」下載失敗`); continue;
                    }
                    setProg(`${head}　存入 App 中…`);
                    const file = new File([blob], x.name, { type: x.mimeType || blob.type });
                    ok += await importFiles([file], { folder: f.name, silent: true, extra: () => ({ driveId: x.id }) });
                    lastActive = Date.now();
                }
            } finally {
                state.busy = false; setProg('');
                state.picked.clear();
                toast(`已下載 ${ok} 個檔案到 App 的「${f.name}」資料夾`);
                render();
            }
        }

        return { show, render, captureRedirect, get pendingOpen() { return state.pendingOpen; }, set pendingOpen(v) { state.pendingOpen = v; } };
    })();
    Cloud.captureRedirect();

    window.Vault = { open, close, lock, isOpen };
})();
