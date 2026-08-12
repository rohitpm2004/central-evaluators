import EventEmitter from 'events';
import redisConnection from '../config/redis.js';
import logger from '../config/logger.js';

class WebhookPubSub extends EventEmitter {
  constructor() {
    super();
    this.subscriber = null;
  }

  init() {
    if (this.subscriber) return;
    
    logger.info('Initializing shared Redis subscriber for webhooks...');
    this.subscriber = redisConnection.getClient().duplicate();
    
    // Subscribe to a pattern for all webhooks to avoid 1 connection per job
    this.subscriber.psubscribe('github_webhook_*', (err, count) => {
      if (err) {
        logger.error('Failed to subscribe to github_webhook_* pattern:', err);
      } else {
        logger.info(`Subscribed to github_webhook_* pattern for webhook events`);
      }
    });

    this.subscriber.on('pmessage', (pattern, channel, message) => {
      try {
        const payload = JSON.parse(message);
        this.emit(channel, payload);
      } catch (err) {
        logger.error(`Failed to parse webhook message for ${channel}:`, err);
      }
    });
    
    this.subscriber.on('error', (err) => {
      logger.error('Shared webhook subscriber connection error:', err);
    });
  }

  async waitForWebhook(jobId, timeoutMs) {
    this.init(); // ensure subscriber is running
    return new Promise((resolve, reject) => {
      const channel = `github_webhook_${jobId}`;
      let timeoutId;
      
      const handler = (payload) => {
        clearTimeout(timeoutId);
        this.off(channel, handler);
        resolve(payload);
      };

      this.on(channel, handler);

      timeoutId = setTimeout(() => {
        this.off(channel, handler);
        reject(new Error("GitHub Actions webhook timeout"));
      }, timeoutMs);
    });
  }
}

export const webhookPubSub = new WebhookPubSub();
