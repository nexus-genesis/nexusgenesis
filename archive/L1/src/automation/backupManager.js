/**
 * NexusGenesis System Backup & Recovery Service
 * Provides reliable data backup and rapid recovery functionality
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Backup type
const BACKUP_TYPES = {
  FULL: 'full',
  INCREMENTAL: 'incremental',
  DIFFERENTIAL: 'differential'
};

// backupstatus
const BACKUP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

class BackupManager {
  constructor() {
    this.backups = new Map();
    this.backupDirectory = path.join(__dirname, '../../data/backups');
    this.systemDirectories = {
      wallet: path.join(__dirname, '../../data/wallet'),
      blockchain: path.join(__dirname, '../../data/blockchain'),
      agents: path.join(__dirname, '../../data/agents'),
      tasks: path.join(__dirname, '../../data/tasks'),
      state: path.join(__dirname, '../../data/state'),
      workflowTasks: path.join(__dirname, '../../data/workflow-tasks')
    };
    this.initDirectories();
    this.loadBackupHistory();
    this.setupBackupSchedule();
  }

  initDirectories() {
    // Ensure backup directory exists
    if (!fs.existsSync(this.backupDirectory)) {
      fs.mkdirSync(this.backupDirectory, { recursive: true });
    }

    // Ensure all system directories exist
    Object.values(this.systemDirectories).forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  // Setup backup schedule
  setupBackupSchedule() {
    console.log('[BackupManager] Setup backup schedule');

    // 1. Daily full backup (at 2:00 AM)
    this.scheduleDailyBackup(BACKUP_TYPES.FULL, 2, 0);

    // 2. every  hoursIncremental backup
    this.scheduleHourlyBackup(BACKUP_TYPES.INCREMENTAL);

    // 3. Weekly full backup (Sunday at 3:00 AM)
    this.scheduleWeeklyBackup(BACKUP_TYPES.FULL, 0, 3, 0);

    console.log('[BackupManager] Backup schedule setup complete');
  }

  // Schedule dailybackup
  scheduleDailyBackup(type, hour, minute) {
    const now = new Date();
    let nextBackup = new Date(now);
    nextBackup.setHours(hour, minute, 0, 0);

    // 如果时间已过, Set为明 days
    if (nextBackup <= now) {
      nextBackup.setDate(nextBackup.getDate() + 1);
    }

    const delay = nextBackup - now;

    console.log(`[BackupManager] Schedule daily${type}backup: ${nextBackup.toISOString()}`);

    setTimeout(() => {
      this.createBackup(type);
      // 递归调度下一次backup
      this.scheduleDailyBackup(type, hour, minute);
    }, delay);
  }

  // Schedule hourlybackup
  scheduleHourlyBackup(type) {
    const now = new Date();
    let nextBackup = new Date(now);
    nextBackup.setHours(nextBackup.getHours() + 1, 0, 0, 0);

    const delay = nextBackup - now;

    console.log(`[BackupManager] Schedule hourly${type}backup: ${nextBackup.toISOString()}`);

    setTimeout(() => {
      this.createBackup(type);
      // 递归调度下一次backup
      this.scheduleHourlyBackup(type);
    }, delay);
  }

  // Schedule weeklybackup
  scheduleWeeklyBackup(type, dayOfWeek, hour, minute) {
    const now = new Date();
    let nextBackup = new Date(now);

    // Set到下一个指定的星期几
    while (nextBackup.getDay() !== dayOfWeek) {
      nextBackup.setDate(nextBackup.getDate() + 1);
    }

    nextBackup.setHours(hour, minute, 0, 0);

    // 如果时间已过, Set为下周
    if (nextBackup <= now) {
      nextBackup.setDate(nextBackup.getDate() + 7);
    }

    const delay = nextBackup - now;

    console.log(`[BackupManager] Schedule weekly${type}backup: ${nextBackup.toISOString()}`);

    setTimeout(() => {
      this.createBackup(type);
      // 递归调度下一次backup
      this.scheduleWeeklyBackup(type, dayOfWeek, hour, minute);
    }, delay);
  }

  // Createbackup
  async createBackup(type = BACKUP_TYPES.FULL, directories = null) {
    if (!directories) {
      directories = Object.keys(this.systemDirectories);
    }

    const backupId = `${type}-${Date.now()}`;
    const backup = {
      id: backupId,
      type,
      directories,
      status: BACKUP_STATUS.RUNNING,
      createdAt: new Date().toISOString(),
      completedAt: null,
      size: 0,
      filesCount: 0,
      duration: 0,
      error: null
    };

    this.backups.set(backupId, backup);

    console.log(`[BackupManager] Start ${type}backup: ${backupId}`);

    const startTime = Date.now();

    try {
      // Create backup directory
      const backupPath = path.join(this.backupDirectory, backupId);
      fs.mkdirSync(backupPath, { recursive: true });

      // Execute different backup strategies based on backup type
      let filesCount = 0;
      let totalSize = 0;

      if (type === BACKUP_TYPES.FULL) {
        // Full backup of all specified directories
        for (const dirName of directories) {
          const sourceDir = this.systemDirectories[dirName];
          const targetDir = path.join(backupPath, dirName);
          
          const { files, size } = await this.copyDirectory(sourceDir, targetDir, true);
          filesCount += files;
          totalSize += size;
        }
      } else if (type === BACKUP_TYPES.INCREMENTAL) {
        // Incremental backup, only backup files changed since last backup
        const lastBackup = this.getLastBackup();
        if (!lastBackup) {
          // If no previous backup, perform full backup
          return this.createBackup(BACKUP_TYPES.FULL, directories);
        }

        const lastBackupTime = new Date(lastBackup.createdAt).getTime();
        
        for (const dirName of directories) {
          const sourceDir = this.systemDirectories[dirName];
          const targetDir = path.join(backupPath, dirName);
          
          const { files, size } = await this.copyChangedFiles(sourceDir, targetDir, lastBackupTime, true);
          filesCount += files;
          totalSize += size;
        }
      }

      // Update backup info
      backup.status = BACKUP_STATUS.COMPLETED;
      backup.completedAt = new Date().toISOString();
      backup.size = totalSize;
      backup.filesCount = filesCount;
      backup.duration = Date.now() - startTime;

      // Compress backup
      await this.compressBackup(backupId);

      // Cleanup old backups
      this.cleanupOldBackups();

      console.log(`[BackupManager] ${type}backup complete: ${backupId} (${filesCount} files, ${(totalSize / 1024 / 1024).toFixed(2)}MB)`);

      return backup;
    } catch (error) {
      console.error(`[BackupManager] ${type}backup failed: ${backupId}`, error);

      backup.status = BACKUP_STATUS.FAILED;
      backup.completedAt = new Date().toISOString();
      backup.error = error.message;
      backup.duration = Date.now() - startTime;

      return backup;
    } finally {
      // Savebackupinfo
      this.saveBackupHistory();
    }
  }

  // Copy directory
  async copyDirectory(source, target, compress = false) {
    if (!fs.existsSync(source)) {
      return { files: 0, size: 0 };
    }

    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    let filesCount = 0;
    let totalSize = 0;

    const items = fs.readdirSync(source);
    for (const item of items) {
      const sourcePath = path.join(source, item);
      const targetPath = path.join(target, item);
      
      const stats = fs.statSync(sourcePath);
      
      if (stats.isDirectory()) {
        const result = await this.copyDirectory(sourcePath, targetPath, compress);
        filesCount += result.files;
        totalSize += result.size;
      } else {
        // 复制文件
        await this.copyFile(sourcePath, targetPath, compress);
        filesCount++;
        totalSize += stats.size;
      }
    }

    return { files: filesCount, size: totalSize };
  }

  // Copy file
  async copyFile(source, target, compress = false) {
    const data = fs.readFileSync(source);
    
    if (compress) {
      const compressed = zlib.gzipSync(data);
      fs.writeFileSync(`${target}.gz`, compressed);
    } else {
      fs.writeFileSync(target, data);
    }
  }

  // Copy changed files
  async copyChangedFiles(source, target, sinceTime, compress = false) {
    if (!fs.existsSync(source)) {
      return { files: 0, size: 0 };
    }

    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    let filesCount = 0;
    let totalSize = 0;

    const items = fs.readdirSync(source);
    for (const item of items) {
      const sourcePath = path.join(source, item);
      const targetPath = path.join(target, item);
      
      const stats = fs.statSync(sourcePath);
      
      if (stats.isDirectory()) {
        const result = await this.copyChangedFiles(sourcePath, targetPath, sinceTime, compress);
        filesCount += result.files;
        totalSize += result.size;
      } else if (stats.mtime.getTime() > sinceTime) {
        // 仅Copy changed files
        await this.copyFile(sourcePath, targetPath, compress);
        filesCount++;
        totalSize += stats.size;
      }
    }

    return { files: filesCount, size: totalSize };
  }

  // Compress backup
  async compressBackup(backupId) {
    const backupPath = path.join(this.backupDirectory, backupId);
    const archivePath = `${backupPath}.tar.gz`;

    if (!fs.existsSync(backupPath)) {
      throw new Error(`backup目录 ${backupPath} does not exist`);
    }

    const files = this._collectAllFiles(backupPath);
    const tarBuffer = this._createTarArchive(backupPath, files);
    const compressed = zlib.gzipSync(tarBuffer);
    fs.writeFileSync(archivePath, compressed);

    const archiveSize = fs.statSync(archivePath).size;
    const uncompressedSize = files.reduce((sum, f) => sum + f.size, 0);
    
    console.log(`[BackupManager] Compression complete: ${archivePath} (${archiveSize} bytes, ${(archiveSize / Math.max(1, uncompressedSize) * 100).toFixed(1)}% ratio)`);
    
    return {
      archivePath,
      compressedSize: archiveSize,
      uncompressedSize,
      fileCount: files.length
    };
  }

  _collectAllFiles(dirPath, baseDir = null) {
    if (!baseDir) baseDir = dirPath;
    const files = [];
    const entries = fs.readdirSync(dirPath);
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        files.push(...this._collectAllFiles(fullPath, baseDir));
      } else {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        files.push({
          name: relativePath,
          path: fullPath,
          size: stat.size,
          mode: stat.mode,
          mtime: Math.floor(stat.mtime.getTime() / 1000)
        });
      }
    }
    
    return files;
  }

  _createTarArchive(baseDir, files) {
    const chunks = [];
    
    for (const file of files) {
      const header = this._createTarHeader(file);
      chunks.push(header);
      
      const content = fs.readFileSync(path.join(baseDir, file.name));
      chunks.push(content);
      
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding));
      }
    }
    
    chunks.push(Buffer.alloc(1024));
    
    return Buffer.concat(chunks);
  }

  _createTarHeader(file) {
    const header = Buffer.alloc(512);
    
    const name = file.name.length > 100 ? file.name.slice(0, 100) : file.name;
    header.write(name, 0, 100, 'utf8');
    
    const mode = (file.mode || 0o644).toString(8).padStart(7, '0');
    header.write(mode, 100, 8, 'utf8');
    
    const uid = '0000000';
    header.write(uid, 108, 8, 'utf8');
    
    const gid = '0000000';
    header.write(gid, 116, 8, 'utf8');
    
    const size = file.size.toString(8).padStart(11, '0');
    header.write(size, 124, 12, 'utf8');
    
    const mtime = (file.mtime || 0).toString(8).padStart(11, '0');
    header.write(mtime, 136, 12, 'utf8');
    
    header.write('        ', 148, 8, 'utf8');
    
    header[156] = 0x30;
    
    const linkName = '';
    header.write(linkName, 157, 100, 'utf8');
    
    const ustar = 'ustar\0';
    header.write(ustar, 257, 6, 'utf8');
    
    header.write('00', 263, 2, 'utf8');
    
    let checksum = 8 * 32;
    for (let i = 0; i < 512; i++) {
      if (i < 148 || i >= 156) {
        checksum += header[i];
      }
    }
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(checksumStr, 148, 8, 'utf8');
    
    return header;
  }

  // Restore backup
  async restoreBackup(backupId, targetDirectories = null) {
    console.log(`[BackupManager] Start recoverybackup: ${backupId}`);

    const backup = this.backups.get(backupId);
    if (!backup) {
      throw new Error(`backup ${backupId} does not exist`);
    }

    if (backup.status !== BACKUP_STATUS.COMPLETED) {
      throw new Error(`backup ${backupId} 未complete, 无法recovery`);
    }

    const backupPath = path.join(this.backupDirectory, backupId);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`backup文件 ${backupPath} does not exist`);
    }

    const directories = targetDirectories || backup.directories;

    for (const dirName of directories) {
      const sourceDir = path.join(backupPath, dirName);
      const targetDir = this.systemDirectories[dirName];
      
      if (!fs.existsSync(sourceDir)) {
        console.warn(`Directory not found in backup ${dirName}`);
        continue;
      }

      // Clear target directory
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });

      // 复制文件
      await this.extractDirectory(sourceDir, targetDir);
      console.log(`[BackupManager] Restored directory ${dirName} complete`);
    }

    console.log(`[BackupManager] Backup restore complete: ${backupId}`);
    return true;
  }

  // Extract directory
  async extractDirectory(source, target) {
    const items = fs.readdirSync(source);
    
    for (const item of items) {
      const sourcePath = path.join(source, item);
      const stats = fs.statSync(sourcePath);
      
      if (stats.isDirectory()) {
        const targetPath = path.join(target, item);
        fs.mkdirSync(targetPath, { recursive: true });
        await this.extractDirectory(sourcePath, targetPath);
      } else if (item.endsWith('.gz')) {
        // Extract file
        const targetPath = path.join(target, item.slice(0, -3));
        const compressedData = fs.readFileSync(sourcePath);
        const data = zlib.gunzipSync(compressedData);
        fs.writeFileSync(targetPath, data);
      } else {
        // Directly copy uncompressed files
        fs.copyFileSync(sourcePath, path.join(target, item));
      }
    }
  }

  // Get last backup
  getLastBackup() {
    const backups = Array.from(this.backups.values());
    if (backups.length === 0) return null;
    
    return backups.sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    )[0];
  }

  // Get backup history
  getBackupHistory(days = 7) {
    const backups = Array.from(this.backups.values());
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    return backups
      .filter(backup => new Date(backup.createdAt) >= cutoffDate)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // Cleanup old backups
  cleanupOldBackups() {
    console.log('[BackupManager] Cleanup old backups');
    
    // Retain full backups from the last 30 days
    const fullBackups = Array.from(this.backups.values())
      .filter(backup => backup.type === BACKUP_TYPES.FULL && backup.status === BACKUP_STATUS.COMPLETED)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Retain full backups from the last 30 days
    const backupsToKeep = fullBackups.slice(0, 30);
    const backupIdsToKeep = new Set(backupsToKeep.map(b => b.id));
    
    // Cleanup incremental backups, retain only those from the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    this.backups.forEach((backup, backupId) => {
      // Retain specified backups
      if (backupIdsToKeep.has(backupId)) {
        return;
      }
      
      // Retain backups from the last 30 days
      if (new Date(backup.createdAt) >= thirtyDaysAgo) {
        return;
      }
      
      // Delete old backups
      this.deleteBackup(backupId);
    });
    
    console.log('[BackupManager] Old backup cleanup complete');
  }

  // Deletebackup
  deleteBackup(backupId) {
    const backup = this.backups.get(backupId);
    if (!backup) return;
    
    const backupPath = path.join(this.backupDirectory, backupId);
    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
    
    const compressedPath = `${backupPath}.zip`;
    if (fs.existsSync(compressedPath)) {
      fs.unlinkSync(compressedPath);
    }
    
    this.backups.delete(backupId);
    this.saveBackupHistory();
    
    console.log(`[BackupManager] Deletebackup: ${backupId}`);
  }

  // Verify backup integrity
  async verifyBackup(backupId) {
    const backup = this.backups.get(backupId);
    if (!backup) {
      throw new Error(`backup ${backupId} does not exist`);
    }

    const backupPath = path.join(this.backupDirectory, backupId);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`backup文件 ${backupPath} does not exist`);
    }

    let filesCount = 0;
    let totalSize = 0;

    // Check if all directories exist
    for (const dirName of backup.directories) {
      const sourceDir = path.join(backupPath, dirName);
      
      if (!fs.existsSync(sourceDir)) {
        throw new Error(`backup中缺少目录 ${dirName}`);
      }

      const { files, size } = await this.countFiles(sourceDir);
      filesCount += files;
      totalSize += size;
    }

    // Verify file count and size match backup records
    if (backup.filesCount !== filesCount) {
      throw new Error(`backup文件数量不匹配: 记录 ${backup.filesCount}, 实际 ${filesCount}`);
    }

    // Size may differ slightly due to compression, approximate verification only
    const sizeDifference = Math.abs(backup.size - totalSize);
    if (sizeDifference > backup.size * 0.05) { // allow5%的误差
      throw new Error(`backup大小不匹配: 记录 ${backup.size}, 实际 ${totalSize}`);
    }

    return {
      valid: true,
      backupId,
      filesCount,
      size: totalSize,
      message: 'backup完整性Verifyvia'
    };
  }

  // Count files and size
  async countFiles(dir) {
    let filesCount = 0;
    let totalSize = 0;

    const items = fs.readdirSync(dir);
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stats = fs.statSync(itemPath);
      
      if (stats.isDirectory()) {
        const result = await this.countFiles(itemPath);
        filesCount += result.files;
        totalSize += result.size;
      } else {
        filesCount++;
        totalSize += stats.size;
      }
    }

    return { files: filesCount, size: totalSize };
  }

  // Load backup history
  loadBackupHistory() {
    const historyFile = path.join(this.backupDirectory, 'backup-history.json');
    if (fs.existsSync(historyFile)) {
      try {
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        history.forEach(backup => {
          this.backups.set(backup.id, backup);
        });
      } catch (error) {
        console.error('Load backup historyFailed:', error);
      }
    }
  }

  // Save backup history
  saveBackupHistory() {
    const historyFile = path.join(this.backupDirectory, 'backup-history.json');
    const history = Array.from(this.backups.values());
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
  }

  // Get backup statistics
  getBackupStatistics() {
    const backups = Array.from(this.backups.values());
    const completedBackups = backups.filter(b => b.status === BACKUP_STATUS.COMPLETED);
    const failedBackups = backups.filter(b => b.status === BACKUP_STATUS.FAILED);
    
    const stats = {
      totalBackups: backups.length,
      completedBackups: completedBackups.length,
      failedBackups: failedBackups.length,
      successRate: completedBackups.length > 0 ? 
        Math.round((completedBackups.length / backups.length) * 100) : 0,
      lastBackup: this.getLastBackup(),
      backupTypes: {
        full: backups.filter(b => b.type === BACKUP_TYPES.FULL).length,
        incremental: backups.filter(b => b.type === BACKUP_TYPES.INCREMENTAL).length,
        differential: backups.filter(b => b.type === BACKUP_TYPES.DIFFERENTIAL).length
      }
    };
    
    return stats;
  }
}

export default BackupManager;
export { BACKUP_TYPES, BACKUP_STATUS };
