/**
 * MeetNameSentry — content.js (v1.0.0)
 * Google Meet 命名纪律守卫（只有主持人 / 联席主持人才真正有“移出”权限）
 *
 * 设计原则
 *  1. 破坏性动作宁可漏、不可错：读不出名字 / 找不到确切菜单项 / 复核不一致 → 放弃，绝不猜。
 *  2. 不靠固定延时等 DOM：所有等待都走 waitFor（MutationObserver + 低频轮询兜底 + 超时）。
 *  3. 选择器分层：语义属性（role / aria-* / data-*）优先 → 多语言词库 → 位置启发式兜底。
 *  4. 任何一次循环抛错都不会杀死调度器；扩展被重载后旧脚本自毁。
 *  5. 所有缓存都有 TTL 与容量上限，且不持有 DOM 节点引用（虚拟列表会回收节点）。
 */
(() => {
  'use strict';

  if (window.__MEET_NAME_SENTRY__) return; // 防重复注入
  window.__MEET_NAME_SENTRY__ = true;

  const LOG = '[MeetNameSentry]';

  /* ════════════════════════ 0. 参数 ════════════════════════ */
  const T = {
    tick: 1500,              // 主调度周期（后台标签页自动 ×3）
    harvestDebounce: 150,    // 列表变动 → 触发采集的防抖
    suspectStable: 1200,     // 同一目标须在 ≥1.2s 间隔内被两次判为不合规才动手（防瞬时脏数据）
    suspectTTL: 90_000,
    postKickHold: 8_000,     // 确认移出后，等对方行消失的保护期
    failTTL: 10 * 60_000,
    userBusy: 800,           // 用户刚操作过界面 → 本次让路
    idleBeforeSweep: 3_000,  // 用户空闲多久后才允许主动滚动列表
    sweepMin: 8_000,         // 两次滚动扫描的最小间隔
    sweepInterval: 60_000,   // 人数没变时的保底全量扫描间隔（防“一进一出”漏检）
    sweepRetry: 5_000,
    panelOpenRetry: 8_000,
    menu: 2_500,
    dialog: 3_000,
    closing: 4_000,
  };
  const MAP_CAP = 500; // 所有 Map 的容量上限，防长会议内存增长

  // 若你实测确认“移出确认对话框一定带昵称”，可设为 true：对话框里找不到昵称前缀就中止
  const STRICT_DIALOG_NAME_CHECK = false;

  /* ════════════════════════ 1. 词库（尽力而为，可由 popup 的“额外菜单文案”补充） ════════════════════════ */

  // 菜单项：“从通话/会议中移出”（匹配前已做 NFKC + 小写）
  const REMOVE_TEXT_RES = [
    /\bremove\b.*\b(call|meeting)\b/,
    /(移出|移除|踢出|删除|刪除).*(通话|通話|会议|會議)|(通话|通話|会议|會議).*(移出|移除)/,
    /(通話|会議|ミーティング).*(削除|退出|除外)|(削除|退出|除外).*(通話|会議)/,
    /(통화|회의).*(삭제|제거|내보내|퇴장)/,
    /(anruf|meeting|besprechung).*(entfernen|ausschlie)|(entfernen|ausschlie).*(anruf|meeting|besprechung)/,
    /(supprimer|retirer|exclure|éjecter).*(appel|réunion|reunion)/,
    /(quitar|eliminar|expulsar|sacar).*(llamada|reuni)/,
    /(remover|excluir|expulsar).*(chamada|reuni)/,
    /(rimuovi|rimuovere|elimina|espelli).*(chiamata|riunione)/,
    /(удалить|исключить|убрать).*(звонк|встреч|конференц|собран)/,
    /verwijder.*(gesprek|vergadering|oproep)/,
    /(arama|görüşme|toplantı).*(çıkar|kaldır)/,
    /usu(ń|n).*(połączeni|spotkani|rozmow)/,
    /(hapus|keluarkan|singkirkan).*(panggilan|rapat)/,
    /(xóa|xoá|loại bỏ).*(cuộc gọi|cuộc họp)/,
    /(นำออก|ลบ).*(สาย|การโทร|การประชุม)/,
    /(إزالة|إخراج).*(المكالمة|الاجتماع)/,
  ];
  // 这些菜单项绝不能点（尤其“举报”）
  const MENU_NEGATIVE_RE =
    /\b(report|block|pin|unpin|mute|hide|spotlight|melden|signaler|denunciar|bloquear)\b|举报|檢舉|举報|舉報|報告|报告|通報|신고|屏蔽|封鎖|固定|不显示|不顯示|隐藏|隱藏|静音|靜音|聚焦/;

  // 确认对话框按钮
  const DESTRUCTIVE_RE =
    /移出|移除|踢出|remove|削除|退出させ|삭제|제거|내보내|entfernen|ausschlie|supprimer|retirer|exclure|quitar|eliminar|expulsar|remover|excluir|rimuovi|elimina|удалить|исключить|verwijder|çıkar|kaldır|usuń|usun|hapus|keluarkan|xóa|xoá|นำออก|ลบ|إزالة|إخراج|हटा/;
  const CANCEL_RE =
    /取消|关闭|關閉|cancel|キャンセル|취소|abbrechen|annuler|cancelar|annulla|отмен|annuleren|iptal|anuluj|batal|hủy|ยกเลิก|إلغاء|रद्द/;

  // 面板开关按钮（优先 data-panel-id，词库仅兜底）
  const PEOPLE_LABEL_RE =
    /people|participants|everyone|协作人员|协作者|参会者|参与者|所有人|人员|成員|參與者|參加者|与会者|参加者|teilnehmer|personen|participantes|personas|personnes|partecipanti|persone|участники|deelnemers|katılımcı|uczestnicy|peserta|người tham gia|참여자|참가자|ผู้เข้าร่วม/i;
  const CHAT_LABEL_RE = /chat|聊天|チャット|채팅/i;

  // 自己 / 展示内容（演示流）标记（匹配前已 NFKC，全角括号已变半角）
  const SELF_RE =
    /\(\s*(you|你|您|あなた|du|tú|tu|vous|você|voce|ты|вы|당신|나|jij|sen|ty|anda|bạn)\s*\)/;
  const PRESENTATION_RE =
    /\([^()]*(presentation|presenting|presentación|presentacion|apresenta|präsentation|présentation|presentazione|презентац|展示内容|展示內容|演示内容|プレゼン|발표|프레젠)[^()]*\)/;
  // 主持人徽标：只在“昵称之外”的次级文本里匹配，避免被昵称伪造
  const HOST_RE =
    /host|organi[sz]er|moderator|主持|主办|主辦|ホスト|호스트|gastgeber|anfitri|hôte|organisateur|organizzatore|organizador|организатор|ведущий|ev sahibi|gospodarz|tuan rumah|chủ trì|người tổ chức/;

  // Material Icons / Google Symbols 连字：形态 + 字体双重判定，不再用“保留词黑名单”
  // （黑名单会让昵称叫 mic / pin / info 的人直接免疫）
  const LIGATURE_RE = /^[a-z][a-z0-9_]*$/;
  const ICON_CLASS_RE = /(google-symbols|google-material-icons|material-icons|material-symbols|gm-icon|\bicon\b)/i;
  const ICON_FONT_RE = /(symbols|material|icons)/i;

  /* ════════════════════════ 2. 状态与配置 ════════════════════════ */
  const life = new AbortController(); // 生命周期：abort 后所有监听/等待一并结束
  const state = {
    busy: false, sweeping: false,
    suspects: new Map(),  // key -> {nameN, first, last}
    hold: new Map(),      // key -> {until, reason}   冷却 / 退避 / 保护期统一入口
    fails: new Map(),     // key -> {n, last}
    dry: new Map(),       // key -> ts                试运行去重
    recentFails: [], noRemoveStreak: 0, kicked: 0,
    pausedUntil: 0, pauseReason: '',
    lastInput: 0, lastSweepAt: 0, lastSweepCount: null, incomplete: false, retries: 0,
    lastOpenAttempt: 0, openAttempts: [],
    coverage: null,
    listObserver: null, observedList: null,
    tickTimer: 0, harvestTimer: 0,
  };

  const DEFAULTS = {
    enabled: true, dryRun: true,
    requiredKeywords: 'AA', keywordWhitelist: '', exactWhitelist: '', extraRemoveLabels: '',
  };
  let configReady = false, configRevision = 0, configRequest = 0;
  const cfg = { enabled: false, dryRun: false, required: [], keywords: [], exact: new Set(), extraRemove: [] };

  // NFKC：全角“ＡＡ”→“aa”；去零宽字符；折叠空白；转小写
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const splitList = (s, sep) => String(s ?? '').split(sep).map(norm).filter(Boolean);

  function applyConfig(items) {
    const it = { ...DEFAULTS, ...(items || {}) };
    if (typeof it.enabled !== 'boolean' || typeof it.dryRun !== 'boolean' ||
        ['requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels']
          .some((k) => typeof it[k] !== 'string' || it[k].length > 8192)) {
      throw new Error('invalid-config');
    }
    cfg.enabled = it.enabled;
    cfg.dryRun = it.dryRun;
    // 同时支持半角/全角逗号、顿号、分号、换行
    cfg.required = splitList(it.requiredKeywords, /[,，、;；\n]+/);
    cfg.keywords = splitList(it.keywordWhitelist, /[,，、;；\n]+/);
    cfg.exact = new Set(splitList(it.exactWhitelist, /\n+/)); // 精确姓名里可能含逗号，只按换行拆
    cfg.extraRemove = splitList(it.extraRemoveLabels, /[,，、;；\n]+/);
    // 规则变更 → 旧判定与退避全部作废
    state.suspects.clear(); state.hold.clear(); state.fails.clear();
    state.noRemoveStreak = 0; state.pausedUntil = 0;
    configRevision++;
    configReady = true;
  }

  const loadConfig = () => {
    const request = ++configRequest;
    // 从收到变更起就撤销旧动作授权；过期读取不能覆盖较新的配置。
    configReady = false;
    configRevision++;
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (items) => {
          const error = chrome.runtime.lastError;
          if (request !== configRequest) return resolve();
          try {
            if (error) throw new Error('config-read-failed');
            applyConfig(items);
          } catch {
            cfg.enabled = false;
            configReady = false;
            console.warn(LOG, '配置读取失败或格式异常，已停止自动操作。');
          }
          resolve();
        });
      } catch {
        cfg.enabled = false;
        resolve();
      }
    });
  };

  const onStorageChanged = (changes, area) => {
    if (area === 'sync' && Object.keys(DEFAULTS).some((k) => Object.hasOwn(changes, k))) loadConfig();
  };

  /* ════════════════════════ 3. 通用工具 ════════════════════════ */
  const alive = () => {
    try { return !life.signal.aborted && !!chrome.runtime?.id; } catch { return false; }
  };

  const clip = (s, n = 22) => (s.length > n ? `${s.slice(0, n)}…` : s);

  function capMap(map) { // 超限则淘汰最旧项
    while (map.size > MAP_CAP) map.delete(map.keys().next().value);
  }

  const isVisible = (el) =>
    !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  /**
   * 等待某个条件成立（取代 setTimeout(r, 400)）。
   *  - MutationObserver：DOM 一变就（节流 30ms）重新探测，响应最快
   *  - 250ms 低频轮询：兜底“只改 class/style、不触发我们订阅的属性”的情况
   *  - timeout：永不无限等待；生命周期结束时立刻返回 null
   * 返回探针的真值，超时返回 null。
   */
  function waitFor(probe, { timeout = 3000, root = document.documentElement } = {}) {
    return new Promise((resolve) => {
      let obs, poll, timer, queued = 0, settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        obs.disconnect(); clearInterval(poll); clearTimeout(timer); clearTimeout(queued);
        life.signal.removeEventListener('abort', onAbort);
        resolve(v || null);
      };
      const onAbort = () => finish(null);
      const check = () => {
        queued = 0;
        let v = null;
        try { v = probe(); } catch { /* 探针异常视为未命中 */ }
        if (v) finish(v);
      };
      obs = new MutationObserver(() => { if (!queued) queued = setTimeout(check, 30); });
      obs.observe(root, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-expanded', 'aria-checked', 'aria-hidden', 'hidden', 'open', 'style', 'class'],
      });
      poll = setInterval(check, 250);
      timer = setTimeout(() => finish(null), timeout);
      life.signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  /** 等一个容器“安静”下来（虚拟列表滚动后渲染稳定），最长 maxMs。 */
  function waitForQuiet(root, quietMs = 90, maxMs = 700) {
    return new Promise((resolve) => {
      const start = Date.now();
      let t;
      const done = () => { obs.disconnect(); clearTimeout(t); resolve(); };
      const arm = () => {
        clearTimeout(t);
        t = setTimeout(done, Math.max(0, Math.min(quietMs, maxMs - (Date.now() - start))));
      };
      const obs = new MutationObserver(arm);
      obs.observe(root, { childList: true, subtree: true });
      arm();
    });
  }

  // —— 模拟点击 ——
  const press = (el) => { el.focus?.({ preventScroll: true }); el.click(); };
  function pressFull(el) { // 兜底：完整指针序列后再 click（只会产生一次 click）
    const Ptr = window.PointerEvent || MouseEvent;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ev = type.startsWith('pointer') ? Ptr : MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
  }
  function hover(el) {
    for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']) {
      const Ev = type.startsWith('pointer') ? window.PointerEvent || MouseEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, view: window }));
    }
  }
  function sendEscape(target = document.activeElement || document.body) {
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
  }

  /* ════════════════════════ 4. HUD（Shadow DOM，样式与 Meet 隔离） ════════════════════════ */
  const C = { ok: '#1e8e3e', warn: '#ea8600', err: '#d93025', idle: '#5f6368' };
  const hud = (() => {
    let host = null, dot = null, txt = null, last = '';
    const ensure = () => {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.id = 'meet-sentry-hud';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .pill{position:fixed;top:12px;left:120px;z-index:2147483647;display:flex;align-items:center;gap:8px;
            padding:6px 14px;border-radius:20px;background:rgba(32,33,36,.95);border:1px solid #5f6368;color:#e8eaed;
            font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4);
            pointer-events:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .dot{flex:none;width:8px;height:8px;border-radius:50%}
        </style>
        <div class="pill"><span class="dot"></span><span class="txt"></span></div>`;
      dot = root.querySelector('.dot');
      txt = root.querySelector('.txt');
      (document.body || document.documentElement).appendChild(host);
      last = '';
    };
    return {
      set(text, color = C.ok) { // 去重：内容没变就不碰 DOM
        const sig = `${text}|${color}`;
        ensure();
        if (sig === last) return;
        last = sig;
        txt.textContent = `MeetNameSentry · ${text}`;
        dot.style.background = color;
      },
      remove() { host?.remove(); host = null; },
    };
  })();

  /* ════════════════════════ 5. 选择器策略层（集中管理，Meet 改版时只改这里） ════════════════════════ */
  const isButtonLike = (el) => el.matches('button, [role="button"]');

  function peopleToggle() {
    return (
      document.querySelector('button[data-panel-id="1"], [role="button"][data-panel-id="1"]') ||
      [...document.querySelectorAll('button, [role="button"]')].find((b) => PEOPLE_LABEL_RE.test(b.getAttribute('aria-label') || ''))
    );
  }
  function chatToggle() {
    return (
      document.querySelector('button[data-panel-id="2"], [role="button"][data-panel-id="2"]') ||
      [...document.querySelectorAll('button, [role="button"]')].find((b) => CHAT_LABEL_RE.test(b.getAttribute('aria-label') || ''))
    );
  }
  const isPressed = (b) => !!b && (b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-expanded') === 'true');

  /** 参与者行：先找“人员面板根”下的 listitem；找不到再全局兜底（排除聊天/对话框/菜单）。 */
  function findRowsRaw() {
    const roots = [...document.querySelectorAll('[data-panel-id="1"]')].filter((el) => !isButtonLike(el));
    let rows = roots.flatMap((r) => [...r.querySelectorAll('[role="listitem"]')]);
    if (!rows.length) {
      rows = [...document.querySelectorAll('[role="list"] [role="listitem"]')].filter(
        (el) => !el.closest('[data-panel-id="2"], [role="dialog"], [role="menu"]')
      );
    }
    return rows;
  }

  /** 最近的可滚动祖先（不再假设 list.parentElement 就是滚动容器）。 */
  function scrollParentOf(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return null;
  }

  const insideWithin = (el, root, sel) => {
    for (let p = el; p && p !== root; p = p.parentElement) if (p.matches(sel)) return true;
    return false;
  };
  const isIconElement = (el) =>
    ICON_CLASS_RE.test(el.getAttribute?.('class') || '') || ICON_FONT_RE.test(getComputedStyle(el).fontFamily || '');

  /** 行内“像昵称”的文本：排除按钮、aria-hidden、图标连字。 */
  function collectTexts(row) {
    const out = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el || insideWithin(el, row, 'button, [role="button"], [aria-hidden="true"]')) continue;
      // 只有“长得像连字”的文本才去查字体，兼顾性能；昵称就算叫 mic 也不会被误杀
      if (LIGATURE_RE.test(t) && isIconElement(el)) continue;
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }

  function iconNames(el) { // 仅用于诊断输出
    const out = [];
    for (const n of el.querySelectorAll('i, span, div')) {
      if (n.children.length) continue;
      const t = (n.textContent || '').trim();
      if (LIGATURE_RE.test(t) && isIconElement(n)) out.push(t);
    }
    return out;
  }

  /** “更多操作”按钮：仅认菜单属性或明确的更多图标，不猜行内最后一个按钮。 */
  function findMoreButton(row) {
    const btns = [...row.querySelectorAll('button, [role="button"]')];
    return (
      btns.find((b) => /^(menu|true)$/.test(b.getAttribute('aria-haspopup') || '')) ||
      btns.find((b) => /more_vert|more_horiz/.test(b.textContent || '')) ||
      null
    );
  }

  /** 解析一行 → 结构化信息（不缓存 DOM 引用到长期状态里）。 */
  function readRow(row, selfId) {
    const texts = collectTexts(row);
    const label = (row.getAttribute('aria-label') || '').trim();
    const name = label || texts[0] || '';
    const nameN = norm(name);
    if (!nameN) return null; // 读不出名字 → 不参与判定

    const id =
      row.getAttribute('data-participant-id') ||
      row.querySelector('[data-participant-id]')?.getAttribute('data-participant-id') ||
      '';
    const everything = norm([label, ...texts].join(' '));
    // 自己：有可靠 id 就只认 id（文本标记可被昵称伪造）；否则退化为文本标记
    const isSelf = selfId && id ? id === selfId : SELF_RE.test(everything);
    return {
      row, key: id || `n:${nameN}`, name, nameN, isSelf,
      isHost: texts.slice(1).some((t) => HOST_RE.test(norm(t))), // 只看昵称之外的文本
      isPresentation: PRESENTATION_RE.test(everything),
      moreBtn: findMoreButton(row),
    };
  }

  function readRows() {
    const selfId = document.querySelector('[data-self-name][data-participant-id]')?.getAttribute('data-participant-id') || '';
    return findRowsRaw().map((r) => readRow(r, selfId)).filter(Boolean);
  }

  const queryMenus = () => {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(isVisible);
    if (menus.length) return menus;
    const parents = [...document.querySelectorAll('[role="menuitem"]')]
      .filter(isVisible)
      .map((i) => i.closest('[role="menu"]') || i.parentElement);
    return [...new Set(parents)];
  };
  const queryDialogs = () =>
    [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].filter(isVisible);

  /* ════════════════════════ 6. 合规判定 ════════════════════════ */
  function evaluate(info) {
    if (!info.nameN) return { ok: true, why: 'unreadable' };
    if (info.isSelf) return { ok: true, why: 'self' };
    if (info.isHost) return { ok: true, why: 'host' };
    if (info.isPresentation) return { ok: true, why: 'presentation' };
    if (cfg.exact.has(info.nameN)) return { ok: true, why: 'exact-whitelist' };
    if (cfg.keywords.some((k) => info.nameN.includes(k))) return { ok: true, why: 'keyword-whitelist' };
    if (cfg.required.some((k) => info.nameN.includes(k))) return { ok: true, why: 'required-hit' };
    return { ok: false, why: 'violation' };
  }

  /* ════════════════════════ 7. 面板维护（不抢焦点、不反复开关） ════════════════════════ */
  const userIsTyping = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  function ensurePeoplePanel() {
    if (findRowsRaw().length) return true;
    if (userIsTyping()) return false;           // 正在输入 → 不打断
    if (isPressed(chatToggle())) return false;  // 聊天面板开着 → 不抢占
    const btn = peopleToggle();
    if (!btn || isPressed(btn)) return false;   // 面板已开但还没渲染 → 等，别把它点关了

    const now = Date.now();
    state.openAttempts = state.openAttempts.filter((t) => now - t < 60_000);
    if (now - state.lastOpenAttempt < T.panelOpenRetry) return false;
    if (state.openAttempts.length >= 3) { // 点了 3 次仍识别不到列表 → 多半是 DOM 改版，停手并告警
      pause(5 * 60_000, '识别不到参与者列表（Meet 界面可能已更新）');
      state.openAttempts = [];
      return false;
    }
    state.lastOpenAttempt = now;
    state.openAttempts.push(now);
    press(btn);
    return false;
  }

  function participantCount() { // 人员按钮角标里的数字，仅作辅助信号
    const m = peopleToggle()?.textContent?.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function attachListObserver() {
    const first = findRowsRaw()[0];
    const list = first && (first.closest('[role="list"]') || first.parentElement);
    if (!list || state.observedList === list) return;
    state.listObserver?.disconnect();
    state.observedList = list;
    state.listObserver = new MutationObserver(() => { if (!state.busy && !state.sweeping) scheduleHarvest(); });
    state.listObserver.observe(list, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-label', 'data-participant-id'],
    });
  }

  /* ════════════════════════ 8. 采集 / 嫌疑确认 / 冷却 ════════════════════════ */
  const held = (key, now) => (state.hold.get(key)?.until ?? 0) > now;
  function markHold(key, ms, reason) {
    state.hold.set(key, { until: Date.now() + ms, reason });
    capMap(state.hold);
  }

  /** 读取当前已渲染的行并判定；返回“已确认、可处置”的第一个目标。 */
  function harvest(seen) {
    const now = Date.now();
    let ripe = null;
    for (const info of readRows()) {
      seen?.add(info.key);
      if (evaluate(info).ok) { state.suspects.delete(info.key); continue; }
      if (held(info.key, now)) continue;

      let s = state.suspects.get(info.key);
      if (!s || s.nameN !== info.nameN) { // 首次发现 / 同一节点被回收成了别人 → 重新计时
        s = { nameN: info.nameN, first: now, last: now };
        state.suspects.set(info.key, s);
        capMap(state.suspects);
      } else s.last = now;

      if (!ripe && now - s.first >= T.suspectStable) ripe = info;
    }
    return ripe;
  }

  function scheduleHarvest() {
    if (state.harvestTimer) return;
    state.harvestTimer = setTimeout(async () => {
      state.harvestTimer = 0;
      if (!alive() || state.busy || state.sweeping || !configReady || !cfg.enabled || !cfg.required.length) return;
      if (Date.now() < state.pausedUntil) return;
      try {
        const t = harvest();
        if (t) await kick(t);
      } catch (e) { console.error(LOG, e); }
    }, T.harvestDebounce);
  }

  function pruneState() {
    const now = Date.now();
    for (const [k, h] of state.hold) if (h.until <= now) state.hold.delete(k);
    for (const [k, s] of state.suspects) if (now - s.last > T.suspectTTL) state.suspects.delete(k);
    for (const [k, f] of state.fails) if (now - f.last > T.failTTL) state.fails.delete(k);
    for (const [k, t] of state.dry) if (now - t > 60_000) state.dry.delete(k);
  }

  function pause(ms, reason) {
    state.pausedUntil = Date.now() + ms;
    state.pauseReason = reason;
    console.warn(LOG, `暂停 ${Math.round(ms / 1000)}s：${reason}`);
  }

  /* ════════════════════════ 9. 处置序列：开菜单 → 点移出 → 取消举报勾选 → 确认 ════════════════════════ */
  class KickError extends Error { constructor(code) { super(code); this.code = code; } }
  const assertActive = (revision, inputAt) => {
    if (!alive() || !configReady || !cfg.enabled || cfg.dryRun || !cfg.required.length ||
        revision !== configRevision || state.lastInput !== inputAt) throw new KickError('aborted');
  };

  function locateTarget(target) {
    const matches = readRows().filter((r) => r.key === target.key);
    if (matches.length !== 1 || matches[0].nameN !== target.nameN || evaluate(matches[0]).ok) {
      throw new KickError('stale');
    }
    return matches[0];
  }

  async function openMenu({ row, moreBtn }, baseline, checkActive) {
    const idOf = () => moreBtn.getAttribute('aria-controls');
    // 只认“本次新出现的菜单”或按钮 aria-controls 指向的菜单，避免把页面上别的菜单当成自己的
    const probe = () => {
      const byId = idOf() && document.getElementById(idOf());
      if (byId && byId.matches('[role="menu"]') && isVisible(byId) && !baseline.menus.has(byId)) return byId;
      const fresh = queryMenus().filter((m) => !baseline.menus.has(m));
      return fresh.length === 1 ? fresh[0] : null;
    };
    checkActive();
    hover(row); hover(moreBtn);
    press(moreBtn);
    let menu = await waitFor(probe, { timeout: T.menu });
    if (!menu) { // 兜底：完整指针序列
      checkActive();
      pressFull(moreBtn);
      menu = await waitFor(probe, { timeout: T.menu });
    }
    return menu;
  }

  /** 在“当前菜单内部”按叶子节点匹配，避免命中祖先容器（原版 find 会先命中最外层 div）。 */
  function findRemoveItem(menu) {
    const cands = [...menu.querySelectorAll('[role^="menuitem"], li, button')];
    const leaves = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    const hits = leaves.filter((el) => {
      const text = norm(el.textContent);
      if (!isVisible(el) || el.matches(':disabled, [aria-disabled="true"]') || !text || MENU_NEGATIVE_RE.test(text)) return false;
      return REMOVE_TEXT_RES.some((re) => re.test(text)) || cfg.extraRemove.some((k) => text === k);
    });
    const el = hits.length === 1 ? hits[0] : null;
    return el ? el.closest('[role^="menuitem"]') || el : null;
  }

  function dumpMenu(menu) {
    // 诊断仅记录数量；菜单文字可能包含参会姓名，不写入控制台。
    console.warn(LOG, '未识别到唯一的“移出”菜单项，请检查界面语言或高级菜单文案。',
      { itemCount: menu.querySelectorAll('[role^="menuitem"], li, button').length });
  }

  const visibleButtons = (dialog) =>
    [...dialog.querySelectorAll('button, [role="button"]')].filter((b) => isVisible(b) && norm(b.textContent));
  const cancelButtons = (dialog) => visibleButtons(dialog).filter((b) => CANCEL_RE.test(norm(b.textContent)));

  function findConfirmButton(dialog) {
    const hits = visibleButtons(dialog).filter((b) =>
      !b.matches(':disabled, [aria-disabled="true"]') &&
      !CANCEL_RE.test(norm(b.textContent)) &&
      !MENU_NEGATIVE_RE.test(norm(b.textContent)) &&
      DESTRUCTIVE_RE.test(norm(b.textContent)));
    // 不再猜测“非取消按钮”；举报/屏蔽或多个破坏性按钮均中止。
    return hits.length === 1 ? hits[0] : null;
  }

  const checkboxes = (d) => [...d.querySelectorAll('input[type="checkbox"], [role="checkbox"]')];
  const isChecked = (b) => b.checked === true || b.getAttribute('aria-checked') === 'true';
  const anyChecked = (d) => checkboxes(d).some(isChecked);

  /** 绝不举报：发现已勾选就取消勾选，并复核；复核不过则中止整个流程。 */
  async function ensureNoReport(dialog, checkActive) {
    for (const b of checkboxes(dialog)) {
      if (!isChecked(b)) continue;
      checkActive();
      press(b);
      if (!(await waitFor(() => !isChecked(b), { timeout: 1000 }))) return false;
    }
    return !anyChecked(dialog);
  }

  async function dismissOverlays(owned, inputAt) {
    // 用户接管后不再关闭浮层；仅清理本次已识别的节点，不点击页面背景。
    if (state.lastInput !== inputAt) return;
    if (isVisible(owned.dialog)) {
      const cancel = cancelButtons(owned.dialog);
      if (cancel.length === 1) press(cancel[0]);
    }
    if (isVisible(owned.menu)) sendEscape(owned.menu);
  }

  async function kick(target) {
    if (state.busy || !configReady || !cfg.enabled || !cfg.required.length) return; // 单飞：tick / 防抖采集 / 滚动扫描三个入口绝不允许并发处置
    const { key, name } = target;

    if (cfg.dryRun) {
      if (!state.dry.has(key)) {
        state.dry.set(key, Date.now()); capMap(state.dry);
        console.warn(LOG, '[试运行] 发现不合规参会者（未移出）。');
        hud.set(`[试运行] 发现不合规：${clip(name)}`, C.warn);
      }
      markHold(key, 30_000, 'dry');
      return;
    }
    if (Date.now() - state.lastInput < T.userBusy) return; // 用户正在操作 → 让路，下个周期再来

    const revision = configRevision, inputAt = state.lastInput;
    const checkActive = () => assertActive(revision, inputAt);
    const baseline = { dialogs: new Set(queryDialogs()), menus: new Set(queryMenus()) };
    if (baseline.dialogs.size || baseline.menus.size) return; // 不与用户已有操作交叉
    const owned = { menu: null, dialog: null };
    state.busy = true;
    hud.set(`🎯 处理中：${clip(name)}`, C.err);

    try {
      checkActive();
      // ① 用 key 重新定位并复核（不信任采集时留下的节点引用）
      const first = locateTarget(target);
      if (!first.moreBtn || !isVisible(first.moreBtn)) throw new KickError('stale');
      first.row.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });

      // ② 开菜单
      const menu = await openMenu(first, baseline, checkActive);
      if (!menu) throw new KickError('menu-timeout');
      owned.menu = menu;

      // ③ 识别菜单项；找不到绝不乱点
      const item = findRemoveItem(menu);
      if (!item) { dumpMenu(menu); throw new KickError('no-remove-item'); }

      // ④ 菜单打开期间列表可能重排 → 再复核一次
      const second = locateTarget(target);
      if (second.row !== first.row || second.moreBtn !== first.moreBtn) throw new KickError('stale');
      checkActive();

      // ⑤ 点“移出”，等确认对话框
      press(item);
      const dialog = await waitFor(() => {
        const fresh = queryDialogs().filter((d) => !baseline.dialogs.has(d));
        return fresh.length === 1 ? fresh[0] : null;
      }, { timeout: T.dialog });
      if (!dialog) throw new KickError('dialog-timeout');
      owned.dialog = dialog;
      if (STRICT_DIALOG_NAME_CHECK && !norm(dialog.textContent).includes(target.nameN.slice(0, 8))) {
        throw new KickError('dialog-name-mismatch');
      }

      // ⑥ 举报复选框：取消勾选 → 复核；点确认前再做一次同步终检
      checkActive();
      if (!(await ensureNoReport(dialog, checkActive))) throw new KickError('report-box-stuck');
      const confirm = findConfirmButton(dialog);
      if (!confirm) throw new KickError('no-confirm-button');
      if (anyChecked(dialog)) throw new KickError('report-box-stuck');
      checkActive();
      const finalTarget = locateTarget(target);
      if (finalTarget.row !== first.row || finalTarget.moreBtn !== first.moreBtn ||
          !isVisible(dialog) || !dialog.contains(confirm) || findConfirmButton(dialog) !== confirm) {
        throw new KickError('stale');
      }
      press(confirm);

      // ⑦ 以“对话框消失”作为成功信号
      if (!(await waitFor(() => !isVisible(dialog), { timeout: T.closing }))) throw new KickError('dialog-not-closed');

      state.kicked++; state.noRemoveStreak = 0; state.fails.delete(key);
      markHold(key, T.postKickHold, 'kicked');
      hud.set(`✓ 已移出：${clip(name)}`, C.ok);
      console.log(LOG, '已完成移出操作。');
    } catch (err) {
      await dismissOverlays(owned, inputAt);
      onKickFailure(key, name, err);
    } finally {
      state.suspects.delete(key);
      state.busy = false;
      scheduleHarvest();
    }
  }

  function onKickFailure(key, name, err) {
    const code = err instanceof KickError ? err.code : 'exception';
    if (code === 'aborted') return;
    if (!(err instanceof KickError)) console.error(LOG, err);
    if (code === 'stale') { markHold(key, 3_000, code); return; } // 列表变了，不算故障

    const now = Date.now();
    const f = state.fails.get(key) || { n: 0, last: 0 };
    f.n++; f.last = now; state.fails.set(key, f); capMap(state.fails);
    // 指数退避；“没有移出项”（自己/演示流/无权限）直接长冷却，不再反复开菜单
    markHold(key, code === 'no-remove-item' ? 5 * 60_000 : Math.min(5 * 60_000, 10_000 * 2 ** (f.n - 1)), code);
    console.warn(LOG, `处置失败：${code}`);
    hud.set(`✗ ${code}：${clip(name)}`, C.err);

    // 熔断：从未成功过、却连续 3 个不同对象都没有“移出”项 → 大概率不是主持人或词库没覆盖
    state.recentFails = state.recentFails.filter((t) => now - t < 60_000);
    state.recentFails.push(now);
    if (code === 'no-remove-item' && state.kicked === 0) state.noRemoveStreak++;
    if (state.noRemoveStreak >= 3) pause(5 * 60_000, '找不到“移出”菜单项（非主持人？或文案未收录）');
    else if (state.recentFails.length >= 5) pause(2 * 60_000, '连续失败，疑似界面改版');
  }

  /* ════════════════════════ 10. 大型会议：滚动扫描（仅在必要且用户空闲时） ════════════════════════ */
  async function maybeSweep() {
    if (state.busy || state.sweeping || document.hidden) return;
    const list = state.observedList;
    if (!list || !list.isConnected) return;
    const sc = scrollParentOf(list);
    if (!sc) { state.coverage = null; return; } // 全部可见：无需滚动，对用户零打扰

    const now = Date.now();
    const count = participantCount();
    const since = now - state.lastSweepAt;
    const countChanged = count !== null && count !== state.lastSweepCount && since >= T.sweepMin;
    const due = since >= T.sweepInterval;
    const retry = state.incomplete && state.retries < 3 && since >= T.sweepRetry;
    // 扫描中新发现的嫌疑人还差“第二次目击”：发现后 30s 内提前补扫确认，而不是干等 60s
    const confirm = since >= T.sweepRetry &&
      [...state.suspects].some(([k, s]) => !held(k, now) && now - s.first < 30_000);
    if (!(countChanged || due || retry || confirm)) return;
    if (now - state.lastInput < T.idleBeforeSweep) return; // 用户在操作：让路
    await sweep(sc, count);
  }

  async function sweep(sc, count) {
    state.sweeping = true;
    const origin = sc.scrollTop;
    const startedAt = Date.now();
    const seen = new Set();
    let completed = false;
    try {
      sc.scrollTo({ top: 0, behavior: 'instant' });
      for (let i = 0; i < 300 && alive() && sc.isConnected; i++) {
        await waitForQuiet(state.observedList);       // 等虚拟列表渲染稳定，而不是睡固定时间
        const target = harvest(seen);
        if (target) await kick(target);                // 目标此刻就在视口内，直接处置
        if (!cfg.enabled || state.lastInput > startedAt) break; // 用户一动手立刻让位
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) { completed = true; break; }
        // 步长 ≤ 70% 视口：相邻两屏必有重叠，不会漏掉被 overscan 之外的行
        sc.scrollTo({ top: sc.scrollTop + Math.max(60, Math.floor(sc.clientHeight * 0.7)), behavior: 'instant' });
      }
    } finally {
      if (sc.isConnected) sc.scrollTo({ top: origin, behavior: 'instant' }); // 还原用户的滚动位置
      state.sweeping = false;
      state.lastSweepAt = Date.now();
      state.retries = count !== state.lastSweepCount ? 0 : state.retries + 1;
      state.lastSweepCount = count;
      state.coverage = count ? `${Math.min(seen.size, count)}/${count}` : null;
      state.incomplete = !completed || (count !== null && seen.size < count);
    }
  }

  /* ════════════════════════ 11. 调度 ════════════════════════ */
  async function runCycle() {
    pruneState();
    if (state.busy) return; // 处置进行中：本周期让路，HUD 保持“处理中”
    if (!configReady) return hud.set('配置未就绪 · 自动操作已停止', C.warn);
    if (!cfg.enabled) return hud.set('已暂停', C.warn);
    if (!peopleToggle()) return hud.set('待命（未入会）', C.idle);
    if (!cfg.required.length) return hud.set('未设置必需关键词 · 不执行移出', C.warn);
    if (Date.now() < state.pausedUntil) return hud.set(`已暂停：${state.pauseReason}`, C.err);
    if (!ensurePeoplePanel()) return hud.set('参与者面板未打开 · 巡检暂缓', C.idle);

    attachListObserver();
    const target = harvest();
    if (target) await kick(target);
    else await maybeSweep();

    if (!state.busy) {
      const cov = state.coverage ? ` ${state.coverage}` : '';
      hud.set(cfg.dryRun ? `试运行 · 巡检中${cov}` : `巡检中${cov}`, cfg.dryRun ? C.warn : C.ok);
    }
  }

  async function tick() {
    if (!alive()) return shutdown('扩展上下文失效（扩展被重载/卸载）');
    try { await runCycle(); }
    catch (err) { console.error(LOG, '巡检周期异常（已隔离，下个周期继续）：', err); }
    if (alive()) state.tickTimer = setTimeout(tick, document.hidden ? T.tick * 3 : T.tick);
    else shutdown('扩展上下文失效');
  }

  function shutdown(reason) {
    if (life.signal.aborted) return;
    life.abort();
    clearTimeout(state.tickTimer); clearTimeout(state.harvestTimer);
    state.listObserver?.disconnect();
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* 上下文已失效 */ }
    hud.remove();
    console.info(LOG, '已停止：', reason);
  }

  /* ════════════════════════ 12. 启动 ════════════════════════ */
  (async () => {
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch { return; }
    await loadConfig();

    // 只认真人输入（isTrusted），我们自己派发的合成事件不算
    const markInput = (e) => { if (e.isTrusted) state.lastInput = Date.now(); };
    for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart']) {
      document.addEventListener(type, markInput, { capture: true, passive: true, signal: life.signal });
    }

    tick();
    console.info(LOG, '巡检引擎已挂载 v1.0.0');
  })();
})();
