#!/usr/bin/env node

// 能源管理系统（EMS）场景 WorldPort：需量控制 + 需求响应 + 逆变器能量路由。
// 设备语义：
// - 电表：并网点计量 + 需量表（本场景用当步负荷近似 15 分钟需量窗口）；
// - 逆变器：光伏经逆变器并网（效率降额 + 无功占用视在容量），支持
//   并网/离网双模式切换——离网时电表不走字（需量冻结），本地平衡失败拒绝；
// - DR 资源：HVAC 群削减 40kW 持续 3 步后自动恢复并反弹 +10kW；
//   恢复反弹是延迟效应——世界在反弹步的 feedback[] 中按原 shed 的
//   executionNonce 返回结果快照，由 Kernel 的延迟反馈通道归因。
// 观测 3 维：[本地负荷/100，需量峰值/250，DR 剩余持续/3]；
// ValueSpec：目标 [2.2, 1.0, 0] —— 负荷压向 220（削峰目标）、需量不超合同 250，
// DR 剩余通道仅作上下文（weight 0）。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DR_RESOURCE,
  INVERTER,
  inverterOutput,
  loadKw,
  pvOutputKw,
} from '../shared/energy-sim.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'ems-adapter-v1';
const WORLD_ID = 'ems';
const CAPABILITY_IDS = ['hvac.shed', 'hvac.restore', 'inv.island', 'inv.grid'];
const CONTRACT_DEMAND_KW = 250;
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

function baseState() {
  return {
    schemaVersion: VERSION,
    stateVersion: 'ems:0',
    revision: 0,
    hour: 0,
    demandPeakKw: 0,
    shedRemaining: 0,
    shedNonce: null,
    mode: 'grid',
    usedExecutionNonces: [],
  };
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: 'ems-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: {
        schemaVersion: VERSION,
        observationDimensions: 3,
        weights: [1.2, 1.5, 0],
        target: [2.2, 1.0, 0],
      },
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: baseState() };
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
  const localLoad = effectiveLoad(state);
  const pv = pvOutputKw(state.hour);
  if (capabilityId === 'hvac.shed') {
    // DR 资源忙时不可重复削减
    return state.shedRemaining === 0 && localLoad - DR_RESOURCE.shedKw >= 0;
  }
  if (capabilityId === 'hvac.restore') {
    return state.shedRemaining > 0;
  }
  if (capabilityId === 'inv.island') {
    // 离网需本地平衡：光伏经逆变器出力必须覆盖本地负荷
    const { activeKw } = inverterOutput(Math.min(pv, INVERTER.ratedActiveKw), { mode: 'island' });
    return state.mode === 'grid' && activeKw >= localLoad;
  }
  if (capabilityId === 'inv.grid') {
    return state.mode === 'island' && pv >= localLoad;
  }
  return false;
}

// 有效负荷：DR 削减期内 -40kW；DR 恢复步反弹 +10kW
function effectiveLoad(state, { rebound = false } = {}) {
  let load = loadKw(state.hour);
  if (state.shedRemaining > 0) load -= DR_RESOURCE.shedKw;
  if (rebound) load += DR_RESOURCE.reboundKw;
  return load;
}

function observation(state, overloadKw = 0) {
  const load = effectiveLoad(state) + overloadKw;
  return {
    schemaVersion: VERSION,
    vector: [
      Math.round(load / 100 * 1000) / 1000,
      Math.round(state.demandPeakKw / CONTRACT_DEMAND_KW * 1000) / 1000,
      Math.round(state.shedRemaining / DR_RESOURCE.durationSteps * 1000) / 1000,
    ],
    stateVersion: `ems:${state.hour}`,
    intervalId: `ems:${state.hour}`,
    evidence: [],
  };
}

function advance(state, rebound) {
  const load = effectiveLoad(state, { rebound });
  const meteredKw = state.mode === 'island'
    ? Math.min(load, Math.max(0, pvOutputKw(state.hour))) // 离网：电表不走字
    : load; // 并网：电表计量全部净负荷（本场景无储能）
  const demandPeakKw = state.mode === 'grid' && state.hour > 0
    ? Math.max(state.demandPeakKw, load)
    : state.demandPeakKw;
  return { load, meteredKw, demandPeakKw };
}

