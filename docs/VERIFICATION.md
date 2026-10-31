# 验证记录

环境：`@deepseek-ai/dsh` **0.2.2-alpha.2**、Node **26.10**、Windows。

## 1. 临时 DSH 实例（端到端，26 项全过）

用独立 `DSH_HOME` 起一个 Web 实例（3099），把本插件作为 bundle 装进去冷启动，然后经网关（3100）逐项验证：

| 检查 | 结果 |
|---|---|
| 经网关取首页 | `200`，且页面里不含上游 authority（`127.0.0.1:3099`）——Host 改写没有泄漏到 HTML |
| `/api/nope`（已认证但无此路由） | `404`；未认证直连同一路径是 `401`（说明认证真的通过了） |
| 用本机局域网 IP 访问（非 loopback 源地址） | `200` |
| `list` 模式排除该局域网 IP | `403` |
| 同一 `list` 模式下 loopback | 仍 `200`（本机不会被锁死） |
| `list` 模式填 CIDR（`192.168.0.0/16`） | 放行 |
| 非法 CIDR 提交 | `400` |
| 静态资源 | `200 image/svg+xml` |
| `ws://…/api/remote.mux` | 握手成功 |
| 显式指定被占用端口（3102） | 网关回答 `pending` 后自动绑到 `3103`，新端口首页 `200` |
| 改回 `port: null` | 回到 `3100` |
| 直接编辑 `lan-gateway.json` | 1 秒内热生效（模式切换可见） |
| 监听 `::` | `http://[::1]:3050/` 返回 `200`，随后恢复 IPv4 |

## 2. 真实浏览器（headless Chrome，经网关）

- 打开网关地址 → 应用正常挂载、渲染用户真实界面，**0 个页面异常、0 条控制台错误**（含 WebSocket 连接）
- 客户端 bundle 确实在启动清单里，并由 `/plugins/??…` combo 以 `200 text/javascript` 提供
- 「设置 → 内置插件」出现本插件的标签页；面板展示的上游、端口、模式、计数与接口一致
- 在面板里把模式切到「指定 IP」并保存 → 状态立即更新、提示「已保存并生效」；切回「仅局域网」同样成功

## 3. 故障注入（"坏掉也不会拖垮 DSH"）

在同一个临时 profile 里同时放四颗雷：

- 故意写坏的 `lan-gateway.json`（非法 JSON）
- 一个 `apply` 必抛异常的第三方行（`zzz-throw`）
- 一个只写进 `dsh.profile.bundles`、根本没安装的 bundle（`zzz-missing`）
- 预先占住网关要用的前三个端口（3100 / 3101 / 3102）

结果：

```
stderr: dsh: skipping profile bundle "zzz-missing" ...
        dsh: warning: 1 entry did not activate   zzz-throw: deliberate apply failure
stdout: [lan-gateway] ...lan-gateway.json: Expected property name ...   ← 坏配置被吞掉
        [lan-gateway] listening on http://…:3103/ -> http://127.0.0.1:3099
```

- DSH 正常启动（`GET /` 返回 `401`，认证栅栏在工作）
- 网关按默认配置继续，并自动落到 **3103**（首页 `200`、`/api/nope` `404`）

结论：DSH 的普通 Loader 行是互相隔离的，行内异常不阻止启动；插件据此把异常全部吞在自己的入口里（`apply` / `handle` / `handleUpgrade` / `startGateway` / `applyConfig` / 文件 watcher / 面板路由）。

## 4. 单元与静态门禁

- `node test/unit.mjs` → `ok 88 checks`：IPv4/IPv6 解析、CIDR 匹配、`lan`/`any`/`list` 三档、IPv4 映射地址、cookie 解析、请求头改写（Host/Origin/hop-by-hop/伪造转发头）、配置合并。
- `node test/client-shape.mjs` → 客户端 bundle 只 `require('react')`，注册到 `settings.plugins.tab`，id/order/标签正确。
- `node test/client-render.mjs` → 用最小假 React 跑面板的加载态、正常态、错误态、停用态四条渲染路径。
- `node verify.mjs` → 包契约（`dsh.client` ↔ `client.js`）+ 只读不变量（禁 `globalThis`、`process.on`、环境变量赋值、`process.exit`、删除 API；只允许一处 `writeFileSync` 写自己的设置文件）。

## 5. 运行中的实例

在真实 `web` profile 上安装后（`link:` 依赖 + `dsh.profile.bundles` 一行）：

- 网关在 `0.0.0.0:3081` 监听，`/api/lan-gateway` 返回上游 `127.0.0.1:3080`
- 浏览器从局域网 IP 打开 `http://<局域网IP>:3081/`，无 token 直接进入真实界面，0 异常
- 长时间运行计数：`requests=238 / rejected=0 / upgrades=5 / errors=0`，宿主进程未重启、未崩溃
