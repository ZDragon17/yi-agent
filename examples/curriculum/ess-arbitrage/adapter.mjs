#!/usr/bin/env node

// L4 跨期套利场景：分时电价套利的全局最优需要跨期价值——谷时段充电的
// 即期成本（costRate 上升）只有通过数小时后的峰时段放电才能回本。
// 单步距离几何（horizon 1）在数学上无法表达这一跨期机会成本；
// 有界序列规划（v16-v18，horizon ≤ 8）是底座唯一的跨期工具。
// 本场景是 F-125 记录的开放方向（跨期套利收敛）的直接检验。
//
// 观测 3 维：[并网点功率/50，电价偏离中位，SOC/100]；
// ValueSpec：目标 [0, 0, 0]，权重 [1.5, 0.3, 0] —— SOC 通道纯上下文：
// 单步最优策略必然是「峰放 + 谷 idle + SOC 单调下降」（初始 50% 的一次性红利），
// 跨期套利（谷充回本）只能由 horizon 规划发现。判据按预注册三组 horizon 对比。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PRICE_LEVELS_BY_HOUR,
  BATTERY,
  batteryAllows,
  batteryStep,
  gridPowerKw,
  loadKw,
  priceChannel,
  tariffForHour,
} from '../../energy/shared/energy-sim.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'ess-arbitrage-adapter-v1';
const WORLD_ID = 'ess-arbitrage';
const CAPABILITY_IDS = ['ess.charge', 'ess.discharge', 'ess.idle'];
const ESS_POWER = { 'ess.charge': BATTERY.ratedPowerKw, 'ess.discharge': -BATTERY.ratedPowerKw, 'ess.idle': 0 };
const OBS_SCALE = 50;
const stateFileIndex = process.argv.indexOf('--settlement-delay');
const SETTLEMENT_DELAY = stateFileIndex === -1 ? 2 : Math.max(1, Number(process.argv[stateFileIndex + 1]) || 2);
const NOISY = process.argv.includes('--noisy-feedback');
const NOISE_LIMIT = 0.2;
const ADVERSARIAL = process.argv.includes('--adversarial');
const EVIDENCE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';

const input = readFileSync(0, 'utf8').split(/\r?\n/u).find((line) => line.length > 0);
if (input === undefined) process.exit(64);

let request;
try {
  request = JSON.parse(input);
} catch {
  respond(null, false, 'request is not JSON');
  process.exit(0);
}

if (request.protocol !== PROTOCOL || request.version !== VERSION || typeof request.id !== 'string') {
  respond(request.id ?? null, false, 'unsupported protocol');
  process.exit(0);
}

try {
  respond(request.id, true, dispatch(request.op, request.payload ?? {}));
} catch (error) {
  respond(request.id, false, error instanceof Error ? error.message : String(error));
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: `ess-arbitrage-2-d${SETTLEMENT_DELAY}`,
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: {
        schemaVersion: VERSION,
        observationDimensions: 3,
        weights: [1.5, 0.3, 0],
        target: [0, 0, 0],
      },
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') {
    return { state: { schemaVersion: VERSION, stateVersion: 'arbitrage:0', revision: 0, hour: 0, soc: 50, lastNonce: null, pendingSettlements: [], usedExecutionNonces: [] } };
  }
  if (op === 'actions') {
    const entries = payload.manifest?.tokenMap?.entries;
    if (!Array.isArray(entries) || entries.length !== CAPABILITY_IDS.length) throw new Error('manifest token map is missing');
    return {
      actions: entries.map((entry) => ({
        schemaVersion: VERSION,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: capabilitySafe(entry.capabilityId, payload.state),
      })),
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request, payload.manifest);
  throw new Error(`unsupported operation: ${op}`);
}

function capabilitySafe(capabilityId, state) {
  const power = ESS_POWER[capabilityId] ?? 0;
  if (!batteryAllows(state.soc, power)) return false;
  // 防逆流投影：放电使并网点为负 → 不安全
  return gridPowerKw({ load: loadKw(state.hour), pv: 0, essPower: power }) >= 0;
}

function effectivePrice(hour, state) {
  const base = tariffForHour(hour).price;
  if (!ADVERSARIAL) return base;
  // 市场响应：连续放电（削峰）推高峰价、连续充电（填谷）推高谷价 ×1.3
  const recent = state.recentActions ?? [];
  const allDischarge = recent.length === 3 && recent.every((c) => c === 'ess.discharge');
  const allCharge = recent.length === 3 && recent.every((c) => c === 'ess.charge');
  if (allDischarge && PRICE_LEVELS_BY_HOUR[hour % 24] === 2) return base * 1.3;
  if (allCharge && PRICE_LEVELS_BY_HOUR[hour % 24] === 0) return base * 1.3;
  return base;
}

function noisySnapshot(vector, step) {
  if (!NOISY) return vector;
  const wave = Math.sin(step * 12.9898) * 43758.5453;
  const noise = (wave - Math.floor(wave)) * 2 - 1;
  return vector.map((v) => Math.round(v * (1 + NOISE_LIMIT * noise) * 1000) / 1000);
}

function observation(state) {
  const grid = gridPowerKw({ load: loadKw(state.hour), pv: 0, essPower: 0 });
  return {
    schemaVersion: VERSION,
    vector: [
      grid / OBS_SCALE,
      Math.round(priceChannel(state.hour) * 1000) / 1000,
      Math.round(state.soc / 100 * 1000) / 1000,
    ],
    stateVersion: `arbitrage:${state.hour}`,
    intervalId: `arbitrage:${state.hour}`,
    evidence: [],
  };
}

