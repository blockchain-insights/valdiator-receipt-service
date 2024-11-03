// src/grpc/server.js
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config/index.js';
import dbService from '../services/db.service.js';
import postgresService from '../services/postgres.service.js';
import syncService from '../services/sync.service.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROTO_PATHS = {
  eventlog: join(__dirname, '../proto/eventlog.proto'),
  postgresSync: join(__dirname, '../proto/postgres_sync.proto')
};

class EventLogServer {
  constructor() {
    this.server = new grpc.Server();
  }

  async initialize() {
    const eventlogProto = await this.loadProto(PROTO_PATHS.eventlog);
    const postgresSyncProto = await this.loadProto(PROTO_PATHS.postgresSync);

    // Event Log Service Implementation
    const eventLogHandlers = {
      addEvent: this.handleAddEvent.bind(this),
      getEvents: this.handleGetEvents.bind(this),
      getEventById: this.handleGetEventById.bind(this),
      addEventBatch: this.handleAddEventBatch.bind(this),
      getMetrics: this.handleGetMetrics.bind(this),
      streamMetrics: this.handleStreamMetrics.bind(this),
      healthCheck: this.handleHealthCheck.bind(this)
    };

    // Postgres Sync Service Implementation
    const postgresSyncHandlers = {
      getSyncStatus: this.handleGetSyncStatus.bind(this),
      triggerSync: this.handleTriggerSync.bind(this),
      pauseSyncing: this.handlePauseSyncing.bind(this),
      resumeSyncing: this.handleResumeSyncing.bind(this),
      getBatchStatus: this.handleGetBatchStatus.bind(this),
      retryBatch: this.handleRetryBatch.bind(this),
      getSyncMetrics: this.handleGetSyncMetrics.bind(this),
      streamSyncMetrics: this.handleStreamSyncMetrics.bind(this)
    };

    this.server.addService(eventlogProto.eventlog.EventLogService.service, eventLogHandlers);
    this.server.addService(postgresSyncProto.postgres_sync.PostgresSyncService.service, postgresSyncHandlers);
  }

