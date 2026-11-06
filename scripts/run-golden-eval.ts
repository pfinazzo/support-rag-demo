/**
 * Why this file exists: it runs the golden questions from the command line, as `npm run eval`.
 * It prints each result and exits with an error if any answer drifted, so a script or a
 * build can fail on worse answers. Flags: --judge adds the LLM judge, --canary plants a
 * bad first answer to prove the check can fail.
 * Without BASE_URL it starts its own server with every model mocked.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The server this script started, if any. It is stopped at the end. */
let child: ChildProcess | undefined;

/** The server to test. Defaults to a local port that the script starts itself. */
const base = process.env.BASE_URL || 'http://127.0.0.1:3488';

try {
  if (!process.env.BASE_URL) {
    /**
     * Starts our server on its own port with every model and guard mocked and hot reload off.
     * Why: the run is then fast, free and the same every time.
     */
    child = spawn(
      process.execPath,
      [path.resolve('node_modules/tsx/dist/cli.mjs'), 'src/server.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: '3488',
          MOCK_AI: 'true',
          FORCE_MOCK_LLM: 'true',
          FORCE_MOCK_GUARD: 'true',
          FORCE_MOCK_NLI: 'true',
          HOT_RELOAD: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    /** Waits for the health check to pass. Gives up after a fixed number of tries and throws. */
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(base + '/api/health')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error('Evaluation server did not start');
  }
  /**
   * Asks the server to run the evaluation.
   * The live judge runs only against an existing server, because a started one is mocked.
   */
  const response = await fetch(base + '/api/eval/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      judge: process.argv.includes('--judge'),
      liveJudge: Boolean(process.env.BASE_URL) && process.argv.includes('--judge'),
      canary: process.argv.includes('--canary'),
    }),
  });
  if (!response.ok) throw new Error('Evaluation HTTP ' + response.status);
  const result = (await response.json()) as {
    total: number;
    completed: number;
    passed: number;
    drifted: number;
    results: Array<{ id: string; status: string; reasons: string[] }>;
  };
  for (const r of result.results) console.log(r.id, r.status, r.reasons.join(','));
  console.log(
    JSON.stringify({
      completed: result.completed,
      total: result.total,
      passed: result.passed,
      drifted: result.drifted,
    }),
  );
  /**
   * Fails the run if it did not finish every question, or if any answer drifted.
   * With --canary a drift is expected, so only an incomplete run fails.
   */
  if (result.completed !== 20 || (!process.argv.includes('--canary') && result.drifted))
    process.exitCode = 1;
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
}
