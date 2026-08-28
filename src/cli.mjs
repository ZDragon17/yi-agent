import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { inspectLab, initLab, replayLab, recoverLab, runLab } from './application/agent-service.mjs';
import { challenge } from './application/challenge-service.mjs';
import { loadExternalWorldRegistry } from './application/external-world-registry.mjs';
import { restoreEffectBroker } from './effects/effect-broker.mjs';
import { EffectJournal } from './effects/effect-journal.mjs';
import { assertSandboxRoot, createSandboxFileExecutor } from './effects/sandbox-file-executor.mjs';
import { createOpenAICompatibleClient, loadApiConfig } from './api/openai-compatible-client.mjs';
import { createModelAdvisor } from './agent/model-advisor.mjs';

export async function main(argv, io = defaultIo()) {
  const json = argv.includes('--json');
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      io.stdout(helpText());
      return 0;
    }
    const { command, options } = parseArguments(argv);
    const data = await dispatch(command, options);
    const exitCode = data?.status === 'HALTED' || data?.verdict === 'FALSIFIED' ? 2 :
      data?.verdict === 'INCONSISTENT' ? 3 : 0;
    writeSuccess(io, data, json);
    return exitCode;
  } catch (error) {
    const failure = normalizeCliError(error);
    writeFailure(io, failure, json);
    return failure.exitCode;
  }
}

async function dispatch(command, options) {
  if (command === 'agent') return dispatchAgent(options);
  if (command === 'api') return dispatchApi(options);
  if (command === 'ask') return askApi(options);
  if (command === 'effect') return dispatchEffect(options);
  if (command === 'init') {
    const labPath = required(options, 'lab');
    const labId = options['lab-id'] ?? path.basename(path.resolve(labPath));
    const store = await initLab({
      labPath,
      labId,
      worldId: required(options, 'world'),
      seed: options.seed ?? 'seed-1',
       registry: loadRegistry(options),
    });
    return (await store.inspect()).manifest;
  }
  if (command === 'run') {
    return runLab({
      labPath: required(options, 'lab'),
      steps: parseSteps(required(options, 'steps')),
      runId: options['run-id'],
      scenario: options.scenario,
      registry: loadRegistry(options),
    });
  }
  if (command === 'inspect') {
    return inspectLab({
      labPath: required(options, 'lab'),
      runId: options.run,
      action: options.action,
      registry: loadRegistry(options, false),
    });
  }
  if (command === 'replay') {
    return replayLab({
      labPath: required(options, 'lab'),
      runId: required(options, 'run'),
      registry: loadRegistry(options, false),
    });
  }
  if (command === 'recover') {
    return recoverLab({
      labPath: required(options, 'lab'),
      confirmLockOwnerDead: options['confirm-lock-owner-dead'] === true,
    });
  }
  if (command === 'challenge') {
    return challenge({
      labPath: required(options, 'lab'),
      caseId: options.case,
    });
  }
  throw cliError('INVALID_INPUT', `Unsupported command: ${command ?? '(missing)'}`, {}, 64);
}

async function dispatchAgent(options) {
  const config = loadApiConfig();
  const advisor = createModelAdvisor({
    client: createOpenAICompatibleClient(config),
    model: config.model,
    goal: options.goal ?? null,
  });
  if (options.agentOperation !== 'run') {
    throw cliError('INVALID_INPUT', `Unsupported agent operation: ${options.agentOperation ?? '(missing)'}`, {}, 64);
  }
  return runLab({
    labPath: required(options, 'lab'),
    steps: parseSteps(required(options, 'steps')),
    runId: options['run-id'],
    scenario: options.scenario,
    registry: loadRegistry(options),
    advisor,
    goal: options.goal,
  });
}

async function dispatchApi(options) {
  const config = loadApiConfig();
  const client = createOpenAICompatibleClient(config);
  if (options.apiOperation === 'test') return client.testConnection();
  throw cliError('INVALID_INPUT', `Unsupported api operation: ${options.apiOperation ?? '(missing)'}`, {}, 64);
}

async function askApi(options) {
  const prompt = await readPrompt(options);
  const config = loadApiConfig();
  return createOpenAICompatibleClient(config).chat(prompt);
}

