// Run after app-icon-gen's author-icon to refresh the app integrations.
// Uses the icon skill's installed renderer; macOS iconutil produces the ICNS.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(resolve(root, '.agents/skills/app-icon-gen/scripts/package.json'))
const { Resvg } = require('@resvg/resvg-js')
const { PNG } = require('pngjs')
const delivery = resolve(root, 'assets/agent-time-icon')
const scratch = resolve(delivery, 'tmp/work')
const icons = resolve(root, 'src-tauri/icons')
const spec = JSON.parse(readFileSync(resolve(scratch, 'spec.json'), 'utf8'))
const preview = readFileSync(resolve(delivery, 'agent-time-icon.preview.svg'), 'utf8')
const render = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()
mkdirSync(icons, { recursive: true })
copyFileSync(resolve(delivery, 'agent-time-icon.preview.svg'), resolve(root, 'src/ui/icon.svg'))
writeFileSync(resolve(scratch, 'preview-64.png'), render(preview, 64))

// Template artwork is a transparent monochrome silhouette, without tiny ticks.
const mark = spec.layers.filter(layer => !['background', 'dial markers'].includes(layer.name))
  .map(layer => layer.svg.replace(/#[\da-f]{6}/gi, '#000000')).join('\n')
const tray = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="54 140 884 744">${mark}</svg>`
writeFileSync(resolve(icons, 'tray.svg'), tray)
const trayPng = render(tray, 36)
writeFileSync(resolve(icons, 'tray.png'), trayPng)
writeFileSync(resolve(icons, 'tray.rgba'), PNG.sync.read(trayPng).data)

// Apple supplies the rounded platform mask; never bundle the square source PNG.
const applePath = resolve(delivery, 'apple/macOS/Default.png')
const nativeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><image width="1024" height="1024" href="data:image/png;base64,${readFileSync(applePath).toString('base64')}"/></svg>`
// Icon Composer exports 16-bit channels. Tauri's default-window-icon decoder
// requires an 8-bit RGBA buffer, so normalize through the renderer first.
writeFileSync(resolve(icons, 'icon.png'), render(nativeSvg, 1024))
const iconset = resolve(scratch, 'AgentTime.iconset')
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(resolve(iconset, `icon_${size}x${size}.png`), render(nativeSvg, size))
  writeFileSync(resolve(iconset, `icon_${size}x${size}@2x.png`), render(nativeSvg, size * 2))
}
execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', resolve(icons, 'icon.icns'), iconset])
console.log('Refreshed sidebar/favicon SVG, monochrome tray assets, and macOS PNG/ICNS.')
