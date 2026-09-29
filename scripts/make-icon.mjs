#!/usr/bin/env node
/**
 * Generate `assets/app.ico` — the shortcut icon.
 *
 * The ICO container is written directly (a 256×256 BGRA bitmap with an AND mask,
 * which every Windows shell reads), and the artwork is drawn with plain math, so
 * this needs no image library at build or run time.
 *
 *   node scripts/make-icon.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SIZE = 256
const root = resolve(import.meta.dirname, '..')

/** Signed distance from a point to a rounded rectangle. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const halfWidth = (right - left) / 2
  const halfHeight = (bottom - top) / 2
  const centerX = left + halfWidth
  const centerY = top + halfHeight
  const dx = Math.abs(x - centerX) - (halfWidth - radius)
  const dy = Math.abs(y - centerY) - (halfHeight - radius)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
}

/** Linear interpolation between two `[r, g, b]` colors (kept in float until the end). */
const mix = (a, b, t) => a.map((channel, index) => channel + (b[index] - channel) * t)

/**
 * Composite one sub-sample onto an RGBA sample with source-over.
 *
 * Overlapping shapes must *replace*, not add: the white bubble sits on top of the
 * blue plate, and summing their channels would overflow into a clamped mess. Each
 * sub-sample is composited independently and the 2×2 results are averaged at the
 * end, which is what gives antialiased edges without additive ghosting.
 *
 * @param {number[]} sample - `[r, g, b, a]` with `a` in 0–1; mutated in place.
 * @param {number[]} rgb - `[r, g, b]` in 0–255.
 * @param {number} alpha - coverage of this sub-sample, 0–1.
 */
function sourceOver(sample, rgb, alpha) {
  if (alpha <= 0) return
  const inv = 1 - alpha
  sample[0] = rgb[0] * alpha + sample[0] * inv
  sample[1] = rgb[1] * alpha + sample[1] * inv
  sample[2] = rgb[2] * alpha + sample[2] * inv
  sample[3] = alpha + sample[3] * inv
}

/** Clamp a coverage value that came from a signed distance. */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance))

/**
 * Render the icon as premultiplied BGRA pixels, bottom-up (BMP row order).
 *
 * Premultiplied is what a 32-bit BMP-in-ICO expects for partially transparent
 * pixels; straight alpha would fringe the antialiased edges.
 */
export function renderIcon(size = SIZE) {
  const pixels = Buffer.alloc(size * size * 4)
  const scale = size / 256
  const at = (x, y) => ((size - 1 - y) * size + x) * 4
  const top = [0x4f, 0x8b, 0xf7]
  const bottom = [0x1f, 0x4f, 0xd8]
  const white = [0xf7, 0xfa, 0xff]

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      // Antialias by supersampling the coverage of each shape.
      for (const [sx, sy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const px = (x + sx) / scale
        const py = (y + sy) / scale
        const sample = [0, 0, 0, 0]
        sourceOver(sample, mix(top, bottom, py / 256), coverage(roundedRectDistance(px, py, 8, 8, 248, 248, 56)))
        sourceOver(sample, white, coverage(roundedRectDistance(px, py, 40, 56, 216, 176, 34)))
        // The little tail that makes the bubble read as a chat bubble.
        if (px >= 66 && px <= 108 && py >= 170 && py <= 214 && py - 170 <= (px - 66) * 0.9) {
          sourceOver(sample, white, 1)
        }
        // Three dots inside the bubble.
        for (const dotX of [88, 128, 168]) {
          const distance = Math.hypot(px - dotX, py - 116)
          if (distance <= 15.5) sourceOver(sample, mix(top, bottom, py / 256), coverage(distance - 15))
        }
        red += sample[0] * sample[3]
        green += sample[1] * sample[3]
        blue += sample[2] * sample[3]
        alpha += sample[3]
      }
      const offset = at(x, y)
      // Average the sub-samples, then premultiply once: the stores below are
      // `color * alpha`, which is the representation a 32-bit ICO expects.
      const meanAlpha = alpha / 4
      const divisor = alpha === 0 ? 1 : alpha
      pixels[offset] = Math.min(255, Math.round(((blue / divisor) * meanAlpha)))
      pixels[offset + 1] = Math.min(255, Math.round(((green / divisor) * meanAlpha)))
      pixels[offset + 2] = Math.min(255, Math.round(((red / divisor) * meanAlpha)))
      pixels[offset + 3] = Math.min(255, Math.round(meanAlpha * 255))
    }
  }
  return pixels
}

/**
 * Wrap BGRA pixels in an ICO container.
 * @param {Buffer} pixels - bottom-up BGRA pixel data.
 * @param {number} size - square edge in pixels.
 * @returns {Buffer} `.ico` file bytes.
 */
export function toIco(pixels, size = SIZE) {
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // BMP height counts the mask as a second plane
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(pixels.length + mask.length, 20)

  const image = Buffer.concat([header, pixels, mask])
  const directory = Buffer.alloc(6)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size === 256 ? 0 : size, 0)
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(image.length, 8)
  entry.writeUInt32LE(6 + 16, 12)
  return Buffer.concat([directory, entry, image])
}

const target = join(root, 'assets', 'app.ico')
mkdirSync(join(root, 'assets'), { recursive: true })
const pixels = renderIcon(SIZE)
writeFileSync(target, toIco(pixels, SIZE))
console.log(`已生成图标：${target}`)
