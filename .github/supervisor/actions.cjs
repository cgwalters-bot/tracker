'use strict';

// This is the boundary for agent-produced data, not an agent instruction.
// Prompt injection in logs/issues must not turn the executor (execute.cjs) into an
// arbitrary API client. Validate the WHOLE batch before producing any command.
const schemas = {
  rerun: ['run'], cancel: ['run'],
  // State and label changes can release scheduler holds or close people's PRs.
  // Dispatch is also left to the operator until it has a durable budget cap.
  // No enqueue: queueing a pull request merges it once its checks pass, and
  // that is the operator's decision, not an agent's that read public text.
  dequeue: ['item'],
  set_variable: ['name', 'value'],
  reset_checkpoint: ['comment'],
  comment: ['item', 'body'], edit_log: ['item', 'body'],
};

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function text(value, max) {
  return typeof value === 'string' && value.trim().length > 0 &&
    Buffer.byteLength(value) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function repository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) &&
    value.length <= 140;
}

function validateBatch(source, policy) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 32768) {
    throw new Error('Supervisor requests exceed 32 KiB');
  }
  const requests = source.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
  if (requests.length > 10) throw new Error('Supervisor permits at most ten requests');
  if (!policy || !Array.isArray(policy.repositories) || !policy.repositories.every(repository) ||
      typeof policy.organization !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(policy.organization) ||
      !repository(policy.log?.repository) || !positive(policy.log?.issue) ||
      !Array.isArray(policy.kinds) || !Array.isArray(policy.pools) ||
      !policy.variables || typeof policy.variables !== 'object' || Array.isArray(policy.variables)) {
    throw new Error('Invalid supervisor policy');
  }
  return requests.map(request => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        request.type !== 'supervisor_action' || typeof request.action !== 'string' ||
        !Object.hasOwn(schemas, request.action)) {
      throw new Error('Unknown supervisor action');
    }
    const fields = ['type', 'action', 'repository', ...schemas[request.action]];
    if (Object.keys(request).length !== fields.length || !fields.every(key => Object.hasOwn(request, key))) {
      throw new Error('Unexpected or missing supervisor fields');
    }
    const repo = request.repository;
    // The log's repository is the operator's private one: the agent may write
    // to the log issue there and nothing else, not the decisions document.
    const toLog = repo === policy.log.repository && ['comment', 'edit_log'].includes(request.action) &&
      request.item === policy.log.issue;
    if (!repository(repo) || repo.split('/')[0] !== policy.organization ||
        !(policy.repositories.includes(repo) || toLog)) throw new Error('Repository outside supervisor policy');
    for (const key of ['run', 'item', 'comment']) {
      if (Object.hasOwn(request, key) && !positive(request[key])) throw new Error('Malformed supervisor target');
    }
    // Posted as the bot, whose comments the coordinator and scheduler trust:
    // a hidden marker or a fenced block could forge a checkpoint, a dispatch
    // record, a plan or a triage verdict. Slash commands can start workflows
    // too: the PAT user is admitted by its collaborator role, not bot rules.
    for (const key of ['reason', 'body']) {
      if (Object.hasOwn(request, key) && (!text(request[key], key === 'body' ? 8000 : 2000) ||
          request[key].includes('<!--') || /^[ \t>]*(```|~~~)/m.test(request[key]) ||
          request[key].trimStart().startsWith('/'))) {
        throw new Error(`Invalid ${key}`);
      }
    }
    if (request.action === 'set_variable' &&
        (typeof request.name !== 'string' || !Object.hasOwn(policy.variables, request.name) ||
         !Array.isArray(policy.variables[request.name]) ||
         !policy.variables[request.name].includes(request.value) || request.value !== 'off')) {
      throw new Error('Variable or value outside supervisor allowlist');
    }
    if (request.action === 'edit_log' && (repo !== policy.log.repository || request.item !== policy.log.issue)) {
      throw new Error('Only the configured supervisor log may be edited');
    }
    return Object.freeze({ ...request });
  });
}

// The policy comes from the default branch's configuration alone, never a
// dispatcher's input: the scheduler's owner and repositories, the log issue,
// and the pools dispatch.yml knows. Null until the requests and log issues
// are configured, which keeps the agent and the executor off.
function policyFrom(cfg, settings, pools) {
  const agent = cfg.agent;
  if (!agent?.requests || !agent?.log) return null;
  return {
    organization: settings.schedule.owner,
    repositories: settings.schedule.repositories,
    log: agent.log, requests: agent.requests,
    variables: agent.variables, kinds: agent.kinds, pools: Object.keys(pools),
    bot: settings.bot, dispatchRepo: settings.dispatchRepo, dispatchWorkflow: settings.dispatchWorkflow,
    epicsRepository: settings.epics.repository,
  };
}

module.exports = { validateBatch, policyFrom };
