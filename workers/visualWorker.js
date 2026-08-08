// src/workers/visualWorker.js
/**
 * Visual Evaluation Worker
 * 
 * Handles UI/Visual evaluations with:
 * - Browser pooling for efficiency
 * - Proper error handling
 * - Logging and monitoring
 * - Integration with new queueManager
 */

import { Worker, UnrecoverableError } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { getBrowserPool } from '../evaluators/visual/browserPool.js';
import { evaluateStudentsWithVision } from '../evaluators/visual/evaluatorService.js';
import { cloneGitRepo, deleteRepo, sweepStaleRepos } from '../evaluators/visual/repoService.js';
import { RubricParseError } from '../evaluators/visual/rubricSchema.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';

let visualWorker = null;

// Free-tier RAM budget: each Chromium instance is ~300-500MB, so default to a
// pool of 1 unless BROWSER_POOL_SIZE is set (e.g. on a bigger instance).
const BROWSER_POOL_SIZE = parseInt(process.env.BROWSER_POOL_SIZE) || 1;

/**
 * Initialize visual worker
 * Called once at application startup
 */
export async function initializeVisualWorker() {
  try {
    logger.info('Initializing Visual Worker...');

    // Clean up clone dirs orphaned by a previous crash (V-25)
    await sweepStaleRepos();

    // Initialize browser pool first
    await getBrowserPool(BROWSER_POOL_SIZE);

    // Get queue from queueManager
    const visualQueue = queueManager.getQueue('visual');
    const config = queueManager.getConfig('visual');

    // Create worker with proper concurrency
    visualWorker = new Worker(
      'visual-evaluation',
      async (job) => {
        return await processVisualJob(job);
      },
      {
        connection: redisConnection.getClient(), // V-13: BullMQ will duplicate this for the blocking client automatically
        concurrency: config.concurrency,  // 2 concurrent jobs
        settings: {
          maxStalledCount: 2,             // Allow 2 stalls before failing
          // V-19: visual jobs are long (2x goto + 2x GPT-4o). Lock must comfortably
          // exceed worst-case work; renew at half the lock.
          lockDuration: 180000,           // 3 min
          lockRenewTime: 60000,           // renew every 1 min
          retryProcessDelay: 5000         // Delay between retries
        }
      }
    );

    // Setup event handlers
    setupWorkerEvents();

    logger.info('Visual Worker initialized');
    logger.info(`Concurrency: ${config.concurrency}, Timeout: ${config.timeout}ms`);

    return visualWorker;

  } catch (err) {
    logger.error('Failed to initialize visual worker:', err);
    throw err;
  }
}

/**
 * Process a visual evaluation job
 */
async function processVisualJob(job) {
  const jobId = job.id;
  const jobData = job.data;
  let repoPath = null;

  let browserPool = null;

  const config = queueManager.getConfig('visual');

  const {
    submission,
    rubricText,
    expectedUrl,
    assignmentId
    } = job.data;
  try {
    logger.info(`Starting visual evaluation job: ${jobId}`);
     repoPath = await cloneGitRepo(
      submission.repoUrl
    );
    
    // Get browser pool
    browserPool = await getBrowserPool(BROWSER_POOL_SIZE);
    logger.debug(`Browser pool stats:`, browserPool.getStats());
    
    // Main evaluation logic
    // const results = await evaluateStudentsWithVision({
      //   rubricText: jobData.rubricText,
      //   expectedUrl: jobData.expectedUrl,
      //   repoUrl: jobData.repoUrl
      // });
        
        logger.debug(`Job data:`, {
          jobId,
          repoUrl: submission.repoUrl,
          expectedUrl,
          rubricLength: rubricText?.length
        });
const result =
  await withTimeout(
    evaluateStudentsWithVision({
      jobId,
      assignmentId,
      studentId:
        submission.studentId,

      studentName:
        submission.studentName,

      repoPath,

      rubricText,
      expectedUrl,
      entryFile: submission.entryFile
    }),
    config.timeout, // V-08: real, enforced job timeout
    `visual-eval ${jobId}`
  );

    logger.info(`Job completed: ${jobId}`, {
      totalStudents: result?.length || 0,
      successCount: result?.filter(r => !r.error)?.length || 0
    });

    // return {
    //   success: true,
    //   jobId,
    //   results,
    //   timestamp: new Date().toISOString()
    // };
    return {
  success: true,
  result
};

  } catch (err) {
    logger.error(`Job failed: ${jobId}`, {
      error: err.message,
      stack: err.stack
    });

    // V-17: classify failures. Permanent ones (bad rubric, missing inputs) must
    // NOT be retried 3x — that just burns GPT-4o spend on a deterministic fail.
    const permanent =
      err instanceof RubricParseError ||
      err.message === 'Missing required inputs';

    if (permanent) {
      throw new UnrecoverableError(err.message);
    }

    throw err;  // transient (network / browser) → BullMQ retries

  }finally {
  if (repoPath) {

    await deleteRepo(
      repoPath
    );

    logger.info(
      `[VISUAL WORKER] Deleted repo ${repoPath}`
    );
  }
}
}

/**
 * Setup event handlers for worker
 */
function setupWorkerEvents() {
  if (!visualWorker) return;

  // Job completed
  visualWorker.on('completed', (job, result) => {
    logger.info(`Visual Job ${job.id} completed`, {
      duration: job.finishedOn - job.processedOn,
      students: result?.results?.length
    });
  });

  // Job failed
  visualWorker.on('failed', (job, err) => {
    logger.error(`Visual Job ${job.id} failed`, {
      error: err.message,
      attempts: job.attemptsMade,
      maxAttempts: job.attempts
    });
  });

  // Job started
  visualWorker.on('active', (job) => {
    logger.info(`Visual Job ${job.id} started processing`);
  });

  // Stalled job (took too long)
  visualWorker.on('stalled', (jobId) => {
    logger.warn(`Visual Job ${jobId} stalled`);
  });

  // Error in worker
  visualWorker.on('error', (err) => {
    logger.error('Visual Worker error:', err);
  });

  // Worker is ready
  visualWorker.on('ready', () => {
    logger.info('Visual Worker is ready');
  });

  // Worker connection closed
  visualWorker.on('closed', () => {
    logger.info('Visual Worker closed');
  });
}

/**
 * Graceful shutdown
 */
export async function stopVisualWorker() {
  try {
    logger.info('Stopping visual worker...');

    if (visualWorker) {
      await visualWorker.close();
    }

    // Close browser pool
    const browserPool = await getBrowserPool(BROWSER_POOL_SIZE).catch(() => null);
    if (browserPool) {
      await browserPool.close();
    }

    logger.info('Visual worker stopped');

  } catch (err) {
    logger.error('Error stopping visual worker:', err);
  }
}

/**
 * Get worker status
 */
export function getVisualWorkerStatus() {
  if (!visualWorker) {
    return { status: 'not_initialized' };
  }

  return {
    status: 'running',
    isRunning: !visualWorker.closing,
    concurrency: queueManager.getConfig('visual').concurrency
  };
}

export { visualWorker };