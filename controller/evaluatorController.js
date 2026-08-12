// src/controllers/evaluationController.js

import { routeEvaluation } from '../router/evaluationRouter.js';
import logger from '../config/logger.js';
import {
  assertSafeUrl,
  assertUrlSyntax,
  getAllowedGitHosts
} from '../evaluators/visual/utils/urlGuard.js';

const MAX_SUBMISSIONS = Number(process.env.MAX_SUBMISSIONS) || 500;
const MAX_RUBRIC_CHARS = Number(process.env.MAX_RUBRIC_CHARS) || 20000;

class ValidationError extends Error {}

// Validate + sanitize the visual payload (V-28) and its URLs (V-03).
async function validateVisualPayload(payload) {
  const { submissions, expectedUrl, rubricText } = payload;

  if (!Array.isArray(submissions) || submissions.length === 0) {
    throw new ValidationError('submissions must be a non-empty array');
  }
  if (submissions.length > MAX_SUBMISSIONS) {
    throw new ValidationError(`Too many submissions (max ${MAX_SUBMISSIONS})`);
  }
  if (typeof rubricText !== 'string' || !rubricText.trim()) {
    throw new ValidationError('rubricText is required');
  }
  if (rubricText.length > MAX_RUBRIC_CHARS) {
    throw new ValidationError(`rubricText too large (max ${MAX_RUBRIC_CHARS} chars)`);
  }
  if (typeof expectedUrl !== 'string') {
    throw new ValidationError('expectedUrl is required');
  }

  // Full SSRF check on the single reference URL.
  await assertSafeUrl(expectedUrl);

  // Fast syntactic + allowlist check on each repo URL (full DNS check runs at clone).
  const allowedHosts = getAllowedGitHosts();
  for (const s of submissions) {
    if (!s || typeof s.repoUrl !== 'string') {
      throw new ValidationError('each submission needs a repoUrl');
    }
    assertUrlSyntax(s.repoUrl, { allowedHosts });
  }
}

// Author: Arma Sahar (backendBugs.md #7)
// Backend submissions used to reach `extractSubmission()` (inside the
// worker, after the job was already queued and picked up) with zero
// validation — a malformed or malicious payload burned a full BullMQ
// attempt budget (3 retries, per queueManager.js) before failing, and the
// caller never got a clean 400. `visual` payloads already fail fast here,
// synchronously, before anything is queued; this brings `backend` in line
// with that. Only a syntax + allowlist check runs here (cheap, no DNS) —
// the full SSRF check (assertSafeUrl, with DNS resolution) still runs
// again right before the actual clone, same as the visual evaluator does.
function validateRubricCriteria(rubric) {
  if (!rubric || !Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    throw new ValidationError('rubric.criteria must be a non-empty array');
  }

  // Bug found during audit, confirmed by actually running evaluateResults():
  // a criterion missing/with a non-numeric `weight` doesn't just score that
  // one criterion wrong — `maxScore += possiblePoints` accumulates a
  // running total, so one bad criterion turns the *entire* score NaN,
  // silently, for every submission graded against that rubric. Reject it
  // here instead of scoring every future submission as NaN.
  rubric.criteria.forEach((criterion, i) => {
    if (!criterion || typeof criterion.name !== 'string' || !criterion.name.trim()) {
      throw new ValidationError(`rubric.criteria[${i}] is missing a string "name".`);
    }
    if (typeof criterion.weight !== 'number' || !Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      throw new ValidationError(`rubric.criteria[${i}] ("${criterion.name}") must have a positive numeric "weight".`);
    }
  });
}

function validateBackendPayload(payload) {
  const { repoUrl, rubric } = payload;

  if (typeof repoUrl !== 'string' || !repoUrl.trim()) {
    throw new ValidationError('repoUrl is required');
  }
  assertUrlSyntax(repoUrl, { allowedHosts: getAllowedGitHosts() });

  validateRubricCriteria(rubric);
}

function validatePythonPayload(payload) {
  const { submissions } = payload;
  if (!Array.isArray(submissions) || submissions.length === 0) {
    throw new ValidationError('submissions must be a non-empty array');
  }
  const allowedHosts = getAllowedGitHosts();
  for (const s of submissions) {
    if (!s || typeof s.repoUrl !== 'string') {
      throw new ValidationError('each submission needs a repoUrl');
    }
    assertUrlSyntax(s.repoUrl, { allowedHosts });
  }
}

// react. repoUrl + rubric. same criteria shape as backend.
function validateReactPayload(payload) {
  const { repoUrl, rubric } = payload;
  if (typeof repoUrl !== 'string' || !repoUrl.trim()) {
    throw new ValidationError('repoUrl is required');
  }
  assertUrlSyntax(repoUrl, { allowedHosts: getAllowedGitHosts() });
  validateRubricCriteria(rubric);
}

export async function evaluate(req, res) {
  try {
    const payload = req.body || {};

    if (!payload.type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: type'
      });
    }

    if (payload.type === 'visual') {
      await validateVisualPayload(payload);
    }

    if (payload.type === 'backend') {
      validateBackendPayload(payload);
    }
    
    if (payload.type === 'python') {
      validatePythonPayload(payload);
    }
    
    if (payload.type === 'react') {
      validateReactPayload(payload);
    }

    const jobs = await routeEvaluation(payload);

    logger.info('Evaluation job created', { type: payload.type });

    if (Array.isArray(jobs)) {
      return res.json({
        success: true,
        jobs: jobs.map(job => ({
          jobId: job.id,
          statusUrl: `/jobs/${payload.type}/${job.id}`
        }))
      });
    }

    return res.json({
      success: true,
      jobId: jobs.id,
      statusUrl: `/jobs/${payload.type}/${jobs.id}`
    });

  } catch (err) {
    // Bad input → 400; everything else → 500.
    const isBadInput =
      err instanceof ValidationError ||
      /Invalid URL|Disallowed URL scheme|Host not in allowlist|private\/loopback|DNS resolution failed/.test(
        err.message
      );

    if (isBadInput) {
      return res.status(400).json({ success: false, error: err.message });
    }

    logger.error('Evaluation error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
