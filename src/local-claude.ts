/**
 * Why this file exists: our server can use the user's own signed-in `claude`
 * program as its LLM, with no API key. This file finds that program, checks and
 * starts its login, and runs prompts through it. Without it, the Local Claude
 * option would have no way to reach the model.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What we know about the `claude` program and the user's login to it. */
export interface ClaudeAuthStatus {
  /** True if the `claude` program was found. */
  installed: boolean;
  /** Where the program was found. Null if it was not. */
  binaryPath: string | null;
  /** True if the user is signed in to Claude. */
  loggedIn: boolean;
  /** The signed-in account, usually an email. Null if unknown. */
  account: string | null;
  /** The raw reply of `claude auth status`. Null if it gave none. */
  authDetails: Record<string, unknown> | null;
  /** True if Local Claude is the LLM in use now and the user is signed in. */
  active: boolean;
  /** True while a browser login is waiting to finish. */
  loginInProgress: boolean;
  /** The sign-in page address the program printed. Null until it prints one. */
  loginUrl: string | null;
  /** The latest problem, shown to the user. Null if there is none. */
  lastError: string | null;
}

/** What one Local Claude prompt needs. */
export interface LocalClaudeGenerateArgs {
  systemPrompt: string;
  userPrompt: string;
  model?: string | null;
}

/**
 * Where the last search found the `claude` program.
 * Undefined: not searched yet. Null: searched and not found.
 */
let cachedBinary: string | null | undefined;

/** True while a browser login is running. */
let loginInProgress = false;

/** The sign-in page address printed by the running login. */
let loginUrl: string | null = null;

/** The latest problem with the program or the login. */
let lastError: string | null = null;

/** The running `claude auth login` process. Null if none. */
let loginChild: ChildProcess | null = null;

/** The timer that checks the login status. Null when not checking. */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Which LLM answers questions. Chosen at runtime, apart from the MOCK_AI embedding mode. */
export type LlmProvider = 'local-claude' | 'anthropic-api' | 'openai' | 'mock';

/** The provider in use now. Stays 'mock' until startup or a login changes it. */
let llmProvider: LlmProvider = 'mock';

/** Returns the LLM provider in use now. */
export function getLlmProvider(): LlmProvider {
  return llmProvider;
}

/** Switches the LLM provider for every request after this call. */
export function setLlmProvider({ provider }: { provider: LlmProvider }): void {
  llmProvider = provider;
}

/**
 * Picks the LLM provider when the server starts, before anyone signs in.
 * Sets the module's provider and returns it.
 *
 * If mock is forced, by option or by FORCE_MOCK_LLM=true: mock.
 * If LLM_PROVIDER is "openai" and OPENAI_API_KEY is set: openai.
 * If an Anthropic key is passed in or in ANTHROPIC_API_KEY: anthropic-api.
 * Otherwise: mock.
 * Local Claude is never picked here. It starts only after a login.
 */
export function initLlmProvider(opts: {
  forceMockLlm?: boolean;
  hasAnthropicKey?: boolean;
}): LlmProvider {
  if (opts.forceMockLlm || process.env.FORCE_MOCK_LLM === 'true') {
    llmProvider = 'mock';
    return llmProvider;
  }
  if (process.env.LLM_PROVIDER === 'openai' && process.env.OPENAI_API_KEY) {
    llmProvider = 'openai';
    return llmProvider;
  }
  if (opts.hasAnthropicKey || process.env.ANTHROPIC_API_KEY) {
    llmProvider = 'anthropic-api';
    return llmProvider;
  }
  llmProvider = 'mock';
  return llmProvider;
}

/** Turns a leading `~/` into the user's home folder. */
function expandHome({ p }: { p: string }): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** True if the path is a regular file we may run. Any error counts as false. */
function isExecutable({ filePath }: { filePath: string }): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks for `claude` in each Node version that nvm installed, newest version first.
 * If there is no nvm folder, or it cannot be read: returns null.
 */
