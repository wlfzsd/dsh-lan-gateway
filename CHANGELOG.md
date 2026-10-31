# 变更台账

| 日期 | 版本 | 改动 | 验证 |
|---|---|---|---|
| 2026-10-31 | 1.0.0 | 首版：旁路反向代理（默认 端口+1、占用递增）、进程内 token→会话 cookie 注入、IP 三档、设置面板、`$DSH_HOME/lan-gateway.json` 热加载 | 88 项单测；临时实例 26 项 e2e；真实浏览器经局域网地址打开真实 profile（0 异常） |
| 2026-10-31 | 1.0.0 | 隔离加固：`apply` 整体 try/catch 永不 reject；`handle` / `handleUpgrade` / `startGateway` / `applyConfig` / 文件 watcher / 面板路由各自 catch（消除 async 回调的 unhandled rejection）；单实例守卫由 `globalThis` 改为 `WeakMap`（按 `ctx.root`）；`server.on('error')` 常驻；新增 `verify.mjs` 预检与 `test/client-render.mjs` | 故障注入：坏 JSON 配置 + 必抛行 + 缺失 bundle + 端口占满 → DSH 仍启动、网关落到下一端口；加固后 26 项 e2e 复跑全过 |
| 2026-10-31 | 1.0.0 | `verify.mjs` 增加**只读不变量门禁**：禁 `globalThis.*`、`process.on(...)`、环境变量赋值、`process.exit`、任何删除 API；并断言全仓只有一处 `writeFileSync` 且目标是插件自己的设置文件 | `node verify.mjs` 全 PASS；live 实例 `/api/lan-gateway` 200 |
