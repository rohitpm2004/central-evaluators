import express from 'express';
import { handleGithubWebhook } from '../controller/webhookController.js';

const router = express.Router();

router.post('/github', handleGithubWebhook);

export default router;