function findNvmClaude(): string | null {
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (!fs.existsSync(nvmRoot)) return null;
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(nvmRoot);
  } catch {
    return null;
  }
  const sorted = versions
    .filter((v) => /^v?\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => {
      const pa = a
        .replace(/^v/, '')
        .split('.')
        .map((n) => Number(n) || 0);
      const pb = b
        .replace(/^v/, '')
        .split('.')
        .map((n) => Number(n) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });
  for (const ver of sorted) {
    const candidate = path.join(nvmRoot, ver, 'bin', 'claude');
    if (isExecutable({ filePath: candidate })) return candidate;
  }
  return null;
}

/** Looks for a program in each PATH folder. Returns null if none has it. */
function findOnPath({ name }: { name: string }): string | null {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable({ filePath: candidate })) return candidate;
  }
  return null;
}

/**
 * Finds the `claude` program and returns its path, or null if it is not installed.
 * Looks in this order: CLAUDE_CLI_PATH, the PATH folders, nvm, then common install folders.
 * Keeps the answer, a miss included. `forceRefresh` searches again.
 * Without the kept answer, every prompt would search the disk again.
 */
export function discoverClaudeBinary({ forceRefresh = false }: { forceRefresh?: boolean } = {}):
  string | null {
  if (!forceRefresh && cachedBinary !== undefined) return cachedBinary;

  const fromEnv = process.env.CLAUDE_CLI_PATH;
  if (fromEnv && isExecutable({ filePath: expandHome({ p: fromEnv }) })) {
    cachedBinary = expandHome({ p: fromEnv });
    return cachedBinary;
  }

  const fromPath = findOnPath({ name: 'claude' });
  if (fromPath) {
    cachedBinary = fromPath;
    return cachedBinary;
  }

  const nvm = findNvmClaude();
  if (nvm) {
    cachedBinary = nvm;
    return cachedBinary;
  }

  const extras = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const p of extras) {
    if (isExecutable({ filePath: p })) {
      cachedBinary = p;
      return cachedBinary;
    }
  }

  cachedBinary = null;
  return null;
}

/**
 * Builds the environment for running the `claude` program.
 *
 * PATH gets extra folders. A server started from a desktop app may lack the folder
 * with `node`, and `claude` needs it to start.
 * If ANTHROPIC_API_KEY is blank: it is removed, so the program uses the user's login.
 * CLAUDECODE is removed, because `claude` refuses to start when launched inside Claude Code.
 */
