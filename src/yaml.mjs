/**
 * Minimal YAML subset parser — enough for the bridge's config file.
 *
 * Supports: nested block maps, block sequences, flow sequences/maps ([a, b] / {a: 1}),
 * single/double quoted strings, `true/false/null/numbers`, and `#` comments.
 * No anchors, tags, or multi-line scalars. JSON is a valid subset, so a `.json`
 * config file can be fed to the same parser.
 */

import { readFileSync } from 'node:fs'

const indentOf = (line) => line.length - line.trimStart().length
const isBlank = (line) => line.trim() === '' || line.trimStart().startsWith('#')

/** Strip a trailing comment that is not inside quotes. */
function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i += 1
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i)
    }
  }
  return text
}

/** Split a flow collection body on commas that are not nested or quoted. */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') {
        current += body[i + 1] ?? ''
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Split `key: value` at the first top-level colon. */
function splitKeyValue(text) {
  let quote = null
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ':' && depth === 0) {
      const next = text[i + 1]
      if (next === undefined || next === ' ' || next === '\t') {
        return [text.slice(0, i).trim(), text.slice(i + 1).trim()]
      }
    }
  }
  return null
}

/** Parse a scalar, flow collection, or quoted string. */
export function parseScalar(raw) {
  const text = stripComment(raw).trim()
  if (text === '') return null
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'")
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitFlow(text.slice(1, -1)).map((part) => parseScalar(part))
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const map = {}
    for (const part of splitFlow(text.slice(1, -1))) {
      const pair = splitKeyValue(part)
      if (pair === null) continue
      map[String(parseScalar(pair[0]))] = parseScalar(pair[1])
    }
    return map
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text)
  return text
}

/**
 * Parse YAML text into a plain JavaScript value.
 * @param {string} source - YAML document text.
 * @returns {unknown} the parsed document root.
 */
