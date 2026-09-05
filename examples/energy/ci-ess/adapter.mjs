#!/usr/bin/env node

// 工商储能（C&I ESS）峰谷套利场景 WorldPort。
// 观测 3 维：[SOC(%)，并网点功率/50，电价偏离中位]；
// ValueSpec：目标 [90, 0, 0] —— 谷时段充电抬高 SOC、峰时段放电压低并网点功率。
// 电价通道以中位电价归一，使 Kernel 的关系签名天然区分峰/谷方向：
// 这是「分时异向目标」投影到同一套距离几何的关键。
// 设备模型（SOC 动力学、BMS 边界、并网约束、电价表）全部在本 WorldPort 边界内。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BATTERY,
  batteryAllows,
  batteryStep,
  gridPowerKw,
  loadKw,
  priceChannel,
  tariffForHour,
} from '../shared/energy-sim.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'ci-ess-adapter-v1';
const WORLD_ID = 'ci-ess';
const SCENARIO_IDS = ['steady'];
const CAPABILITY_IDS = ['ess.charge', 'ess.discharge', 'ess.idle'];
const ESS_POWER = { 'ess.charge': BATTERY.ratedPowerKw, 'ess.discharge': -BATTERY.ratedPowerKw, 'ess.idle': 0 };
const OBS_SCALE = 50; // 并网点功率观测归一化尺度（kW）
// 演示密钥：与 counter-world 示例同源的 Ed25519 公钥（外部输入验签用）
const EVIDENCE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';

// 观测通道 1 为放电余量（soc-socMin)/100：只作上下文（weight 0），
// 价值几何唯一来源是并网点功率压零（削峰）；跨期套利（谷充峰放）需要
// 跨期价值表达，超出单步距离几何，作为开放方向记录。
const VALUE_SPEC = {
  schemaVersion: VERSION,
  observationDimensions: 3,
  weights: [1.5, 0.8, 0],
  target: [0, 0, 0],
};

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
      worldVersion: 'ci-ess-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: SCENARIO_IDS,
      valueSpec: VALUE_SPEC,
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') {
    return { state: { schemaVersion: VERSION, stateVersion: 'ci-ess:0', revision: 0, hour: 0, soc: 50, usedExecutionNonces: [] } };
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
  // 能力投影：放电使并网点倒送（工商业不允许）→ 不安全。
  // transition 内的 GRID_EXPORT_NOT_ALLOWED 是第二道防线。
  return gridPowerKw({ load: loadKw(state.hour), pv: 0, essPower: power }) >= 0;
}

function observation(state) {
  const grid = gridPowerKw({
    load: loadKw(state.hour),
    pv: 0,
    essPower: 0, // 行动前观测：储能尚未动作
  });
  return {
    schemaVersion: VERSION,
    vector: [
      grid / OBS_SCALE,
      Math.round((state.soc - BATTERY.socMin) / 100 * 1000) / 1000,
      Math.round(priceChannel(state.hour) * 1000) / 1000,
    ],
    stateVersion: `ci-ess:${state.hour}`,
    intervalId: `ci-ess:${state.hour}`,
    evidence: [{
      schemaVersion: VERSION,
      kind: 'tariff',
      hour: state.hour,
      price: tariffForHour(state.hour).price,
      soc: state.soc,
    }],
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
    // 工商业并网点不允许倒送（防逆流保护）
    return rejected(state, request, 'GRID_EXPORT_NOT_ALLOWED');
  }

  const next = {
    schemaVersion: VERSION,
    stateVersion: `ci-ess:${state.hour + 1}`,
    revision: state.revision + 1,
    hour: state.hour + 1,
    soc: nextSoc,
    usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
  };
  const gridAfter = gridPowerKw({ load: loadKw(next.hour), pv: 0, essPower: 0 });
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
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: {
      schemaVersion: VERSION,
      vector: [
        gridAfter / OBS_SCALE,
        Math.round((nextSoc - BATTERY.socMin) / 100 * 1000) / 1000,
        Math.round(priceChannel(next.hour) * 1000) / 1000,
      ],
      stateVersion: `ci-ess:${next.hour}`,
      intervalId: `ci-ess:${next.hour}`,
      evidence: [{
        schemaVersion: VERSION,
        kind: 'settlement',
        hour: state.hour,
        gridPowerKw: grid,
        price: tariffForHour(state.hour).price,
        costYuan: Math.round(grid * tariffForHour(state.hour).price * 1000) / 1000,
        soc: nextSoc,
      }],
    },
  };
}

function tariffPrice(hour) {
  return tariffForHour(hour).price;
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

