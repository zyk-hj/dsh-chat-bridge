/** Small shared helpers: logging, timing, string limits, chat-text handling. */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

let currentLevel = 'info'
let sink = null
const observers = new Set()

/**
 * Subscribe to every log line regardless of the active level, for the desktop
 * console's log panel.
 * @param {(entry: { level: string, scope: string, message: string }) => void} observer - called per line.
 * @returns {() => void} unsubscribe.
 */
export function observeLogs(observer) {
  observers.add(observer)
  return () => observers.delete(observer)
}

/**
 * Configure the logger.
 * @param {keyof typeof LEVELS} level - minimum level to print.
 * @param {(entry: { level: string, message: string }) => void} [extraSink] - optional observer (used by tests).
 */
export function configureLogging(level, extraSink) {
  currentLevel = LEVELS[level] === undefined ? 'info' : level
  sink = extraSink ?? null
}

function emit(level, scope, args) {
  const text = args
    .map((value) => {
      if (value instanceof Error) return value.stack ?? value.message
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
  for (const observer of observers) {
    try {
      observer({ level, scope, message: text })
    } catch {
      // an observer must never break logging
    }
  }
  if (LEVELS[level] > LEVELS[currentLevel]) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
  sink?.({ level, scope, message: text })
}

/**
 * Create a scoped logger.
 * @param {string} scope - short subsystem name.
 */
export function createLogger(scope) {
  return {
    error: (...args) => emit('error', scope, args),
    warn: (...args) => emit('warn', scope, args),
    info: (...args) => emit('info', scope, args),
    debug: (...args) => emit('debug', scope, args),
  }
}

/** Resolve after `ms` milliseconds. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve with the promise result, or with `fallback` once `ms` elapses.
 * @template T
 * @param {Promise<T>} promise - the underlying operation.
 * @param {number} ms - timeout in milliseconds.
 * @param {T} fallback - value returned on timeout.
 */
export function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/**
 * Split long text into chunks that respect `maxLength`, preferring paragraph and
 * line boundaries so a chunk boundary never lands mid-sentence when avoidable.
 * @param {string} text - the full reply text.
 * @param {number} maxLength - maximum characters per chunk.
 * @returns {string[]} chunks, in order.
 */
export function chunkText(text, maxLength) {
  const limit = Math.max(200, maxLength)
  const normalized = String(text).replaceAll('\r\n', '\n').trim()
  if (normalized === '') return []
  const chunks = []
  let rest = normalized
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    let separator = 2
    if (cut < limit * 0.5) {
      cut = window.lastIndexOf('\n')
      separator = 1
    }
    if (cut < limit * 0.5) {
      cut = window.lastIndexOf('。')
      separator = 1
    }
    if (cut < limit * 0.5) {
      cut = window.lastIndexOf(' ')
      separator = 1
    }
    if (cut < limit * 0.5) {
      cut = limit - 1
      separator = 1
    }
    const piece = rest.slice(0, cut).trim()
    if (piece !== '') chunks.push(piece)
    rest = rest.slice(cut + separator).replace(/^\s+/, '')
  }
  if (rest.trim() !== '') chunks.push(rest.trim())
  return chunks
}

/**
 * Clamp an inbound message so one chat message cannot blow up the prompt.
 * @param {string} text - raw inbound text.
 * @param {number} maxLength - maximum characters kept.
 */
export function clampText(text, maxLength) {
  const value = String(text ?? '')
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n…[消息过长已截断]`
}

const CQ_ENTITIES = { '&amp;': '&', '&#91;': '[', '&#93;': ']', '&#44;': ',', '&quot;': '"', '&apos;': "'" }

/**
 * Decode OneBot CQ entity escapes.
 * @param {string} text - text that may contain CQ entities.
 */
export function decodeCqEntities(text) {
  return String(text ?? '').replace(/&(?:amp|#91|#93|#44|quot|apos);/g, (match) => CQ_ENTITIES[match] ?? match)
}

/**
 * Escape text so OneBot does not interpret it as a CQ code.
 * @param {string} text - plain text bound for the chat platform.
 */
export function encodeCqText(text) {
  return String(text ?? '').replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;')
}

/** Strip characters that would corrupt a single-line log record. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}
