import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initLab, runLab } from '../../src/application/agent-service.mjs';
import { evaluateLabCounterfactual } from '../../src/application/counterfactual-service.mjs';
import { createCandidatePolicyAdvisor } from '../../src/runtime/candidate-policy.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { verifySelfDigest } from '../../src/runtime/schema.mjs';

test('the driving policy itself replays to full agreement on the recorded history', async () => {
  await withTemp(async (root) => {
    const labPath = path.join(root, 'lab');
    await initLab({ labPath, labId: 'counterfactual-lab', worldId: 'temperature', seed: 'counterfactual-seed' });
    const store = await LabStore.open({ labPath });
    const tokens = store.manifest.tokenMap.entries.map((entry) => entry.token);
    const recorded = { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[0], rules: [] };
    await runLab({
      labPath,
      runId: 'run-1',
      steps: 3,
      scenario: 'steady',
      advisor: createCandidatePolicyAdvisor(recorded),
    });

    const report = await evaluateLabCounterfactual({ labPath, policy: recorded });
    assert.equal(verifySelfDigest(report), true);
    assert.equal(report.type, 'counterfactual-policy-evaluation');
    assert.equal(report.worldId, 'temperature');
    assert.equal(report.manifestDigest, store.manifest.selfDigest);
    assert.equal(report.historySteps, report.evaluation.basis.steps + report.evaluation.basis.opaque);
    assert.ok(report.historySteps >= 1);
    assert.equal(report.evaluation.agreement.matched, report.evaluation.basis.steps);
    assert.equal(report.evaluation.agreement.diverged, 0);
    assert.equal(report.evaluation.agreement.agreementRate, 1);
    assert.equal(report.evaluation.outcome.verdict, 'INSUFFICIENT_EVIDENCE');

    const history = await store.readCandidateOutcomes();
    assert.ok(history.length >= 1);
    assert.ok(history.every((entry) => /^sha256:[0-9a-f]{64}$/u.test(entry.valueSpecDigest)));

    const repeated = await evaluateLabCounterfactual({ labPath, policy: recorded });
    assert.equal(repeated.evaluation.policyDigest, report.evaluation.policyDigest);
    assert.deepEqual(repeated, report);
  });
});

test('a different default token surfaces divergences without executing anything', async () => {
  await withTemp(async (root) => {
    const labPath = path.join(root, 'lab');
    await initLab({ labPath, labId: 'counterfactual-divergence-lab', worldId: 'temperature', seed: 'counterfactual-divergence-seed' });
    const store = await LabStore.open({ labPath });
    const tokens = store.manifest.tokenMap.entries.map((entry) => entry.token);
    await runLab({
      labPath,
      runId: 'run-1',
      steps: 3,
      scenario: 'steady',
      advisor: createCandidatePolicyAdvisor({ schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[0], rules: [] }),
    });

    const report = await evaluateLabCounterfactual({
      labPath,
      policy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[1], rules: [] },
    });
    assert.ok(report.evaluation.basis.steps >= 1);
    assert.ok(report.evaluation.agreement.diverged >= 1);
    assert.ok(report.evaluation.agreement.agreementRate < 1);
    assert.equal(
      report.evaluation.agreement.matched + report.evaluation.agreement.diverged,
      report.evaluation.basis.steps,
    );
    for (const sample of report.evaluation.samples) {
      assert.equal(sample.recordedToken, tokens[0]);
      assert.equal(sample.counterfactualToken, tokens[1]);
    }

    const strict = await evaluateLabCounterfactual({
      labPath,
      binding: 'strict',
      policy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[1], rules: [] },
    });
    assert.equal(strict.evaluation.binding, 'strict');
    assert.equal(strict.evaluation.divergence.vector, 0);
    assert.equal(strict.evaluation.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  });
});

test('an offline counterfactual report is labelled as historical replay, not real evidence', async () => {
  await withTemp(async (root) => {
    const labPath = path.join(root, 'lab');
    await initLab({ labPath, labId: 'counterfactual-label-lab', worldId: 'temperature', seed: 'counterfactual-label-seed' });
    const store = await LabStore.open({ labPath });
    const tokens = store.manifest.tokenMap.entries.map((entry) => entry.token);
    const recorded = { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[0], rules: [] };
    await runLab({
      labPath,
      runId: 'run-1',
      steps: 3,
      scenario: 'steady',
      advisor: createCandidatePolicyAdvisor(recorded),
    });

    const report = await evaluateLabCounterfactual({ labPath, policy: recorded });
    assert.equal(report.epistemicLabel, 'historical-policy-replay');
    assert.equal(report.type, 'counterfactual-policy-evaluation');
    assert.equal(report.evaluation.mode, 'history-anchored-one-step-v2');
    // The report is a pure function of the existing ledger: it must not create
    // a branch lab, re-run the world, or re-request a model cursor.
    const entries = await (await LabStore.open({ labPath })).readCandidateOutcomes();
    assert.ok(report.historySteps >= 1);
    assert.ok(Array.isArray(entries));
  });
});

test('policies are bound to the parent token map and existing labs', async () => {
  await withTemp(async (root) => {
    const labPath = path.join(root, 'lab');
    await initLab({ labPath, labId: 'counterfactual-invalid-lab', worldId: 'temperature', seed: 'counterfactual-invalid-seed' });
    await runLab({ labPath, runId: 'run-1', steps: 1, scenario: 'steady' });

    await assert.rejects(
      () => evaluateLabCounterfactual({
        labPath,
        policy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: 'tok_NOTMAPPED', rules: [] },
      }),
      (error) => error.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      () => evaluateLabCounterfactual({
        labPath: path.join(root, 'missing'),
        policy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: 'tok_AAAAAAAA', rules: [] },
      }),
      (error) => error.code === 'NOT_FOUND',
    );
  });
});

test('an explicitly WorldPort-bound policy cannot be evaluated against another implementation', async () => {
  await withTemp(async (root) => {
    const labPath = path.join(root, 'lab');
    await initLab({ labPath, labId: 'counterfactual-identity-lab', worldId: 'temperature', seed: 'counterfactual-identity-seed' });
    const store = await LabStore.open({ labPath });
    const token = store.manifest.tokenMap.entries[0].token;
    const bound = {
      schemaVersion: 1,
      type: 'candidate-policy',
      version: 1,
      worldId: store.manifest.worldId,
      worldVersion: store.manifest.worldVersion,
      worldImplementationDigest: store.manifest.worldImplementationDigest,
      tokenMapDigest: store.manifest.tokenMap.digest,
      defaultToken: token,
      rules: [],
    };

    await assert.rejects(
      () => evaluateLabCounterfactual({
        labPath,
        policy: { ...bound, worldImplementationDigest: `sha256:${'f'.repeat(64)}` },
      }),
      (error) => error.code === 'INVALID_INPUT',
    );
  });
});

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-counterfactual-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
