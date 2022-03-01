import satisfies from 'semver/functions/satisfies'
import { transform } from './transform'
import { load, promises } from './load'

interface Bundle {
  exposes: string;
  provides: Record<string, [string, number]>;
  internal: Record<string, number>;
  requires: Record<string, string>;
  offsets: Record<string, number>;
}

const vfs: Record<string, ArrayBuffer> = {}
const bundles: Record<string, Bundle> = {}
const packages: Record<string, Array<[string, PromiseLike<any>]>> = {}
const decoder = new TextDecoder()
const encoder = new TextEncoder()

function setOffsets(bundleLength: number, bundle: Bundle) {
  bundle.offsets = bundle.offsets || {}
  let i = bundleLength

  bundle.offsets[bundle.exposes] = i
  i += bundle.internal[bundle.exposes]

  for (const [name, size] of Object.entries(bundle.internal).filter(([m, _]) => m !== bundle.exposes)) {
    bundle.offsets[name] = i
    i += size
  }

  for (const [name, range] of Object.entries(bundle.provides)) {
    const [_, size] = range
    bundle.offsets[name] = i
    i += size
  }
}

async function getManifest(path: string): Promise<Bundle> {
  if (bundles[path]) {
    return bundles[path]
  }

  const controller = new AbortController()
  const signal = controller.signal
  const manifest = await fetch(path, { signal }).then(res => res.body?.getReader())

  if (!manifest) {
    throw new Error("Unable to get bundle")
  }

  let maybeJSON = ''

  return new Promise(async (resolve, reject) => {
    let run = true
    let first = false
    const blobs: Uint8Array[] = []
    let indent = 0;

    const abort = () => {
      controller.abort()
      run = false
    }

    const parse = (chunk: string) => {
      if (first && chunk[0] !== '{') {
        abort()
        return reject('Not a federated bundle')
      }

      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];
        switch (char) {
          case '{': {
            indent++
            break
          }
          case '}': {
            indent--
            break
          }
        }
        if (indent === 0) {
          maybeJSON += chunk.slice(0, i + 1)
          try {
            const json = JSON.parse(maybeJSON)
            abort();
            if (blobs.length === 1) {
              vfs[path] = blobs[0].buffer
            } else {
              const buf = new Uint8Array(blobs.reduce((acc, blob) => acc + blob.length, 0))
              let i = 0
              for (const blob of blobs) {
                let j = 0
                for (; j < blob.length; j++) {
                  buf[i + j] = blob[j]
                }
                i += j
              }
              vfs[path] = buf.buffer
            }
            const bundleLength = encoder.encode(JSON.stringify(json, null, 2)).byteLength + 1
            setOffsets(bundleLength, json)
            return resolve(json)
          } catch (e) {
            maybeJSON += chunk
            return
          }
        }
      }
    };

    while (run) {
      const { done, value } = await manifest.read()

      if (done) {
        return reject('Not a federated bundle')
      }

      if (!value) {
        return reject('Failed to parse manifest')
      }

      blobs.push(value)
      parse(decoder.decode(value))
    }
  })
}

async function decodeRange(buffer: ArrayBuffer, offset: number, size: number) {
  const chunk = new Uint8Array(buffer, offset, size)
  return decoder.decode(chunk)
}

async function getRange(path: string, offset: number, size: number): Promise<string> {
  const buffer = vfs[path]
  const end = offset + size - 1

  if (buffer && end <= buffer.byteLength) {
    return decodeRange(buffer, offset, size)
  } else {
    const res = await fetch(path, {
      method: 'GET',
      headers: {
        Range: `bytes=${offset}-${end}`
      }
    })
    switch (res.status) {
      case 206: {
        return res.text()
      }
      case 200: {
        const body = await res.arrayBuffer()
        return decodeRange(body, offset, size)
      }
      default: {
        throw new Error("Couldn't get range")
      }
    }
  }
}

async function loadFederated(path: URL | string) {
  const file = new URL(path, location.origin)
  const dir = new URL(file.pathname.split('/').slice(0, -1).join('/'), location.origin)

  let bundle: Bundle
  try {
    bundle = await getManifest(file.toString());
  } catch (e) {
    return load(path)
  }

  const { exposes, provides, internal } = bundle

  for (const [name, size] of Object.entries(internal)) {
    const origin = new URL([dir, name].join('/'), dir).toString()
    const offset = bundle.offsets[name]

    promises[origin] = {
      async then(fn: any) {
        const pending = new Promise(async (resolve) => {
          const mod = await getRange(file.toString(), offset, size)
          const transformed = transform(mod, origin)
          const exp = await (new Function('return ' + transformed))();
          resolve(exp)
        })
        promises[origin] = pending
        return pending.then(fn)
      }
    }
  }

  for (const [name, meta] of Object.entries(provides)) {
    const [version, size] = meta
    const origin = new URL([dir, name].join('/'), dir).toString()
    const offset = bundle.offsets[name]

    packages[name] = packages[name] || []
    const index = packages[name].push([version, {
      then(fn: any) {
        const pending = new Promise(async (resolve) => {
          const mod = await getRange(file.toString(), offset, size)
          const transformed = transform(mod, origin)
          const exp = await (new Function('return ' + transformed))();
          resolve(exp)
        })
        packages[name][index - 1] = [version, pending]
        return pending.then(fn)
      }
    }])

    const required = bundle.requires[name]

    promises[origin] = {
      then(fn: any) {
        for (const [version, promise] of packages[name]) {
          if (satisfies(version, required)) {
            promises[origin] = promise
            return promise.then(fn)
          }
        }
        return Promise.reject(`Unable to find valid module for ${name}`)
      }
    }
  }

  const entry = exposes.replace('./', '')
  const base = new URL(path, window.location.origin).toString()

  return load(base.split('/').slice(0, -1).concat([entry]).join('/'))
}

export default loadFederated
