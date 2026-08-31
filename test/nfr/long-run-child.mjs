import { initLab, runLab } from '../../src/application/agent-service.mjs';

const labPath = process.argv[2];
if (typeof labPath !== 'string' || labPath.length === 0) {
  throw new Error('lab path is required');
}

await initLab({
  labPath,
  labId: 'nfr-performance',
  worldId: 'temperature',
  seed: 'nfr-performance-seed',
});
const result = await runLab({ labPath, runId: 'nfr-run', steps: 10_000 });
process.stdout.write(JSON.stringify({ executed: result.metrics.executed }));
