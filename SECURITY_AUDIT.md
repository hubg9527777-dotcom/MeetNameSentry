# MeetNameSentry v1.0.1 — 安全审计报告（2026-10-14）

## 审核结论与边界

**基线**：`MeetNameSentry-v1.0.1-name-based.zip`（最新确认的“只按 Meet 当前显示姓名放行”版本），不混用早期 1.0.1/1.0.2 ZIP。**交付版本**：`1.0.1` 不变。2026-10-14 为用户约定的报告日期；执行环境里的存档时间可能因时区不同显示到次日。

此次检查覆盖所有可访问的源码、网页与资源、既有测试、说明文档、`.gitignore` 和发布 ZIP；实际执行本地测试、语法/Manifest 检查、静态凭据搜索与 ZIP 安全检查。**没有真实 Google Meet 主持人账号及实际参会者页面 DOM 的端到端环境**，不能宣称自动移出已通过生产安全验证。当前目录为解压副本，无 `.git`，无法审计远端提交历史或 GitHub Actions。结论只针对提供的构建，未审计 Google Meet/Chrome 自身的全部代码。

## 一、项目概况及依赖漏洞

| 项目 | 实际结果 |
|---|---|
| 语言与框架 | 原生 JavaScript、HTML、CSS；Chrome Manifest V3 浏览器扩展 |
| 包管理器/服务器 | 无包管理器；无后端；无数据库；无独立构建步骤 |
| 直接第三方依赖 | 0 |
| 锁文件中的间接依赖 | 0 |
| 依赖声明与锁文件 | 未发现 package.json、npm/pnpm/yarn lock、requirements.txt、go.mod、Cargo.toml、pom.xml、Podfile 等 |
| 测试依赖 | Node 内置 `node:test`、`node:vm`、`node:assert`、`node:fs`（运行时来自 Node，无第三方包清单） |
| Manifest 权限 | `permissions: ["storage"]`，未声明 `host_permissions`、`externally_connectable` 或额外 API 权限 |
| 内容脚本匹配 | `https://meet.google.com/*`；无需固定员工账号/邮箱/ID |
| 网络、远程代码 | 源代码未发现 fetch/XHR、远程 JS、eval/new Function、动态 import 或消息监听器 |
| npm audit | 实际运行 `npm audit --offline --json` 得到 `ENOLOCK`（没有锁文件）；**不能解释成漏洞为 0** |
| 过期/冒名依赖 | 没有可审计的第三方依赖，故没有可核对的包名/固定版本/对应 CVE |

已查阅 Chrome 官方的 Manifest 权限、MV3 内容安全、内容脚本风险、Storage API 文档。因为直接依赖数为零，GitHub Advisory Database、OSV.dev、NVD 中没有对应的 **第三方包及版本** 可逐一匹配；不能编造不存在的依赖 CVE。Google Meet Web UI 与 Chrome 更新属于未固定版本的外部运行环境，**待现场版本验证**。

官方参考：
- https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure
- https://developer.chrome.com/docs/extensions/mv3/declare_permissions
- https://developer.chrome.com/docs/extensions/reference/api/storage
- https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements

## 二、问题总表

行号以下均指最终修复版（`content.js` / `popup.js`）；历史漏洞位置可能和这里略有偏移。严重级别主要按**误移出会议参与者**的实际影响评估，不代表已证实存在可远程利用的 CVE。