export function claudeSpawnEnv({ binaryPath }: { binaryPath: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binDir = path.dirname(binaryPath);
  const nodeCandidates = [
    binDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
  ];
  /** If `claude` lives under nvm: also add that Node version's bin folder, first. */
  const parts = binaryPath.split(path.sep);
  const nodeIdx = parts.lastIndexOf('node');
  if (nodeIdx >= 0 && parts[nodeIdx + 1]) {
    nodeCandidates.unshift(
      path.join(os.homedir(), '.nvm', 'versions', 'node', parts[nodeIdx + 1], 'bin'),
    );
  }
  const extra = nodeCandidates.filter((d) => fs.existsSync(d)).join(path.delimiter);
  env.PATH = extra ? `${extra}${path.delimiter}${env.PATH || ''}` : env.PATH;

  /** A blank key would be used instead of the user's login. Remove it. */
  if (!env.ANTHROPIC_API_KEY || String(env.ANTHROPIC_API_KEY).trim() === '') {
    delete env.ANTHROPIC_API_KEY;
  }
  /** The program blocks being started from inside another Claude Code session. */
  delete env.CLAUDECODE;

  return env;
}

type RunClaudeParams = {
  binaryPath: string;
  args: string[];
  opts?: { timeoutMs?: number; input?: string };
};

/**
 * Runs the `claude` program once and collects what it printed.
 * Starts a process and writes `opts.input` to its input, if given.
 *
 * Normally: resolves with the exit code, output and error text, even for a non-zero exit.
 * If the program does not finish in `opts.timeoutMs` (60000 if unset): stops it and rejects.
 * If the program cannot start: rejects.
 */
function runClaude({
  binaryPath,
  args,
  opts = {},
}: RunClaudeParams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      env: claudeSpawnEnv({ binaryPath }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude ${args.join(' ')} timed out after ${opts.timeoutMs || 60000}ms`));
    }, opts.timeoutMs || 60000);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (opts.input != null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Reads the JSON that `claude auth status` printed. Returns null if there is none.
 * The program may print other text first, so the last JSON object is used.
 * If that fails: tries each line, last line first.
 */
function parseAuthJson({ raw }: { raw: string }): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}\s*$/);
  const candidate = match ? match[0] : text;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    for (const line of text.split(/\r?\n/).reverse()) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        return JSON.parse(t) as Record<string, unknown>;
      } catch {
        /* continue */
      }
    }
    return null;
  }
}

/**
 * Says whether the auth status shows a signed-in user.
 * Reads the first of these that exists: loggedIn, authenticated, logged_in.
 * Otherwise: an email, account or subscriptionType field means signed in.
 * Otherwise: signed in only if the program exited with 0 and printed JSON.
 */
function isLoggedInFromPayload({
  payload,
  exitCode,
}: {
  payload: Record<string, unknown> | null;
  exitCode: number | null;
}): boolean {
  if (payload) {
    if (typeof payload.loggedIn === 'boolean') return payload.loggedIn;
    if (typeof payload.authenticated === 'boolean') return payload.authenticated;
    if (typeof payload.logged_in === 'boolean') return payload.logged_in as boolean;
    if (payload.email || payload.account || payload.subscriptionType) return true;
  }
  return exitCode === 0 && Boolean(payload);
}

/**
 * Returns the account name from the auth status.
 * Takes the first of email, account, userEmail and username. Null if none exists.
 */
function accountFromPayload({
  payload,
}: {
  payload: Record<string, unknown> | null;
}): string | null {
  if (!payload) return null;
  const email = payload.email || payload.account || payload.userEmail || payload.username;
  return email != null ? String(email) : null;
}

/**
 * Asks `claude auth status --json` whether the program is installed and signed in.
 * Starts a process, waits at most 15 seconds, and updates the stored last error.
 *
 * If the program is missing: `installed` is false and the error says how to install it.
 * If the status call fails or times out: `loggedIn` is false and the error says why.
 * Always searches for the program again, so a fresh install is noticed.
 */
export async function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  const binaryPath = discoverClaudeBinary({ forceRefresh: true });
  if (!binaryPath) {
    return {
      installed: false,
      binaryPath: null,
      loggedIn: false,
      account: null,
      authDetails: null,
      active: llmProvider === 'local-claude',
      loginInProgress,
      loginUrl,
      lastError:
        lastError || 'Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code',
    };
  }

  try {
    const { code, stdout, stderr } = await runClaude({
      binaryPath,
      args: ['auth', 'status', '--json'],
      opts: {
        timeoutMs: 15000,
      },
    });
    const payload = parseAuthJson({ raw: stdout }) || parseAuthJson({ raw: stderr });
    const loggedIn = isLoggedInFromPayload({ payload, exitCode: code });
    lastError = null;
    return {
      installed: true,
      binaryPath,
      loggedIn,
      account: accountFromPayload({ payload }),
      authDetails: payload,
      active: llmProvider === 'local-claude' && loggedIn,
      loginInProgress,
      loginUrl,
      lastError: null,
    };
  } catch (err) {
    lastError = String((err as Error).message || err);
    return {
      installed: true,
      binaryPath,
      loggedIn: false,
      account: null,
      authDetails: null,
      active: false,
      loginInProgress,
      loginUrl,
      lastError,
    };
  }
}

/** Returns the first https address in the text, without trailing punctuation. Null if none. */
function extractHttpsUrl({ text }: { text: string }): string | null {
  const m = text.match(/https:\/\/[^\s"'<>]+/);
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

/** Stops the timer that checks the login status. */
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Checks the login status every 1.5 seconds until the user is signed in or time runs out.
 * Resolves with the last status. The default wait is 120 seconds.
 *
 * If the user signs in: stops checking and makes Local Claude the LLM provider.
 * If time runs out: stops checking and stores a timeout error for the user to see.
 */
async function pollUntilLoggedIn({
  timeoutMs = 120_000,
}: { timeoutMs?: number } = {}): Promise<ClaudeAuthStatus> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const status = await checkClaudeAuth();
      if (status.loggedIn) {
        loginInProgress = false;
        stopPolling();
        setLlmProvider({ provider: 'local-claude' });
        status.active = true;
        status.loginInProgress = false;
        resolve(status);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        loginInProgress = false;
        stopPolling();
        lastError = 'Timed out waiting for Claude login (120s). Try again.';
        status.loginInProgress = false;
        status.lastError = lastError;
        resolve(status);
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 1500);
  });
}

/**
 * Starts the browser sign-in with `claude auth login --claudeai`.
 * Starts a process and begins checking the login status in the background.
 * Returns at once. The page checks the status later to learn the result.
 *
 * If the program is missing: returns `ok: false` with the reason.
 * If the user is already signed in: makes Local Claude the LLM provider and returns.
 * If a login is already running: returns without starting another.
 * Otherwise: starts the login and returns with `loginInProgress` true.
 * `loginUrl` may still be null in that reply, because the program prints it a moment later.
 */
export async function startClaudeLogin(): Promise<{
  ok: boolean;
  alreadyLoggedIn?: boolean;
  active: boolean;
  status: ClaudeAuthStatus;
  message?: string;
}> {
  const status = await checkClaudeAuth();
  if (!status.installed || !status.binaryPath) {
    return {
      ok: false,
      active: false,
      status,
      message: status.lastError || 'Claude CLI not installed',
    };
  }

  if (status.loggedIn) {
    setLlmProvider({ provider: 'local-claude' });
    loginInProgress = false;
    loginUrl = null;
    return {
      ok: true,
      alreadyLoggedIn: true,
      active: true,
      status: { ...status, active: true, loginInProgress: false },
      message: 'Already logged in — Local Claude is now active.',
    };
  }

  if (loginInProgress) {
    return {
      ok: true,
      active: false,
      status: { ...status, loginInProgress: true, loginUrl },
      message: 'Login already in progress — finish the browser OAuth flow.',
    };
  }

  loginInProgress = true;
  loginUrl = null;
  lastError = null;
  const binaryPath = status.binaryPath;

  const child = spawn(binaryPath, ['auth', 'login', '--claudeai'], {
    env: claudeSpawnEnv({ binaryPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  loginChild = child;

  /** Saves the latest https address the login program prints. It is the sign-in page. */
  const onChunk = (buf: Buffer) => {
    const chunkText = buf.toString('utf8');
    const url = extractHttpsUrl({ text: chunkText });
    if (url) loginUrl = url;
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('exit', () => {
    loginChild = null;
  });

  /**
   * Not awaited, so the HTTP reply goes out now.
   * Waiting here would hold the reply until the user finished signing in.
   */
  void pollUntilLoggedIn({ timeoutMs: 120_000 });

  return {
    ok: true,
    active: false,
    status: {
      ...status,
      loginInProgress: true,
      loginUrl,
      active: false,
    },
    message: 'Browser OAuth started. Complete login in the opened window.',
  };
}

/**
 * Stops using Local Claude and switches to another provider, mock if unset.
 * Stops the login check and ends a running login process.
 * Does not sign the user out of Claude.
 * Returns the fresh status with `active` false.
 */
export async function disconnectLocalClaude({
  fallback = 'mock',
}: { fallback?: LlmProvider } = {}): Promise<ClaudeAuthStatus> {
  stopPolling();
  if (loginChild) {
    try {
      loginChild.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    loginChild = null;
  }
  loginInProgress = false;
  loginUrl = null;
  setLlmProvider({ provider: fallback });
  const status = await checkClaudeAuth();
  status.active = false;
  return status;
}

/**
 * Gets one answer from the `claude` program, with all of its own tools turned off.
 * Starts a process and saves no session.
 *
 * The model is `args.model`, else CLAUDE_LOCAL_MODEL, else the program's own default.
 * The wait limit is CLAUDE_LOCAL_TIMEOUT_MS, 120000 milliseconds if unset.
 * Throws if the program is missing, times out, or prints nothing.
 */
export async function generateWithLocalClaude(
  args: LocalClaudeGenerateArgs,
): Promise<{ answer: string; model: string }> {
  const binaryPath = discoverClaudeBinary();
  if (!binaryPath) {
    throw new Error('Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code');
  }

  const cliArgs = [
    '-p',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--tools',
    '',
    '--system-prompt',
    args.systemPrompt,
  ];
  const model = args.model || process.env.CLAUDE_LOCAL_MODEL;
  if (model) {
    cliArgs.push('--model', model);
  }

  const { code, stdout, stderr } = await runClaude({
    binaryPath,
    args: cliArgs,
    opts: {
      timeoutMs: Number(process.env.CLAUDE_LOCAL_TIMEOUT_MS || 120000),
      input: args.userPrompt,
    },
  });

  const answer = stdout.trim();
  if (!answer) {
    throw new Error(
      `Local Claude produced empty output (exit ${code}). stderr: ${stderr.slice(0, 400)}`,
    );
  }
  return { answer, model: model || 'local-claude-cli' };
}

/** For tests: forgets the stored path, so the next call searches again. */
export function _resetClaudeDiscoveryCache(): void {
  cachedBinary = undefined;
}

/**
 * Gets one answer from the `claude` program and passes the text on as it arrives.
 * Starts a process, with its tools turned off and no session saved.
 * The program must reply in the JSON shape given by `schema`.
 *
 * Calls `onText` for each piece of text. The program prints one JSON event per line.
 * Resolves with the program's structured answer, else its result text, else the text received.
 * The wait limit is CLAUDE_LOCAL_TIMEOUT_MS, 60000 milliseconds if unset. Then it stops the program.
 * Rejects if the program is missing, exits with an error, or reports a failed result.
 * The error message holds the last 2000 characters the program printed as errors.
 */
export async function streamLocalClaude(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  schema: unknown;
  onText?: ({ delta }: { delta: string }) => void;
}): Promise<unknown> {
  const binary = discoverClaudeBinary();
  if (!binary) throw new Error('Claude CLI unavailable');
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--no-session-persistence',
        '--tools',
        '',
        '--model',
        args.model,
        '--json-schema',
        JSON.stringify(args.schema),
        '--system-prompt',
        args.systemPrompt,
      ],
      { env: claudeSpawnEnv({ binaryPath: binary }), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let buffer = '',
      stderr = '',
      final: unknown = null,
      text = '';
    let settled = false;
    const timer = setTimeout(
      () => {
        child.kill('SIGTERM');
        finish({ error: new Error('Claude timeout') });
      },
      Number(process.env.CLAUDE_LOCAL_TIMEOUT_MS || 60000),
    );
    /** Ends the call once, whichever of the timeout, an error or the exit comes first. */
    const finish = ({ error }: { error?: Error } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(final ?? text);
    };
    /**
     * Handles one line of program output.
     * A line that is not JSON is ignored.
     * A text piece goes to `onText`. A result event sets the final answer.
     * A failed result ends the call with an error and stops the program.
     */
    const consume = ({ line }: { line: string }) => {
      try {
        const event = JSON.parse(line) as Record<string, any>;
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
          const delta = event.event.delta?.text || event.event.delta?.partial_json || '';
          text += delta;
          if (delta) args.onText?.({ delta });
        }
        if (event.type === 'result') {
          if (event.is_error) throw new Error(event.result || 'Claude generation failed');
          final = event.structured_output ?? event.result ?? text;
        }
      } catch (e) {
        if (e instanceof SyntaxError) return;
        finish({ error: e as Error });
        child.kill('SIGTERM');
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        consume({ line: buffer.slice(0, i) });
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      /** Keeps only the last 2000 characters of error text. */
      stderr = (stderr + d).slice(-2000);
    });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code) => {
      if (buffer.trim()) consume({ line: buffer });
      if (code !== 0) finish({ error: new Error('Claude unavailable ' + code + ': ' + stderr) });
      else finish();
    });
    child.stdin.end(args.userPrompt);
  });
}
