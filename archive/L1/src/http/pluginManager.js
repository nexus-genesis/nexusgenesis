import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_LIFECYCLE_HOOKS = [
  'onInit',
  'onReady',
  'onShutdown',
  'onBlockProduced',
  'onTransactionReceived',
  'onAgentRegistered',
  'onAgentUnregistered',
  'onTaskCreated',
  'onTaskCompleted',
  'onError'
];

class PluginManager {
  constructor(options = {}) {
    this.plugins = new Map();
    this.hooks = new Map();
    this.pluginsDir = options.pluginsDir || path.join(__dirname, '../../plugins');
    this.autoLoad = options.autoLoad !== false;
    this.config = options.config || {};
    this.status = 'initialized';

    for (const hook of PLUGIN_LIFECYCLE_HOOKS) {
      this.hooks.set(hook, new Map());
    }
  }

  async register(plugin) {
    if (!plugin.name || !plugin.version) {
      throw new Error('Plugin must have name and version');
    }

    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    plugin.status = 'registered';
    plugin.registeredAt = Date.now();
    plugin.dependencies = plugin.dependencies || [];
    plugin.hooks = plugin.hooks || [];

    for (const dep of plugin.dependencies) {
      if (!this.plugins.has(dep)) {
        throw new Error(`Plugin "${plugin.name}" depends on "${dep}" which is not registered`);
      }
      const depPlugin = this.plugins.get(dep);
      if (depPlugin.status !== 'active') {
        throw new Error(`Plugin "${plugin.name}" depends on "${dep}" which is not active (status: ${depPlugin.status})`);
      }
    }

    for (const [hookName, handler] of Object.entries(plugin.hooks || {})) {
      if (!this.hooks.has(hookName)) {
        throw new Error(`Unknown hook: "${hookName}"`);
      }
      this.hooks.get(hookName).set(plugin.name, handler);
    }

    if (plugin.routes && typeof plugin.routes === 'function') {
      plugin.router = Router();
      plugin.routes(plugin.router);
    }

    this.plugins.set(plugin.name, plugin);

    if (plugin.onRegister) {
      await plugin.onRegister(this);
    }

    console.log(`[PluginManager] Registered plugin: ${plugin.name} v${plugin.version}`);
    return true;
  }

  async activate(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found`);
    }

    if (plugin.status === 'active') {
      return true;
    }

    await this._executeHook('onInit', name);

    plugin.status = 'active';
    plugin.activatedAt = Date.now();

    console.log(`[PluginManager] Activated plugin: ${name} v${plugin.version}`);
    return true;
  }

  async deactivate(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found`);
    }

    plugin.status = 'inactive';

    for (const [hookName, handlers] of this.hooks) {
      handlers.delete(name);
    }

    console.log(`[PluginManager] Deactivated plugin: ${name}`);
    return true;
  }

  async unregister(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found`);
    }

    await this.deactivate(name);
    this.plugins.delete(name);

    console.log(`[PluginManager] Unregistered plugin: ${name}`);
    return true;
  }

  get(name) {
    return this.plugins.get(name) || null;
  }

  getAll() {
    const result = [];
    for (const [name, plugin] of this.plugins) {
      result.push({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        status: plugin.status,
        dependencies: plugin.dependencies,
        registeredAt: plugin.registeredAt,
        activatedAt: plugin.activatedAt
      });
    }
    return result;
  }

  getRouter(name) {
    const plugin = this.plugins.get(name);
    return plugin ? plugin.router : null;
  }

  getAllRouters() {
    const routers = new Map();
    for (const [name, plugin] of this.plugins) {
      if (plugin.router && plugin.status === 'active') {
        routers.set(name, plugin.router);
      }
    }
    return routers;
  }

  async mountAllRouters(app, prefix = '/api/v1/plugins') {
    for (const [name, plugin] of this.plugins) {
      if (plugin.router && plugin.status === 'active') {
        app.use(`${prefix}/${name}`, plugin.router);
        console.log(`[PluginManager] Mounted plugin routes: ${prefix}/${name}`);
      }
    }
  }

  async _executeHook(hookName, pluginName) {
    const handlers = this.hooks.get(hookName);
    if (!handlers) return;

    const handler = handlers.get(pluginName);
    if (handler) {
      try {
        await handler(this);
      } catch (e) {
        console.error(`[PluginManager] Hook "${hookName}" failed for plugin "${pluginName}":`, e.message);
      }
    }
  }

  async executeHook(hookName, ...args) {
    const handlers = this.hooks.get(hookName);
    if (!handlers) return;

    for (const [pluginName, handler] of handlers) {
      const plugin = this.plugins.get(pluginName);
      if (plugin && plugin.status === 'active') {
        try {
          await handler(this, ...args);
        } catch (e) {
          console.error(`[PluginManager] Hook "${hookName}" error in "${pluginName}":`, e.message);
        }
      }
    }
  }

  async loadPluginFromFile(filePath) {
    try {
      const absolutePath = path.resolve(filePath);
      const pluginModule = await import(`file://${absolutePath}`);
      const plugin = pluginModule.default || pluginModule;

      if (!plugin.name) {
        throw new Error(`Plugin at "${filePath}" has no name`);
      }

      await this.register(plugin);
      await this.activate(plugin.name);

      return plugin.name;
    } catch (e) {
      console.error(`[PluginManager] Failed to load plugin from "${filePath}":`, e.message);
      return null;
    }
  }

  async autoLoadPlugins() {
    if (!this.autoLoad) return;

    const pluginsDir = this.pluginsDir;
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
      return;
    }

    const files = fs.readdirSync(pluginsDir);

    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.mjs')) {
        const filePath = path.join(pluginsDir, file);
        await this.loadPluginFromFile(filePath);
      }
    }
  }

  async shutdown() {
    this.status = 'shutting_down';

    for (const [name, plugin] of this.plugins) {
      if (plugin.status === 'active') {
        await this._executeHook('onShutdown', name);
      }
    }

    this.plugins.clear();
    this.hooks.clear();
    this.status = 'shutdown';

    console.log('[PluginManager] All plugins shut down');
  }

  createPluginManifest(name, version, config = {}) {
    return {
      name,
      version,
      description: config.description || '',
      author: config.author || '',
      license: config.license || 'MIT',
      dependencies: config.dependencies || [],
      hooks: config.hooks || {},
      routes: null,
      status: 'defined',
      registeredAt: null,
      activatedAt: null
    };
  }
}

export { PluginManager, PLUGIN_LIFECYCLE_HOOKS };
export default PluginManager;