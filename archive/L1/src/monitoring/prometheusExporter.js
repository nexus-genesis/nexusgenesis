class Metric {
  constructor(name, help, type, labelNames = []) {
    this.name = name;
    this.help = help;
    this.type = type;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  _key(labels = {}) {
    if (Object.keys(labels).length === 0) return '__default__';
    const parts = this.labelNames.map(k => `${k}="${labels[k] || ''}"`);
    return `{${parts.join(',')}}`;
  }

  set(value, labels = {}) {
    this.values.set(this._key(labels), value);
  }

  get(labels = {}) {
    return this.values.get(this._key(labels));
  }

  inc(amount = 1, labels = {}) {
    const key = this._key(labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }

  render() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} ${this.type}`);
    for (const [key, value] of this.values) {
      if (key === '__default__') {
        lines.push(`${this.name} ${value}`);
      } else {
        lines.push(`${this.name}${key} ${value}`);
      }
    }
    return lines.join('\n');
  }
}

class PrometheusExporter {
  constructor() {
    this.metrics = new Map();
    this._registerDefaults();
  }

  _registerDefaults() {
    this.registerGauge('nexus_system_cpu_percent', 'CPU usage percentage');
    this.registerGauge('nexus_system_memory_percent', 'Memory usage percentage');
    this.registerGauge('nexus_system_disk_percent', 'Disk usage percentage');
    this.registerGauge('nexus_system_network_connections', 'Network connection count');

    this.registerGauge('nexus_blockchain_height', 'Current blockchain block height');
    this.registerGauge('nexus_blockchain_block_time_seconds', 'Time since last block in seconds');
    this.registerGauge('nexus_mempool_size', 'Mempool transaction count');
    this.registerGauge('nexus_transactions_per_block', 'Transactions in latest block');

    this.registerGauge('nexus_p2p_peer_count', 'Number of connected P2P peers');
    this.registerGauge('nexus_p2p_seed_connected', 'Whether connected to seed nodes');
    this.registerGauge('nexus_consensus_round', 'Current consensus round');
    this.registerGauge('nexus_consensus_last_block_timestamp', 'Timestamp of last consensus block');

    this.registerGauge('nexus_agent_total_count', 'Total agent count');
    this.registerGauge('nexus_agent_healthy_count', 'Healthy agent count');
    this.registerGauge('nexus_agent_unhealthy_count', 'Unhealthy agent count');
    this.registerGauge('nexus_agent_active_count', 'Active agent count');
    this.registerGauge('nexus_agent_remote_count', 'Remote agents discovered via network');
    this.registerGauge('nexus_agent_registration_rate', 'Agent registrations per minute');
    this.registerGauge('nexus_agent_average_reputation', 'Average agent reputation');

    this.registerGauge('nexus_task_total', 'Total task count');
    this.registerGauge('nexus_task_pending', 'Pending task count');
    this.registerGauge('nexus_task_completed', 'Completed task count');
    this.registerGauge('nexus_task_success_rate', 'Task success rate (0-1)');

    this.registerGauge('nexus_governance_proposal_count', 'Active governance proposal count');
    this.registerGauge('nexus_governance_vote_participation', 'Governance vote participation rate (0-1)');

    this.registerCounter('nexus_http_requests_total', 'Total HTTP requests', ['method', 'path']);
    this.registerGauge('nexus_http_request_duration_seconds', 'HTTP request duration in seconds', ['method', 'path']);
    this.registerGauge('nexus_http_success_rate', 'HTTP success rate (0-1)');
    this.registerGauge('nexus_http_error_rate', 'HTTP error rate (0-1)');

    this.registerGauge('nexus_rate_limit_triggers_total', 'Rate limit triggers');
    this.registerGauge('nexus_cache_hit_ratio', 'Cache hit ratio (0-1)');
    this.registerGauge('nexus_cache_size', 'Cache entry count');

    this.registerGauge('nexus_up', 'Node is up (1 = up, 0 = down)');
  }

  registerGauge(name, help, labelNames = []) {
    this.metrics.set(name, new Metric(name, help, 'gauge', labelNames));
  }

  registerCounter(name, help, labelNames = []) {
    this.metrics.set(name, new Metric(name, help, 'counter', labelNames));
  }

  setGauge(name, value, labels = {}) {
    const metric = this.metrics.get(name);
    if (metric) metric.set(value, labels);
  }

  incCounter(name, amount = 1, labels = {}) {
    const metric = this.metrics.get(name);
    if (metric) metric.inc(amount, labels);
  }

  updateFromSystemMonitor(monitorData) {
    if (!monitorData) return;

    this.setGauge('nexus_up', 1);

    if (monitorData.system) {
      this.setGauge('nexus_system_cpu_percent', monitorData.system.cpu || 0);
      this.setGauge('nexus_system_memory_percent', monitorData.system.memory || 0);
      this.setGauge('nexus_system_disk_percent', monitorData.system.disk || 0);
      this.setGauge('nexus_system_network_connections', monitorData.system.networkConnections || 0);
    }

    if (monitorData.blockchain) {
      this.setGauge('nexus_blockchain_height', monitorData.blockchain.height || 0);
      this.setGauge('nexus_blockchain_block_time_seconds', monitorData.blockchain.blockTime || 0);
      this.setGauge('nexus_mempool_size', monitorData.blockchain.mempoolSize || 0);
      this.setGauge('nexus_transactions_per_block', monitorData.blockchain.txPerBlock || 0);
    }

    if (monitorData.p2p) {
      this.setGauge('nexus_p2p_peer_count', monitorData.p2p.peerCount || 0);
      this.setGauge('nexus_p2p_seed_connected', monitorData.p2p.seedConnected ? 1 : 0);
    }

    if (monitorData.consensus) {
      this.setGauge('nexus_consensus_round', monitorData.consensus.round || 0);
      this.setGauge('nexus_consensus_last_block_timestamp', monitorData.consensus.lastBlockTimestamp || 0);
    }

    if (monitorData.agents) {
      this.setGauge('nexus_agent_total_count', monitorData.agents.total || 0);
      this.setGauge('nexus_agent_healthy_count', monitorData.agents.healthy || 0);
      this.setGauge('nexus_agent_unhealthy_count', monitorData.agents.unhealthy || 0);
      this.setGauge('nexus_agent_active_count', monitorData.agents.active || 0);
      this.setGauge('nexus_agent_remote_count', monitorData.agents.remote || 0);
      this.setGauge('nexus_agent_registration_rate', monitorData.agents.registrationRate || 0);
      this.setGauge('nexus_agent_average_reputation', monitorData.agents.averageReputation || 0);
    }

    if (monitorData.tasks) {
      this.setGauge('nexus_task_total', monitorData.tasks.total || 0);
      this.setGauge('nexus_task_pending', monitorData.tasks.pending || 0);
      this.setGauge('nexus_task_completed', monitorData.tasks.completed || 0);
      this.setGauge('nexus_task_success_rate', monitorData.tasks.successRate || 0);
    }

    if (monitorData.governance) {
      this.setGauge('nexus_governance_proposal_count', monitorData.governance.proposalCount || 0);
      this.setGauge('nexus_governance_vote_participation', monitorData.governance.voteParticipation || 0);
    }

    if (monitorData.http) {
      this.setGauge('nexus_http_success_rate', monitorData.http.successRate || 0);
      this.setGauge('nexus_http_error_rate', monitorData.http.errorRate || 0);
    }

    if (monitorData.rateLimiting) {
      this.setGauge('nexus_rate_limit_triggers_total', monitorData.rateLimiting.triggers || 0);
    }

    if (monitorData.cache) {
      this.setGauge('nexus_cache_hit_ratio', monitorData.cache.hitRatio || 0);
      this.setGauge('nexus_cache_size', monitorData.cache.size || 0);
    }
  }

  getMetricsText() {
    const lines = [];
    for (const metric of this.metrics.values()) {
      lines.push(metric.render());
      lines.push('');
    }
    return lines.join('\n');
  }
}

const exporter = new PrometheusExporter();
export default exporter;