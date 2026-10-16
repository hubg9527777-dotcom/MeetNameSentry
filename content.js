/**
 * MeetNameSentry — content.js (v1.0.2)
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

  // 同一个 Meet 页面里的静态注入与后台补注入可能相继到达。
  // 健康实例仅唤醒，不并行建立第二套自动移出流程。
  // 若仅有明确可终止且已经失效的本扩展实例，才允许清理后重新初始化。
  const existing = window.__MEET_NAME_SENTRY__;
  if (existing) {
    let healthy = false;
    try { healthy = typeof existing === 'object' && existing.alive?.() === true; }
    catch { /* 扩展升级后旧上下文可能已经失效 */ }
    if (healthy) {
      try { existing.wake?.(); } catch { /* 仅唤醒；不会启动第二引擎 */ }
      return;
    }
    // 未知的历史实例可能仍在控制移出操作，宁可跳过恢复，也不能双重点击。
    if (typeof existing !== 'object' || typeof existing.shutdown !== 'function' ||
        typeof existing.alive !== 'function') return;
    try { existing.shutdown('清理失效的旧实例'); } catch { return; }
    if (window.__MEET_NAME_SENTRY__ === existing) return;
  }

  const LOG = '[MeetNameSentry]';
  // 错误对象的 message/stack 可能包含第三方页面文字或会议 URL，日志仅输出受限错误类别。
  const safeErrorKind = (error) => typeof error?.name === 'string' &&
    /^[A-Za-z]{1,40}(?:Error|Exception)$/.test(error.name) ? error.name : 'unexpected-error';


  /* ════════════════════════ 0. 参数 ════════════════════════ */
  const T = {
    tick: 1500,              // 前台/后台共用的调度目标间隔；实际唤醒仍受 Chrome 节流约束
    watchdog: 12_000,        // 独立于巡检周期的低频健康检查
    staleCycle: 18_000,      // 没有正常巡检时尝试安全唤醒（不会并发移出）
    configRetry: 15_000,     // 配置读失败后重试；失败期间永不自动移出
    slowCycle: 45_000,       // 长时间未结束的周期仅标记异常，不并发启动另一轮
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
    panelRender: 2_500,
    panelBackoff: 30_000,
    hiddenRosterWarmup: 20_000, // 后台页面至少隐藏 20s 才考虑温和刷新
    hiddenRosterInterval: 90_000, // 无人数提示时，每 90s 最多一次名单重挂载实验
    hiddenRosterMismatchInterval: 40_000, // 人数角标与名单不符，可略微提前尝试
    hiddenRosterMaxTries: 3, // 10 分钟最多尝试三次，防止隐藏页无效点击循环
    menu: 2_500,
    dialog: 3_000,
    closing: 4_000,
  };
  // Claude 路线：保留 A3 重挂载函数供隔离实验，但默认不自动关闭已展开的人员面板。
  // 真实 Meet 的 hidden 渲染并未被证明可由按钮重挂载恢复；避免陷入 close-not-confirmed。
  const AUTO_HIDDEN_ROSTER_TOGGLE_EXPERIMENT = false;
  const COVERAGE_MISMATCH_GRACE_MS = 5_000;
  const RENDER_HEARTBEAT_FRESH_MS = 5_000;
  const REFRESH_LOG_CAP = 12;
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
  // 明确排除批量处置菜单项；本扩展只允许逐个定位、逐个移出参会者。
  // 语言词库不是完整的 Meet 国际化清单；识别到可疑批量文案就停止，绝不猜。
  // 英 / 西 / 葡 / 法 / 意 / 德等常见界面：动作与“所有人”可前置或后置。
  const BULK_ACTION_RE = /\b(?:remove|kick|expel|exclude|delete|quitar|eliminar|expulsar|sacar|remover|excluir|supprimer|retirer|exclure|rimuovi|rimuovere|elimina|espelli|entfernen|ausschlie(?:ßen|ssen))\b/u;
  const BULK_SCOPE_RE = /\b(?:all|everyone|everybody|entire|participants|members|todos|todas|tutti|tutte|tous|toutes|alle|allen|sämtliche|tout le monde|todo el mundo|todo mundo)\b/u;
  const BULK_REMOVE_RE = /移出所有|移除所有|踢出所有|删除所有|刪除所有|全部移出|全员移出|全員移出|全员.*(?:移出|移除)|全員.*(?:削除|退出)|(?:削除|退出).*全員|모든.*(?:내보내|제거)|(?:내보내|제거).*모든/u;
  const isBulkRemoval = (text) => BULK_REMOVE_RE.test(text) ||
    (BULK_ACTION_RE.test(text) && BULK_SCOPE_RE.test(text));

  // 确认对话框按钮
  const DESTRUCTIVE_RE =
    /移出|移除|踢出|remove|削除|退出させ|삭제|제거|내보내|entfernen|ausschlie|supprimer|retirer|exclure|quitar|eliminar|expulsar|remover|excluir|rimuovi|elimina|удалить|исключить|verwijder|çıkar|kaldır|usuń|usun|hapus|keluarkan|xóa|xoá|นำออก|ลบ|إزالة|إخراج|हटा/;
  const CANCEL_RE =
    /取消|关闭|關閉|cancel|キャンセル|취소|abbrechen|annuler|cancelar|annulla|отмен|annuleren|iptal|anuluj|batal|hủy|ยกเลิก|إلغاء|रद्द/;

  // 面板开关按钮（优先 data-panel-id，词库仅兜底）
  const PEOPLE_LABEL_RE =
    /people|participants|everyone|协作人员|協作人員|协作者|参会者|参与者|所有人|每个人|每個人|人员|成員|參與者|參加者|与会者|與會者|参加者|teilnehmer|personen|participantes|personas|personnes|partecipanti|persone|участники|deelnemers|katılımcı|uczestnicy|peserta|người tham gia|참여자|참가자|ผู้เข้าร่วม/i;

  // 自己 / 展示内容（演示流）标记（匹配前已 NFKC，全角括号已变半角）
  const PRESENTATION_RE =
    /\([^()]*(presentation|presenting|presentación|presentacion|apresenta|präsentation|présentation|presentazione|презентац|展示内容|展示內容|演示内容|プレゼン|발표|프레젠)[^()]*\)/;
  // 主持人徽标：只在“昵称之外”的次级文本里匹配，避免被昵称伪造
  const HOST_RE =
    /\b(?:co[-\s]?)?host\b|\borgani[sz]er\b|\bmoderator\b|主持|主办|主辦|ホスト|호스트|gastgeber|anfitri|hôte|organisateur|organizzatore|organizador|организатор|ведущий|ev sahibi|gospodarz|tuan rumah|chủ trì|người tổ chức/;

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
    lastOpenAttempt: 0, openAttempts: [], panelRetryAt: 0,
    panelStatus: '', cycling: false,
    coverage: null,
    listObserver: null, observedList: null,
    tickTimer: 0, harvestTimer: 0, suspectReviewTimer: 0, lastBackgroundHarvestAt: 0,
    watchdogTimer: 0, rootObserver: null, lastDomWakeAt: 0,
    lastCycleAt: Date.now(), lastCycleStartAt: 0, lastConfigAttemptAt: 0,
    lastPatrolAt: 0, // 只有成功解析到当前 Meet 参会者姓名时才更新时间，不把空循环当作健康巡检
    // 匿名计数/阶段诊断：不存储姓名或会议链接。巡检存活不代表隐藏页能渲染动作菜单。
    lastRawRows: 0, lastReadableRows: 0, lastViolations: 0, lastMissingAction: 0,
    lastKickAttemptAt: 0, lastKickSuccessAt: 0, lastKickFailureAt: 0,
    lastKickFailure: '', lastKickStage: 'none',
    refreshingRoster: false, hiddenSince: document.hidden ? Date.now() : 0,
    lastRosterRefreshAt: 0, rosterRefreshAttempts: 0, rosterRefreshWindowAt: 0,
    rosterRefreshBefore: null, rosterRefreshAfter: null, rosterRefreshResult: 'not-attempted',
    rosterRefreshEvidence: null,
    rosterRefreshLog: [], rosterRefreshThrottle: '',
    coverageMismatchSince: 0, coverageStatus: 'unknown',
    lastCompleteCoverageAt: 0, lastCoverageAt: 0, lastCoverageHint: null,
    renderFrameCount: 0, lastRenderFrameAt: 0, renderFrameRequest: 0,
    lastTickStartedAt: 0, lastTickIntervalMs: null,
  };

  const DEFAULTS = {
    enabled: true, dryRun: false,
    requiredKeywords: 'AA', keywordWhitelist: '', exactWhitelist: '', extraRemoveLabels: '',
  };
  let configReady = false, configRevision = 0, configRequest = 0;
  const cfg = { enabled: false, dryRun: false, required: [], keywords: [], exact: new Set(), extraRemove: [] };

  // NFKC：全角ＡＡ→aa；删除所有 Unicode 默认不可见字符（不仅限常见零宽字符）。
  // 否则 AA\u2063lice 在视觉上是 AAlice，却会被看成 AA + "非拉丁边界" 而错误放行。
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const splitList = (s, sep) => String(s ?? '').split(sep).map(norm).filter(Boolean);

  const LATIN_TOKEN_CHAR_RE = /[\p{Script=Latin}\p{Number}\p{Mark}]/u;
  const LETTER_RE = /\p{Letter}/u;
  const LETTER_OR_NUMBER_RE = /[\p{Letter}\p{Number}]/u;
  const isLatinLikeMarker = (marker) => LATIN_TOKEN_CHAR_RE.test(firstCodePoint(marker)) ||
    LATIN_TOKEN_CHAR_RE.test(lastCodePoint(marker));
  // 返回完整的 Unicode 码点而不是 UTF-16 单个码元；避免补充平面字符破坏边界判断。
  const lastCodePoint = (s) => Array.from(s).at(-1) || '';
  const firstCodePoint = (s) => Array.from(s)[0] || '';

  /**
   * 英文标记不可嵌在更长的拉丁字母/数字中。
   * strictEdge=true：必需关键词只能位于姓名前缀或后缀，且除标记外必须确实有姓名文字：
   *   AA张三、张三AA、[AA]张三、张三(AA) → 合规；张AA三、AA、AA--- → 不合规。
   * 关键词白名单保留已有“词内独立标记”的用法，不强制前后缀。
   */
  function containsCompleteMarker(name, marker, strictEdge = false) {
    if (!name || !marker) return false;
    const checkLeft = LATIN_TOKEN_CHAR_RE.test(firstCodePoint(marker));
    const checkRight = LATIN_TOKEN_CHAR_RE.test(lastCodePoint(marker));
    let from = 0;
    while (from <= name.length - marker.length) {
      const pos = name.indexOf(marker, from);
      if (pos < 0) return false;
      const left = name.slice(0, pos);
      const right = name.slice(pos + marker.length);
      const before = lastCodePoint(left);
      const after = firstCodePoint(right);
      const tokenOk = (!checkLeft || !before || !LATIN_TOKEN_CHAR_RE.test(before)) &&
        (!checkRight || !after || !LATIN_TOKEN_CHAR_RE.test(after));
      const edgeOk = !strictEdge ||
        (!LETTER_OR_NUMBER_RE.test(left) && LETTER_RE.test(right)) ||
        (!LETTER_OR_NUMBER_RE.test(right) && LETTER_RE.test(left));
      if (tokenOk && edgeOk) return true;
      from = pos + 1;
    }
    return false;
  }

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
    clearTimeout(state.suspectReviewTimer); state.suspectReviewTimer = 0;
    state.coverage = null; state.lastSweepAt = 0; state.lastSweepCount = null;
    state.coverageMismatchSince = 0; state.coverageStatus = 'unknown';
    state.noRemoveStreak = 0; state.pausedUntil = 0;
    state.lastOpenAttempt = 0; state.openAttempts = []; state.panelRetryAt = 0;
    configRevision++;
    configReady = true;
  }

  const loadConfig = () => {
    state.lastConfigAttemptAt = Date.now();
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
   *  - MutationObserver：前台 30ms 合并探测；后台直接由微任务响应真实 DOM 变化
   *  - 250ms 低频轮询：兜底“只改 class/style、不触发我们订阅的属性”的情况
   *  - timeout：永不无限等待；生命周期结束时立刻返回 null
   * 返回探针的真值，超时返回 null。
   */
  function waitFor(probe, { timeout = 3000, root = document.documentElement } = {}) {
    return new Promise((resolve) => {
      let obs, poll, timer, debounceTimer = 0, queued = false, settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        obs.disconnect(); clearInterval(poll); clearTimeout(timer); clearTimeout(debounceTimer);
        life.signal.removeEventListener('abort', onAbort);
        resolve(v || null);
      };
      const onAbort = () => finish(null);
      const check = () => {
        queued = false;
        debounceTimer = 0;
        if (settled) return;
        let v = null;
        try { v = probe(); } catch { /* 探针异常视为未命中 */ }
        if (v) finish(v);
      };
      obs = new MutationObserver(() => {
        if (settled || queued) return;
        queued = true;
        // 隐藏标签页的 setTimeout 可能被 Chrome 强力节流；DOM 已发生变化时直接用微任务检查。
        // 仍仅在本页真实 DOM 变化时触发，不尝试绕过浏览器的冻结/丢弃机制。
        if (document.hidden) queueMicrotask(check);
        else debounceTimer = setTimeout(check, 30);
      });
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

  /** 渲染心跳：只观测 Chrome 是否交付真实动画帧，不伪造前台或改变 Meet 原生 API。 */
  function onRenderFrame() {
    if (!alive()) return;
    state.renderFrameCount++;
    state.lastRenderFrameAt = Date.now();
    state.renderFrameRequest = requestAnimationFrame(onRenderFrame);
  }
  function startRenderHeartbeat() {
    if (typeof requestAnimationFrame !== 'function' || state.renderFrameRequest) return;
    state.renderFrameRequest = requestAnimationFrame(onRenderFrame);
  }

  /** 姓名覆盖健康：人数是辅助信号；一致也只代表计数对得上，不能保证姓名永远准确。 */
  function assessRosterCoverage(now = Date.now(), hint = participantCount(), actualReadable = state.lastReadableRows) {
    state.lastCoverageAt = now;
    state.lastCoverageHint = hint;
    if (!configReady || !cfg.enabled || !cfg.required.length) {
      state.coverageMismatchSince = 0;
      return (state.coverageStatus = 'inactive');
    }
    const readable = actualReadable;
    const validHint = Number.isSafeInteger(hint) && hint > 0;
    if (!validHint) {
      state.coverageMismatchSince = 0;
      return (state.coverageStatus = 'unknown');
    }
    // 如果已有完整滚动扫描，当前视口只有部分行不能直接当作缺人。
    // 避免用几小时前的完整扫描，证明当前换人的会议名单仍然齐全。
    const sweepComplete = state.coverage === `${hint}/${hint}` && !state.incomplete &&
      state.lastSweepCount === hint && state.lastSweepAt > 0 &&
      now >= state.lastSweepAt && now - state.lastSweepAt <= T.sweepInterval + T.sweepRetry;
    if ((readable === hint && readable > 0) || sweepComplete) {
      state.coverageMismatchSince = 0;
      state.lastCompleteCoverageAt = now;
      return (state.coverageStatus = 'count-consistent');
    }
    if (!state.coverageMismatchSince) state.coverageMismatchSince = now;
    const elapsed = now - state.coverageMismatchSince;
    return (state.coverageStatus = elapsed >= COVERAGE_MISMATCH_GRACE_MS ?
      'blind' : 'mismatch-pending');
  }

  /* ════════════════════════ 4. HUD（Shadow DOM，样式与 Meet 隔离） ════════════════════════ */
  const C = { ok: '#1e8e3e', warn: '#ea8600', err: '#d93025', idle: '#5f6368' };
  const hud = (() => {
    let host = null, dot = null, txt = null, last = '', label = '', shade = C.idle;
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
        label = text; shade = color;
        const sig = `${text}|${color}`;
        ensure();
        if (sig === last) return;
        last = sig;
        txt.textContent = `MeetNameSentry · ${text}`;
        dot.style.background = color;
      },
      // Google Meet 重新挂载 DOM 后，可把上一次真实状态恢复为可见 HUD。
      restore() { if (label && (!host || !host.isConnected)) this.set(label, shade); },
      remove() { host?.remove(); host = null; label = ''; },
    };
  })();

  /* ════════════════════════ 5. 选择器策略层（集中管理，Meet 改版时只改这里） ════════════════════════ */
  const isButtonLike = (el) => el.matches('button, [role="button"]');

  function peopleToggle() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((b) =>
      isVisible(b) && !b.matches(':disabled, [aria-disabled="true"]') &&
      !b.closest('[role="listitem"], [role="menu"], [role="dialog"], [role="alertdialog"]'));
    const unique = (items) => items.length === 1 ? items[0] : null;
    const labels = new Map(buttons.map((b) => {
      const labelledBy = (b.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '').join(' ');
      return [b, [
        b.getAttribute('aria-label'), b.getAttribute('title'),
        b.getAttribute('data-tooltip'), b.getAttribute('data-tooltip-text'), labelledBy,
      ].filter(Boolean).join(' ')];
    }));
    // 实测新布局同时有“参与者”和“与所有人聊天”，不能把聊天当成第二个参与者按钮。
    const candidates = buttons.filter((b) =>
      !/\b(chat|messages?|messaging)\b|聊天|消息|訊息|チャット|メッセージ|채팅|메시지/i.test(labels.get(b)));
    const exact = candidates.filter((b) =>
      /^(参与者|參與者|参会者|參會者|协作人员|協作人員|people|participants|everyone)(?:\s*[（(]?\d+[）)]?)?$/i.test(norm(labels.get(b))));
    if (exact.length) return unique(exact);
    const byPanel = candidates.filter((b) => b.getAttribute('data-panel-id') === '1');
    if (byPanel.length) return unique(byPanel);
    const byLabel = candidates.filter((b) => PEOPLE_LABEL_RE.test(labels.get(b)));
    if (byLabel.length) return unique(byLabel);
    // 新布局可能只有群组图标和人数；只认实际图标元素，不按坐标或人数猜按钮。
    return unique(candidates.filter((b) => iconNames(b).some((name) =>
      ['people', 'group', 'groups', 'supervisor_account'].includes(name))));
  }
  const isPressed = (b) => !!b && (b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-expanded') === 'true');

  /** 参与者行：先找“人员面板根”下的 listitem；找不到再全局兜底（排除聊天/对话框/菜单）。 */
  function findRowsRaw() {
    const roots = [...document.querySelectorAll('[data-panel-id="1"]')].filter((el) => !isButtonLike(el));
    let rows = roots.flatMap((r) => [...r.querySelectorAll('[role="listitem"]')]).filter(isVisible);
    if (!rows.length) {
      rows = [...document.querySelectorAll('[role="list"] [role="listitem"]')].filter(
        (el) => !el.closest('[data-panel-id="2"], [role="dialog"], [role="alertdialog"], [role="menu"]')
      );
    }
    return [...new Set(rows)].filter(isVisible);
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
      if (!el || !isVisible(el) || insideWithin(el, row, 'button, [role="button"], [aria-hidden="true"]')) continue;
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

  /**
   * 后台页有时保留姓名行及其唯一菜单按钮，但 CSS 因无 hover 将按钮折叠为 0 个矩形。
   * 只对【仍可见的目标行】里唯一、明确声明 aria-haspopup=menu 的按钮允许尝试逻辑点击。
   * 不能把这个放宽到菜单项/确认按钮，更不能按坐标猜测目标。
   */
  function isOperableMoreButton(btn, row) {
    if (!btn || !row || !btn.isConnected || !row.isConnected || !row.contains(btn)) return false;
    if (btn.matches(':disabled, [aria-disabled="true"]') || btn.closest?.('[aria-hidden="true"], [inert]')) return false;
    if (!isVisible(row)) return false;
    if (isVisible(btn)) return true;
    return document.hidden === true && /^(menu|true)$/.test(btn.getAttribute('aria-haspopup') || '');
  }

  /** “更多操作”按钮：仅认菜单属性或明确的更多图标，不猜行内最后一个按钮。 */
  function findMoreButton(row) {
    const btns = [...row.querySelectorAll('button, [role="button"]')]
      .filter((b) => isOperableMoreButton(b, row));
    // “更多操作”入口不唯一时拒绝猜测目标，防止界面改版后点错参会者。
    const explicit = btns.filter((b) => /^(menu|true)$/.test(b.getAttribute('aria-haspopup') || ''));
    if (explicit.length > 1) return null;
    if (explicit.length === 1) return explicit[0];
    const byIcon = btns.filter((b) => /^(more_vert|more_horiz)$/.test(norm(b.textContent)));
    return byIcon.length === 1 ? byIcon[0] : null;
  }

  /** 解析一行 → 结构化信息（不缓存 DOM 引用到长期状态里）。 */
  function readRow(row, selfId) {
    const texts = collectTexts(row);
    const label = (row.getAttribute('aria-label') || '').trim();
    // 用户可见姓名优先于 aria-label（无障碍标签可能附带状态/操作提示，不能把提示里的 AA 当成姓名）。
    // 如果两种来源完全对不上，则姓名来源有歧义，宁可跳过该行，不触发破坏性操作。
    let visibleName = texts[0] || '';
    let nameTextIndex = 0;
    // 某些名单行先渲染头像缩写（A/AJ/张），再渲染真正昵称。
    // 在这种情况下不能把头像缩写当作姓名，否则可能误移出 AA张三。
    // 仅当 aria-label 以第二段真实文本开头时认领第二段，否则标记歧义并跳过。
    const first = norm(visibleName);
    const second = norm(texts[1] || '');
    const labelN = norm(label);
    if (first && second && Array.from(first).length <= 2 && second.length > first.length &&
        (labelN.startsWith(second) || (labelN.includes(second) && second.startsWith(first)))) {
      if (!labelN.startsWith(second)) return null;
      visibleName = texts[1];
      nameTextIndex = 1;
    }
    // 只有头像缩写而完整名字只存在于辅助标签时，无法确认两者关系：跳过而非移出。
    // 例：仅可见 A，aria-label=AA张三, 已静音，不能把 A 当作姓名判违规。
    if (texts.length === 1 && first && Array.from(first).length <= 2 && labelN &&
        labelN.split(/[,，;；]/, 1)[0].trim() !== first) return null;
    // 无真实可见姓名时，aria-label 可能只是状态/按钮提示；不把它当作移出依据。
    if (!visibleName) return null;
    // 头像在前却缺少可核对的辅助标签，无法区分头像与姓名，安全跳过。
    if (nameTextIndex === 0 && first && Array.from(first).length <= 2 &&
        texts.length > 1 && second && second.length > first.length && !labelN) return null;
    if (label && !labelN.includes(norm(visibleName))) return null;
    const name = visibleName;
    const nameN = norm(name);
    if (!nameN) return null; // 读不出名字 → 不参与判定

    // 该值只辅助当前会议 DOM 目标定位，不是 Google 账号身份或合规准入要求；
    // 无痕/访客参会者没有此属性时，按当前显示姓名创建临时候选键。
    const id =
      row.getAttribute('data-participant-id') ||
      row.querySelector('[data-participant-id]')?.getAttribute('data-participant-id') ||
      '';
    // 自己：有可靠 id 就只认 id（文本标记可被昵称伪造）；否则退化为文本标记
    // 禁止用“昵称写 (You)”伪装自己；仅在 Meet 提供的参与者 ID 明确一致时豁免。
    const isSelf = Boolean(selfId && id && id === selfId);
    // 注意头像缩写可以排在昵称前：此时 texts[1] 才是姓名，不能把它也当成主持人/演示标签。
    // 仅从完整昵称之后的独立文本里读取辅助身份标记。
    const badges = texts.slice(nameTextIndex + 1);
    return {
      row, key: id || `n:${nameN}`, name, nameN, isSelf,
      isHost: badges.some((t) => HOST_RE.test(norm(t))),
      // 昵称“foo (presentation)”本身不能获得演示流豁免；只认独立的次级描述。
      isPresentation: badges.some((t) => PRESENTATION_RE.test(norm(t))),
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

  /**
   * Meet 的 Gemini 介绍、“会议已准备就绪”等提示可能以 dialog/menu 呈现。
   * 它们不妨碍用户手动打开参与者面板，不应该永久阻止自动巡检。
   * 但移出/举报、警告确认及正在编辑的窗口仍必须保持隔离。
   * 该判断仅决定能否继续操作，绝不点击或关闭现有弹窗。
   */
  function blocksParticipantAutomation(overlay) {
    if (!isVisible(overlay)) return false;
    if (overlay.matches('[role="alertdialog"]')) return true;
    const editable = [...overlay.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]')]
      .some((el) => isVisible(el) && !el.readOnly && el.getAttribute('readonly') === null);
    if (editable) return true;
    const description = norm([
      overlay.getAttribute('aria-label'), overlay.getAttribute('title'), overlay.textContent,
    ].filter(Boolean).join(' '));
    return isBulkRemoval(description) || DESTRUCTIVE_RE.test(description) || MENU_NEGATIVE_RE.test(description);
  }
  function hasBlockingOverlay() {
    return [...queryMenus(), ...queryDialogs()].some(blocksParticipantAutomation);
  }

  /* ════════════════════════ 6. 合规判定 ════════════════════════ */
  function evaluate(info) {
    if (!info.nameN) return { ok: true, why: 'unreadable' };
    if (info.isSelf) return { ok: true, why: 'self' };
    if (info.isHost) return { ok: true, why: 'host' };
    if (info.isPresentation) return { ok: true, why: 'presentation' };
    if (cfg.exact.has(info.nameN)) return { ok: true, why: 'exact-whitelist' };
    if (cfg.keywords.some((k) => containsCompleteMarker(info.nameN, k))) return { ok: true, why: 'keyword-whitelist' };
    if (cfg.required.some((k) => containsCompleteMarker(info.nameN, k, isLatinLikeMarker(k)))) return { ok: true, why: 'required-hit' };
    return { ok: false, why: 'violation' };
  }

  /* ════════════════════════ 7. 面板维护（运行时自动打开参与者面板） ════════════════════════ */
  const userIsTyping = () => {
    const a = document.activeElement;
    const editable = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    // 输入框保有焦点不代表仍在输入；停止真实操作3秒后允许切换。
    return editable && Date.now() - state.lastInput < T.idleBeforeSweep;
  };

  function panelReady() {
    if (!findRowsRaw().length) return false;
    state.lastOpenAttempt = 0;
    state.openAttempts = [];
    state.panelRetryAt = 0;
    state.panelStatus = '';
    return true;
  }

  async function ensurePeoplePanel() {
    if (panelReady()) return true; // 手动打开后立即恢复，不受面板重试退避影响。
    state.panelStatus = '正在准备参与者面板';
    if (!alive() || !configReady || !cfg.enabled || !cfg.required.length) return false;
    if (userIsTyping() || Date.now() - state.lastInput < T.userBusy) {
      state.panelStatus = '等待当前输入结束后打开参与者面板';
      return false;
    }
    if (hasBlockingOverlay()) {
      state.panelStatus = '敏感操作窗口尚未关闭 · 等待安全恢复';
      return false;
    }
    const btn = peopleToggle();
    if (!btn) { state.panelStatus = '未识别到唯一的参与者按钮 · 持续重试'; return false; }
    // 已展开时只等待列表，不能再次点击把面板关掉。
    if (isPressed(btn)) { state.panelStatus = '参与者面板已展开 · 等待可见名单'; return false; }

    const now = Date.now();
    state.openAttempts = state.openAttempts.filter((t) => now - t < 60_000);
    if (now < state.panelRetryAt || (state.lastOpenAttempt && now - state.lastOpenAttempt < T.panelOpenRetry)) {
      state.panelStatus = '参与者面板尚未就绪 · 等待重试';
      return false;
    }
    if (state.openAttempts.length >= 3) {
      // 面板失败只退避打开动作，不进入移出操作的全局安全熔断。
      state.panelRetryAt = now + T.panelBackoff;
      state.openAttempts = [];
      state.panelStatus = '参与者面板打开失败 · 30秒后重试（手动打开可立即恢复）';
      return false;
    }
    const revision = configRevision, inputAt = state.lastInput;
    state.lastOpenAttempt = now;
    state.openAttempts.push(now);
    state.panelStatus = '正在打开参与者面板';
    btn.click(); // 聊天/其他面板打开也切换；不额外抢输入焦点。
    await waitFor(() => {
      if (!alive() || revision !== configRevision || !configReady || !cfg.enabled || state.lastInput !== inputAt) return 'aborted';
      return findRowsRaw().length ? 'ready' : null;
    }, { timeout: T.panelRender });
    if (!alive() || revision !== configRevision || !configReady || !cfg.enabled || state.lastInput !== inputAt) return false;
    if (panelReady()) return true;
    state.panelStatus = '等待参与者名单渲染 · 自动重试';
    return false;
  }

  /**
   * 以 Meet 的参与者面板本身确认展开状态，避免依赖某些布局不提供的 aria-expanded。
   * 只承认唯一、可见、带真实参会者行的 data-panel-id=1 面板。
   * 不读取其他弹窗或聊天区，不把人数角标误当作姓名。
   */
  function verifiedRosterPanel() {
    const roots = [...document.querySelectorAll('[data-panel-id="1"]')]
      .filter((root) => !isButtonLike(root) && isVisible(root));
    if (roots.length !== 1) return null;
    const root = roots[0];
    const rows = [...root.querySelectorAll('[role="listitem"]')].filter(isVisible);
    return rows.length ? { root, rows } : null;
  }

  /**
   * 只接受能够用 Meet 人员按钮的语义或原生图标证明身份的开关。
   * 某些布局的按钮没有 data-panel-id/aria-expanded，不能把缺少该属性当成“名单未展开”。
   * 和唯一的可见人员面板交叉核对，仅用于非破坏性的收起/展开，不授权踢人。
   */
  function peopleToggleEvidence(btn) {
    if (!btn || !btn.isConnected) return 'missing';
    if (btn.getAttribute('data-panel-id') === '1') return 'panel-id';
    const labelledBy = (btn.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const label = norm([
      btn.getAttribute('aria-label'), btn.getAttribute('title'),
      btn.getAttribute('data-tooltip'), btn.getAttribute('data-tooltip-text'), labelledBy,
    ].filter(Boolean).join(' '));
    if (label && !/\b(chat|messages?|messaging)\b|聊天|消息|訊息|チャット|メッセージ|채팅|메시지/i.test(label) &&
        PEOPLE_LABEL_RE.test(label)) return 'people-label';
    if (iconNames(btn).some((name) =>
      ['people', 'group', 'groups', 'supervisor_account'].includes(name))) return 'people-icon';
    return 'unverified';
  }

  /**
   * 隐藏页面人员名单重挂载实验，针对人数角标已更新而 DOM 姓名行没更新。
   * aria-pressed/expanded 可能不设置；此时只在唯一面板和可验证按钮的强证据下尝试。
   * 在每次点击后检查真实面板 DOM 变化；任何不确定均停止，不盲点第二次。
   */
  async function maybeRefreshHiddenRoster() {
    if (!alive() || !document.hidden || !configReady || !cfg.enabled || !cfg.required.length ||
        state.busy || state.sweeping || state.refreshingRoster ||
        Date.now() < state.pausedUntil || userIsTyping() ||
        Date.now() - state.lastInput < T.idleBeforeSweep || hasBlockingOverlay()) return false;

    const now = Date.now();
    if (!state.hiddenSince) state.hiddenSince = now;
    if (now - state.hiddenSince < T.hiddenRosterWarmup) return false;
    const btn = peopleToggle();
    const panel = verifiedRosterPanel();
    const before = findRowsRaw().length;
    const badge = participantCount();
    const mismatch = badge !== null && badge > before;
    const ariaOpen = !!btn && isPressed(btn);
    const toggleEvidence = peopleToggleEvidence(btn);
    // A2 要求 data-panel-id=1 是过度约束：有些 Meet 布局只提供 aria-label 或人员图标。
    // 仅在有明确的人员按钮身份 + 唯一的可见名单面板 + 人数不匹配时允许非破坏性刷新。
    const fallbackOpen = !!panel && mismatch &&
      ['panel-id', 'people-label', 'people-icon'].includes(toggleEvidence);
    // 只回传匿名校验证据，帮助区分“控制按钮不明”和“名单面板无法确认”。
    state.rosterRefreshEvidence = {
      toggleEvidence, panelVerified: !!panel, countMismatch: mismatch, ariaOpen,
    };
    if (!btn || (!ariaOpen && !fallbackOpen)) {
      state.rosterRefreshResult = !btn ? 'no-people-toggle' :
        !mismatch && !ariaOpen ? 'no-count-mismatch' : 'no-verified-open-toggle';
      return false;
    }
    const cooldown = mismatch ? T.hiddenRosterMismatchInterval : T.hiddenRosterInterval;
    if (state.lastRosterRefreshAt && now - state.lastRosterRefreshAt < cooldown) return false;
    if (!mismatch && now - state.hiddenSince < T.hiddenRosterInterval) return false;
    if (!state.rosterRefreshWindowAt || now - state.rosterRefreshWindowAt > 600_000) {
      state.rosterRefreshWindowAt = now;
      state.rosterRefreshAttempts = 0;
    }
    if (state.rosterRefreshAttempts >= T.hiddenRosterMaxTries) {
      state.rosterRefreshThrottle = 'rate-limited';
      return false;
    }
    const revision = configRevision, inputAt = state.lastInput;
    const valid = () => alive() && configReady && cfg.enabled && !state.busy && !state.sweeping &&
      revision === configRevision && state.lastInput === inputAt &&
      Date.now() >= state.pausedUntil && btn.isConnected && document.hidden && !hasBlockingOverlay();
    const scopedRows = () => {
      const roots = [...document.querySelectorAll('[data-panel-id="1"]')]
        .filter((root) => !isButtonLike(root) && isVisible(root));
      if (roots.length !== 1) return null;
      return [...roots[0].querySelectorAll('[role="listitem"]')].filter(isVisible).length;
    };
    if (!valid()) return false;
    state.refreshingRoster = true;
    state.lastRosterRefreshAt = now;
    state.rosterRefreshAttempts++;
    state.rosterRefreshBefore = before;
    state.rosterRefreshAfter = null;
    state.rosterRefreshThrottle = '';
    state.rosterRefreshResult = 'closing';
    try {
      btn.click();
      const closed = await waitFor(() => {
        if (!valid()) return null;
        if (ariaOpen && !isPressed(btn)) return 'closed';
        const count = scopedRows();
        return count === null || count === 0 ? 'closed' : null;
      }, { timeout: 1800 });
      if (!closed || !valid()) {
        state.rosterRefreshResult = 'close-not-confirmed';
        return false;
      }
      // DOM 已确认收起；同一按钮依然存在且没有其他交互，才重新展开。
      state.rosterRefreshResult = 'reopening';
      btn.click();
      const reopened = await waitFor(() => {
        if (!valid()) return null;
        if (ariaOpen && isPressed(btn)) return 'opened';
        const count = scopedRows();
        return count !== null && count > 0 ? 'opened' : null;
      }, { timeout: 1800 });
      if (!reopened || !valid()) {
        state.rosterRefreshResult = 'reopen-not-confirmed';
        return false;
      }
      // 后台页面若仅恢复旧的一行，也如实记录无增长；不假装已经读到第二人的姓名。
      await waitFor(() => findRowsRaw().length > before ? 'more-rows' : null, { timeout: T.panelRender });
      if (!valid()) return false;
      const after = findRowsRaw().length;
      state.rosterRefreshAfter = after;
      state.rosterRefreshResult = after > before ? 'rows-increased' :
        after === 0 ? 'still-empty' : 'no-growth';
      attachListObserver();
      if (after) scheduleHarvest();
      return after > before;
    } catch {
      state.rosterRefreshResult = 'refresh-error';
      return false;
    } finally {
      state.rosterRefreshLog.push({
        at: Date.now(), attempt: state.rosterRefreshAttempts,
        before: state.rosterRefreshBefore, after: state.rosterRefreshAfter,
        outcome: state.rosterRefreshResult,
      });
      if (state.rosterRefreshLog.length > REFRESH_LOG_CAP) state.rosterRefreshLog.shift();
      state.refreshingRoster = false;
    }
  }

  function participantCount() { // 人员按钮角标里的数字，仅作辅助信号
    const m = peopleToggle()?.textContent?.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function attachListObserver() {
    const first = findRowsRaw()[0];
    const list = first && (first.closest('[role="list"]') || first.parentElement);
    if (state.observedList === (list || null)) return;
    state.listObserver?.disconnect();
    state.listObserver = null;
    state.observedList = list || null;
    state.coverage = null; state.lastSweepAt = 0; state.lastSweepCount = null;
    state.incomplete = false; state.retries = 0;
    state.suspects.clear();
    if (!list) return;
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
    const entries = readRows();
    state.lastRawRows = findRowsRaw().length;
    state.lastReadableRows = entries.length;
    state.lastViolations = 0;
    state.lastMissingAction = 0;
    if (entries.length) state.lastPatrolAt = now;
    for (const info of entries) {
      seen?.add(info.key);
      if (evaluate(info).ok) { state.suspects.delete(info.key); continue; }
      state.lastViolations++;
      if (!info.moreBtn) state.lastMissingAction++;
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
    const check = async () => {
      state.harvestTimer = 0;
      if (!alive() || state.busy || state.sweeping || state.refreshingRoster || !configReady || !cfg.enabled || !cfg.required.length) return;
      if (Date.now() < state.pausedUntil) return;
      try {
        const t = harvest();
        if (t) await kick(t);
        else if (document.hidden && !state.suspectReviewTimer) {
          // 首次仅目击一次的违规姓名，需要独立二次复核；定时器只负责再次读取，绝不直接踢人。
          const now = Date.now();
          const waits = [...state.suspects.entries()]
            .filter(([key, item]) => !held(key, now) && item.last >= now - T.suspectTTL &&
              now - item.first < T.suspectStable)
            .map(([, item]) => Math.max(20, T.suspectStable - (now - item.first) + 25));
          if (waits.length) {
            state.suspectReviewTimer = setTimeout(() => {
              state.suspectReviewTimer = 0;
              if (alive()) scheduleHarvest();
            }, Math.min(...waits));
          }
        }
      } catch (e) { console.error(LOG, '采集异常：', safeErrorKind(e)); }
    };
    if (document.hidden) {
      // 后台列表 MutationObserver 已通知变化：无需等可能被节流到一分钟的定时器。
      // 同时按真实时间限流，避免人数多时由持续 DOM 变化产生过多微任务。
      const now = Date.now();
      if (now - state.lastBackgroundHarvestAt < 200) return;
      state.lastBackgroundHarvestAt = now;
      // 使用哨兵防止同一轮 DOM 变化重复提交；嫌疑人仍需间隔 T.suspectStable 复核。
      state.harvestTimer = -1;
      queueMicrotask(check);
    } else {
      state.harvestTimer = setTimeout(check, T.harvestDebounce);
    }
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
        Date.now() < state.pausedUntil ||
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
    // 批量处置选项出现时不做任何自动点击，即使同时存在普通“移出”。
    if (leaves.some((el) => isVisible(el) && isBulkRemoval(norm(el.textContent)))) return null;
    const hits = leaves.filter((el) => {
      const text = norm(el.textContent);
      if (!isVisible(el) || el.matches(':disabled, [aria-disabled="true"]') || !text || MENU_NEGATIVE_RE.test(text) || isBulkRemoval(text)) return false;
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
    if (visibleButtons(dialog).some((b) => isBulkRemoval(norm(b.textContent)))) return null;
    const hits = visibleButtons(dialog).filter((b) =>
      !b.matches(':disabled, [aria-disabled="true"]') &&
      !CANCEL_RE.test(norm(b.textContent)) &&
      !MENU_NEGATIVE_RE.test(norm(b.textContent)) &&
      !isBulkRemoval(norm(b.textContent)) &&
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
    if (state.busy || !configReady || !cfg.enabled || !cfg.required.length || Date.now() < state.pausedUntil) return; // 单飞 + 安全熔断，对滚动扫描入口也有效
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
    // 普通提示弹窗可保持打开；本次操作只认相对于 baseline 新出现的菜单/确认框。
    // 移出、举报、警告确认和编辑中的弹窗仍然完全阻止处置。
    if ([...baseline.dialogs, ...baseline.menus].some(blocksParticipantAutomation)) return;
    const owned = { menu: null, dialog: null };
    state.lastKickAttemptAt = Date.now();
    state.lastKickStage = 'target-check';
    state.busy = true;
    hud.set(`🎯 处理中：${clip(name)}`, C.err);

    try {
      checkActive();
      // ① 用 key 重新定位并复核（不信任采集时留下的节点引用）
      const first = locateTarget(target);
      if (!isOperableMoreButton(first.moreBtn, first.row)) throw new KickError('stale');
      first.row.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });

      // ② 开菜单
      state.lastKickStage = 'open-menu';
      const menu = await openMenu(first, baseline, checkActive);
      if (!menu) throw new KickError('menu-timeout');
      owned.menu = menu;

      // ③ 识别菜单项；找不到绝不乱点
      state.lastKickStage = 'find-remove-item';
      const item = findRemoveItem(menu);
      if (!item) { dumpMenu(menu); throw new KickError('no-remove-item'); }

      // ④ 菜单打开期间列表可能重排 → 再复核一次
      const second = locateTarget(target);
      if (second.row !== first.row || second.moreBtn !== first.moreBtn) throw new KickError('stale');
      checkActive();

      // ⑤ 点“移出”，等确认对话框
      state.lastKickStage = 'open-confirm-dialog';
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
      state.lastKickStage = 'confirm-check';
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
      state.lastKickStage = 'submit-confirm';
      press(confirm);

      // ⑦ 以“对话框消失”作为成功信号
      if (!(await waitFor(() => !isVisible(dialog), { timeout: T.closing }))) throw new KickError('dialog-not-closed');

      state.lastKickStage = 'completed';
      state.lastKickSuccessAt = Date.now();
      state.lastKickFailure = '';
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
    state.lastKickFailure = code;
    state.lastKickFailureAt = Date.now();
    if (code === 'aborted') return;
    // 未预期异常可能携带 Meet DOM 文字、会议链接或参会者姓名，不输出异常正文/堆栈。
    if (!(err instanceof KickError)) console.error(LOG, '未预期处置异常：', safeErrorKind(err));
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
    if (state.busy || state.sweeping || state.refreshingRoster) return;
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
    const sweepRevision = configRevision;
    const seen = new Set();
    let completed = false;
    try {
      sc.scrollTo({ top: 0, behavior: 'instant' });
      for (let i = 0; i < 300 && alive() && sc.isConnected; i++) {
        // 在后台浏览器可能延迟虚拟列表渲染；限制一次扫描的墙上耗时以免长期占用调度器。
        if (Date.now() - startedAt > 20_000) break;
        if (!configReady || !cfg.enabled || Date.now() < state.pausedUntil ||
            sweepRevision !== configRevision || state.lastInput > startedAt) break;
        await waitForQuiet(state.observedList);       // 等虚拟列表渲染稳定，而不是睡固定时间
        // 等待期间用户可能开始操作或熔断被触发，必须先检查再处置。
        if (!configReady || !cfg.enabled || Date.now() < state.pausedUntil ||
            sweepRevision !== configRevision || state.lastInput > startedAt) break;
        const target = harvest(seen);
        if (target) await kick(target);                // 目标此刻就在视口内，直接处置
        if (!configReady || !cfg.enabled || Date.now() < state.pausedUntil ||
            sweepRevision !== configRevision || state.lastInput > startedAt) break;
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

  /* ════════════════════════ 11. 调度与自恢复（不扩大扩展权限） ════════════════════════ */
  async function runCycle() {
    pruneState();
    if (state.busy || state.sweeping || state.refreshingRoster) return;
    if (!configReady) return hud.set('配置未就绪 · 正在等待自动恢复', C.warn);
    if (!cfg.enabled) return hud.set('已暂停', C.warn);
    if (!cfg.required.length) return hud.set('未设置必需关键词 · 不执行移出', C.warn);
    if (Date.now() < state.pausedUntil) return hud.set(`已暂停：${state.pauseReason}`, C.err);
    if (!(await ensurePeoplePanel())) {
      attachListObserver();
      // 隐藏页默认不执行收起/重开面板：UI 可能无法再渲染回来。
      assessRosterCoverage();
      return hud.set(state.panelStatus || '参与者名单未就绪 · 持续重试', C.warn);
    }

    attachListObserver();
    const target = harvest();
    if (target) await kick(target);
    else {
      await maybeSweep();
      // A3 旧面板重挂载默认关闭，仅保留为隔离实验入口。
      if (AUTO_HIDDEN_ROSTER_TOGGLE_EXPERIMENT && !state.busy && !state.sweeping &&
          state.lastViolations === 0) await maybeRefreshHiddenRoster();
    }

    if (!state.busy) {
      // 扫描期间页面可能卸载人员面板，不能用旧的结果制造“巡检中”假正常状态。
      if (!panelReady()) return hud.set('参与者名单已变化 · 正在自动恢复', C.idle);
      const coverage = assessRosterCoverage();
      if (coverage === 'blind') {
        // countHint=3、readable=1 时明确承认盲区；绝不按缺失行或人数猜目标。
        const hint = state.lastCoverageHint;
        const where = document.hidden ? '后台' : '当前';
        return hud.set(`${where}名单未同步 · 可读 ${state.lastReadableRows}/${hint} 人`, C.warn);
      }
      if (coverage === 'mismatch-pending')
        return hud.set('参会者名单更新中 · 正在核对人数', C.warn);
      if (coverage === 'unknown')
        return hud.set('姓名巡检运行中 · 名单完整性未知', C.warn);
      const cov = state.coverage ? ` ${state.coverage}` : '';
      hud.set(cfg.dryRun ? `试运行 · 巡检中${cov}` : `巡检中${cov}`, cfg.dryRun ? C.warn : C.ok);
    }
  }

  async function tick() {
    if (state.cycling) return;
    if (!alive()) return shutdown('扩展上下文失效（扩展被重载/卸载）');
    state.cycling = true;
    const tickNow = Date.now();
    if (state.lastTickStartedAt) state.lastTickIntervalMs = tickNow - state.lastTickStartedAt;
    state.lastTickStartedAt = tickNow;
    state.lastCycleStartAt = tickNow;
    try { await runCycle(); }
    catch (err) {
      console.error(LOG, '巡检周期异常（已隔离，下个周期继续）：', safeErrorKind(err));
      hud.set('巡检异常 · 正在自动重试', C.warn);
    } finally {
      state.cycling = false;
      state.lastCycleAt = Date.now();
    }
    if (alive()) state.tickTimer = setTimeout(tick, T.tick);
    else shutdown('扩展上下文失效');
  }

  // 浏览器真实恢复、名单突然重建等情况下唤醒调度器；
  // 不会在处置/扫描进行中再启动另一轮，因此没有重复确认移出的风险。
  function wake() {
    if (!alive() || state.cycling || state.busy || state.sweeping) return;
    clearTimeout(state.tickTimer);
    state.tickTimer = 0;
    queueMicrotask(tick);
  }

  function healthCheck() {
    if (!alive()) return shutdown('扩展上下文失效');
    hud.restore();
    if (!configReady && Date.now() - state.lastConfigAttemptAt >= T.configRetry) {
      // 从 Chrome storage 临时错误恢复；失败期间仍不会移出任何人。
      void loadConfig().then(wake);
      return;
    }
    if (state.cycling) {
      if (Date.now() - state.lastCycleStartAt >= T.slowCycle) {
        // 不得为“修复卡住”而并发点击另一个移出按钮。
        hud.set('本轮巡检响应缓慢 · 等待安全恢复', C.warn);
      }
      return;
    }
    if (state.observedList && !state.observedList.isConnected) attachListObserver();
    if (Date.now() - state.lastCycleAt >= T.staleCycle) wake();
  }

  function shutdown(reason) {
    if (life.signal.aborted) return;
    life.abort();
    clearTimeout(state.tickTimer); clearTimeout(state.harvestTimer);
    clearTimeout(state.suspectReviewTimer); state.suspectReviewTimer = 0;
    clearInterval(state.watchdogTimer);
    if (state.renderFrameRequest && typeof cancelAnimationFrame === 'function')
      cancelAnimationFrame(state.renderFrameRequest);
    state.renderFrameRequest = 0;
    state.listObserver?.disconnect(); state.rootObserver?.disconnect();
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* 上下文已失效 */ }
    try { chrome.runtime.onMessage.removeListener(onHealthMessage); } catch { /* 上下文已失效 */ }
    if (window.__MEET_NAME_SENTRY__ === instance) delete window.__MEET_NAME_SENTRY__;
    hud.remove();
    console.info(LOG, '已停止：', reason);
  }

  // 与 MV3 Service Worker 的最小化通信协议：不向后台传参会者姓名、名单或会议链接。
  // 只有巡检引擎本身执行 DOM 检查、菜单确认和移出动作；后台仅判断存活并唤醒。
  const HEALTH_PROTOCOL = 'MNS_HEALTH_V1';
  function healthSnapshot() {
    // 页面正在重绘、导航或卸载时 DOM 查询可能失败，不能因此让后台误以为脚本已经丢失。
    let peopleButtonFound = false, peopleRowsVisible = false, blockingOverlay = false;
    let participantCountHint = null, instantRawRows = null, instantReadableRows = null;
    try {
      peopleButtonFound = !!peopleToggle();
      instantRawRows = findRowsRaw().length;
      peopleRowsVisible = instantRawRows > 0;
      instantReadableRows = readRows().length;
      blockingOverlay = hasBlockingOverlay();
      participantCountHint = participantCount();
      // PING 使用当前 DOM 行数，而不是可能已经过时的最后一次巡检缓存。
      // 仅读取数量，不返回姓名，也不触发任何移出操作。
      assessRosterCoverage(Date.now(), participantCountHint, instantReadableRows);
    } catch { /* 诊断失败不影响生命体征回复，也不授权移出 */ }
    return {
      protocol: HEALTH_PROTOCOL,
      version: '1.0.2',
      alive: alive(),
      configReady,
      enabled: configReady && cfg.enabled,
      paused: Date.now() < state.pausedUntil,
      busy: state.busy || state.sweeping || state.refreshingRoster || state.cycling,
      lastCycleAt: state.lastCycleAt,
      lastPatrolAt: state.lastPatrolAt,
      // 仅供本扩展后台诊断；不传姓名、会议链接或人员明细。
      pageHidden: document.hidden === true,
      peopleButtonFound,
      peopleRowsVisible,
      blockingOverlay,
      // 只读匿名统计；不包含姓名、参与者 ID 或会议链接。
      rawRows: instantRawRows ?? state.lastRawRows,
      readableRows: instantReadableRows ?? state.lastReadableRows,
      violationRows: state.lastViolations,
      missingActionButtons: state.lastMissingAction,
      // 实验性后台名单重挂载数据：纯计数与枚举值，不包含参会姓名。
      rosterRefreshAttempts: state.rosterRefreshAttempts,
      rosterRefreshSecondsAgo: state.lastRosterRefreshAt ? Math.floor((Date.now() - state.lastRosterRefreshAt) / 1000) : null,
      rosterRefreshBefore: state.rosterRefreshBefore,
      rosterRefreshAfter: state.rosterRefreshAfter,
      rosterRefreshResult: state.rosterRefreshResult,
      rosterRefreshEvidence: state.rosterRefreshEvidence,
      rosterRefreshThrottle: state.rosterRefreshThrottle,
      rosterRefreshLog: state.rosterRefreshLog.slice(),
      autoHiddenRosterToggle: AUTO_HIDDEN_ROSTER_TOGGLE_EXPERIMENT,
      participantCountHint,
      coverageStatus: state.coverageStatus,
      coverageMismatchSeconds: state.coverageMismatchSince ? Math.floor((Date.now() - state.coverageMismatchSince) / 1000) : 0,
      lastCompleteCoverageAt: state.lastCompleteCoverageAt,
      renderAlive: state.lastRenderFrameAt ? Date.now() - state.lastRenderFrameAt <= RENDER_HEARTBEAT_FRESH_MS : null,
      renderAgeSeconds: state.lastRenderFrameAt ? Math.floor((Date.now() - state.lastRenderFrameAt) / 1000) : null,
      renderFrameCount: state.renderFrameCount,
      lastRenderFrameAt: state.lastRenderFrameAt,
      tickIntervalMs: state.lastTickIntervalMs,
      dryRun: configReady ? cfg.dryRun : null,
      kickStage: state.lastKickStage,
      lastKickFailure: state.lastKickFailure,
      lastKickAttemptAt: state.lastKickAttemptAt,
      lastKickSuccessAt: state.lastKickSuccessAt,
      lastKickFailureAt: state.lastKickFailureAt,
    };
  }
  function onHealthMessage(message, sender, respond) {
    // 即便日后增加对外消息能力，网页和其他扩展也不得唤醒/查询巡检引擎。
    if (sender?.id !== chrome.runtime.id || sender?.tab) return false;
    if (!message || message.protocol !== HEALTH_PROTOCOL ||
        (message.action !== 'PING' && message.action !== 'WAKE')) return false;
    if (message.action === 'WAKE' && alive() && !state.busy && !state.sweeping) {
      healthCheck(); // 被后台唤醒时同步执行一次配置重试检查，而不依赖被节流的页面定时器。
      wake();
    }
    respond(healthSnapshot());
    return false; // 同步回复，避免让 Service Worker 长时间等待异步通道。
  }
  const instance = Object.freeze({ alive, wake, shutdown, protocol: HEALTH_PROTOCOL });
  window.__MEET_NAME_SENTRY__ = instance;
  try { chrome.runtime.onMessage.addListener(onHealthMessage); }
  catch { /* 异常后由外围健康监护尝试重新注入 */ }

  /* ════════════════════════ 12. 启动与页面生命周期恢复 ════════════════════════ */
  (async () => {
    hud.set('正在启动巡检…', C.idle);
    try { chrome.storage.onChanged.addListener(onStorageChanged); }
    catch { hud.set('扩展权限暂不可用 · 请重新加载扩展', C.err); return; }

    // 轻量 rAF 观测，不改变 Meet 的 visibilityState / 原生动画调度。
    startRenderHeartbeat();
    // 看门狗在加载配置之前启动：第一次 chrome.storage.sync.get() 失败也能自动重试。
    state.watchdogTimer = setInterval(healthCheck, T.watchdog);
    await loadConfig();
    if (!alive()) return shutdown('扩展上下文失效');

    const markInput = (e) => { if (e.isTrusted) state.lastInput = Date.now(); };
    for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart', 'input', 'paste', 'compositionstart', 'compositionupdate', 'compositionend']) {
      document.addEventListener(type, markInput, { capture: true, passive: true, signal: life.signal });
    }
    document.addEventListener('visibilitychange', () => {
      state.hiddenSince = document.hidden ? Date.now() : 0;
      wake();
    }, { signal: life.signal });
    document.addEventListener('resume', wake, { signal: life.signal });
    window.addEventListener('pageshow', wake, { signal: life.signal });
    window.addEventListener('focus', wake, { signal: life.signal });

    // 等 Meet 挂载/重建参与者 DOM 时立即醒来，不等待后台节流后的定时器。
    // 只在“尚未附着到可靠的名单”时生效，且每 3 秒最多唤醒一次。
    state.rootObserver = new MutationObserver(() => {
      if (!alive() || !configReady || !cfg.enabled || state.observedList?.isConnected) return;
      if (state.cycling || state.busy || state.sweeping) return;
      const now = Date.now();
      if (now - state.lastDomWakeAt < 3_000) return;
      if (!document.querySelector('[data-panel-id="1"] [role="listitem"], [role="list"] [role="listitem"]')) return;
      state.lastDomWakeAt = now;
      wake();
    });
    state.rootObserver.observe(document.documentElement, { childList: true, subtree: true });

    wake();
    console.info(LOG, '巡检引擎已挂载 v1.0.2');
  })().catch((err) => {
    console.error(LOG, '巡检引擎初始化异常：', safeErrorKind(err));
    try { hud.set('启动异常 · 正在等待监护恢复', C.err); } catch { /* DOM 暂不可用 */ }
    shutdown('启动失败，允许后台监护稍后安全补注入');
  });
})();
