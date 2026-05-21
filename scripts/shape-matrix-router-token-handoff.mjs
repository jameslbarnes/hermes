#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const matrixServerUrl = process.env.MATRIX_SERVER_URL || 'https://mtrx.shaperotator.xyz';
const expectedUserId = process.env.MATRIX_EXPECTED_USER_ID || '@router:mtrx.shaperotator.xyz';
const token = process.env.MATRIX_ACCESS_TOKEN?.trim();
const explicitDeviceId = process.env.MATRIX_DEVICE_ID?.trim();
const teleportRouterRepo = process.env.TELEPORT_ROUTER_REPO || 'jameslbarnes/teleport-router';
const routerTeamworkRepo = process.env.ROUTER_TEAMWORK_REPO || 'teleport-computer/router-teamwork';
const apply = process.env.SHAPE_MATRIX_TOKEN_HANDOFF_APPLY === '1';
const dispatch = process.env.SHAPE_MATRIX_TOKEN_HANDOFF_DISPATCH === '1';

function fail(message) {
  console.error(`[shape-matrix-router-token-handoff] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[shape-matrix-router-token-handoff] ${message}`);
}

function localpartFromMxid(mxid) {
  const match = /^@([^:]+):/.exec(mxid);
  if (!match) fail(`expected Matrix user id must be an MXID, got ${mxid}`);
  return match[1];
}

async function matrixWhoami() {
  if (!token) fail('MATRIX_ACCESS_TOKEN is required');
  const res = await fetch(`${matrixServerUrl.replace(/\/$/, '')}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`/whoami returned non-JSON HTTP ${res.status}`);
  }
  if (!res.ok) {
    const code = body.errcode || body.error || `HTTP ${res.status}`;
    fail(`/whoami rejected the supplied token: ${code}`);
  }
  if (body.user_id !== expectedUserId) {
    fail(`/whoami returned ${body.user_id || '(missing user_id)'}, expected ${expectedUserId}`);
  }
  return body;
}

function runGh(args, input) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    fail(`gh ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout.trim();
}

function setSecret(repo, name, value) {
  if (!value) return;
  if (!apply) {
    log(`dry-run: would set ${repo} secret ${name}`);
    return;
  }
  runGh(['secret', 'set', name, '--repo', repo], value);
  log(`set ${repo} secret ${name}`);
}

function dispatchWorkflow(repo, workflow, ref, fields = []) {
  if (!dispatch) return;
  const args = ['workflow', 'run', workflow, '--repo', repo, '--ref', ref];
  for (const [key, value] of fields) args.push('-f', `${key}=${value}`);
  runGh(args);
  log(`dispatched ${repo} ${workflow} on ${ref}`);
}

const whoami = await matrixWhoami();
const botHandle = localpartFromMxid(expectedUserId);
const deviceId = explicitDeviceId || whoami.device_id || '';

log(`validated Matrix token for ${whoami.user_id}${deviceId ? ` device=${deviceId}` : ''}`);
if (!apply) {
  log('dry-run only; set SHAPE_MATRIX_TOKEN_HANDOFF_APPLY=1 to update GitHub secrets');
}

setSecret(teleportRouterRepo, 'MATRIX_ACCESS_TOKEN', token);
setSecret(teleportRouterRepo, 'MATRIX_USER_ID', expectedUserId);
setSecret(teleportRouterRepo, 'MATRIX_BOT_HANDLE', botHandle);
if (deviceId) setSecret(teleportRouterRepo, 'MATRIX_DEVICE_ID', deviceId);

setSecret(routerTeamworkRepo, 'SHAPE_MATRIX_ACCESS_TOKEN', token);
setSecret(routerTeamworkRepo, 'SHAPE_MATRIX_HOMESERVER', matrixServerUrl);
setSecret(routerTeamworkRepo, 'SHAPE_MATRIX_BOT_HANDLE', botHandle);

dispatchWorkflow(teleportRouterRepo, 'build.yml', 'master', [['deploy', 'true']]);
dispatchWorkflow(routerTeamworkRepo, 'deploy.yml', 'main');

if (!dispatch) {
  log('secrets ready; set SHAPE_MATRIX_TOKEN_HANDOFF_DISPATCH=1 to dispatch both deploy workflows');
  log(`manual deploy commands:
  gh workflow run build.yml --repo ${teleportRouterRepo} --ref master -f deploy=true
  gh workflow run deploy.yml --repo ${routerTeamworkRepo} --ref main`);
}