function transition(state, request, manifest) {
  const entries = manifest?.tokenMap?.entries;
  const entry = entries?.find((candidate) => candidate.token === request.token);
  if (entry === undefined) throw new Error('unknown action token');
  const essPower = ESS_POWER[entry.capabilityId] ?? 0;

  if (!batteryAllows(state.soc, essPower)) {
    return rejected(state, request, 'BMS_SOC_BOUNDARY');
  }
  const nextSoc = batteryStep(state.soc, essPower);
  const grid = gridPowerKw({ load: loadKw(state.hour), pv: 0, essPower });
  if (grid < 0) {
    return rejected(state, request, 'GRID_EXPORT_NOT_ALLOWED');
  }

  // R2：结算反馈延迟 2 步——本步动作的结算（电网功率/电价/SOC 快照）在其后
  // 第二步的 feedback[] 中按 executionNonce 送达，Kernel 以 pending credit 结算。
  const DAILY = process.argv.includes('--daily-settlement');
// R7：反馈噪声——确定性扰动（sin 驱动，±20%），保持重放确定性
const NOISY = process.argv.includes('--noisy-feedback');
const NOISE_LIMIT = 0.2;
function noisy(value, step) {
  if (!NOISY) return value;
  const wave = Math.sin(step * 12.9898) * 43758.5453;
  const noise = (wave - Math.floor(wave)) * 2 - 1; // [-1, 1] 确定性伪随机
  return value * (1 + NOISE_LIMIT * noise);
}
// R8：对抗叠加——世界对「套利行为」反学：连续 3 步放电 → 峰价加成 ×1.3
//（市场对削峰需求的响应），连续 3 步充电 → 谷价加成 ×1.3。确定性、状态内。
const ADVERSARIAL = process.argv.includes('--adversarial');
  const pendingSettlements = DAILY
    ? []
    : (state.pendingSettlements ?? [])
        .filter((item) => item.dueRevision > state.revision + 1);
  const due = DAILY
    ? []
    : (state.pendingSettlements ?? []).filter((item) => item.dueRevision === state.revision + 1);
  if (!DAILY) {
    pendingSettlements.push({
      executionNonce: request.executionNonce,
      dueRevision: state.revision + SETTLEMENT_DELAY,
      hour: state.hour,
      gridPowerKw: grid,
      price: tariffForHour(state.hour).price,
      soc: nextSoc,
    });
  }

  const next = {
    schemaVersion: VERSION,
    stateVersion: `arbitrage:${state.hour + 1}`,
    revision: state.revision + 1,
    hour: state.hour + 1,
    soc: nextSoc,
    lastNonce: request.executionNonce,
    pendingSettlements,
    recentActions: [...(state.recentActions ?? []).slice(-2), entry.capabilityId],
    usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
  };

  const noisyStep = next.hour;
  const feedback = DAILY
    ? (next.hour % 24 === 0
        ? [{
            schemaVersion: VERSION,
            executionNonce: state.lastNonce,
            vector: [
              Math.round(gridPowerKw({ load: loadKw(next.hour), pv: 0, essPower: 0 }) / OBS_SCALE * 1000) / 1000,
              Math.round(priceChannel(next.hour) * 1000) / 1000,
              Math.round(nextSoc / 100 * 1000) / 1000,
            ],
            stateVersion: next.stateVersion,
            intervalId: next.stateVersion,
            confounderCount: 1, // 日总量混合归因：不可学习
          }]
        : [])
    : due.map((item) => ({
        schemaVersion: VERSION,
        executionNonce: item.executionNonce,
        vector: [
          Math.round(gridPowerKw({ load: loadKw(next.hour), pv: 0, essPower: 0 }) / OBS_SCALE * 1000) / 1000,
          Math.round(priceChannel(next.hour) * 1000) / 1000,
          Math.round(item.soc / 100 * 1000) / 1000,
        ],
        stateVersion: next.stateVersion,
        intervalId: next.stateVersion,
        confounderCount: 0,
      }));

  return {
    nextWorldState: next,
    receipt: {
      schemaVersion: VERSION,
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(next),
      // 结算反馈延迟 2 步送达：本步归因窗口未完成，进入 pending credit
      attributionWindowComplete: false,
      confounderCount: 0,
    },
    postObservation: {
      schemaVersion: VERSION,
      vector: [
        grid / OBS_SCALE,
        Math.round(priceChannel(next.hour) * 1000) / 1000,
        Math.round(nextSoc / 100 * 1000) / 1000,
      ],
      stateVersion: next.stateVersion,
      intervalId: next.stateVersion,
      ...(feedback.length === 0 ? {} : { feedback }),
      evidence: [{
        schemaVersion: VERSION,
        kind: 'settlement',
        hour: state.hour,
        gridPowerKw: grid,
        price: tariffForHour(state.hour).price,
        costYuan: Math.round(grid * effectivePrice(state.hour, state) * 1000) / 1000,
        soc: nextSoc,
      }],
    },
  };
}

function rejected(state, request, reason) {
  return {
    nextWorldState: state,
    receipt: {
      schemaVersion: VERSION,
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      status: 'REJECTED',
      rejectionReason: reason,
      effectDigest: canonicalDigest(state),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(state),
  };
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: VERSION, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
