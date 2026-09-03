/**
 * NexusGenesis - Error Handler
 * 
 * errorProcessing工具, 提供统一的errorProcessing和Logging
 */

// Error type
export const ERROR_TYPES = {
  VALIDATION: 'validation_error',
  NOT_FOUND: 'not_found',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INTERNAL: 'internal_error',
  NETWORK: 'network_error'
};

// errorstatus码映射
const ERROR_STATUS_CODES = {
  [ERROR_TYPES.VALIDATION]: 400,
  [ERROR_TYPES.NOT_FOUND]: 404,
  [ERROR_TYPES.UNAUTHORIZED]: 401,
  [ERROR_TYPES.FORBIDDEN]: 403,
  [ERROR_TYPES.INTERNAL]: 500,
  [ERROR_TYPES.NETWORK]: 503
};

// error日志级别
const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug'
};

// 记录error日志
function logError(error, context = {}) {
  const timestamp = new Date().toISOString();
  const logMessage = {
    timestamp,
    level: LOG_LEVELS.ERROR,
    error: {
      message: error.message,
      type: error.type || ERROR_TYPES.INTERNAL,
      stack: error.stack,
      details: error.details
    },
    context
  };
  
  console.error(JSON.stringify(logMessage, null, 2));
  
  // 这里can添加更多的日志ProcessingLogic, e.g.写入文件或Send到日志service
}

// 记录warning日志
function logWarn(message, context = {}) {
  const timestamp = new Date().toISOString();
  const logMessage = {
    timestamp,
    level: LOG_LEVELS.WARN,
    message,
    context
  };
  
  console.warn(JSON.stringify(logMessage, null, 2));
}

// 记录info日志
function logInfo(message, context = {}) {
  const timestamp = new Date().toISOString();
  const logMessage = {
    timestamp,
    level: LOG_LEVELS.INFO,
    message,
    context
  };
  
  console.log(JSON.stringify(logMessage, null, 2));
}

// Createerror对象
function createError(message, type = ERROR_TYPES.INTERNAL, details = {}) {
  const error = new Error(message);
  error.type = type;
  error.details = details;
  return error;
}

// ProcessingHTTP请求error
function handleHttpError(res, error) {
  const statusCode = ERROR_STATUS_CODES[error.type] || 500;
  const response = {
    success: false,
    error: {
      message: error.message,
      type: error.type,
      details: error.details
    }
  };
  
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

// errorrecovery机制
function attemptRecovery(error, recoveryFn) {
  try {
    return recoveryFn();
  } catch (recoveryError) {
    logError(recoveryError, { originalError: error.message });
    throw error;
  }
}

// 统一的errorProcessing中间件
function errorHandlerMiddleware(req, res, next) {
  try {
    next();
  } catch (error) {
    logError(error, { request: { method: req.method, url: req.url } });
    handleHttpError(res, error);
  }
}

export {
  logError,
  logWarn,
  logInfo,
  createError,
  handleHttpError,
  attemptRecovery,
  errorHandlerMiddleware
};