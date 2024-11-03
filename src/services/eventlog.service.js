// src/services/eventlog.service.js
import { status } from '@grpc/grpc-js';
import dbService from './db.service.js';
import logger from '../utils/logger.js';

class EventLogService {
  async addEvent(call, callback) {
    try {
      const event = call.request;
      const hash = await dbService.eventlog.add({
        data: event.data,
        timestamp: event.timestamp || Date.now()
      });

      logger.info(`Event added with hash: ${hash}`);
      callback(null, { id: hash, success: true });
    } catch (error) {
      logger.error('Error adding event:', error);
      callback({
        code: status.INTERNAL,
        details: error.message
      });
    }
  }

  async getEvents(call) {
    try {
      const query = call.request;
      const limit = query.limit || 100;
      const events = await dbService.eventlog.iterator({ limit }).collect();

      for (const event of events) {
        call.write({
          id: event.hash,
          data: event.payload.data,
          timestamp: event.payload.timestamp
        });
      }
      call.end();
    } catch (error) {
      logger.error('Error getting events:', error);
      call.destroy({
        code: status.INTERNAL,
        details: error.message
      });
    }
  }
}

export default new EventLogService();