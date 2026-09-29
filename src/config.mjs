/**
 * The bridge's configuration model: defaults, a deep merge, and validation.
 *
 * The config file is optional — every field has a working default, so a fresh
 * checkout boots by talking to a local `dsh --profile sdk` runtime.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readYamlFile } from './yaml.mjs'

/** @returns {Record<string, any>} a fresh default configuration. */
export function defaultConfig() {
  return {
    /** The DSH runtime this bridge drives over stdio JSON-RPC. */
    dsh: {
      command: 'dsh',
      args: ['--profile', 'sdk'],
      /** Empty means "use this process's working directory". */
      cwd: '',
      env: {},
      /** Session handshake route. */
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      /** How long one WeChat turn may run before the bridge gives up on it. */
      turnTimeoutMs: 600000,
      startupTimeoutMs: 180000,
    },
    onebot: {
      /** 'reverse' = the bridge dials the bot; 'forward' = the bridge accepts the bot's connection. */
      mode: 'reverse',
      url: 'ws://127.0.0.1:3001',
      accessToken: '',
      host: '127.0.0.1',
      port: 8080,
      /** WebSocket path used by `forward` mode. */
      path: '/onebot',
      /** Event path used by the bot's HTTP POST reporting (`http-post` mode). */
      postPath: '/onebot/event',
      /** HTTP endpoint of the bot's OneBot API, e.g. http://127.0.0.1:3000. Empty = send over WebSocket. */
      httpApi: '',
      reconnectDelayMs: 3000,
    },
    chat: {
      /** A fresh DSH session starts once this many characters of chat text accumulate. */
      maxSessionChars: 60000,
      /** Spare session ids kept ready so a renewal needs no handshake. 0 disables. */
      prewarmCount: 2,
      /** Optional allowlists; null means "never drop". */
      allowedUsers: null,
      allowedGroups: null,
      /** In group chats, only answer messages that @-mention the bot. */
      requireAtInGroup: true,
      /** Prefix bot replies in groups with an @ of the sender. */
      replyAtInGroup: false,
      replyToMessage: true,
      typingIndicator: true,
      /** Send a short "received, working on it" note while a turn runs. */
      ackOnBusy: true,
      maxInboundChars: 4000,
      maxReplyChars: 1500,
      /** Consecutive failures before the bridge stops replying in a group. */
      groupErrorBudget: 3,
      /** How long a group stays muted after that budget is exhausted. */
      groupCooldownMs: 300000,
    },
    /** Local browser test page (same pipeline as OneBot, no bot required). */
    web: {
      enabled: true,
      host: '127.0.0.1',
      port: 8787,
    },
    /**
     * The WeChat route (personal account).
     *
     * Everything here goes through WeChat's own iLink Bot API. Three earlier
     * routes were removed after being measured on a real machine, and they are
     * worth naming so nobody re-adds them:
     *
     *   wcferry    — a DLL injection into WeChat 3.9.12.17. Injection worked, but
     *                Tencent's server refuses to log that client in at all, so the
     *                route could never reach a usable state.
     *   uia        — UI Automation against the desktop client. WeChat 4.x draws its
     *                whole interface itself: the main window exposes three elements
     *                and no search box or message box exists to address.
     *   weixin     — simulated mouse and keyboard against 4.x. It does not fail
     *                loudly; it reported success while delivering nothing.
     *   weflow     — a third-party push stream that ships no binary and expects the
     *                operator to supply a native decryption component.
     */
    wechat: {
      /** Master switch for the whole WeChat route. */
      enabled: false,
      /** The bot account's own display names: group @-detection and self-filtering. */
      botNicknames: [],
      /** Where inbound messages come from: `ilink` (official API), `webhook`, or `none`. */
      inbound: 'ilink',
      /**
       * iLink Bot settings — WeChat's official bot API.
       *
       * A QR scan mints a bearer token, and the bot then appears in WeChat as an
       * ordinary contact you can chat with. No DLL injection, no database
       * decryption, no UI scraping.
       */
      ilink: {
        baseUrl: 'https://ilinkai.weixin.qq.com',
        /** Filled in by the QR login; empty means "read it from statePath". */
        token: '',
        /** Where the QR login stores the token. Relative paths resolve against the launch directory. */
        statePath: 'ilink-account.json',
        /** Long-poll window in milliseconds; the gateway may shorten it at runtime. */
        pollTimeoutMs: 40000,
        /**
         * How long a `context_token` stays usable. iLink only lets a bot reply to
         * someone who messaged it recently, so a token older than this counts as
         * absent and the reply fails with an actionable message instead of being
         * accepted by the gateway and then silently dropped. Set 0 to switch the
         * check off (only after measuring the real lifetime yourself).
         */
        contextTokenTtlMs: 86400000,
        /** Protocol version reported to the gateway; empty means "the built-in one". */
        clientVersion: '',
        /** Optional `SKRouteTag` header, for pinning a specific gateway route. */
        routeTag: '',
        /** Fetch images/files the gateway points at on the Tencent CDN. */
        mediaDownload: true,
        /**
         * The CDN *download* endpoint (full URL, not a bare base) that inbound
         * media is fetched from. Overridable so tests can point both directions at
         * one stub: the upload URL is derived by stripping the trailing `/download`,
         * because the official naming for this setting is a bare base while ours
         * has always been the endpoint itself.
         */
        cdnBaseUrl: '',
        /** Where downloaded media lands; empty means the OS temporary directory. */
        mediaDir: '',
        /** Refuse downloads larger than this (bytes). */
        maxBytes: 20971520,
        /** Per-download timeout in milliseconds. */
        mediaTimeoutMs: 20000,
        /**
         * Refuse to *upload* a file larger than this (bytes).
         *
         * Uploading encrypts the whole file in memory and the gateway has to accept
         * it, so this is a guard against a runaway agent attaching a multi-gigabyte
         * artifact rather than a protocol limit.
         */
        uploadMaxBytes: 20971520,
        /** Per-upload timeout in milliseconds (whole file, including the CDN POST). */
        uploadTimeoutMs: 60000,
      },
      webhook: {
        host: '127.0.0.1',
        port: 8788,
        /** Path that accepts a message POST. */
        path: '/message',
        /** Shared secret; empty means no authentication (loopback only!). */
        token: '',
      },
      /**
       * Outbound sending. Off by default so nothing reaches out until the operator
       * has actually configured a route.
       */
      sendEnabled: false,
      /** How to send: `ilink` (official API), `command`, or `http`. */
      sendStrategy: 'ilink',
      /**
       * Only the `command` and `http` strategies need this wide-id → display-name
       * map; iLink addresses the conversation directly by user id.
       */
      recipients: {},
      command: {
        /** Program to run; the recipient and text are appended as arguments. */
        command: '',
        /** Fixed arguments placed before the recipient and text. */
        args: [],
        timeoutMs: 30000,
      },
      http: {
        /** Endpoint that accepts `{ recipient, text, peerId }` as JSON. */
        url: '',
        token: '',
        timeoutMs: 30000,
      },
    },
    log: {
      level: 'info',
    },
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Recursively merge `patch` into `base`, replacing arrays wholesale.
 * @template T
 * @param {T} base - the value to merge into (mutated).
 * @param {unknown} patch - overrides.
 * @returns {T} the merged base.
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(base[key])) deepMerge(base[key], value)
    else base[key] = value
  }
  return base
}

