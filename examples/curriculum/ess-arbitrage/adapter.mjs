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
import { createInterface } from 'node:readline';
import {
  PRICE_LEVELS_BY_HOUR,
  BATTERY,
  batteryAllows,
  batteryStep,
  gridPowerKw,
  loadKw,
  priceChannel,
  tariffForHour,
  TOU_TARIFF,
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
const UTILITY_MODE = process.argv.includes('--utility-mode');
// R11：动作链信用——v29 creditChain 的策略收益检验。充电的收益延迟到峰时
// 放电才实现：charge 步归因窗口未完成（保 pending），首个 discharge 步以
// 链反馈 [charge 0.5, discharge 0.5] 一次性结算两步的共同延迟效果。
const CHAIN_CREDIT = process.argv.includes('--chain-credit');
// R12：多充链——真实日形态是谷时多充（≤ CHAIN_MAX_CHARGES 步）+ 峰时一放。
// 链成员 [charge1..chargeN, discharge] 均分份额 1/(N+1)。
const CHAIN_MAX_CHARGES = (() => {
  const index = process.argv.indexOf('--chain-max-charges');
  const parsed = index === -1 ? 1 : Math.max(1, Math.min(3, Number(process.argv[index + 1]) || 1));
  return parsed;
})();
const REGIME_SHIFT_AT = (() => { const i = process.argv.indexOf('--regime-shift-at'); return i === -1 ? -1 : Number(process.argv[i + 1]); })();
// R9：mid-run 电价表翻转（谷峰对调）——非平稳叠加
function effectiveTariffLevel(hour) {
  const level = PRICE_LEVELS_BY_HOUR[hour % 24];
  if (REGIME_SHIFT_AT >= 0 && hour >= REGIME_SHIFT_AT) return level === 0 ? 2 : level === 2 ? 0 : 1;
  return level;
}
function effectiveTariffPrice(hour) {
  return [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][effectiveTariffLevel(hour)];
}

const EVIDENCE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';

// 同一入口同时支持“一次请求一进程”和 persistent-jsonl：一次性宿主关闭
// stdin 后，readline 自然结束；持久宿主保持 stdin 打开，后续请求复用同一
// 进程。WorldPort 的 transport 选择由宿主配置决定，adapter 不需要猜测模式。
let sawInput = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (line.length === 0) return;
  sawInput = true;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    respond(null, false, 'request is not JSON');
    return;
  }

  if (request.protocol !== PROTOCOL || request.version !== VERSION || typeof request.id !== 'string') {
    respond(request.id ?? null, false, 'unsupported protocol');
    return;
  }

  try {
    respond(request.id, true, dispatch(request.op, request.payload ?? {}));
  } catch (error) {
    respond(request.id, false, error instanceof Error ? error.message : String(error));
  }
});
input.on('close', () => {
  if (!sawInput) process.exitCode = 64;
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: `ess-arbitrage-2-d${SETTLEMENT_DELAY}${UTILITY_MODE ? '-utility-v1' : ''}${CHAIN_CREDIT ? '-chain-v1' : ''}`,
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: UTILITY_MODE
        ? {
            schemaVersion: VERSION,
            observationDimensions: 4,
            weights: [0, 0, 0, 1],
            target: [0, 0, 0, 0],
            valueMode: 'signed-v1',
          }
        : {
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
    return {
      state: {
        schemaVersion: VERSION,
        stateVersion: 'arbitrage:0',
        revision: 0,
        hour: 0,
        soc: 50,
        lastNonce: null,
        chargeNonces: [],
        chainToRelease: null,
        pendingSettlements: [],
        usedExecutionNonces: [],
        ...(UTILITY_MODE ? { utilityYuan: 0 } : {}),
      },
    };
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
  const base = effectiveTariffPrice(hour);
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
  return {
    schemaVersion: VERSION,
    vector: observationVector(state),
    stateVersion: `arbitrage:${state.hour}`,
    intervalId: `arbitrage:${state.hour}`,
    evidence: [],
  };
}

function observationVector(state) {
  const grid = gridPowerKw({ load: loadKw(state.hour), pv: 0, essPower: 0 });
  return [
    grid / OBS_SCALE,
    Math.round((effectiveTariffPrice(state.hour) - 0.7) * 1000) / 1000,
    Math.round(state.soc / 100 * 1000) / 1000,
    ...(UTILITY_MODE ? [Math.round(-(state.utilityYuan ?? 0) / 1000 * 1000) / 1000] : []),
  ];
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
  const stepCostYuan = Math.max(0, grid) * effectivePrice(state.hour, state);
  const nextUtilityYuan = (state.utilityYuan ?? 0) + stepCostYuan;

  // R11/R12：动作链信用模式——独立分支，不与 settlement-delay 机制叠加。
  // 协议要求链成员在反馈到达时已经 pending（当前步的 pending 在结算之后
  // 才建立），因此链反馈在放电后的下一步发出：
  //   charge（谷）→ 保 pending 并累积（多充模式最多 CHAIN_MAX_CHARGES 个）；
  //   discharge（峰）→ 保 pending 并登记链 [charge1..chargeN, discharge]；
  //   下一步 → 发链反馈，份额均分 1/(N+1)，结算全链共同延迟效果。
  if (CHAIN_CREDIT) {
    const isCharge = entry.capabilityId === 'ess.charge';
    const isDischarge = entry.capabilityId === 'ess.discharge';
    const pendingChain = state.chainToRelease ?? null;
    const chargeNonces = [...(state.chargeNonces ?? [])];
    if (isCharge) chargeNonces.push(request.executionNonce);
    while (chargeNonces.length > CHAIN_MAX_CHARGES) chargeNonces.shift();
    // 放电登记新链：仅当没有未释放的链且有充电锚点
    const newChain = pendingChain === null && isDischarge && chargeNonces.length > 0
      ? { members: [...chargeNonces, request.executionNonce] }
      : null;
    const nextCharges = newChain !== null ? [] : chargeNonces;
    const nextChain = {
      schemaVersion: VERSION,
      stateVersion: `arbitrage:${state.hour + 1}`,
      revision: state.revision + 1,
      hour: state.hour + 1,
      soc: nextSoc,
      lastNonce: request.executionNonce,
      chargeNonces: nextCharges,
      chainToRelease: newChain,
      recentActions: [...(state.recentActions ?? []).slice(-2), entry.capabilityId],
      usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
      ...(UTILITY_MODE ? { utilityYuan: nextUtilityYuan } : {}),
    };
    const chainFeedback = pendingChain === null ? [] : [{
      schemaVersion: VERSION,
      executionNonce: pendingChain.members[0],
      vector: observationVector(nextChain),
      stateVersion: nextChain.stateVersion,
      intervalId: nextChain.stateVersion,
      confounderCount: 0,
      creditChain: {
        schemaVersion: VERSION,
        // 二进制精确份额：前 N-1 个成员取 unit，末成员取余数 1-(N-1)*unit，
        // 保证浮点求和精确等于 1（kernel 闭合容差 1e-9）。
        members: pendingChain.members.map((executionNonce, index) => ({
          executionNonce,
          share: index < pendingChain.members.length - 1
            ? (pendingChain.members.length <= 2 ? 0.5 : 0.25)
            : 1 - (pendingChain.members.length - 1) * (pendingChain.members.length <= 2 ? 0.5 : 0.25),
        })),
      },
    }];
    return {
      nextWorldState: nextChain,
      receipt: {
        schemaVersion: VERSION,
        token: request.token,
        basedOnVersion: request.basedOnVersion,
        policyVersion: request.policyVersion,
        constraintsDigest: request.constraintsDigest,
        executionNonce: request.executionNonce,
        status: 'ACCEPTED',
        rejectionReason: null,
        effectDigest: canonicalDigest(nextChain),
        // charge 与链内 discharge 的收益共同延迟：窗口未完成
        attributionWindowComplete: isCharge || newChain !== null ? false : true,
        confounderCount: 0,
      },
      postObservation: {
        schemaVersion: VERSION,
        vector: observationVector(nextChain),
        stateVersion: nextChain.stateVersion,
        intervalId: nextChain.stateVersion,
        ...(chainFeedback.length === 0 ? {} : { feedback: chainFeedback }),
        evidence: [{
          schemaVersion: VERSION,
          kind: 'settlement',
          hour: state.hour,
          gridPowerKw: grid,
          price: effectivePrice(state.hour, state),
          costYuan: Math.round(stepCostYuan * 1000) / 1000,
          soc: nextSoc,
        }],
      },
    };
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
      price: effectiveTariffPrice(state.hour),
      soc: nextSoc,
      ...(UTILITY_MODE ? { utilityYuan: nextUtilityYuan } : {}),
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
    ...(UTILITY_MODE ? { utilityYuan: nextUtilityYuan } : {}),
  };

  const noisyStep = next.hour;
  const feedback = DAILY
    ? (next.hour % 24 === 0
        ? [{
            schemaVersion: VERSION,
            executionNonce: state.lastNonce,
            vector: observationVector(next),
            stateVersion: next.stateVersion,
            intervalId: next.stateVersion,
            confounderCount: 1, // 日总量混合归因：不可学习
          }]
        : [])
    : due.map((item) => ({
        schemaVersion: VERSION,
        executionNonce: item.executionNonce,
        vector: observationVector({ ...next, soc: item.soc, utilityYuan: item.utilityYuan ?? next.utilityYuan }),
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
      vector: observationVector(next),
      stateVersion: next.stateVersion,
      intervalId: next.stateVersion,
      ...(feedback.length === 0 ? {} : { feedback }),
      evidence: [{
        schemaVersion: VERSION,
        kind: 'settlement',
        hour: state.hour,
        gridPowerKw: grid,
        price: tariffForHour(state.hour).price,
        costYuan: Math.round(stepCostYuan * 1000) / 1000,
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