function transition(state, request, manifest) {
  const entries = manifest?.tokenMap?.entries;
  const entry = entries?.find((candidate) => candidate.token === request.token);
  if (entry === undefined) throw new Error('unknown action token');
  const capabilityId = entry.capabilityId;

  let shedRemaining = state.shedRemaining;
  let rebound = false;
  let nextMode = state.mode;
  let shedNonce = state.shedNonce;
  const feedback = [];

  if (capabilityId === 'hvac.shed') {
    // 新削减：DR 资源忙时不允许（safe 投影已挡），旧削减的未决反馈混杂结算
    if (state.shedNonce !== null) {
      feedback.push({ nonce: state.shedNonce, confounder: 1 });
    }
    shedRemaining = DR_RESOURCE.durationSteps;
    shedNonce = request.executionNonce;
  } else if (capabilityId === 'hvac.restore') {
    // 手动恢复：立即结束 DR，向原 shed 发混杂反馈（干预使归因不可信）
    if (state.shedNonce !== null) {
      feedback.push({ nonce: state.shedNonce, confounder: 1 });
    }
    shedRemaining = 0;
    shedNonce = null;
  } else if (capabilityId === 'inv.island') {
    nextMode = 'island';
  } else if (capabilityId === 'inv.grid') {
    nextMode = 'grid';
  } else {
    throw new Error('unknown capability');
  }

  // DR 持续期递减（shed 步本身不递减、restore 步已在上方清零）；
  // 归零时触发自动恢复反弹，并向原 shed 发干净反馈（confounder 0 → ACTION）
  if (capabilityId !== 'hvac.shed' && capabilityId !== 'hvac.restore' && state.shedRemaining > 0) {
    shedRemaining = state.shedRemaining - 1;
    if (shedRemaining === 0) {
      rebound = true;
      if (shedNonce !== null) {
        feedback.push({ nonce: shedNonce, confounder: 0 });
      }
      shedNonce = null;
    }
  }

  const { load, meteredKw, demandPeakKw } = advance(state, rebound);
  const next = {
    schemaVersion: VERSION,
    stateVersion: `ems:${state.hour + 1}`,
    revision: state.revision + 1,
    hour: state.hour + 1,
    demandPeakKw,
    shedRemaining,
    shedNonce: rebound ? null : shedNonce,
    mode: nextMode,
    usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
  };

  // 恢复反弹步与手动恢复步：世界在 feedback[] 中按原 shed 的 executionNonce
  // 返回延迟结果快照。自动反弹干净归因（confounderCount 0 → ACTION）；
  // 手动恢复是外部干预，混杂归因（confounderCount 1 → AMBIGUOUS 不学习），
  // 避免 restore 冒充或污染原 shed 的因果信用。
  const feedbackItems = feedback.map((item) => ({
    schemaVersion: VERSION,
    executionNonce: item.nonce,
    vector: [Math.round(load / 100 * 1000) / 1000,
      Math.round(demandPeakKw / CONTRACT_DEMAND_KW * 1000) / 1000,
      Math.round(shedRemaining / DR_RESOURCE.durationSteps * 1000) / 1000],
    stateVersion: next.stateVersion,
    intervalId: next.stateVersion,
    confounderCount: item.confounder,
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
      // DR 削减的完整效果要等恢复反弹后才可知：只有 shed 步保持归因窗口
      // 未完成（进入 pending credit，反弹/恢复时按原 nonce 结算）；
      // 模式切换等其他动作的归因窗口完整，不得产生无主 pending。
      attributionWindowComplete: capabilityId === 'hvac.shed' ? false : true,
      confounderCount: 0,
    },
    postObservation: {
      schemaVersion: VERSION,
      vector: [
        Math.round(load / 100 * 1000) / 1000,
        Math.round(demandPeakKw / CONTRACT_DEMAND_KW * 1000) / 1000,
        Math.round(shedRemaining / DR_RESOURCE.durationSteps * 1000) / 1000,
      ],
      stateVersion: next.stateVersion,
      intervalId: next.stateVersion,
      evidence: [{
        schemaVersion: VERSION,
        kind: 'demand',
        hour: state.hour,
        loadKw: load,
        meteredKw,
        demandPeakKw,
        inverter: inverterOutput(
          Math.min(pvOutputKw(state.hour), INVERTER.ratedActiveKw),
          { mode: state.mode },
        ),
      }],
      ...(feedbackItems.length === 0 ? {} : { feedback: feedbackItems }),
    },
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
