// popup.js — 与 content.js 共用同一套 storage 字段与默认值
const DEFAULTS = {
  enabled: true,
  dryRun: false,
  requiredKeywords: 'AA',
  keywordWhitelist: '',
  exactWhitelist: '',
  extraRemoveLabels: '',
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const sizeEl = $('size');

// chrome.storage.sync 单个 key 上限约 8192 字节（含 key 名与 JSON 序列化开销）
const ITEM_LIMIT = 8192;
const byteLen = (s) => new TextEncoder().encode(s).length;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    dryRun: $('dryRun').checked,
    requiredKeywords: $('requiredKeywords').value,
    keywordWhitelist: $('keywordWhitelist').value,
    exactWhitelist: $('exactWhitelist').value,
    extraRemoveLabels: $('extraRemoveLabels').value,
  };
}

function writeForm(items) {
  $('enabled').checked = !!items.enabled;
  $('dryRun').checked = !!items.dryRun;
  for (const k of ['requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels']) {
    $(k).value = items[k] ?? '';
  }
}

function updateHints(payload) {
  const used = byteLen(payload.exactWhitelist) + 'exactWhitelist'.length + 2;
  sizeEl.textContent = used > ITEM_LIMIT * 0.6 ? `白名单 ${used}/${ITEM_LIMIT} 字节` : '';
}

let ready = false;
let timer = 0;
const pendingText = new Set();
let writeGeneration = 0;
const failedFields = new Set();
const textFieldIds = ['requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'];

// 按字段写入：旧的文本保存不能携带旧 dryRun/enabled，覆盖最新安全开关。
// Chrome storage 是异步的，回调也可能乱序；只有最后一个回调能更新状态提示。
function persist(fields) {
  if (!ready || !fields.length) return;
  const form = readForm();
  const payload = Object.fromEntries(fields.map((id) => [id, form[id]]));
  updateHints(form);
  // sync.set 单条记录存在 8KiB 配额，提前拒绝，避免误显示已保存。
  const oversized = fields.find((id) => typeof form[id] === 'string' &&
    byteLen(id) + byteLen(JSON.stringify(form[id])) > ITEM_LIMIT);
  if (oversized) {
    failedFields.add(oversized);
    return setStatus(`保存失败：${oversized} 超过同步存储单项大小限制`, 'err');
  }
  const generation = ++writeGeneration;
  setStatus('保存中…');
  chrome.storage.sync.set(payload, () => {
    const err = chrome.runtime.lastError;
    if (err) fields.forEach((id) => failedFields.add(id));
    else fields.forEach((id) => failedFields.delete(id));
    if (failedFields.size) return setStatus('保存失败：部分设置未写入，请重新操作并确认。', 'err');
    if (generation !== writeGeneration) return;
    if (!form.requiredKeywords.trim()) return setStatus('已保存。未设置必需关键词，不会移出任何人。', 'warn');
    if (form.dryRun) return setStatus('已保存。试运行中，不会真正移出。', 'warn');
    setStatus('已保存', 'ok');
  });
}

function flushText() {
  if (!pendingText.size) return;
  clearTimeout(timer);
  timer = 0;
  const fields = [...pendingText];
  pendingText.clear();
  persist(fields);
}

function scheduleSave(id) {
  if (!ready) return;
  pendingText.add(id);
  clearTimeout(timer);
  setStatus('保存中…');
  timer = setTimeout(flushText, 350);
}

const fieldIds = Object.keys(DEFAULTS);
for (const id of fieldIds) $(id).disabled = true;

chrome.storage.sync.get(DEFAULTS, (items) => {
  if (chrome.runtime.lastError) {
    setStatus('读取配置失败，请重新打开设置。自动保存已停止。', 'err');
    return;
  }
  const config = { ...DEFAULTS, ...items };
  if (typeof config.enabled !== 'boolean' || typeof config.dryRun !== 'boolean' ||
      ['requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels']
        .some((k) => typeof config[k] !== 'string' || config[k].length > 8192)) {
    setStatus('配置格式异常，自动保存已停止；请检查扩展存储中的设置。', 'err');
    return;
  }
  ready = true;
  for (const id of fieldIds) $(id).disabled = false;
  writeForm(config);
  updateHints(readForm());
  if (!$('requiredKeywords').value.trim()) setStatus('未设置必需关键词，不会移出任何人。', 'warn');
});

// 安全开关当场发出单字段写入，不受文字输入防抖影响。
for (const id of ['enabled', 'dryRun']) $(id).addEventListener('change', () => {
  if (!ready) return;
  flushText();
  persist([id]);
});
// 文字字段分别追踪待保存项，不会因编辑另一个文本字段丢失先前修改。
for (const id of textFieldIds) {
  $(id).addEventListener('input', () => scheduleSave(id));
  $(id).addEventListener('change', flushText);
}
// 页面关闭时尽力发出最后一次写入；异步完成与跨设备同步仍无法在关闭后保证。
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushText);