/**
 * Load the configuration, merging a file over the defaults.
 * @param {string} [path] - explicit config path; when omitted, `./bridge.config.yaml` is used if present.
 * @returns {{ config: Record<string, any>, path: string | null }} resolved config and the file it came from.
 */
export function loadConfig(path) {
  const config = defaultConfig()
  let source = null
  if (path !== undefined && path !== '') {
    source = resolve(path)
    if (!existsSync(source)) throw new Error(`config file not found: ${source}`)
  } else {
    const fallback = resolve(process.cwd(), 'bridge.config.yaml')
    if (existsSync(fallback)) source = fallback
  }
  if (source === null) return { config: validateConfig(config), path: null }
  deepMerge(config, readYamlFile(source))
  return { config: validateConfig(migrateConfig(config)), path: source }
}

/**
 * Merge a partial configuration document onto a full one, filling any field the
 * patch omits from the defaults. Used by the desktop console, which submits only
 * the groups the operator edited.
 *
 * @param {Record<string, any>} base - the current full configuration.
 * @param {unknown} patch - the partial document.
 * @returns {Record<string, any>} a new, unvalidated configuration.
 */
export function mergeConfigFile(base, patch) {
  return deepMerge(defaultConfig(), deepMerge(structuredClone(base), patch))
}

/**
 * Bring a configuration written before the providers were split up to date.
 *
 * The WeChat route used to be WeFlow-only with a flat `weflowEnabled` flag. An
 * existing `bridge.config.yaml` must keep working, so the old keys are mapped
 * onto the new structure instead of being silently ignored.
 *
 * @param {Record<string, any>} config - merged configuration (mutated).
 * @returns {Record<string, any>} the same object.
 */
export function migrateConfig(config) {
  const wechat = config.wechat
  if (wechat === undefined || wechat === null) return config
  if (wechat.weflowEnabled !== undefined) {
    // The old flag meant "read the WeFlow push stream". WeFlow is gone, so honouring
    // it is impossible — and mapping it to 'weflow' would make validation reject the
    // whole file, leaving the service unable to start at all. 'none' (send-only) is
    // the conservative fallback: it never silently switches the operator onto a
    // route they did not ask for, and the console shows the new value.
    wechat.inbound = 'none'
    delete wechat.weflowEnabled
  }
  // Any other removed route in a stored file would fail validation the same way,
  // so unknown provider names fall back rather than taking the process down.
  if (!['ilink', 'webhook', 'none'].includes(String(wechat.inbound))) {
    wechat.inbound = 'none'
  }
  return config
}

