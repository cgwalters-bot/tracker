'use strict';

// This is the boundary for agent-produced data, not an agent instruction.
// Prompt injection in logs/issues must not turn the future executor into an
// arbitrary API client. Validate the WHOLE batch before producing any command.
const schemas = {
  rerun: ['run'], cancel: ['run'],
  close: ['item', 'reason'], reopen: ['item', 'reason'],
  add_label: ['item', 'label'], remove_label: ['item', 'label'],
  enqueue: ['item'], dequeue: ['item'],
  set_variable: ['name', 'value'],
  reset_checkpoint: ['comment'],
  dispatch: ['item', 'kind', 'pool'],
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
  const requests = source.trim() === '' ? [] : source.trim().split('\n').map(line => JSON.parse(line));
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
    if (!repository(repo) || repo.split('/')[0] !== policy.organization ||
        !policy.repositories.includes(repo)) throw new Error('Repository outside supervisor policy');
    for (const key of ['run', 'item', 'comment']) {
      if (Object.hasOwn(request, key) && !positive(request[key])) throw new Error('Malformed supervisor target');
    }
    if (Object.hasOwn(request, 'reason') && !text(request.reason, 2000)) throw new Error('Invalid reason');
    if (Object.hasOwn(request, 'body') && !text(request.body, 8000)) throw new Error('Invalid body');
    if (Object.hasOwn(request, 'label') && (!text(request.label, 50) || /[\r\n]/.test(request.label))) {
      throw new Error('Invalid label');
    }
    if (request.action === 'set_variable' &&
        (typeof request.name !== 'string' || !Object.hasOwn(policy.variables, request.name) ||
         !Array.isArray(policy.variables[request.name]) ||
         !policy.variables[request.name].includes(request.value) || typeof request.value !== 'string')) {
      throw new Error('Variable or value outside supervisor allowlist');
    }
    if (request.action === 'dispatch' &&
        (!policy.kinds.includes(request.kind) || !policy.pools.includes(request.pool))) {
      throw new Error('Dispatch kind or pool outside supervisor allowlist');
    }
    if (request.action === 'edit_log' && (repo !== policy.log.repository || request.item !== policy.log.issue)) {
      throw new Error('Only the configured supervisor log may be edited');
    }
    return Object.freeze({ ...request });
  });
}

// No CLI or write path yet: the runner must first support this safe-output
// type and bind its artifact to the health-triggered run. Live execution must
// also authenticate checkpoint/log ownership and PR targets before mutation.
module.exports = { validateBatch };
