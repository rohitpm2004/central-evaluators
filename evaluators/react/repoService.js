import path from 'path';
import fs from 'fs';
import { simpleGit } from 'simple-git';
import { assertSafeUrl, getAllowedGitHosts } from '../visual/utils/urlGuard.js';
import { parseGithubTreeUrl } from '../backend/extractService.js';

const TEMP_DIR = path.join(process.cwd(), 'temp');

export async function cloneRepo(repoUrl) {
  if (!repoUrl) {
    throw new Error('repoUrl is required');
  }

  const parsedGithub = parseGithubTreeUrl(repoUrl);
  const actualCloneUrl = parsedGithub ? parsedGithub.cloneUrl : repoUrl;

  await assertSafeUrl(actualCloneUrl, { allowedHosts: getAllowedGitHosts() });

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const repoName = `repo_${Date.now()}`;
  const repoPath = path.join(TEMP_DIR, repoName);

  const cloneArgs = ['--depth', '1'];
  if (parsedGithub && parsedGithub.branch) {
    cloneArgs.push('--branch', parsedGithub.branch);
  }
  cloneArgs.push('--');

  await simpleGit().clone(actualCloneUrl, repoPath, cloneArgs);

  return repoPath;
}

export async function deleteRepo(repoPath) {
  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch (err) {
    console.error(`[REPO CLEANUP ERROR] ${err.message}`);
  }
}