async function dispatchEffect(options) {
  const operation = options.effectOperation;
  const journalPath = requiredAbsolute(options, 'journal');
  const journal = await EffectJournal.open(journalPath);
  if (operation === 'inspect') {
    const nonces = [...new Set(journal.read().map((event) => event.executionNonce))];
    const broker = await restoreEffectBroker({ journal, executor: inertExecutor() });
    return {
      journal: journalPath,
      effects: nonces.map((executionNonce) => broker.get(executionNonce)),
    };
  }

  const sandboxRoot = requiredAbsolute(options, 'sandbox-root');
  await assertSandboxRoot(sandboxRoot);
  const broker = await restoreEffectBroker({
    journal,
    executor: createSandboxFileExecutor({ sandboxRoot }),
  });
  if (operation === 'plan') return broker.plan(await readIntentFile(requiredAbsolute(options, 'intent')));

  const executionNonce = required(options, 'nonce');
  if (operation === 'confirm') return broker.confirm(executionNonce);
  if (operation === 'execute') return broker.execute(executionNonce);
  if (operation === 'reconcile') return broker.reconcile(executionNonce);
  if (operation === 'compensate') return broker.compensate(executionNonce);
  if (operation === 'reconcile-compensation') return broker.reconcileCompensation(executionNonce);
  throw cliError('INVALID_INPUT', `Unsupported effect operation: ${operation ?? '(missing)'}`, {}, 64);
}

function parseArguments(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {};
  if (command === 'effect') {
    const operation = args.shift();
    if (!['plan', 'confirm', 'execute', 'reconcile', 'compensate', 'reconcile-compensation', 'inspect'].includes(operation)) {
      throw cliError('INVALID_INPUT', `Unsupported effect operation: ${operation ?? '(missing)'}`, {}, 64);
    }
    options.effectOperation = operation;
  }
  if (command === 'api') {
    const operation = args.shift();
    if (operation !== 'test') {
      throw cliError('INVALID_INPUT', `Unsupported api operation: ${operation ?? '(missing)'}`, {}, 64);
    }
    options.apiOperation = operation;
  }
  if (command === 'agent') {
    const operation = args.shift();
    if (operation !== 'run') {
      throw cliError('INVALID_INPUT', `Unsupported agent operation: ${operation ?? '(missing)'}`, {}, 64);
    }
    options.agentOperation = operation;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') continue;
    if (!argument.startsWith('--')) throw cliError('INVALID_INPUT', `Unexpected argument: ${argument}`, {}, 64);
    const name = argument.slice(2);
    if (name === 'confirm-lock-owner-dead') {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw cliError('INVALID_INPUT', `Option requires a value: --${name}`, { field: name }, 64);
    }
    options[name] = value;
    index += 1;
  }
  const allowed = {
    agent: ['agentOperation', 'lab', 'steps', 'run-id', 'scenario', 'adapter', 'goal'],
    api: ['apiOperation'],
    ask: ['prompt', 'prompt-file'],
    init: ['lab', 'lab-id', 'world', 'seed', 'adapter'],
    run: ['lab', 'run-id', 'steps', 'scenario', 'adapter'],
    inspect: ['lab', 'run', 'action', 'adapter'],
    replay: ['lab', 'run', 'adapter'],
    recover: ['lab', 'confirm-lock-owner-dead'],
    challenge: ['lab', 'case'],
    effect: ['effectOperation', 'journal', 'sandbox-root', 'intent', 'nonce'],
  }[command] ?? [];
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw cliError('INVALID_INPUT', `Unknown option: --${name}`, { field: name }, 64);
  }
  return { command, options };
}

async function readPrompt(options) {
  const direct = options.prompt;
  const file = options['prompt-file'];
  if (direct !== undefined && file !== undefined) {
    throw cliError('INVALID_INPUT', 'Use either --prompt or --prompt-file, not both.', { field: 'prompt' }, 64);
  }
  if (direct === undefined && file === undefined) {
    throw cliError('INVALID_INPUT', 'Missing required option: --prompt or --prompt-file', { field: 'prompt' }, 64);
  }
  if (direct !== undefined) {
    if (direct === '-') return readStdinPrompt();
    return direct;
  }
  let prompt;
  try {
    prompt = await readFile(path.resolve(file), 'utf8');
  } catch (error) {
    throw Object.assign(new Error('Prompt file could not be read.'), { code: error?.code ?? 'EIO', context: { filePath: path.resolve(file) } });
  }
  return prompt;
}

