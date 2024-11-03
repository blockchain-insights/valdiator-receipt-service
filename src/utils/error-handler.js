// src/utils/error-handler.js
import logger from './logger.js';

export class ServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function handleError(error, context = '') {
  logger.error(`${context}: ${error.message}`, {
    stack: error.stack,
    code: error.code
  });
  return new ServiceError(error.message, error.code);
}