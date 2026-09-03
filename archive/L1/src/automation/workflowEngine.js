/**
 * NexusGenesis Automated Workflow Engine
 * Provides reliable task scheduling, error handling, and system monitoring
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import SystemMonitor from './systemMonitor.js';
import BackupManager from './backupManager.js';
import NotificationService from './notificationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Task Status常量
const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying'
};

// Error Type Constants
const ERROR_TYPES = {
  API_RATE_LIMIT: 'api_rate_limit',
  NETWORK_ERROR: 'network_error',
  VALIDATION_ERROR: 'validation_error',
  UNKNOWN_ERROR: 'unknown_error'
};

class WorkflowEngine {
  constructor() {
    this.tasks = new Map();
    this.scheduledTasks = new Map();
    this.runningTasks = new Map();
    this.retryQueue = new Map();
    this.tasksDirectory = path.join(__dirname, '../../data/workflow-tasks');
    this.logsDirectory = path.join(__dirname, '../../logs');
    this.systemMonitor = SystemMonitor.getInstance ? SystemMonitor.getInstance() : new SystemMonitor();
    this.backupManager = new BackupManager();
    this.notificationService = new NotificationService();
    this.initDirectories();
    this.loadTasks();
    this.startHeartbeat();
  }

  initDirectories() {
    // Ensure task directory exists
    if (!fs.existsSync(this.tasksDirectory)) {
      fs.mkdirSync(this.tasksDirectory, { recursive: true });
    }
    // Ensure log directory exists
    if (!fs.existsSync(this.logsDirectory)) {
      fs.mkdirSync(this.logsDirectory, { recursive: true });
    }
  }

  loadTasks() {
    if (!fs.existsSync(this.tasksDirectory)) {
      return;
    }

    const taskFiles = fs.readdirSync(this.tasksDirectory);
    taskFiles.forEach(file => {
      if (file.endsWith('.json')) {
        try {
          const taskData = JSON.parse(fs.readFileSync(path.join(this.tasksDirectory, file), 'utf8'));
          this.tasks.set(taskData.id, taskData);
          
          // 根据Task StatusrecoveryExecute
          if (taskData.status === TASK_STATUS.PENDING) {
            this.scheduleTask(taskData);
          } else if (taskData.status === TASK_STATUS.RUNNING) {
            this.retryTask(taskData.id);
          } else if (taskData.status === TASK_STATUS.RETRYING) {
            this.retryQueue.set(taskData.id, taskData);
          }
        } catch (error) {
          this.logError(`Error loading task ${file}:`, error);
        }
      }
    });
  }

  saveTask(task) {
    const taskPath = path.join(this.tasksDirectory, `workflow-task-${task.id}.json`);
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf8');
  }

  deleteTask(taskId) {
    const taskPath = path.join(this.tasksDirectory, `workflow-task-${taskId}.json`);
    if (fs.existsSync(taskPath)) {
      fs.unlinkSync(taskPath);
    }
    this.tasks.delete(taskId);
    this.scheduledTasks.delete(taskId);
    this.runningTasks.delete(taskId);
    this.retryQueue.delete(taskId);
  }

  // Create new task
  createTask(name, action, options = {}) {
    const task = {
      id: Date.now().toString(),
      name,
      action,
      status: TASK_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
      errorCount: 0,
      lastError: null,
      ...options,
      retryConfig: options.retryConfig || {
        maxRetries: 3,
        initialDelay: 60000, // 1分钟
        backoffMultiplier: 2
      }
    };

    this.tasks.set(task.id, task);
    this.saveTask(task);
    return task;
  }

  // Schedule task
  scheduleTask(task, delay = 0) {
    if (!task) return;

    const timeoutId = setTimeout(() => {
      this.executeTask(task.id);
    }, delay);

    this.scheduledTasks.set(task.id, {
      task,
      timeoutId
    });

    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return timeoutId;
  }

  // 取消Schedule task
  unscheduleTask(taskId) {
    const scheduledTask = this.scheduledTasks.get(taskId);
    if (scheduledTask) {
      clearTimeout(scheduledTask.timeoutId);
      this.scheduledTasks.delete(taskId);
      
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = TASK_STATUS.PENDING;
        this.saveTask(task);
      }
    }
  }

  // Execute task
  async executeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logError(`Task ${taskId} not found`);
      return;
    }

    // Check if max retry count exceeded
    if (task.errorCount >= task.retryConfig.maxRetries) {
      task.status = TASK_STATUS.FAILED;
      this.saveTask(task);
      this.handleTaskFailure(task);
      return;
    }

    // UpdateTask Status
    task.status = TASK_STATUS.RUNNING;
    task.runCount++;
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);

    this.runningTasks.set(taskId, task);

    try {
      // Execute task动作
      const result = await task.action();
      
      // Task completed successfully
      task.status = TASK_STATUS.COMPLETED;
      task.result = result;
      task.updatedAt = new Date().toISOString();
      this.saveTask(task);
      this.handleTaskSuccess(task);
    } catch (error) {
      // Task execution failed
      task.status = TASK_STATUS.FAILED;
      task.errorCount++;
      task.lastError = {
        message: error.message,
        type: this.determineErrorType(error),
        timestamp: new Date().toISOString(),
        stack: error.stack
      };
      task.updatedAt = new Date().toISOString();
      this.saveTask(task);
      this.handleTaskFailure(task);
      this.retryTask(taskId);
    } finally {
      this.runningTasks.delete(taskId);
    }
  }

  // Retry task
  retryTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Check if max retry count exceeded
    if (task.errorCount >= task.retryConfig.maxRetries) {
      return;
    }

    // Calculate retry delay
    const delay = task.retryConfig.initialDelay * Math.pow(task.retryConfig.backoffMultiplier, task.errorCount - 1);

    // UpdateTask Status
    task.status = TASK_STATUS.RETRYING;
    task.nextRetryAt = new Date(Date.now() + delay).toISOString();
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);

    this.retryQueue.set(taskId, task);

    // 调度Retrying
    setTimeout(() => {
      this.retryQueue.delete(taskId);
      this.executeTask(taskId);
    }, delay);

    this.logInfo(`Task ${taskId} scheduled for retry in ${delay}ms`);
  }

  // Determine error type
  determineErrorType(error) {
    if (error.message.includes('Posting too fast') || error.message.includes('rate limit') || error.message.includes('429')) {
      return ERROR_TYPES.API_RATE_LIMIT;
    } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      return ERROR_TYPES.NETWORK_ERROR;
    } else if (error.message.includes('validation') || error.message.includes('400')) {
      return ERROR_TYPES.VALIDATION_ERROR;
    } else {
      return ERROR_TYPES.UNKNOWN_ERROR;
    }
  }

  // Handle task success
  handleTaskSuccess(task) {
    this.logInfo(`Task ${task.id} (${task.name}) completed successfully`);
    
    // If recurring task, reschedule
    if (task.isRecurring && task.interval) {
      this.scheduleTask(task, task.interval);
    } else if (task.autoDelete) {
      // If auto-delete is set, delete task after specified time
      setTimeout(() => {
        this.deleteTask(task.id);
      }, task.autoDeleteDelay || 3600000); // Default1小时
    }
  }

  // Handle task failure
  handleTaskFailure(task) {
    this.logError(`Task ${task.id} (${task.name}) failed with error: ${task.lastError.message}`);
    
    // Send alert
    this.sendAlert({
      type: 'TASK_FAILURE',
      taskId: task.id,
      taskName: task.name,
      error: task.lastError,
      timestamp: new Date().toISOString()
    });
  }

  // Create recurring task
  createRecurringTask(name, action, interval, options = {}) {
    const task = this.createTask(name, action, {
      ...options,
      isRecurring: true,
      interval
    });

    // Immediately schedule first execution
    this.scheduleTask(task);
    return task;
  }

  // System monitoring
  startSystemMonitor() {
    // Check system status every 5 minutes
    setInterval(() => {
      this.checkSystemStatus();
    }, 5 * 60 * 1000);
  }

  // Check system status
  checkSystemStatus() {
    try {
      // Check disk space
      const diskStats = fs.statSync(__dirname);
      // Check memory usage (simple check in Node.js environment)
      const memoryUsage = process.memoryUsage();
      // Check task queue status
      const queueStats = {
        totalTasks: this.tasks.size,
        runningTasks: this.runningTasks.size,
        pendingTasks: this.scheduledTasks.size,
        retryTasks: this.retryQueue.size
      };

      const status = {
        timestamp: new Date().toISOString(),
        diskStats,
        memoryUsage,
        queueStats
      };

      // Save system status log
      const statusLogPath = path.join(this.logsDirectory, 'system-status.log');
      fs.appendFileSync(statusLogPath, JSON.stringify(status) + '\n', 'utf8');

      // Check是否requiresSend alert
      this.checkAlerts(status);
    } catch (error) {
      this.logError('Error checking system status:', error);
    }
  }

  // Check是否requiresSend alert
  checkAlerts(status) {
    // 示例: 当Running tasks exceed 10个时Send alert
    if (status.queueStats.runningTasks > 10) {
      this.sendAlert({
        type: 'SYSTEM_HIGH_LOAD',
        message: `System load too high, currently running tasks: : ${status.queueStats.runningTasks}`,
        status,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Heartbeat check
  startHeartbeat() {
    // Record heartbeat every 1 minute
    setInterval(() => {
      const heartbeat = {
        timestamp: new Date().toISOString(),
        status: 'running',
        taskCount: this.tasks.size,
        runningTasks: this.runningTasks.size
      };

      const heartbeatPath = path.join(this.logsDirectory, 'workflow-heartbeat.log');
      fs.appendFileSync(heartbeatPath, JSON.stringify(heartbeat) + '\n', 'utf8');
    }, 60000);
  }

  // Send alert
  sendAlert(alert) {
    // Save alert log
    const alertPath = path.join(this.logsDirectory, 'alerts.log');
    fs.appendFileSync(alertPath, JSON.stringify(alert) + '\n', 'utf8');

    // Send multi-channel alerts via notification service
    this.notificationService.send({
      subject: `[NexusGenesis Alert] ${alert.type}`,
      message: alert.message || alert.taskName || 'No message',
      alert: alert,
      channels: alert.channels || ['console', 'file']
    });
  }

  // Logging
  logInfo(message) {
    const logEntry = {
      level: 'INFO',
      message,
      timestamp: new Date().toISOString()
    };
    this.writeLog(logEntry);
  }

  logError(message, error = null) {
    const logEntry = {
      level: 'ERROR',
      message,
      timestamp: new Date().toISOString(),
      error: error ? {
        message: error.message,
        stack: error.stack
      } : null
    };
    this.writeLog(logEntry);
  }

  writeLog(logEntry) {
    const logPath = path.join(this.logsDirectory, 'workflow-engine.log');
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf8');
    console[logEntry.level.toLowerCase() === 'error' ? 'error' : 'log'](
      `[${logEntry.level}] ${logEntry.timestamp} - ${logEntry.message}`
    );
  }

  // Get system status report
  getSystemReport() {
    return {
      timestamp: new Date().toISOString(),
      workflowEngine: {
        totalTasks: this.tasks.size,
        runningTasks: this.runningTasks.size,
        pendingTasks: this.scheduledTasks.size,
        retryTasks: this.retryQueue.size
      }
    };
  }
}

export default WorkflowEngine;
export { TASK_STATUS, ERROR_TYPES };