/**
 * Validate the WeChat route, in whichever shape the operator wrote it.
 * @param {Record<string, any>} config - merged configuration.
 * @param {string[]} problems - collected problems (mutated).
 */
function validateWeChat(config, problems) {
  const wechat = config.wechat
  if (!Array.isArray(wechat.botNicknames)) problems.push('wechat.botNicknames must be an array of names')
  const inbound = String(wechat.inbound)
  if (!['ilink', 'webhook', 'none'].includes(inbound)) {
    problems.push(`wechat.inbound must be ilink / webhook / none, got "${inbound}"`)
  }
  if (inbound === 'ilink' && !/^https?:\/\//.test(String(wechat.ilink?.baseUrl ?? ''))) {
    problems.push(`wechat.ilink.baseUrl must be an http:// or https:// URL, got "${wechat.ilink?.baseUrl}"`)
  }
  if (inbound === 'webhook') {
    if (!Number.isInteger(wechat.webhook.port) || wechat.webhook.port <= 0 || wechat.webhook.port > 65535) {
      problems.push(`wechat.webhook.port must be a valid TCP port, got "${wechat.webhook.port}"`)
    }
    if (wechat.webhook.port === config.web.port) {
      problems.push('wechat.webhook.port 不能和 web.port 相同：它们是两个独立的监听端口')
    }
    if (wechat.webhook.token === '' && wechat.webhook.host !== '127.0.0.1' && wechat.webhook.host !== 'localhost') {
      // Without a token anyone who can reach the port can make the agent act.
      problems.push('wechat.webhook 监听在非本机地址却没有设置 token：任何人都能让智能体执行操作')
    }
  }
  if (wechat.sendEnabled) {
    const strategy = String(wechat.sendStrategy)
    // No nickname requirement any more. It existed so the adapter could tell its
    // own reply apart from an inbound message by display name, which only the
    // desktop routes needed: iLink tags the sender type explicitly, and the
    // `command` / `http` senders address the chat themselves.
    if (!['ilink', 'command', 'http'].includes(strategy)) {
      problems.push(`wechat.sendStrategy must be ilink / command / http, got "${strategy}"`)
    }
    if (strategy === 'command' && String(wechat.command.command).trim() === '') {
      problems.push('wechat.sendStrategy=command 需要填写 wechat.command.command')
    }
    if (strategy === 'http' && !/^https?:\/\//.test(String(wechat.http.url))) {
      problems.push('wechat.sendStrategy=http 需要填写 wechat.http.url（http:// 或 https://）')
    }
  }
}

/**
 * Reject configurations that could only fail later, at a confusing moment.
 * @param {Record<string, any>} config - merged configuration.
 * @returns {Record<string, any>} the same object.
 */
export function validateConfig(config) {
  const problems = []
  // `off` is a deliberate opt-out: run the console and chat page without any bot.
  const modes = ['reverse', 'forward', 'http-post', 'off']
  const mode = config.onebot.mode
  if (!modes.includes(mode)) problems.push(`onebot.mode must be one of ${modes.join('/')}, got "${mode}"`)
  if (mode === 'reverse' && !/^wss?:\/\//.test(String(config.onebot.url))) {
    problems.push(`onebot.url must be a ws:// or wss:// URL, got "${config.onebot.url}"`)
  }
  if (!Number.isInteger(config.onebot.port) || config.onebot.port <= 0 || config.onebot.port > 65535) {
    problems.push(`onebot.port must be a valid TCP port, got "${config.onebot.port}"`)
  }
  if (config.onebot.httpApi !== '' && !/^https?:\/\//.test(String(config.onebot.httpApi))) {
    problems.push(`onebot.httpApi must be an http:// or https:// URL, got "${config.onebot.httpApi}"`)
  }
  if (!Number.isInteger(config.web.port) || config.web.port <= 0 || config.web.port > 65535) {
    problems.push(`web.port must be a valid TCP port, got "${config.web.port}"`)
  }
  if (config.dsh.model === '') problems.push('dsh.model must not be empty')
  if (config.dsh.provider === '') problems.push('dsh.provider must not be empty')
  // The runtime rejects an unsupported effort only after spawning, so catch the
  // obvious typos here. `''` means "leave the model's own default alone".
  const efforts = ['', 'off', 'low', 'high', 'max']
  if (!efforts.includes(String(config.dsh.reasoningEffort))) {
    problems.push(
      `dsh.reasoningEffort must be one of ${efforts.filter((e) => e !== '').join('/')} ` +
        `(deepseek-flash supports off/low/high/max), got "${config.dsh.reasoningEffort}"`,
    )
  }
  if (!Number.isInteger(config.chat.prewarmCount) || config.chat.prewarmCount < 0) {
    problems.push(`chat.prewarmCount must be a non-negative integer, got "${config.chat.prewarmCount}"`)
  }
  if (config.wechat.enabled) validateWeChat(config, problems)
  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`)
  return config
}
