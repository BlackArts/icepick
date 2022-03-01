#!/usr/bin/env node

const { Volume } = require('memfs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { install } = require('esinstall')
const { build } = require('esbuild')
const { terser } = require('rollup-plugin-terser')

const workdir = process.cwd()

async function main() {
  const pack = require(path.join(workdir, 'package.json'))

  const { importMap, stats } = await install(Object.keys(pack.dependencies), {
    rollup: {
      plugins: [terser()]
    }
  })

  console.log(importMap, stats)

  try {
    await fs.mkdir('build')
  } catch (e) { }

  const vol = Volume.fromJSON({ 'build/bundle.js': '' })
  const bundle = await vol.promises.open('build/bundle.js', 'w')
  const provides: Record<string, [string, number]> = {}
  const requires: Record<string, string> = {}
  const internal: Record<string, number> = {}

  const { outputFiles: [mod] } = await build({
    entryPoints: ['./src/index.ts'],
    bundle: true,
    external: Object.keys(pack.dependencies),
    write: false,
    minify: true,
    format: 'esm'
  })

  await bundle.write(mod.contents)
  internal['./index.js'] = mod.contents.byteLength

  for (const file of Object.keys(stats.common)) {
    const content = await fs.readFile(path.join('web_modules', file))
    const { size: start } = await bundle.stat()
    await bundle.write(content)
    const { size: end } = await bundle.stat()
    internal[`./${file}`] = end - start
  }

  for (const [name, file] of Object.entries(importMap.imports)) {
    const content = await fs.readFile(path.join('web_modules', file))
    const { size: start } = await bundle.stat()
    await bundle.write(content)
    const { size: end } = await bundle.stat()
    const version = require(path.resolve('node_modules', name, 'package.json')).version
    provides[name] = [version, end - start]
    requires[name] = pack.dependencies[name]
  }

  const meta = {
    exposes: './index.js',
    provides,
    internal,
    requires
  }

  const manifest = Buffer.from(JSON.stringify(meta, null, 2) + '}')
  const complete = await vol.promises.readFile('build/bundle.js')
  await fs.writeFile(path.join(workdir, 'bundle.js'), Buffer.concat([manifest, complete]))
}

main()
