/**
 * dsh-lan-gateway — browser half.
 *
 * A hand-written dsh client bundle: the module system registers this factory
 * (`window.__ModuleLoader__.load`) and the Cordis Loader treats the returned
 * exports as an ordinary browser plugin (`apply` + `inject`). Plain CJS with no
 * build step, so `require` reaches only the shell's platform seed table —
 * `react`.
 *
 * It contributes one tab to Settings → Plugins. Every read and write goes to
 * the authenticated `/api/lan-gateway` Fetch route published by the host half,
 * so the panel and the gateway share one source of truth.
 *
 * @module dsh-lan-gateway/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-lan-gateway',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** The exact `/api` route the host half publishes. */
    const API_PATH = '/api/lan-gateway'
    /** Slot this tab claims inside the Plugins settings section. */
    const SLOT = 'settings.plugins.tab'
    const NS = 'lan-gateway'

    const CSS = [
      '.lg-panel{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;font-size:13px}',
      '.lg-title{margin:0;font-size:18px;font-weight:600}',
      '.lg-card{border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}',
      '.lg-card-title{font-weight:600;font-size:13px}',
      '.lg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.lg-grow{flex:1;min-width:120px}',
      '.lg-muted{color:var(--dsw-alias-label-tertiary)}',
      '.lg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.lg-input,.lg-select,.lg-textarea{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;min-width:0}',
      '.lg-textarea{min-height:88px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.lg-btn{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer}',
      '.lg-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.lg-btn:disabled{opacity:.5;cursor:default}',
      '.lg-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.lg-msg{border-radius:6px;padding:6px 8px;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word}',
      '.lg-msg-ok{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}',
      '.lg-msg-err{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}',
      '.lg-msg-warn{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}',
      '.lg-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}',
      '.lg-kv{display:grid;grid-template-columns:150px 1fr;gap:4px 10px;font-size:12px}',
      '.lg-kv-k{color:var(--dsw-alias-label-tertiary)}',
      '.lg-url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;cursor:pointer;word-break:break-all}',
      '.lg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-lan-gateway]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-lan-gateway', '')
      style.textContent = CSS
      document.head.append(style)
    }

    async function call(method, body) {
      const response = await fetch(API_PATH, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`LAN 网关接口返回了非 JSON 响应（HTTP ${String(response.status)}）`)
      }
      if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
      return payload
    }

    const MODE_TEXT = {
      lan: '仅局域网（私有地址段）',
      any: '任意 IP（任何能连到该端口的地址）',
      list: '指定 IP / 网段',
    }

    function statusDot(state) {
      return h('span', {
        className: 'lg-dot',
        style: { background: state === 'ok' ? 'var(--dsw-alias-state-success-primary)' : state === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)' },
      })
    }

    function draftOf(data) {
      const config = data?.config ?? {}
      return {
        enabled: config.enabled !== false,
        mode: config.mode ?? 'lan',
        allow: Array.isArray(config.allow) ? config.allow : [],
        listenHost: config.listenHost ?? '0.0.0.0',
        port: config.port ?? null,
        portOffset: config.portOffset ?? 1,
        maxPortScan: config.maxPortScan ?? 50,
        verbose: config.verbose === true,
        logRejected: config.logRejected !== false,
        allowText: Array.isArray(config.allow) ? config.allow.join('\n') : '',
      }
    }

    function Panel() {
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => { ensureStyle() }, [])

      const load = React.useCallback(async () => {
        try {
          const payload = await call('GET')
          setData(payload)
          setDraft(draftOf(payload))
          setError(null)
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const update = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const save = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const body = {
            enabled: draft.enabled,
            mode: draft.mode,
            allow: draft.allowText.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
            listenHost: draft.listenHost.trim(),
            port: draft.port === null || draft.port === '' ? null : Number(draft.port),
            portOffset: Number(draft.portOffset),
            maxPortScan: Number(draft.maxPortScan),
            verbose: draft.verbose,
            logRejected: draft.logRejected,
          }
          const payload = await call('POST', body)
          setData(payload)
          setDraft(draftOf(payload))
          if (payload.pending === true) {
            setNotice('已保存，网关正在按新配置重绑端口…')
            window.setTimeout(() => {
              void (async () => {
                try {
                  const fresh = await call('GET')
                  setData(fresh)
                  setDraft(draftOf(fresh))
                  setNotice('已保存并生效。')
                } catch {
                  const where = Array.isArray(payload.expected) && payload.expected.length > 0 ? payload.expected.join('  ') : '新的监听地址'
                  setNotice(`已保存。监听地址或端口已变化，请用以下地址重新打开页面：${where}`)
                }
              })()
            }, 1800)
          } else {
            setNotice('已保存并生效。')
          }
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      if (data === null) {
        return h('div', { className: 'lg-panel' }, [
          h('h2', { key: 't', className: 'lg-title' }, '局域网网关'),
          error === null
            ? h('div', { key: 'l', className: 'lg-muted' }, '读取中…')
            : h('div', { key: 'e', className: 'lg-msg lg-msg-err' }, error),
          error === null
            ? null
            : h('div', { key: 'r', className: 'lg-row' }, h('button', { type: 'button', className: 'lg-btn', onClick: () => { setError(null); void load() } }, '重试')),
        ])
      }

      const status = data.status ?? {}
      const listening = status.listening === true
      const addresses = Array.isArray(data.addresses) ? data.addresses : []

      return h('div', { className: 'lg-panel' }, [
        h('h2', { key: 'title', className: 'lg-title' }, '局域网网关'),

        // ── 状态 ──
        h('div', { key: 'status', className: 'lg-card' }, [
          h('div', { key: 'head', className: 'lg-row' }, [
            statusDot(listening ? 'ok' : 'bad'),
            h('span', { key: 'text', className: 'lg-grow' }, listening ? '正在转发' : '未在监听'),
            h('button', { key: 'refresh', type: 'button', className: 'lg-btn', onClick: () => { void load() } }, '刷新'),
          ]),
          h('div', { key: 'kv', className: 'lg-kv' }, [
            h('span', { key: 'k1', className: 'lg-kv-k' }, '上游（DSH 本体）'),
            h('span', { key: 'v1', className: 'lg-mono' }, `${data.upstream?.protocol ?? 'http:'}//${data.upstream?.authority ?? '?'}`),
            h('span', { key: 'k2', className: 'lg-kv-k' }, '网关端口'),
            h('span', { key: 'v2', className: 'lg-mono' }, status.port === undefined ? '—' : String(status.port)),
            h('span', { key: 'k3', className: 'lg-kv-k' }, '访问模式'),
            h('span', { key: 'v3' }, MODE_TEXT[status.mode] ?? String(status.mode)),
            h('span', { key: 'k4', className: 'lg-kv-k' }, '请求 / 拒绝 / 升级'),
            h('span', { key: 'v4', className: 'lg-mono' }, `${String(status.requests ?? 0)} / ${String(status.rejected ?? 0)} / ${String(status.upgrades ?? 0)}（活动 ${String(status.activeUpgrades ?? 0)}）`),
            h('span', { key: 'k5', className: 'lg-kv-k' }, '配置来源'),
            h('span', { key: 'v5', className: 'lg-mono' }, data.configFile === true ? `${data.configPath}（文件覆盖行配置）` : `${data.configPath}（尚未创建，使用行配置）`),
          ]),
          status.lastError === undefined || status.lastError === null
            ? null
            : h('div', { key: 'lastError', className: 'lg-msg lg-msg-warn' }, `最近错误：${status.lastError}`),
          Array.isArray(data.problems) && data.problems.length > 0
            ? h('div', { key: 'problems', className: 'lg-msg lg-msg-warn' }, data.problems.join('\n'))
            : null,
          addresses.length === 0
            ? null
            : h('div', { key: 'urls', className: 'lg-card' }, [
              h('div', { key: 'h', className: 'lg-card-title' }, '本机可用地址'),
              ...addresses.map((address, index) => h('div', { key: `u${String(index)}`, className: 'lg-url' }, address)),
              h('div', { key: 'hint', className: 'lg-hint' }, '远程设备打开其中一个地址即可，无需登录 token。'),
            ]),
        ]),

        // ── 访问控制 ──
        h('div', { key: 'access', className: 'lg-card' }, [
          h('div', { key: 'title', className: 'lg-card-title' }, '访问控制'),
          h('label', { key: 'enabled', className: 'lg-row' }, [
            h('input', {
              key: 'cb', type: 'checkbox', checked: draft.enabled === true,
              onChange: (event) => update({ enabled: event.target.checked }),
            }),
            h('span', { key: 't' }, '启用网关（关闭后立即停止监听，下次保存或重启后生效）'),
          ]),
          h('label', { key: 'mode', className: 'lg-row' }, [
            h('span', { key: 'k', className: 'lg-grow' }, '访问模式'),
            h('select', {
              key: 's', className: 'lg-select', value: draft.mode,
              onChange: (event) => update({ mode: event.target.value }),
            }, Object.keys(MODE_TEXT).map((value) => h('option', { key: value, value }, MODE_TEXT[value]))),
          ]),
          draft.mode === 'any'
            ? h('div', { key: 'warn', className: 'lg-msg lg-msg-warn' }, '任意 IP 模式会把 DSH 的完整控制权交给任何能连到该端口的地址。只在可信网络中打开。')
            : null,
          draft.mode === 'list'
            ? h('div', { key: 'allow', className: 'lg-row' }, [
              h('div', { key: 'box', className: 'lg-grow' }, [
                h('div', { key: 'k', className: 'lg-hint' }, '允许的 IP 或 CIDR，每行一个，例如 192.168.1.0/24 或 10.8.0.5。本机 loopback（127.0.0.1 / ::1）始终放行，避免把自己锁在外面。'),
                h('textarea', {
                  key: 't', className: 'lg-textarea', value: draft.allowText, spellCheck: false,
                  onChange: (event) => update({ allowText: event.target.value }),
                }),
              ]),
            ])
            : h('div', { key: 'modeHint', className: 'lg-hint' }, draft.mode === 'lan'
              ? '接受所有私有/本地地址：10/8、172.16/12、192.168/16、169.254/16、100.64/10、127/8，以及 IPv6 ::1、fc00::/7、fe80::/10（含 IPv4 映射写法）。'
              : '任何能连到该端口的地址都会放行。'),

          h('div', { key: 'listen', className: 'lg-row' }, [
            h('span', { key: 'k', className: 'lg-grow' }, '监听地址'),
            h('input', {
              key: 'i', className: 'lg-input', value: draft.listenHost, spellCheck: false,
              onChange: (event) => update({ listenHost: event.target.value }),
            }),
          ]),
          h('div', { key: 'ports', className: 'lg-row' }, [
            h('span', { key: 'k', className: 'lg-grow' }, '端口（留空＝DSH 端口 + 偏移）'),
            h('input', {
              key: 'i', className: 'lg-input', style: { width: '96px' }, value: draft.port === null ? '' : String(draft.port),
              inputMode: 'numeric',
              onChange: (event) => update({ port: event.target.value.trim() === '' ? null : event.target.value.replace(/[^\d]/gu, '') }),
            }),
            h('span', { key: 'k2' }, '偏移'),
            h('input', {
              key: 'o', className: 'lg-input', style: { width: '72px' }, value: String(draft.portOffset),
              inputMode: 'numeric',
              onChange: (event) => update({ portOffset: event.target.value.replace(/[^\d]/gu, '') }),
            }),
          ]),
          h('div', { key: 'scan', className: 'lg-row' }, [
            h('span', { key: 'k', className: 'lg-grow' }, '端口被占用时最多向后尝试几个'),
            h('input', {
              key: 'i', className: 'lg-input', style: { width: '72px' }, value: String(draft.maxPortScan),
              inputMode: 'numeric',
              onChange: (event) => update({ maxPortScan: event.target.value.replace(/[^\d]/gu, '') }),
            }),
          ]),
          h('div', { key: 'advanced', className: 'lg-row' }, [
            h('label', { key: 'v', className: 'lg-row' }, [
              h('input', { key: 'cb', type: 'checkbox', checked: draft.verbose === true, onChange: (event) => update({ verbose: event.target.checked }) }),
              h('span', { key: 't' }, '记录每条转发请求'),
            ]),
            h('label', { key: 'r', className: 'lg-row' }, [
              h('input', { key: 'cb', type: 'checkbox', checked: draft.logRejected === true, onChange: (event) => update({ logRejected: event.target.checked }) }),
              h('span', { key: 't' }, '记录被拒绝的 IP'),
            ]),
          ]),
          h('div', { key: 'actions', className: 'lg-row' }, [
            h('button', {
              key: 'save', type: 'button', className: 'lg-btn lg-btn-primary', disabled: busy === true,
              onClick: () => { void save() },
            }, busy === true ? '保存中…' : '保存并生效'),
            h('span', { key: 'hint', className: 'lg-hint lg-grow' }, '保存写入 $DSH_HOME/lan-gateway.json，网关会立即按新配置重绑端口。'),
          ]),
          notice === null ? null : h('div', { key: 'notice', className: 'lg-msg lg-msg-ok' }, notice),
          error === null ? null : h('div', { key: 'error', className: 'lg-msg lg-msg-err' }, error),
        ]),

        h('div', { key: 'about', className: 'lg-card' }, [
          h('div', { key: 't', className: 'lg-card-title' }, '它做了什么（以及没做什么）'),
          h('div', { key: 'body', className: 'lg-hint' }, [
            `版本 ${data.version ?? '?'}。网关只是在旁边多开一个监听端口，把请求转发给 DSH 自己的 Web 服务；`,
            '它不修改 DSH 的任何文件、不替换 BrowserAuth、也不改动 connection/webserver 的配置行。',
            '登录凭据由插件在进程内取自 Connection 服务的启动 token，再换成 DSH 自己签发的会话 cookie 注入到转发请求里，',
            '因此远程浏览器不用手动登录，而 DSH 侧的认证逻辑仍然原样生效。',
          ].join('')),
        ]),
      ])
    }

    /** Services this browser plugin needs before it can contribute a tab. */
    const inject = ['slots']

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: NS,
        order: 30,
        label: () => '局域网网关',
        locale: NS,
        inject: () => ({}),
      }, Panel))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