| 编号 | 类别 | 级别 | 位置 | 状态 | 风险、利用条件及修复/建议 |
| --- | --- | --- | --- | --- | --- |
| S-01 | 代码 | **High** | `popup.js:48-137` | **已修复部分风险** | 旧版把所有字段整包异步写入。用户快速改白名单、再开启试运行时，较旧的整包写入可能携带 `dryRun=false` 覆盖新安全开关。改为**按字段增量写入**，开关立即独立写入，文本变更可合并。异步关闭窗口导致最后请求未完成仍是 S-10。 |
| S-02 | 代码 | **High** | `content.js:70-78, 714-750` | **已修复已知语种** | 西/葡/法/意语批量“移出所有人”此前可能命中单人操作。新增多语种批量识别、动作和全部范围组合；菜单及确认框遇到已知批量词直接停止。未知语种仍待现场验证。 |
| S-03 | 代码 | **Medium** | `content.js:456-508` | **已修复** | 未找到真实可见姓名时旧版退化读取整行 `aria-label`；其中可能混入操作提示。现在拒绝仅凭 `aria-label` 自动判定并移出。触发条件：虚拟列表 DOM 中姓名文本为空或未渲染。 |
| S-04 | 代码 | **Medium** | `content.js:463-488` | **已修复** | 头像缩写与正式姓名相邻，但没有可核对的辅助标签时，旧版有把 `A` 当真实姓名的误踢可能；现在跳过该行而不是猜测。 |
| S-05 | 代码 | **Low** | `content.js:443-453` | **已修复** | `more_vert` 原先为子字符串匹配，可能选中 `more_vert_xxx` 一类伪图标按钮；现在只接受完整图标文本，或明确且唯一的 `aria-haspopup`。 |
| S-06 | 代码 | **Medium** | `popup.js:57-84` | **已修复** | Sync 单条数据 8KiB 配额原先只有提示、不拒绝；大字段可能持续写入失败。现在计算 JSON 编码后字节数，超限立即报错，旧版容量提示继续保留。 |
| S-07 | 代码 | **High** | `content.js:43, 821-861` | **待开发者决定** | 最终确认弹窗**不强制匹配当前姓名**（`STRICT_DIALOG_NAME_CHECK=false`）。用户打开的其他弹窗或 Meet UI 改版可能使破坏性按钮误绑。应验证“同一名单行→独立菜单→弹窗显示姓名”后决定是否强制姓名一致，不需要固定账号 ID。 |
| S-08 | 代码 | **High** | `content.js:119-128`, `popup.js:2-9` | **待开发者决定** | 首次安装默认启用巡检且 `dryRun=false`，初次进入主持人会议会直接执行移出。改首次默认试运行属于业务行为变化，未擅自调整。 |
| S-09 | 代码 | **High** | `content.js:388-398` | **待开发者决定** | 在找不到参与者面板根时，尝试全局查找 `[role=list] [role=listitem]`。Google Meet 改版后可能混入其他列表。建议只处理可信人员面板；但可能影响对新版 DOM 的兼容。 |
| S-10 | 代码 | **Medium** | `popup.js:64-82, 121-137` | **待开发者决定** | `storage.sync.set()` 异步完成；关闭 popup 的最后一刻仍不能保证“已保存”，快速反复改变同一开关也可能存在跨请求顺序问题。完全解决需改用明确保存确认/后台服务工作者协调。当前做了分字段和失败提示，但不能宣称根治。 |
| S-11 | 代码 | **Medium** | `content.js:490-513, 685-690` | **建议关注** | 无 participant-id 的匿名参会者使用 `n:姓名` 临时定位，同名候选唯一性不够时现有代码选择跳过移出。该行为安全但可能漏检；ID 不应成为准入条件。 |
| S-12 | 代码 | **Medium** | `content.js:820-861` | **建议关注** | 当前把确认弹窗关闭作为移出成功信号，不等于服务端确认移出成功；可能出现“已移出”的假成功提示。需要真实 DOM/消息确认途径，改变成功判断前应确定业务与平台行为。 |
| S-13 | 隐私 | **Low** | `popup.js:64`, `content.js:205` | **待开发者决定** | 姓名白名单保存在 `chrome.storage.sync`，启用 Chrome 同步时可能同步到用户其他设备；不是加密机密存储。改为 `storage.local` 将失去既有跨设备同步并需要迁移。 |
| S-14 | 密钥/CI | **Low** | `.gitignore`, `.git` / `.github/workflows` | **建议关注 / 待确认** | 当前 `.gitignore` 已忽略 `.env`、`*.pem` 等；源目录没有 `.git` 或 workflow，无法查远端历史是否泄露秘密或是否使用未固定的 Action。 |
| S-15 | 代码 | **Medium** | `content.js:493-513` | **建议关注** | 主持人/演示身份来自独立辅助标签；当前已防范把昵称直接当豁免，但 Google Meet DOM/本地化结构变化仍可能产生假阳性/假阴性。需在真实会议含联席主持人、屏幕共享的页面测试。 |

## 三、本次直接代码改动

1. **安全开关不被文本保存回滚**：`popup.js` 改为仅持久化修改的字段；`enabled` / `dryRun` 立即调用同步存储，文本字段维持 350ms 防抖；两个文字输入连续编辑不会丢掉先前的值。旧回调不再把成功提示覆盖新回调，且所有存储失败都能在界面上保留错误提示。为什么：避免旧整包配置覆盖最新安全开关。
2. **同步容量预检查**：`popup.js` 校验字段 JSON 序列化后 UTF-8 大小，超 8192 字节停止提交并提示错误。为什么：阻止同步存储配额失败被忽略。
3. **不可信姓名来源停止自动处置**：`content.js` 不再接受“完全没有可见姓名，只有 aria-label”的行；头像和姓名无法判定时返回 `null`。为什么：读错名字会引发不可逆的误移出。代价：个别 DOM 布局可能漏检。
4. **更多操作按钮完整匹配**：`content.js` 将 `more_vert` / `more_horiz` 从子字符串匹配改成完整匹配。为什么：禁止相似文本触发错误的菜单入口。
5. **批量操作的多语言拦截**：`content.js` 对英语、西语、葡语、法语、意语、德语的常见组合及部分东亚语种批量词进行防护；存在疑似批量操作时停止菜单和确认阶段的自动点击。为什么：防止“移出所有人”被当作“移出当前一人”。这是保守拦截，不保证覆盖所有语言和 Google Meet 未来文案。
6. **补充回归测试**：`security.test.cjs` 从基线 83 项增加为 **91 项**，覆盖异步不同字段保存、连续文本修改、保存错误提示、无可见姓名、头像缩写歧义、完整图标匹配、存储配额、多语言批量移出等。
7. **更新报告和使用说明**；未修改 `manifest.json` 版本或权限，也没有引入第三方依赖、远程代码或新增用户身份校验。

