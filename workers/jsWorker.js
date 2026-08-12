import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { generateJSAIFeedback } from '../evaluators/js/aiFeedback.js';

let jsWorker = null;

export async function initializeJsWorker() {
  try {
    logger.info('Initializing JavaScript Worker...');

    const config = queueManager.getConfig('javascript');

    jsWorker = new Worker(
      'javascript-evaluation',
      async (job) => {
        try {
          logger.info(`Starting JS evaluation via GitHub Actions: ${job.id}`);
          const {
            submission,
            testCases,
            entryFunction,
            evaluationMode,
            expectedLogs,
            functions
          } = job.data;

          const results = await withTimeout(
            new Promise((resolve, reject) => {
              const subscriber = redisConnection.getClient().duplicate();
              let timeoutId;
              
              subscriber.subscribe(`github_webhook_${job.id}`, async (err) => {
                if (err) {
                  await subscriber.quit();
                  return reject(err);
                }
                
                timeoutId = setTimeout(async () => {
                  await subscriber.quit();
                  reject(new Error("GitHub Actions webhook timeout"));
                }, config.timeout);
                
                try {
                  const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
                  const repoUrl = submission.repoUrl;
                  const extraPayload = {
                    testCases,
                    entryFunction,
                    evaluationMode,
                    expectedLogs,
                    functions
                  };
                  
                  await triggerGraderWorkflow(repoUrl, job.id, webhookUrl, 'run-js-evaluation', extraPayload);
                } catch (e) {
                  clearTimeout(timeoutId);
                  await subscriber.quit();
                  return reject(e);
                }
              });

              subscriber.on('message', async (channel, message) => {
                if (channel === `github_webhook_${job.id}`) {
                  clearTimeout(timeoutId);
                  await subscriber.quit();
                  try {
                    const payload = JSON.parse(message);
                    if (payload.status === 'completed') {
                      resolve(payload.evaluation || {
                        passed: false,
                        score: 0,
                        error: "Invalid evaluation payload received from GitHub Actions"
                      });
                    } else {
                      reject(new Error("GitHub Actions job failed or cancelled"));
                    }
                  } catch (parseErr) {
                    reject(parseErr);
                  }
                }
              });
            }),
            config.timeout,
            `js-eval ${job.id}`
          );
          
          logger.info(`JS Job ${job.id} completed via GitHub Actions. Generating AI feedback...`);
          
          const aiFeedbackString = await generateJSAIFeedback(job.data, results);
          results.feedback = aiFeedbackString;
          let finalScore = 0;
          if (evaluationMode === 'function') {
            const total = results.length;
            const passed = results.filter(r => r.passed).length;
            finalScore = total > 0 ? (passed / total) * 100 : 0;
          } else if (evaluationMode === 'script') {
            finalScore = results[0]?.score || 0;
          }

          return {
            success: true,
            studentId: submission.studentId,
            studentName: submission.studentName,
            evaluation: {
              score: finalScore,
              feedback: aiFeedbackString,
              details: results
            }
          };
        } catch (err) {
          logger.error(`JS Job ${job.id} failed`, err);
          throw err;
        }
      },
      {
        connection: redisConnection.getClient(),
        concurrency: config.concurrency,
        settings: {
          maxStalledCount: 2,
          lockDuration: 30000,
          lockRenewTime: 15000
        }
      }
    );

    // Event handlers
    jsWorker.on('completed', (job, result) => {
      logger.info(`JS Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    jsWorker.on('failed', (job, err) => {
      logger.error(`JS Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('JavaScript Worker initialized');
    return jsWorker;

  } catch (err) {
    logger.error('Failed to initialize JS worker:', err);
    throw err;
  }
}

export async function stopJsWorker() {
  try {
    if (jsWorker) {
      await jsWorker.close();
    }
    logger.info('JS worker stopped');
  } catch (err) {
    logger.error('Error stopping JS worker:', err);
  }
}

export function getJsWorkerStatus() {
  return {
    status: jsWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('javascript').concurrency
  };
}

export { jsWorker };
