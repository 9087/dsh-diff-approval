// Boot the built plugin against ONE real dsh-client-connection release.
//
// Everything version-specific comes from that release itself: the class, its
// `register`/`rpc.handle` implementation, and the connection plugin's own
// `inject` list read from the package's exports. Nothing here is copied from a
// release's source, so a new release needs no edit to this file.
//
// The transport and browser auth are the only stubs: the channel registry, its
// owner context, and service resolution are all real.
//
// Usage: node dsh-compat-boot.mjs <versionDir> <pluginLibPath> <storageDir>
// Prints one `__COMPAT__{json}` line, then exits 0 even on a boot failure — the
// orchestrator reads the JSON.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [versionDir, pluginLib, storageDir] = process.argv.slice(2)

/** Resolve a package entry from the version dir, with a path fallback. */
function resolveEntry(specifier, fallback) {
  try {
    return createRequire(join(versionDir, 'index.js')).resolve(specifier)
  } catch {
    return join(versionDir, 'node_modules', ...specifier.split('/'), fallback)
  }
}

const outcome = { activated: false, mounted: false, channel: null, error: null }

try {
  const { Context, Service } = await import(pathToFileURL(resolveEntry('@deepseek-ai/cordis', 'lib/index.js')).href)
  const connection = await import(pathToFileURL(resolveEntry('@deepseek-ai/dsh-client-connection', 'lib/index.js')).href)
  const plugin = await import(pathToFileURL(pluginLib).href)

  if (typeof connection.HostConnectionService !== 'function') throw new Error('release exports no HostConnectionService')
  if (!Array.isArray(connection.inject)) throw new Error('release exports no inject list')

  const routes = []

  // The web server is provided by its own (sibling) service plugin, exactly as
  // the real web bundle does — the topology that decides whether the connection
  // plugin's own context can reach it.
  class WebServer extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register(route) { routes.push(route.path); return () => {} }
  }
  class Credentials extends Service {
    constructor(ctx) { super(ctx, 'credentials') }
  }
  class Fs extends Service {
    constructor(ctx) { super(ctx, 'fs') }
    async readText() { return undefined }
    async resolve(path) { return { displayPath: path, targetKey: `key:${path}` } }
    async writeText() { return { version: 1 } }
    async stat() { return { version: 'v1', type: 'file' } }
    processPath(target) { return target.targetKey }
  }
  class WorkspaceRegistry extends Service {
    constructor(ctx) { super(ctx, 'workspaceRegistry') }
    list() { return [] }
  }
  class Sessions extends Service {
    constructor(ctx) { super(ctx, 'sessions') }
    get() { return undefined }
  }

  // HostConnectionService only touches browser auth while serving a request.
  const browserAuth = {
    isAuthenticated: () => true,
    authorizeIndex: () => undefined,
    authenticatedUrl: (url) => url,
  }

  const app = new Context()
  for (const ServiceClass of [WebServer, Credentials, Fs, WorkspaceRegistry, Sessions]) {
    await app.plugin(ServiceClass)
  }

  // The connection plugin, declaring its own real inject list.
  await app.plugin({
    name: 'connection',
    inject: [...connection.inject],
    apply: (ctx) => { new connection.HostConnectionService(ctx, [], browserAuth) },
  })

  // The plugin under test, mounted the way the loader does: module metadata over
  // `apply`, with the module's own real inject list.
  await app.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { storageDir })
  outcome.activated = true
  outcome.mounted = routes.includes(plugin.DIFF_APPROVAL_CHANNEL)
  outcome.channel = plugin.DIFF_APPROVAL_CHANNEL
  outcome.routes = routes

  await app.fiber.dispose()
} catch (error) {
  outcome.error = error instanceof Error ? error.message : String(error)
}

console.log(`__COMPAT__${JSON.stringify(outcome)}`)
