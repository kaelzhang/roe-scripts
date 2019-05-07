const path = require('path')
const {parse} = require('url')
const EE = require('events')
const log = require('util').debuglog('caviar')

const {
  isString, isNumber, isObject
} = require('core-util-is')
const e2k = require('express-to-koa')
const {serve} = require('egg-serve-static')
const mix = require('mix2')

const next = require('next')
const {
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
  PHASE_DEVELOPMENT_SERVER
} = require('next/constants')

const {Roe} = require('roe')
const {code} = require('env-to-code')

const {Lifecycle} = require('./lifecycle')
const {createError} = require('./error')
const {
  requireModule, requireConfigLoader
} = require('./utils')

const error = createError('SERVER')

const createDefinePlugin = (envKeys, wp) => {
  const {DefinePlugin} = wp
  const {runtimeValue} = DefinePlugin

  const config = {}
  envKeys.forEach(key => {
    // Uses `webpack.DefinePlugin.runtimeValue`,
    // so that the changes of process.env could take effect at runtime
    config[`process.env.${key}`] = runtimeValue(
      () => code(process.env[key])
    )
  })

  return new DefinePlugin(config)
}

const createNextMiddleware = nextApp => {
  const handler = nextApp.getRequestHandler()
  const middleware = (req, res) => {
    const {
      [e2k.CONTEXT]: ctx
    } = req

    const {
      params = {},
      url
    } = ctx

    const {
      pathname,
      query
    } = parse(url)

    const parsedUrl = {
      pathname,
      query: {
        ...query,
        ...params
      }
    }

    handler(req, res, parsedUrl)
  }

  return e2k(middleware)
}

class Server extends EE {
  constructor (options) {
    super()

    if (!isObject(options)) {
      throw error('INVALID_OPTIONS', options)
    }

    const {
      src,
      cwd,
      port,
      dev,
      configLoaderClassPath
    } = options

    if (!isString(cwd)) {
      throw error('INVALID_CWD', cwd)
    }

    this._src = src
    this._cwd = cwd
    this._port = port
    this._dev = dev

    this._ready = false

    this._appPkg = null
    this._lifecycle = null

    this._configLoaderClassPath = configLoaderClassPath
    this._configLoader = null

    this._clientEnvKeys = null
    this._nextConfig = null
    this._nextApp = null
    this._serverApp = null
    this._server = null
  }

  // Getters to override
  // Users can override the getter to specify their own App constructor
  /////////////////////////////////////////////////////////////////////
  get App () {
    return Roe
  }

  get ConfigLoader () {
    return requireConfigLoader(this._configLoaderClassPath, error)
  }
  /////////////////////////////////////////////////////////////////////

  _getAppPkg () {
    this._appPkg = require(path.join(this._cwd, 'package.json'))
  }

  _initConfigLoader () {
    this._configLoader = new this.ConfigLoader({
      server: this,
      cwd: this._cwd
    })

    this._configLoader.load()
  }

  _initLifecycle () {
    const lifecycle = this._lifecycle = new Lifecycle({
      sandbox: false,
      configLoader: this._configLoader
    })

    lifecycle.applyPlugins()

    lifecycle.hooks.start.call({
      cwd: this._cwd
    })
  }

  // Initialize env
  async _initEnv () {
    const {
      envs,
      clientEnvKeys
    } = this._configLoader.env

    // Do not override existing env keys
    mix(process.env, envs, false)

    // clientEnvKeys is a Set
    this._clientEnvKeys = [...clientEnvKeys.keys()]

    const lifecycle = this._lifecycle
    const {environment} = lifecycle.hooks
    const cwd = this._cwd

    // No taps added to environment hook
    if (!environment.isUsed()) {
      // We also need to call the hook to enable the next hook
      await environment.promise({cwd})
      return
    }

    lifecycle.clearPlugins()

    await environment.promise({cwd})

    lifecycle.reloadConfig()
    lifecycle.applyPlugins()
  }