async function readStdinPrompt() {
  try {
    return await readFile(0, 'utf8');
  } catch (error) {
    throw Object.assign(new Error('Prompt could not be read from stdin.'), { code: error?.code ?? 'EIO' });
  }
}

async function readIntentFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw Object.assign(new Error('Effect intent file could not be read.'), { code: error?.code ?? 'EIO', context: { filePath } });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError('INVALID_INPUT', 'Effect intent file is not valid JSON.', { filePath }, 64);
  }
}

function requiredAbsolute(options, name) {
  const value = required(options, name);
  if (!path.isAbsolute(value)) throw cliError('INVALID_INPUT', `${name} must be an absolute path.`, { field: name }, 64);
  return path.normalize(value);
}

function inertExecutor() {
  return {
    async execute() { return { status: 'UNKNOWN' }; },
    async reconcile() { return { status: 'UNKNOWN' }; },
    async compensate() { return { status: 'UNKNOWN' }; },
    async reconcileCompensation() { return { status: 'UNKNOWN' }; },
  };
}

function loadRegistry(options, probe = true) {
  return options.adapter === undefined
    ? undefined
    : loadExternalWorldRegistry(required(options, 'adapter'), { probe });
}

function parseSteps(value) {
  if (!/^\d+$/u.test(value)) throw cliError('INVALID_INPUT', 'steps must be an integer from 1 to 10000.', { field: 'steps' }, 64);
  const steps = Number(value);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 10_000) {
    throw cliError('INVALID_INPUT', 'steps must be an integer from 1 to 10000.', { field: 'steps' }, 64);
  }
  return steps;
}

function required(options, name) {
  if (typeof options[name] !== 'string' || options[name].length === 0) {
    throw cliError('INVALID_INPUT', `Missing required option: --${name}`, { field: name }, 64);
  }
  return options[name];
}

function normalizeCliError(error) {
  const code = error?.code ?? error?.cause?.code;
  const exitCode = code === 'INVALID_INPUT' ? 64 :
    code === 'CONFLICT' ? 65 :
      code === 'NOT_FOUND' || code === 'ENOENT' ? 66 :
          code === 'CORRUPT' ? 3 :
            code === 'BUSY' || code === 'LIVE_OWNER' ? 75 :
              code === 'API_ERROR' ? 74 :
                code === 'API_PROTOCOL_ERROR' ? 70 :
              code && /^E[A-Z]+$/u.test(code) ? 74 : 70;
  return {
    code: code ?? 'INTERNAL',
    message: error?.message ?? 'Internal error.',
    context: error?.context ?? {},
    recoverable: [64, 65, 66, 74, 75].includes(exitCode),
    exitCode,
  };
}

function cliError(code, message, context, exitCode) {
  return Object.assign(new Error(message), { code, context, exitCode });
}

function writeSuccess(io, data, json) {
  if (json) io.stdout(`${JSON.stringify({ schemaVersion: 1, ok: true, data })}\n`);
  else io.stdout(`${JSON.stringify(data, null, 2)}\n`);
}

function writeFailure(io, failure, json) {
  const envelope = {
    schemaVersion: 1,
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      context: failure.context,
      recoverable: failure.recoverable,
    },
  };
  if (json) io.stdout(`${JSON.stringify(envelope)}\n`);
  else io.stderr(`${JSON.stringify(envelope, null, 2)}\n`);
}

function defaultIo() {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

function helpText() {
  return [
    'yi-agent - 易闭环 Agent CLI',
    '',
    'API:',
    '  yi-agent api test [--json]',
    '  yi-agent ask --prompt TEXT [--json]',
    '  yi-agent ask --prompt - [--json]              从 stdin 读取',
    '  yi-agent ask --prompt-file PATH [--json]',
    '  yi-agent agent run --lab PATH --steps N [--goal TEXT] [--json]',
    '',
    '实验室:',
    '  yi-agent init|run|inspect|replay|recover|challenge ...',
    '  yi-agent effect plan|confirm|execute|reconcile|compensate|inspect ...',
    '',
    'API 环境变量: YI_AGENT_PROVIDER, YI_AGENT_API_KEY/ZAI_API_KEY, YI_AGENT_API_BASE_URL, YI_AGENT_MODEL, YI_AGENT_API_TIMEOUT_MS',
  ].join('\n') + '\n';
}
