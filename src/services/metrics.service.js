import { EventEmitter } from 'events';

class MetricsService extends EventEmitter {
  constructor() {
    super();
    this.metrics = {
      totalEvents: 0,
      syncedEvents: 0,
      failedEvents: 0,
      retryCount: 0,
      syncTimes: [],
      currentBatchSize: 0,
      lastSyncedHash: null
    };
    this.lastReportTime = Date.now();
    this.reportInterval = 60000; // 1 minute
  }

  recordSync(eventHash, syncTime, isSuccess) {
    this.metrics.totalEvents++;
    this.metrics.syncTimes.push(syncTime);
    
    if (isSuccess) {
      this.metrics.syncedEvents++;
      this.metrics.lastSyncedHash = eventHash;
    } else {
      this.metrics.failedEvents++;
    }

    this.checkAndReport();
  }

  recordRetry(eventHash) {
    this.metrics.retryCount++;
  }

  recordBatchSize(size) {
    this.metrics.currentBatchSize = size;
  }

  async checkAndReport() {
    const now = Date.now();
    if (now - this.lastReportTime >= this.reportInterval) {
      await this.reportMetrics();
      this.resetMetrics();
      this.lastReportTime = now;
    }
  }

  async reportMetrics() {
    const avgSyncTime = this.metrics.syncTimes.length > 0
      ? this.metrics.syncTimes.reduce((a, b) => a + b, 0) / this.metrics.syncTimes.length
      : 0;

    this.emit('metrics', {
      timestamp: new Date(),
      total_events: this.metrics.totalEvents,
      synced_events: this.metrics.syncedEvents,
      failed_events: this.metrics.failedEvents,
      retry_count: this.metrics.retryCount,
      avg_sync_time: avgSyncTime,
      batch_size: this.metrics.currentBatchSize,
      last_synced_hash: this.metrics.lastSyncedHash
    });
  }

  resetMetrics() {
    this.metrics.syncTimes = [];
    this.metrics.totalEvents = 0;
    this.metrics.syncedEvents = 0;
    this.metrics.failedEvents = 0;
    this.metrics.retryCount = 0;
  }
}