  async loadProto(protoPath) {
    const packageDefinition = await protoLoader.load(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    return grpc.loadPackageDefinition(packageDefinition);
  }

  // EventLogService handlers
  async handleAddEvent(call, callback) {
    try {
      const event = call.request;
      const hash = await dbService.eventlog.add({
        data: event.data,
        timestamp: event.timestamp || Date.now(),
        metadata: event.metadata || {}
      });

      callback(null, {
        id: hash,
        success: true,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Error adding event:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleGetEvents(call) {
    try {
      const query = call.request;
      const options = {
        limit: query.limit || 100,
        startAfter: query.start_after,
        timeRange: {
          from: query.from_timestamp,
          to: query.to_timestamp
        },
        metadata: query.filter_metadata
      };

      const events = await dbService.eventlog.iterator(options).collect();

      for (const event of events) {
        if (this.shouldStreamEvent(event, options)) {
          call.write({
            id: event.hash,
            data: event.payload.data,
            timestamp: event.payload.timestamp,
            metadata: event.payload.metadata || {}
          });
        }
      }
      call.end();
    } catch (error) {
      logger.error('Error streaming events:', error);
      call.destroy({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleGetEventById(call, callback) {
    try {
      const eventId = call.request.id;
      const event = await dbService.eventlog.get(eventId);

      if (!event) {
        callback({
          code: grpc.status.NOT_FOUND,
          details: `Event ${eventId} not found`
        });
        return;
      }

      callback(null, {
        id: event.hash,
        data: event.payload.data,
        timestamp: event.payload.timestamp,
        metadata: event.payload.metadata || {}
      });
    } catch (error) {
      logger.error('Error getting event by id:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleAddEventBatch(call, callback) {
    try {
      const batch = call.request;
      const results = await Promise.allSettled(
        batch.events.map(event => 
          dbService.eventlog.add({
            data: event.data,
            timestamp: event.timestamp || Date.now(),
            metadata: event.metadata || {}
          })
        )
      );

      const failedIds = [];
      let processedCount = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          processedCount++;
        } else {
          failedIds.push(batch.events[index].id);
        }
      });

      callback(null, {
        batch_id: batch.batch_id,
        success: failedIds.length === 0,
        processed_count: processedCount,
        failed_ids: failedIds
      });
    } catch (error) {
      logger.error('Error processing batch:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  // PostgresSyncService handlers
  async handleGetSyncStatus(call, callback) {
    try {
      const status = await syncService.getStatus();
      callback(null, status);
    } catch (error) {
      logger.error('Error getting sync status:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleTriggerSync(call, callback) {
    try {
      const result = await syncService.trigger(call.request.force);
      callback(null, result);
    } catch (error) {
      logger.error('Error triggering sync:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handlePauseSyncing(call, callback) {
    try {
      const result = await syncService.pause(call.request.wait_for_batch);
      callback(null, result);
    } catch (error) {
      logger.error('Error pausing sync:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleResumeSyncing(call, callback) {
    try {
      const result = await syncService.resume();
      callback(null, result);
    } catch (error) {
      logger.error('Error resuming sync:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleGetBatchStatus(call, callback) {
    try {
      const status = await syncService.getBatchStatus(call.request.batch_id);
      callback(null, status);
    } catch (error) {
      logger.error('Error getting batch status:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleRetryBatch(call, callback) {
    try {
      const result = await syncService.retryBatch(
        call.request.batch_id,
        call.request.event_ids
      );
      callback(null, result);
    } catch (error) {
      logger.error('Error retrying batch:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  async handleGetSyncMetrics(call, callback) {
    try {
      const metrics = await syncService.getMetrics(
        call.request.from_timestamp,
        call.request.to_timestamp,
        call.request.metric_names
      );
      callback(null, { metrics });
    } catch (error) {
      logger.error('Error getting sync metrics:', error);
      callback({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  handleStreamMetrics(call) {
    try {
      const interval = call.request.interval_seconds * 1000;
      const metricNames = call.request.metric_names;
      
      const intervalId = setInterval(async () => {
        try {
          const metrics = await syncService.getCurrentMetrics(metricNames);
          call.write(metrics);
        } catch (error) {
          logger.error('Error streaming metrics:', error);
          call.destroy({
            code: grpc.status.INTERNAL,
            details: error.message
          });
        }
      }, interval);

      call.on('cancelled', () => {
        clearInterval(intervalId);
      });
    } catch (error) {
      logger.error('Error setting up metrics stream:', error);
      call.destroy({
        code: grpc.status.INTERNAL,
        details: error.message
      });
    }
  }

  handleHealthCheck(call, callback) {
    callback(null, {
      status: 'SERVING'
    });
  }

  shouldStreamEvent(event, options) {
    if (!event) return false;
    
    const { timeRange, metadata } = options;
    
    // Check time range
    if (timeRange) {
      const timestamp = event.payload.timestamp;
      if (timeRange.from && timestamp < timeRange.from) return false;
      if (timeRange.to && timestamp > timeRange.to) return false;
    }

    // Check metadata filters
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        if (event.payload.metadata?.[key] !== value) return false;
      }
    }

    return true;
  }

  async start() {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `${config.grpc.host}:${config.grpc.port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) {
            logger.error('Failed to start gRPC server:', error);
            reject(error);
            return;
          }
          this.server.start();
          logger.info(`gRPC server running at ${config.grpc.host}:${port}`);
          resolve(this.server);
        }
      );
    });
  }

  async stop() {
    return new Promise((resolve) => {
      this.server.tryShutdown(() => {
        logger.info('gRPC server stopped');
        resolve();
      });
    });
  }
}

// Export server instance
export const grpcServer = new EventLogServer();

// Export start function for backwards compatibility
export const startGRPCServer = () => grpcServer.start();