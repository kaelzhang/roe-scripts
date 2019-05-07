const path = require('path')
const log = require('util').debuglog('caviar')
const {isString, isObject} = require('core-util-is')
const spawn = require('cross-spawn')

const {createError} = require('./error')
const {Lifecycle} = require('./lifecycle')
const {requireConfigLoader, joinEnvPaths} = require('./utils')

const error = createError('SANDBOX')

const ESSENTIAL_ENV_KEYS = [
  // For util.debug
  'NODE_DEBUG',
  // For userland debug module
  'DEBUG',
  // For `child_process.spawn`ers
  'PATH'
]

// Private env keys used by roe,
// which should not be changed by env plugins
const PRIVATE_ENV_KEYS = [
  'CAVIAR_CWD',
  'CAVIAR_DEV'
]

const createSetEnv = host => (key, value) => {
  if (value !== undefined) {
    host[key] = value
  }
}

const createInheritEnv = set => key => {
  if (PRIVATE_ENV_KEYS.includes(key)) {
    throw error('PRESERVED_ENV_KEY', key)
  }

  set(key, process.env[key])
}

const ensureEnv = inheritEnv => {
  ESSENTIAL_ENV_KEYS.forEach(inheritEnv)
}

// Sanitize and inject new environment variables into
// the child process
module.exports = class Sandbox {
  constructor (options) {
    if (!isObject(options)) {
      throw error('INVALID_OPTIONS', options)
    }

    const {
      serverClassPath = path.join(__dirname, 'server.js'),
      configLoaderClassPath = path.join(__dirname, 'config-loader.js'),
      src,
      cwd,
      dev,
      port,
      stdio = 'inherit'
    } = options

    if (!isString(serverClassPath)) {
      throw error('INVALID_SERVER_CLASS_PATH', serverClassPath)
    }

    if (!isString(cwd)) {
      throw error('INVALID_CWD', cwd)
    }

    if (!isString(src)) {
      throw error('INVALID_SRC', src)
    }

    this._options = {
      serverClassPath,
      configLoaderClassPath,
      src,
      cwd,
      dev: !!dev,
      port,
    }

    this._stdio = stdio

    this._configLoader = new this.ConfigLoader({
      cwd
    })

    this._configLoader.load()
  }

  get spawner () {
    return path.join(__dirname, '..', 'spawner', 'start.js')
  }

  get ConfigLoader () {
    return requireConfigLoader(
      this._options.configLoaderClassPath, error)
  }

  // ## Usage
  // ```js
  // const env = new Env({
  //   cwd,
  //   env: envConverter
  // })

  // const child = await env.spawn(command, args)
  // child.on('')
  // ```
  async spawn (command, args, options = {}) {
    if (!options.stdio) {
      options.stdio = this._stdio
    }

    const {cwd} = this._options

    options.env = {
      ...this._env,
      CAVIAR_CWD: cwd
    }

    const {dev} = this._options

    if (dev) {
      options.env.CAVIAR_DEV = true
    }

    const setEnv = createSetEnv(options.env)
    const inheritEnv = createInheritEnv(setEnv)

    ensureEnv(inheritEnv)

    // TODO: a better solution
    // Just a workaround that webpack fails to compile babeled modules
    // which depends on @babel/runtime-corejs2
    options.env.NODE_PATH = joinEnvPaths(
      process.env.NODE_PATH,
      ...this._configLoader.getNodePaths()
    )

    const lifecycle = new Lifecycle({
      sandbox: true,
      configLoader: this._configLoader
    })

    lifecycle.applyPlugins()

    const sandbox = {
      inheritEnv,
      setEnv
    }

    // Apply sandbox env plugins
    await lifecycle.hooks.sandboxEnvironment.promise(sandbox, {
      cwd
    })

    log('spawn: %s %j', command, args)

    return spawn(command, args, options)
  }

  start (options) {
    const command = 'node'

    // TODO: child process events
    return this.spawn(
      command, [
        this.spawner,
        JSON.stringify(this._options)
      ],
      options
    )
  }
}
