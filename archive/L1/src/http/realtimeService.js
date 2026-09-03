import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import http from 'http';

const HEARTBEAT_INTERVAL = 30000;
const CLIENT_TIMEOUT = 60000;

class RealtimePushService {
  constructor() {
    this.wss = null;
    this.clients = new Map();
    this.channels = new Map();
    this.eventEmitter = new EventEmitter();
    this.stats = { totalConnections: 0, activeConnections: 0, messagesSent: 0, connectionsByChannel: {} };
    this._heartbeatTimer = null;
  }

  attach(serverOrPort) {
    if (this.wss) return;

    if (typeof serverOrPort === 'number') {
      const srv = http.createServer();
      srv.listen(serverOrPort);
      this.wss = new WebSocketServer({ server: srv });
    } else {
      this.wss = new WebSocketServer({ server: serverOrPort });
    }

    this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));
    this._startHeartbeat();

    return this.wss;
  }

  _handleConnection(ws, req) {
    const clientId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const subscribedChannels = new Set();

    const clientInfo = {
      id: clientId,
      ws,
      subscribedChannels,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
    };

    this.clients.set(clientId, clientInfo);
    this.stats.totalConnections++;
    this.stats.activeConnections++;

    ws.send(JSON.stringify({
      type: 'connection',
      clientId,
      message: 'Connected to NexusGenesis Realtime Service',
      timestamp: Date.now(),
      channels: this._getAvailableChannels()
    }));

    ws.on('message', (data) => this._handleMessage(clientId, data));
    ws.on('close', () => this._handleDisconnect(clientId));
    ws.on('pong', () => { clientInfo.lastHeartbeat = Date.now(); });
    ws.on('error', () => { /* ignore */ });

    this.eventEmitter.emit('clientConnected', { clientId, ip: clientInfo.ip });
  }

  _handleMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'subscribe':
          this._handleSubscribe(clientId, client, msg);
          break;
        case 'unsubscribe':
          this._handleUnsubscribe(clientId, client, msg);
          break;
        case 'ping':
          client.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        default:
          break;
      }
    } catch (e) {
      /* ignore malformed messages */
    }
  }

  _handleSubscribe(clientId, client, msg) {
    const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channel].filter(Boolean);
    const subscribed = [];
    const notFound = [];

    for (const channel of channels) {
      if (this.channels.has(channel) || this._isSystemChannel(channel)) {
        client.subscribedChannels.add(channel);
        subscribed.push(channel);

        if (!this.stats.connectionsByChannel[channel]) {
          this.stats.connectionsByChannel[channel] = 0;
        }
        this.stats.connectionsByChannel[channel]++;
      } else {
        notFound.push(channel);
      }
    }

    client.ws.send(JSON.stringify({
      type: 'subscribed',
      channels: subscribed,
      notFound,
      timestamp: Date.now()
    }));
  }

  _handleUnsubscribe(clientId, client, msg) {
    const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channel].filter(Boolean);

    for (const channel of channels) {
      client.subscribedChannels.delete(channel);
      if (this.stats.connectionsByChannel[channel]) {
        this.stats.connectionsByChannel[channel] = Math.max(0, this.stats.connectionsByChannel[channel] - 1);
      }
    }

    client.ws.send(JSON.stringify({
      type: 'unsubscribed',
      channels,
      timestamp: Date.now()
    }));
  }

  _handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    for (const channel of client.subscribedChannels) {
      if (this.stats.connectionsByChannel[channel]) {
        this.stats.connectionsByChannel[channel]--;
      }
    }

    this.clients.delete(clientId);
    this.stats.activeConnections = this.clients.size;
    this.eventEmitter.emit('clientDisconnected', { clientId });
  }

  _isSystemChannel(channel) {
    return [
      'agent.updates', 'agent.heartbeat', 'agent.task_assigned',
      'marketplace.new_listing', 'marketplace.review_added', 'marketplace.transaction',
      'system.health', 'system.alerts', 'system.metrics',
      'bridge.transfer', 'bridge.validator_change',
      'network.status', 'network.block', 'network.consensus'
    ].includes(channel);
  }

  _getAvailableChannels() {
    return {
      agent: ['agent.updates', 'agent.heartbeat', 'agent.task_assigned'],
      marketplace: ['marketplace.new_listing', 'marketplace.review_added', 'marketplace.transaction'],
      system: ['system.health', 'system.alerts', 'system.metrics'],
      bridge: ['bridge.transfer', 'bridge.validator_change'],
      network: ['network.status', 'network.block', 'network.consensus']
    };
  }

  broadcast(channel, data) {
    if (!this.wss) return 0;

    let sent = 0;
    const payload = JSON.stringify({
      channel,
      data,
      timestamp: Date.now()
    });

    for (const [, client] of this.clients) {
      if (client.subscribedChannels.has(channel) && client.ws.readyState === 1) {
        client.ws.send(payload);
        sent++;
      }
    }

    this.stats.messagesSent += sent;
    return sent;
  }

  broadcastToAll(data) {
    if (!this.wss) return 0;

    let sent = 0;
    const payload = JSON.stringify({ ...data, timestamp: Date.now() });

    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) {
        client.ws.send(payload);
        sent++;
      }
    }

    this.stats.messagesSent += sent;
    return sent;
  }

  sendToClient(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== 1) return false;

    client.ws.send(JSON.stringify({ ...data, timestamp: Date.now() }));
    this.stats.messagesSent++;
    return true;
  }

  registerChannel(channel, description = '') {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, { description, subscriberCount: 0, createdAt: Date.now() });
    }
  }

  getStats() {
    return {
      ...this.stats,
      registeredChannels: this.channels.size,
      activeConnections: this.clients.size,
      uptime: this.wss ? Date.now() - this._startTime : 0
    };
  }

  _startHeartbeat() {
    this._startTime = Date.now();
    this._heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [clientId, client] of this.clients) {
        if (now - client.lastHeartbeat > CLIENT_TIMEOUT) {
          client.ws.terminate();
          this._handleDisconnect(clientId);
        } else if (client.ws.readyState === 1) {
          client.ws.ping();
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  shutdown() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this.wss) {
      this.broadcastToAll({ type: 'shutdown', message: 'Server is shutting down' });
      for (const [, client] of this.clients) {
        client.ws.terminate();
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
  }
}

const realtimeService = new RealtimePushService();
export { RealtimePushService };
export default realtimeService;
