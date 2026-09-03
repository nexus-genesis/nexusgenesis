import fs from 'fs';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class NotificationService {
  constructor(config = {}) {
    this.config = {
      email: {
        enabled: false,
        smtpHost: 'localhost',
        smtpPort: 25,
        from: 'nexusgenesis@localhost',
        to: [],
        ...config.email
      },
      sms: {
        enabled: false,
        webhookUrl: '',
        phoneNumbers: [],
        ...config.sms
      },
      webhook: {
        enabled: false,
        url: '',
        ...config.webhook
      },
      file: {
        enabled: true,
        directory: path.join(__dirname, '../../logs/notifications'),
        ...config.file
      },
      console: {
        enabled: true,
        ...config.console
      }
    };
    
    this._ensureDirectories();
  }

  _ensureDirectories() {
    if (this.config.file.enabled) {
      const dir = this.config.file.directory;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  async send(notification) {
    const { channels = ['console', 'file'] } = notification;
    const results = [];

    for (const channel of channels) {
      try {
        const result = await this._sendViaChannel(channel, notification);
        results.push({ channel, success: true, result });
      } catch (error) {
        results.push({ channel, success: false, error: error.message });
        console.error(`[NotificationService] ${channel} send failed:`, error.message);
      }
    }

    return results;
  }

  async _sendViaChannel(channel, notification) {
    switch (channel) {
      case 'email':
        return this._sendEmail(notification);
      case 'sms':
        return this._sendSMS(notification);
      case 'webhook':
        return this._sendWebhook(notification);
      case 'file':
        return this._sendToFile(notification);
      case 'console':
        return this._sendToConsole(notification);
      default:
        throw new Error(`Unknown notification channel: ${channel}`);
    }
  }

  async _sendEmail(notification) {
    const { email: emailConfig } = this.config;
    if (!emailConfig.enabled || emailConfig.to.length === 0) {
      throw new Error('Email notifications not configured');
    }

    const messageId = `<${crypto.randomBytes(16).toString('hex')}@nexusgenesis>`;
    const boundary = `--boundary_${crypto.randomBytes(16).toString('hex')}`;
    const date = new Date().toUTCString();

    const emailBody = [
      `From: ${emailConfig.from}`,
      `To: ${emailConfig.to.join(', ')}`,
      `Date: ${date}`,
      `Subject: ${notification.subject}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      `Content-Type: text/plain; charset="UTF-8"`,
      '',
      notification.message,
      '',
      '-- NexusGenesis Node Notification Service',
      `Timestamp: ${new Date().toISOString()}`,
      notification.alert ? `Alert Type: ${notification.alert.type}` : ''
    ].join('\r\n');

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      
      socket.setTimeout(10000);
      
      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('SMTP connection timeout'));
      });

      socket.connect(emailConfig.smtpPort, emailConfig.smtpHost, () => {
        let buffer = '';
        
        socket.on('data', (data) => {
          buffer += data.toString();
          const code = parseInt(buffer.slice(0, 3));
          
          if (buffer.includes('\r\n')) {
            const response = buffer.trim();
            buffer = '';
            
            if (!this._smtpHandler) {
              this._smtpHandler = this._createSmtpSequence(
                socket, emailConfig, emailBody, resolve, reject
              );
            }
            this._smtpHandler(response, code);
          }
        });

        this._smtpHandler = this._createSmtpSequence(
          socket, emailConfig, emailBody, resolve, reject
        );
      });
    });
  }

  _createSmtpSequence(socket, emailConfig, emailBody, resolve, reject) {
    let step = 0;

    return (response, code) => {
      if (code >= 400) {
        socket.end();
        reject(new Error(`SMTP error: ${response}`));
        return;
      }

      switch (step) {
        case 0:
          socket.write(`EHLO nexusgenesis\r\n`);
          break;
        case 1:
          socket.write(`MAIL FROM:<${emailConfig.from}>\r\n`);
          break;
        case 2:
          for (const recipient of emailConfig.to) {
            socket.write(`RCPT TO:<${recipient}>\r\n`);
          }
          break;
        case 3:
          socket.write('DATA\r\n');
          break;
        case 4:
          socket.write(`${emailBody}\r\n.\r\n`);
          break;
        case 5:
          socket.write('QUIT\r\n');
          socket.end();
          resolve({ status: 'sent', recipients: emailConfig.to.length });
          return;
      }
      step++;
    };
  }

  async _sendSMS(notification) {
    const { sms: smsConfig } = this.config;
    if (!smsConfig.enabled || smsConfig.phoneNumbers.length === 0) {
      throw new Error('SMS notifications not configured');
    }

    if (smsConfig.webhookUrl) {
      const payload = JSON.stringify({
        to: smsConfig.phoneNumbers,
        message: `[NexusGenesis] ${notification.subject}: ${notification.message}`.slice(0, 160)
      });

      const url = new URL(smsConfig.webhookUrl);
      const httpModule = url.protocol === 'https:' ? await import('https') : await import('http');

      return new Promise((resolve, reject) => {
        const req = httpModule.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ status: 'sent', response: data }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    const smsLogPath = path.join(this.config.file.directory, 'sms.log');
    const entry = {
      timestamp: new Date().toISOString(),
      to: smsConfig.phoneNumbers,
      subject: notification.subject,
      message: notification.message.slice(0, 160)
    };
    fs.appendFileSync(smsLogPath, JSON.stringify(entry) + '\n', 'utf8');
    return { status: 'logged', to: smsConfig.phoneNumbers };
  }

  async _sendWebhook(notification) {
    const { webhook: webhookConfig } = this.config;
    if (!webhookConfig.enabled || !webhookConfig.url) {
      throw new Error('Webhook notifications not configured');
    }

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      subject: notification.subject,
      message: notification.message,
      alert: notification.alert || null
    });

    const url = new URL(webhookConfig.url);
    const httpModule = url.protocol === 'https:' ? await import('https') : await import('http');

    return new Promise((resolve, reject) => {
      const req = httpModule.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: 'delivered', statusCode: res.statusCode }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Webhook timeout'));
      });
      req.write(payload);
      req.end();
    });
  }

  _sendToFile(notification) {
    const dir = this.config.file.directory;
    const filePath = path.join(dir, `notification-${Date.now()}.json`);
    
    const entry = {
      timestamp: new Date().toISOString(),
      subject: notification.subject,
      message: notification.message,
      alert: notification.alert || null
    };
    
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');
    return { status: 'written', path: filePath };
  }

  _sendToConsole(notification) {
    const prefix = notification.alert?.level === 'critical' ? '[CRITICAL]' :
                   notification.alert?.level === 'error' ? '[ERROR]' :
                   notification.alert?.level === 'warning' ? '[WARNING]' :
                   '[ALERT]';

    console.error(`${prefix} ${notification.subject}`);
    console.error(`  Message: ${notification.message}`);
    if (notification.alert) {
      console.error(`  Type: ${notification.alert.type}`);
      console.error(`  Timestamp: ${notification.alert.timestamp || new Date().toISOString()}`);
    }
    
    return { status: 'console' };
  }

  configure(config) {
    this.config = {
      email: { ...this.config.email, ...config.email },
      sms: { ...this.config.sms, ...config.sms },
      webhook: { ...this.config.webhook, ...config.webhook },
      file: { ...this.config.file, ...config.file },
      console: { ...this.config.console, ...config.console }
    };
    this._ensureDirectories();
  }
}

export default NotificationService;