  // Create real configurations for each component
  _createNextConfig (phase) {
    const {
      next: nextConfigFactory,
      webpack: webpackConfigFactory,
      webpackModule
    } = this._configLoader
    const cwd = this._cwd

    const nextConfig = nextConfigFactory(
      phase,
      // Just pass an empty string, but in next it passes `{defaultConfig}`
      {}
    )

    const webpack = (nextWebpackConfig, options) => {
      let config = webpackConfigFactory(
        nextWebpackConfig,
        options,
        // Populate the webpack which caviar uses,
        webpackModule
      )

      const definePlugin = createDefinePlugin(
        this._clientEnvKeys,
        webpackModule
      )
      config.plugins.push(definePlugin)

      if (nextConfig.webpack) {
        config = nextConfig.webpack(config, options)
      }

      this._lifecycle.hooks.webpackConfig.call(config, {
        isServer: options.isServer,
        cwd
      })

      return config
    }

    const enrichedNextConfig = {
      ...nextConfig,
      webpack
    }

    if (!isString(enrichedNextConfig.distDir)) {
      enrichedNextConfig.distDir = '.next'
    }

    this._lifecycle.hooks.nextConfig.call(enrichedNextConfig, {
      cwd
    })

    return enrichedNextConfig
  }

  async _nextBuild () {
    if (this._dev) {
      return
    }

    await requireModule('next/dist/build')(
      this._cwd,
      this._createNextConfig(PHASE_PRODUCTION_BUILD)
    )
  }

  async _createNextApp () {
    log('create next app')

    const conf = this._nextConfig = this._createNextConfig(
      this._dev
        ? PHASE_DEVELOPMENT_SERVER
        : PHASE_PRODUCTION_SERVER
    )

    const app = this._nextApp = next({
      // TODO
      dev: this._dev,
      conf,
      dir: this._src || this._cwd
    })

    await app.prepare()
  }

  _createServerApp () {
    log('create server app')

    const baseDir = this._cwd
    const {
      server: serverConfigFactory
    } = this._configLoader

    const app = this._serverApp = new this.App({
      // framework,
      baseDir,
      https: false,
      title: this._appPkg.name,
      type: 'application',
      extends: {
        next: this._nextApp
      },
      config: appInfo => {
        const serverConfig = serverConfigFactory(appInfo)
        this._lifecycle.hooks.serverConfig.call(serverConfig, {
          cwd: this._cwd
        })
        return serverConfig
      }
    })

    return new Promise((resolve, reject) => {
      app.ready(err => {
        if (err) {
          reject(err)
          return
        }

        log('server app got ready')
        resolve()
      })
    })
  }

  _createServer () {
    log('create server app')

    const server = require('http').createServer(this.callback())

    server.on('error', err => {
      this.emit('error', err)
    })

    this._serverApp.emit('server', server)

    return server
  }

  _applyNextHandler () {
    if (this._dev) {
      this._applyDevNextHandler()
      return
    }

    this._applyProdNextHandler()
  }

  _applyDevNextHandler () {
    log('apply dev next handler')

    const middleware = createNextMiddleware(this._nextApp)

    // Before this, all routers has been registered,
    // so it is safe to register a middleware which contains no koa `next()`
    this._serverApp.use(middleware)
  }

  _applyProdNextHandler () {
    const app = this._serverApp
    const maxAge = this._configLoader.prop('staticFileMaxAge', 0)
    const {
      distDir
    } = this._nextConfig

    const options = {
      maxAge
    }

    // TODO: no hard coding
    serve(app, '/static', this._resolve('static'), options)

    // TODO: no hard coding
    serve(app, '/_next/static', this._resolve(distDir, 'static'), options)
  }

  _resolve (...args) {
    return path.join(this._cwd, ...args)
  }

  get server () {
    if (this._server) {
      return this._server
    }

    return this._server = this._createServer()
  }

  get port () {
    return this._port
  }

  get srcDir () {
    return this._src
  }

  async ready () {
    this._getAppPkg()
    this._initConfigLoader()
    this._initLifecycle()
    await this._initEnv()
    await this._nextBuild()
    await this._createNextApp()
    await this._createServerApp()
    this._applyNextHandler()

    this._ready = true
    return this
  }

  callback () {
    if (!this._ready) {
      throw error('NOT_READY')
    }

    return this._serverApp.callback()
  }

  listen (port) {
    const realPort = port
      || this._port
      || this._configLoader && this._configLoader.prop('port')

    if (!isNumber(realPort)) {
      throw error('INVALID_PORT', realPort)
    }

    this._port = realPort

    return new Promise(resolve => {
      this.server.listen(realPort, resolve)
    })
  }
}

module.exports = Server
