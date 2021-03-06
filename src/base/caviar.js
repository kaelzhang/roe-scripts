const {
  isArray, isString, isObject, isFunction
} = require('core-util-is')

const {
  RETURN_TRUE,

  PHASE_DEFAULT,
  IS_SANDBOX,
  IS_CHILD_PROCESS,
  CAVIAR_MESSAGE_COMPLETE,
  SANDBOX_OUTER,
  SANDBOX_INNER,

  createSymbol
} = require('../constants')
const {
  isSubClass,
  checkPlugin,
  createPluginCondition,
  joinEnvPaths,
  composeEnvs
} = require('../utils')
const {HooksManager, Hookable} = require('../base/hookable')
const {error} = require('../error')

// Symbol in constants.js -> friend method
// Symbol in current js -> private method
// _method -> protected method
// method -> public method

// We create symbols for private method keys,
// in the future we could use `#hooks` if we target caviar to node >= 12
const HOOKS = createSymbol('hooks')
const INIT_ENV = createSymbol('init-env')

const composePlugins = ({
  // key,
  prev = [],
  anchor,
  configFile
}) => {
  if (!isArray(anchor)) {
    throw error('CONFIG_LOADER_INVALID_PLUGINS', configFile, anchor)
  }

  return prev.concat(anchor)
}

const normalizeFactory = rawFactory => {
  if (isFunction(rawFactory)) {
    return rawFactory
  }

  checkPlugin(rawFactory)

  // Always normalize a plugin to a plugin factory
  return () => rawFactory
}

const normalizeCondition = (rawCondition = RETURN_TRUE) => {
  if (isFunction(rawCondition)) {
    return rawCondition
  }

  if (!isObject(rawCondition)) {
    throw error('CONFIG_LOADER_INVALID_PLUGIN_CONDITION', rawCondition)
  }

  return createPluginCondition(rawCondition)
}

// Plugin
// [Plugin | pluginFactory, conditionObject | conditionFactory]
const normalizePlugin = plugin => {
  if (!isArray(plugin)) {
    plugin = [plugin]
  }

  const [
    rawFactory,
    rawCondition
  ] = plugin

  return [
    normalizeFactory(rawFactory),
    normalizeCondition(rawCondition)
  ]
}

module.exports = class CaviarBase {
  constructor (options, hooks) {
    const {
      cwd,
      dev,
      configLoader,

      [IS_CHILD_PROCESS]: isChildProcess
    } = options

    this._options = {
      cwd,
      dev
    }
    this[IS_CHILD_PROCESS] = !!isChildProcess

    this._config = configLoader
    this._caviarConfig = configLoader.namespace('caviar')

    this[HOOKS] = hooks
    this._hooksManager = new HooksManager(hooks)
  }

  // This method could be called before `this._config.load()`
  _applyNodePaths (target) {
    if (this[IS_CHILD_PROCESS]) {
      // If caviar is runned with sandbox,
      // NODE_PATH has been already handled by outer sandbox
      return
    }

    target.NODE_PATH = joinEnvPaths(
      process.env.NODE_PATH,
      ...this._config.getNodePaths()
    )
  }

  // This method should be called after `this._config.load()`
  _applyCaviarEnv (target) {
    if (this[IS_CHILD_PROCESS]) {
      return
    }

    Object.assign(
      target,

      // caviar.env
      // which always included in the repo
      this._caviarConfig.compose({
        key: 'env',
        compose: composeEnvs
      })
    )
  }

  // @protected
  // Apply caviar plugins
  // - pluginCondition `Function(plugin): boolean` tester to determine
  //     whether the plugin should be applied
  // ```
  // interface Plugin {
  //   sandbox?: boolean
  //   apply: Function (getHooks: Function)
  // }
  // ```
  _applyPlugins (pluginCondition) {
    const plugins = this._caviarConfig.compose({
      key: 'plugins',
      compose: composePlugins
    }, [])

    const hooksManager = this._hooksManager
    const {getHooks} = hooksManager

    plugins
    .forEach(rawPlugin => {
      const [pluginFactory, condition] = normalizePlugin(rawPlugin)

      if (!condition()) {
        return
      }

      const plugin = pluginFactory()
      checkPlugin(plugin)

      if (!pluginCondition(plugin)) {
        return
      }

      const {
        constructor,
        hooks
      } = plugin

      // Handle sub hooks of a plugin
      // If the plugin is a Hookable, and has hooks,
      // then apply the proxies
      if (isSubClass(constructor, Hookable) && hooks) {
        hooksManager.applyHooks(constructor, hooks)
      }

      plugin.apply(getHooks)
    })

    return this
  }

  // @private
  // Initialize envs which are essential to caviar
  [INIT_ENV] (phase) {
    if (this[IS_SANDBOX]) {
      // The outer side of the sandbox
      process.env.CAVIAR_SANDBOX = SANDBOX_OUTER
    }

    // If the caviar instance is inside sandbox,
    // env variables below are already been defined in
    // options.env of the child process
    if (this[IS_CHILD_PROCESS]) {
      // Mark as inside the sandbox
      process.env.CAVIAR_SANDBOX = SANDBOX_INNER
      return
    }

    const {
      cwd,
      dev
    } = this._options

    // Always ensures the env variables which are essential to caviar,
    // for both sandbox and caviar
    process.env.CAVIAR_CWD = cwd

    if (dev) {
      process.env.CAVIAR_DEV = 'true'
    } else {
      // process.env.FOO = undefined
      // ->
      // console.log(process.env.FOO)  -> 'undefined'
      delete process.env.CAVIAR_DEV
    }

    process.env.CAVIAR_PHASE = phase
  }

  // @public
  async run (phase = PHASE_DEFAULT) {
    if (!isString(phase)) {
      throw error('INVALID_PHASE', phase)
    }

    this[INIT_ENV](phase)

    const ret = await this._run(phase)

    // If caviar is in a child process
    if (this[IS_CHILD_PROCESS]) {
      process.send({
        type: CAVIAR_MESSAGE_COMPLETE
      })

      return
    }

    // Caviar could run without a sandbox,
    // only monitor the parent process when the current instance is a sandbox
    if (this[IS_SANDBOX]) {
      return ret
    }
  }
}