export function parseYaml(source) {
  const rawLines = String(source).split(/\r?\n/)
  const lines = []
  for (const line of rawLines) {
    if (isBlank(line)) continue
    lines.push({ indent: indentOf(line), text: stripComment(line).trim() })
  }

  let cursor = 0
  const peek = () => lines[cursor]
  /** Indentation at which a child block of `parentIndent` must start. */
  const childIndentOf = (parentIndent) => {
    const next = peek()
    return next === undefined ? parentIndent + 1 : next.indent
  }

  function parseBlock(indent) {
    const first = peek()
    if (first === undefined || first.indent < indent) return null
    // A flow collection written as its own child line (`env:\n  {}`), which is how
    // the serializer emits an empty map or sequence. It may sit at any depth.
    if (/^[[{]/.test(first.text)) {
      cursor += 1
      return parseScalar(first.text)
    }
    if (first.text.startsWith('- ') || first.text === '-') return parseSequence(first.indent)
    return parseMap(first.indent)
  }

  function parseSequence(indent) {
    const items = []
    while (true) {
      const line = peek()
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) throw new Error(`yaml: unexpected indentation near "${line.text}"`)
      if (!(line.text.startsWith('- ') || line.text === '-')) break
      cursor += 1
      const inline = line.text === '-' ? '' : line.text.slice(2).trim()
      if (inline === '') {
        items.push(parseBlock(indent + 1) ?? null)
        continue
      }
      const pair = splitKeyValue(inline)
      if (pair !== null) {
        // `- key: value` starts an inline map whose remaining keys are indented
        // past the dash.
        const map = {}
        const [key, value] = pair
        map[String(parseScalar(key))] = value === '' ? parseBlock(childIndentOf(indent)) ?? null : parseScalar(value)
        const nestedIndent = indent + 2
        while (true) {
          const next = peek()
          if (next === undefined || next.indent < nestedIndent) break
          if (next.text.startsWith('- ') || next.text === '-') break
          const nestedPair = splitKeyValue(next.text)
          if (nestedPair === null) break
          cursor += 1
          const [nestedKey, nestedValue] = nestedPair
          map[String(parseScalar(nestedKey))] =
            nestedValue === '' ? parseBlock(childIndentOf(next.indent)) ?? null : parseScalar(nestedValue)
        }
        items.push(map)
        continue
      }
      items.push(parseScalar(inline))
    }
    return items
  }

  /**
   * Value for a `key:` line: the inline scalar, a flow collection on the next
   * line (`env:\n  {}`), or a nested block.
   * @param {string} inline - text after the colon, already trimmed.
   * @param {number} keyIndent - indentation of the key line.
   */
  function valueFor(inline, keyIndent) {
    if (inline !== '') return parseScalar(inline)
    const next = peek()
    if (next === undefined || next.indent <= keyIndent) return null
    if (/^[[{]/.test(next.text)) {
      cursor += 1
      return parseScalar(next.text)
    }
    return parseBlock(keyIndent + 1) ?? null
  }

  function parseMap(indent) {
    const map = {}
    while (true) {
      const line = peek()
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) throw new Error(`yaml: unexpected indentation near "${line.text}"`)
      if (line.text.startsWith('- ')) break
      const pair = splitKeyValue(line.text)
      if (pair === null) throw new Error(`yaml: expected "key: value" near "${line.text}"`)
      cursor += 1
      const [key, value] = pair
      map[String(parseScalar(key))] = valueFor(value, indent)
    }
    return map
  }

  const root = parseBlock(0)
  return root === null ? {} : root
}

/**
 * Read and parse a YAML (or JSON) file.
 * @param {string} path - absolute or relative file path.
 * @returns {Record<string, unknown>} parsed document.
 */
export function readYamlFile(path) {
  const parsed = parseYaml(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config root must be a mapping: ${path}`)
  }
  return parsed
}

const PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_./@+-]*$/
/**
 * Words that stay strings.
 *
 * YAML 1.1 would read `on`/`off`/`yes`/`no` as booleans, which is a notorious
 * footgun: `mode: off` would silently become `false`. This subset keeps them as
 * strings, matching YAML 1.2 as implemented by the parser above — where only
 * `true`, `false`, and `null` are special.
 */
const RESERVED = new Set(['true', 'false', 'null', '~'])

/** Quote a string scalar unless it is unambiguous as a bare word. */
function quoteScalar(text) {
  const value = String(text)
  if (value === '') return "''"
  if (PLAIN_SAFE.test(value) && !RESERVED.has(value.toLowerCase()) && !/^\d/.test(value)) return value
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Render a JavaScript value as YAML.
 *
 * Only the subset `parseYaml` reads is emitted: block maps, block sequences, and
 * quoted scalars. Quoting is deliberately eager — a value stays bare only when
 * it is a number or a plainly safe word — so round-tripping user input can never
 * produce a document that reads back as something different.
 *
 * @param {unknown} value - the value to render.
 * @param {number} [indent] - current indentation depth.
 * @returns {string} YAML text, without a trailing newline.
 */
export function stringifyYaml(value, indent = 0) {
  const pad = '  '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return quoteScalar(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value
      .map((item) => {
        const rendered = stringifyYaml(item, indent + 1)
        if (rendered.includes('\n') || (item !== null && typeof item === 'object')) return `${pad}-\n${rendered}`
        return `${pad}- ${rendered.trimStart()}`
      })
      .join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return entries
      .map(([key, item]) => {
        const rendered = stringifyYaml(item, indent + 1)
        const nested = item !== null && typeof item === 'object' && !isInlineContainer(item)
        return nested ? `${pad}${key}:\n${rendered}` : `${pad}${key}: ${rendered}`
      })
      .join('\n')
  }
  return quoteScalar(String(value))
}

/** Empty maps and sequences render inline, so they must not be written as a child block. */
function isInlineContainer(value) {
  if (Array.isArray(value)) return value.length === 0
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0
}

/**
 * Serialize a document to YAML text ending in a newline.
 * @param {Record<string, unknown>} document - the document to render.
 * @param {string} [header] - comment block placed above the document.
 * @returns {string} file-ready YAML text.
 */
export function toYamlDocument(document, header) {
  const body = stringifyYaml(document, 0)
  const prefix = header === undefined || header === '' ? '' : `${header.replace(/\n*$/, '')}\n\n`
  return `${prefix}${body}\n`
}
