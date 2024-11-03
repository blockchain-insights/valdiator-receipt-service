import { v4 as uuidv4 } from 'uuid';
import dbService from './db.service.js';
import postgresService from './postgres.service.js';
import metricsService from './metrics.service.js';
import logger from '../utils/logger.js';

class SyncService {
  constructor() {
    this.isRunning = false;
    this.lastProcessedHash = null;
    this.batchSize = 100;
    this.retryLimit = 3;
    this.retryDelay = 5000;
    this.currentBatch = [];
    this.batchTimeout = null;
    this.metricsService = new MetricsService();
    
    this.setupMetricsReporting();
  }

  setupMetricsReporting() {
    this.metricsService.on('metrics', async (metrics) => {
      try {
        await postgresService.saveMetrics(metrics);
        logger.info('Metrics saved successfully');
      } catch (error) {
        logger.error('Failed to save metrics:', error);
      }
    });
  }

  async initialize() {
    try {
      await this.startSync();
      this.setupBatchProcessing();
      logger.info('Sync service initialized');
    } catch (error) {
      logger.error('Failed to initialize sync service:', error);
      throw error;
    }
  }

  setupBatchProcessing() {
    setInterval(async () => {
      if (this.currentBatch.length > 0) {
        await this.processBatch();
      }
    }, 1000); // Process batch every second if there are items
  }

  async startSync() {
    if (this.isRunning) return;
    this.isRunning = true;

    dbService.eventlog.events.on('write', async (address, entry) => {
      try {
        this.addToBatch(entry);
      } catch (error) {
        logger.error('Error processing new event:', error);
      }
    });

    await this.syncExistingEvents();
  }

  addToBatch(event) {
    this.currentBatch.push(event);
    this.metricsService.recordBatchSize(this.currentBatch.length);

    if (this.currentBatch.length >= this.batchSize) {
      this.processBatch();
    }
  }

  async processBatch() {
    if (this.currentBatch.length === 0) return;

    const batchId = uuidv4();
    const events = [...this.currentBatch];
    this.currentBatch = [];

    const startTime = Date.now();

    try {
      await postgresService.beginTransaction();

      for (const event of events) {
        await this.processEventWithRetry(event, batchId);
      }

      await postgresService.commitTransaction();
      
      const syncTime = Date.now() - startTime;
      events.forEach(event => {
        this.metricsService.recordSync(event.hash, syncTime, true);
      });

    } catch (error) {
      await postgresService.rollbackTransaction();
      logger.error(`Batch ${batchId} failed:`, error);
      
      events.forEach(event => {
        this.metricsService.recordSync(event.hash, 0, false);
      });

      // Re-add failed events to the current batch
      this.currentBatch = [...events, ...this.currentBatch];
    }
  }

  async processEventWithRetry(event, batchId, retryCount = 0) {
    try {
      const startTime = Date.now();
      await postgresService.upsertEvent({
        id: event.hash,
        data: event.payload.data,
        timestamp: event.payload.timestamp,
        batch_id: batchId,
        retry_count: retryCount
      });
      
      this.lastProcessedHash = event.hash;
      const syncTime = Date.now() - startTime;
      this.metricsService.recordSync(event.hash, syncTime, true);

    } catch (error) {
      if (retryCount < this.retryLimit) {
        this.metricsService.recordRetry(event.hash);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.processEventWithRetry(event, batchId, retryCount + 1);
      }
      throw error;
    }
  }

  async syncExistingEvents() {
    try {
      const events = await dbService.eventlog.iterator({ limit: -1 }).collect();
      logger.info(`Found ${events.length} existing events to sync`);

      // Process existing events in batches
      for (let i = 0; i < events.length; i += this.batchSize) {
        const batch = events.slice(i, i + this.batchSize);
        this.currentBatch.push(...batch);
        await this.processBatch();
      }

      logger.info('Initial sync completed');
    } catch (error) {
      logger.error('Error during initial sync:', error);
      throw error;
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.currentBatch.length > 0) {
      await this.processBatch();
    }
    await this.metricsService.reportMetrics();
  }
}