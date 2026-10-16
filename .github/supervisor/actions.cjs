'use strict';

// This is the boundary for agent-produced data, not an agent instruction.
// Prompt injection in logs/issues must not turn the executor (execute.cjs) into an
// arbitrary API client. Validate the WHOLE batch before producing any command.
const schemas = {
  rerun: ['run'], cancel: ['run'],
  // Each of these is narrowed by the executor's preflight (execute.cjs) to
  // the routine correction it exists for, so that injected text cannot use it
  // on human work: close only an issue a merged implement pull request of the
  // bot names; remove only needs-human the bot added during a probe failure,
  // only from the bot's pull requests; enqueue only the bot's pull request
  // approved at its head and clean.
  close: ['item', 'pull'],
  remove_label: ['item', 'label'],
  enqueue: ['item'],
  dequeue: ['item'],
  // A dispatch spends inference: the kinds and pools are the policy's, and the
  // caps below and in execute.cjs bound how many runs injected text can start.
  // No free text: a triage or research run posts plans as the bot, which the
  // scheduler accepts, so the executor writes the brief from REASONS and URLs.
  dispatch: ['item', 'kind', 'pool', 'reason'],
  set_variable: ['name', 'value'],
  reset_checkpoint: ['comment'],
  comment: ['item', 'body'], edit_log: ['item', 'body'],
};

const HOLD = 'needs-human';

// The dispatch brief's one variable sentence, as the scheduler's triageTask
// is fixed text: what the run reads is the issue and its links, as data.
const REASONS = {
  'no-plan': 'It has no accepted job plan.',
  'no-pull-request': 'Its last implement run ended without a pull request; its status comment on the issue says why.',
  'part-left': 'A merged pull request did only part of it.',
  'secret-shaped': 'Its last run\'s hand-back was refused for a secret-shaped string, so tests must build such values at run time.',
  'apply-refused': 'Its last run\'s safe outputs were refused by apply; that run\'s log names the code.',
  'blocker-closed': 'Its last run reported missing data naming a blocker that is closed now.',
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
  // Zero, or a cap left out of the configuration, admits no dispatch.
  const perPass = positive(policy.maxDispatchesPerPass) ? policy.maxDispatchesPerPass : 0;
  if (requests.filter(r => ['dispatch', 'remove_label'].includes(r?.action)).length > perPass) {
    throw new Error('More dispatches than the supervisor permits in one pass');
  }
  // A second run on the same item queues behind the first and spends the cap twice.
  const items = requests.filter(r => r?.action === 'dispatch').map(r => `${r.repository}#${r.item}`);
  if (new Set(items).size !== items.length) throw new Error('Two dispatches on one item');
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
    for (const key of ['run', 'item', 'comment', 'pull']) {
      if (Object.hasOwn(request, key) && !positive(request[key])) throw new Error('Malformed supervisor target');
    }
    // Posted as the bot, whose comments the coordinator and scheduler trust:
    // a hidden marker or a fenced block could forge a checkpoint, a dispatch
    // record, a plan or a triage verdict. Slash commands can start workflows
    // too: the PAT user is admitted by its collaborator role, not bot rules.
    for (const key of ['body']) {
      if (Object.hasOwn(request, key) && (!text(request[key], 8000) ||
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
    // A kind with a configured pool (agent-board.json's kindPools) runs only there.
    if (request.action === 'dispatch' && (typeof request.kind !== 'string' || !policy.kinds.includes(request.kind) ||
        typeof request.pool !== 'string' || !policy.pools.includes(request.pool) ||
        (Object.hasOwn(policy.kindPools ?? {}, request.kind) && policy.kindPools[request.kind] !== request.pool))) {
      throw new Error('Kind or pool outside supervisor policy');
    }
    if (request.action === 'dispatch' && (typeof request.reason !== 'string' || !Object.hasOwn(REASONS, request.reason))) {
      throw new Error('Dispatch reason outside supervisor allowlist');
    }
    // Only the hold, and only its removal: other labels drive the scheduler
    // and review (epic, question, agent-review).
    if (request.action === 'remove_label' && request.label !== HOLD) {
      throw new Error('Label outside supervisor allowlist');
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
    variables: agent.variables, kinds: agent.kinds, pools: Object.keys(pools), kindPools: settings.kindPools ?? {},
    maxDispatchesPerPass: agent.maxDispatchesPerPass, maxDispatchesPerDay: agent.maxDispatchesPerDay,
    implementBranchPrefix: cfg.implementBranchPrefix, probeWorkflow: cfg.probeWorkflow,
    bot: settings.bot, operator: settings.operator, dispatchRepo: settings.dispatchRepo, dispatchWorkflow: settings.dispatchWorkflow,
    epicsRepository: settings.epics.repository,
  };
}

module.exports = { HOLD, REASONS, validateBatch, policyFrom };
