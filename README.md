# dsh-browser-control

让模型像 ZCode 那样操作 Harness **内置侧边浏览器**（右栏 Browser 标签页）。

三件事决定了它和"会点 DOM 的自动化"的区别：

1. **观察是无障碍树快照**，不是"页面上前 N 个链接"。页内代理计算隐式/显式 ARIA role、可访问名与状态，渲染成一棵紧凑的缩进树——这棵树是构造定位器的唯一依据。
2. **每个 `ref` 绑定真实元素**，后续动作针对"确实被观察到的元素"，而不是猜出来的选择器。
3. **输入是受信任的**：点击和按键走 `sendInputEvent`，在元素的真实视口坐标上触发，不是 `el.click()`。

## 安装

```bash
# 插件管理器，参数为本地包目录的绝对路径
plugin_manager install_bundle /绝对路径/dsh-browser-control
```

安装后**刷新 Harness 页面**，让 Client 半加载。工具随即出现在模型工具表中。

## 工具

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 打开页面或导航已有标签页；`mode: "same-site"` 复用同域标签页 |
| `browser_tabs` | 列出本会话的浏览器标签页（URL、标题、加载状态、是否挂载） |
| `browser_close` | 关闭一个标签页 |
| `browser_nav` | back / forward / reload / stop |
| `browser_snapshot` | **无障碍树**，每行一个节点：role、可访问名、状态、`ref` |
| `browser_locator` | 只检查定位器：匹配几个、分别是什么；用于确认存在与读取当前状态 |
| `browser_act` | **一次一个**改状态动作：click / dblclick / hover / fill / type / press / select / check / uncheck / focus / scroll |
| `browser_read` | 读可见文本：整页或某个元素 |
| `browser_wait` | 等待定位器状态、可见文本、URL、加载状态 |
| `browser_console` | 读取 console、未捕获错误、页面尝试弹出的原生对话框 |
| `browser_screenshot` | 真实截图，作为图片返回 |

### 一次观察只做一个动作

`browser_act` 只执行一个动作，然后返回结果。下一步必须先再观察：`browser_locator` 查单个元素最便宜，需要新的定位依据时才 `browser_snapshot`。

页面变化后旧 `ref` 会被**明确拒绝**（`stale-ref` / `detached`），不会静默点到别的元素上。

### 定位器优先级

1. `{ "ref": "e12" }` —— 精确，来自最新快照
2. `{ "role": "button", "name": "保存" }` —— 页面自述
3. `{ "testid": "submit-order" }` —— 有测试 id 时最稳
4. `{ "label": "邮箱" }` / `{ "placeholder": "搜索" }` —— 表单字段
5. `{ "css": "..." }` —— 兜底，仅在树里确实没有可用 role/name 时

匹配到多个元素会**报错并要求收紧定位**，而不是让你用 `nth` 猜位置。

### 快照长什么样

```
- navigation "Main" [ref=e1]
  - link "Home" [href=/home] [ref=e2]
- heading "Products" [level=2] [ref=e4]
- region "Filters" [ref=e5]
  - textbox "Search products" [placeholder="Type to search"] [ref=e6]
  - combobox "Red" [value="red"] [options=*"red"|"green"] [ref=e8]
  - checkbox "In stock only" [unchecked] [ref=e9]
  - button "Apply" [testid="apply"] [ref=e10]
  - button "Sold out" [disabled] [ref=e17]
```

隐藏元素（`display:none`、`visibility:hidden`、`aria-hidden`、`inert`、`hidden`）不会出现；可滚动容器单独列出，并给出各自的 `ref`。

## 它怎么工作

```
模型 → browser_* 工具（Host 半）
        ↓ Connection RPC 长轮询
      Client 半（页面内）→ 右栏 Browser 的 <webview> → 页内代理
        ↑ 结果（含截图字节）
      回传 → 附件服务存图 → 以 image 内容块返回模型
```

- **Connection RPC 是单向的**（浏览器 → Host），所以 Host 排队、Client 半长轮询取走执行再回传。
- **命令按 Session 隔离**：一条命令只会交给为该 Session 服务的轮询者。
- **目标定位**用内置浏览器自己发布的公开标记（`data-sidebar-right-tab` / `webview[data-sidebar-browser-frame]`）加 `ctx.sidebarRight.openTabs` 元数据，不是"页面上第一个 webview"。
- **每次调用都重新解析目标**，因此导航、重载、重新停靠都不会留下失效句柄。

## 已知限制

- **不是 CDP**。插件只能拿到 `<webview>` 元素（`executeJavaScript` / `sendInputEvent` / `capturePage`），因此没有后台标签页、没有网络拦截、没有无头模式。
- **截图要求 Harness 窗口可见**。窗口不可见时 Chromium 不产生合成帧，`capturePage` 不返回；插件会快速失败并说明原因。
- **不支持文件上传与下载**；本地文件与 `file:` 页面被拒（那是 Document Preview 的职责）。
- **原生对话框被拒绝**：`alert` / `confirm` / `prompt` 会被记录到 `browser_console`，并以安全默认值应答，不会挂住流程。
- **只接受 http/https**，禁止内嵌凭据，禁止指向 Harness 自身地址。
- 页面内容一律视为**不可信数据**：工具描述、提示段与运行时 skill 都明确了这一点。

## 源码

- `index.js` — Host 半：工具注册、命令代理、截图落盘、提示段、`sidebar-browser` skill
- `client.js` — Client 半：标签页定位、页内 ARIA 代理、受信任输入、截图
- `cordis.patch.yml` — 装载单行插件
- `locale/*.json` — 插件管理器显示用的标题与描述
- `test/agent.smoke.mjs` — 页内代理的 jsdom 冒烟测试（角色、可访问名、定位器、动作、等待、日志捕获）

## 开发

```bash
# 页内代理冒烟测试，需要 jsdom
node test/agent.smoke.mjs
```

改完 `index.js` / `client.js` 后：插件管理器里移除再安装，然后刷新 Harness 页面。

## License

MIT