## 四、未擅自修改：需要开发者选择的设计问题

- **D-01（最高优先级：最终弹窗姓名校验）**：A（建议）从本次打开的参与者名单行采集当前**显示姓名**，如确认弹窗提供可可靠识别的目标姓名，强制匹配；无法验证则不确认，适用于无痕账号。B 保持当前的行引用、菜单唯一性与按钮唯一性复核（风险仍在）。需要真实会议中经过脱敏的 DOM 样本，明确无姓名弹窗如何处理；不能直接强制固定账号 ID。
- **D-02（首次默认行为）**：A（建议）仅新安装首次 `dryRun=true`，已有配置不变。B 维持首次直接自动移出（当前）。这是业务默认变化。
- **D-03（名单来源）**：A（建议）仅在能明确确认“参会者面板根节点”时自动操作，无法确认则跳过。B 维持全局列表兜底（当前），提高兼容但有误识别风险。
- **D-04（保存保证）**：A（建议）添加显式“保存并确认生效”或后台保存协调机制，按完整校验和存储回读确认；可能需要服务工作者与扩展权限/UI 变更。B 维持当前自动保存，用户必须等待“已保存”。
- **D-05（姓名同步隐私）**：A 迁移到本地存储，放弃跨设备同步（需迁移历史数据）；B 保持 `storage.sync`（当前）。

## 五、逐类漏洞核对

- **注入 / XSS**：未发现 SQL/NoSQL、Shell、路径访问等执行面；未发现 `eval`、`Function`、远程脚本。HUD `innerHTML` 是静态常量，不拼接昵称；来自姓名的显示文字通过 `textContent`，未发现可利用的 DOM XSS。
- **Web / 扩展权限**：没有任意页面网络接口、CSRF/SSRF/Open Redirect/CORS 配置，也没有 `chrome.runtime.onMessage` / `window.postMessage` 监听器。主要信任风险是会变化的 Google Meet DOM、语义选择器、自动化按钮点击。
- **上传/反序列化/Zip Slip**：运行时代码不上传或解压用户文件；发布 ZIP 检查路径及 symlink，不能包含 `../` 或绝对路径。
- **加密/TLS**：未发现自行加密、硬编码 IV/盐、TLS 禁验或服务器证书配置；本应用不处理网络连接。
- **隐私/日志**：失败日志主要记录错误码/计数；HUD 向屏幕显示缩略昵称是现有设计，屏幕共享时可能被他人看见，属于隐私取舍。
- **CI/CD**：副本无 `.github/workflows`，无法推断远端不存在未固定的 Action 或不安全的 `pull_request_target`；远端 GitHub 历史待开发者检查。

## 六、密钥与敏感文件

在代码、配置、示例、测试、文档、SVG 图标、发布文件名范围进行静态搜索，未发现可确认的 API Key、数据库密码、云 AccessKey、私钥、Bearer Token、外部 webhook 或 `.env`。项目不依赖环境变量或密钥，因此 **不创建无用途的 `.env.example`**。已有 `.gitignore` 包含 `.env`、`.env.*`（保留 `.env.example`）、私钥、证书、日志和第三方依赖目录。仓库历史不存在于本地副本，过往是否提交秘密为**待确认**。

**如果任何密钥曾经提交到 GitHub 或公开过，必须到对应平台撤销、重新生成并更新部署；只删除代码、Git 历史中的一个文件或修改 `.gitignore` 不会令已泄露密钥失效。**

## 七、构建、测试和发布检查

```bash
node --check content.js
node --check popup.js
node --check security.test.cjs
node --test security.test.cjs
python -m json.tool manifest.json >/dev/null
```

本地环境 Node `v22.16.0`，**91 项测试通过、0 失败**；项目本身无编译/打包依赖流程。打包后将额外验证 ZIP 内文件与清单、ZIP 无路径穿越/符号链接、Manifest 内部版本号 `1.0.1` 及 SHA-256。**没有真实 Chrome/Google Meet UI 端到端自动移出测试，未确认的设计项不能算已修复。**

## 八、发布建议

1. 发布前先在测试会议将**试运行开启，并确认显示“已保存”**；验证 AA 中文前后缀、英文分隔符与英文误命中；匿名/无痕参与者同样依据显示姓名而非账号。
2. 用含同名成员、主持人/联席主持人、演示内容、虚拟滚动列表的实际 Meet 页面验证。不要在生产会议第一次直接关闭试运行。
3. 用脱敏 DOM 采样确认是否能安全把“当前名单行”与“确认对话框姓名”关联；优先决策 D-01、D-03。
4. 如上传 GitHub，请在**真实远端仓库**检查 Actions、历史凭据、Release 文件及所有分支；对 CI 第三方 Actions 固定到可信 commit SHA。对于同号不同构建的 `1.0.1` 应提供 ZIP 校验值，防止误用旧包。
