const {
  SyncHook
} = require('tapable')
const {
  joinEnvPaths
} = require('./utils')
const CaviarBase = require('./base/caviar')
const {
  FRIEND_RUN,
  IS_NOT_SANDBOX_PLUGIN
} = require('./constants')

module.exports = class Caviar extends CaviarBase {
  constructor (options) {
    super(options, {
      start: new SyncHook(),
      afterPlugins: new SyncHook(['caviar'])
    })

    // Apply NODE_PATH before configLoader.load
    if (!process.env.CAVIAR_SANDBOX) {
      // If caviar is runned without sandbox
      this._applyNodePaths()
    }
  }

  _applyNodePaths () {
    const {NODE_PATH} = process.env
    process.env.NODE_PATH = joinEnvPaths(NODE_PATH, this._config.getNodePaths())
  }

  async _run (phase) {
    this._applyPlugins(IS_NOT_SANDBOX_PLUGIN)

    const hooks = this._hooksManager.getHooks()
    hooks.start.call()

    const Mixer = this._caviarConfig.bailBottom('mixer')

    const binder = new Mixer({
      ...this._options,
      configLoader: this._config,
      hooksManager: this._hooksManager
    })

    await binder[FRIEND_RUN](phase)
  }
}
