#!/usr/bin/env node

// 光储充场站场景 WorldPort：光伏 + 储能 + 充电桩 + 电表（并网点计量）。
// 设备语义：SOC 动力学与 BMS 边界（电池）、钟形出力曲线（光伏）、
// 确定性接入序列（充电桩——在桩即行动中外部事件，归因保守化）、
// 变压器容量与防逆流双保护（并网点）。
// 观测 4 维：[SOC，并网点/100，光伏出力/200，充电负荷/120]；
// ValueSpec：目标 [85, 0, 0, 0] —— 并网点功率压向零（自发自用），SOC 维持高位。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  batteryAllows,
  batteryStep,
  gridPowerKw,
  loadKw,
  pvOutputKw,
} from '../shared/energy-sim.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'pv-station-adapter-v1';
const WORLD_ID = 'pv-station';
const CAPABILITY_IDS = ['ess.charge', 'ess.discharge', 'ess.idle', 'charger.stop'];
const ESS_POWER = { 'ess.charge': 100, 'ess.discharge': -100, 'ess.idle': 0 };
const TRANSFORMER_KW = 250;
const CHARGING_SCHEDULE = [0, 0, 0, 60, 0, 0, 0, 0, 120, 120, 0, 0, 60, 60, 0, 0, 90, 90, 60, 0, 0, 0, 0, 0];
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
      worldVersion: 'pv-station-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: {
        schemaVersion: VERSION,
        observationDimensions: 4,
        weights: [0.5, 1.2, 0, 0],
        target: [85, 0, 0, 0],
      },
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') {
    return { state: { schemaVersion: VERSION, stateVersion: 'pv-station:0', revision: 0, hour: 0, soc: 50, usedExecutionNonces: [] } };
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
        safe: entry.capabilityId === 'charger.cap' ? true : capabilitySafe(entry.capabilityId, payload.state),
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
  // 能力投影：储能动作后并网点越变压器容量 → 不安全。
  // transition 内的 TRANSFORMER_CAPACITY 是第二道防线。
  // 能力投影必须考虑动作自身对充电负荷的修改（charger.stop 停充后
  // 光伏盈余即倒送）。transition 内的双保护拒绝是第二道防线。
  const charging = capabilityId === 'charger.stop' ? 0 : chargingAt(state.hour);
  const grid = gridPowerKw({
    load: loadKw(state.hour),
    pv: pvOutputKw(state.hour),
    essPower: power,
    charging,
  });
  // 防逆流与变压器容量双投影：任一越界 → 不安全
  return grid >= 0 && grid <= TRANSFORMER_KW;
}

function chargingAt(hour) {
  return CHARGING_SCHEDULE[hour % 24] ?? 0;
}

function observation(state) {
  const grid = gridPowerKw({
    load: loadKw(state.hour),
    pv: pvOutputKw(state.hour),
    essPower: 0,
    charging: chargingAt(state.hour),
  });
  return {
    schemaVersion: VERSION,
    vector: [
      state.soc,
      grid / 100,
      Math.round(pvOutputKw(state.hour) / 200 * 1000) / 1000,
      chargingAt(state.hour) / 120,
    ],
    stateVersion: `pv-station:${state.hour}`,
    intervalId: `pv-station:${state.hour}`,
    evidence: [],
  };
}

function transition(state, request, manifest) {
  const entries = manifest?.tokenMap?.entries;
  const entry = entries?.find((candidate) => candidate.token === request.token);
  if (entry === undefined) throw new Error('unknown action token');
  const capabilityId = entry.capabilityId;
  const charging = chargingAt(state.hour);
  const cappedCharging = capabilityId === 'charger.stop' ? 0 : charging;
  const essPower = ESS_POWER[capabilityId] ?? 0;

  if (!batteryAllows(state.soc, essPower)) {
    return rejected(state, request, 'BMS_SOC_BOUNDARY');
  }
  const nextSoc = batteryStep(state.soc, essPower);
  const pv = pvOutputKw(state.hour);
  const grid = gridPowerKw({ load: loadKw(state.hour), pv, essPower, charging: cappedCharging });
  if (grid < 0) {
    return rejected(state, request, 'GRID_EXPORT_NOT_ALLOWED');
  }
  if (grid > TRANSFORMER_KW) {
    // 变压器容量保护：储能不足 + 充电负荷越容必须拒绝
    return rejected(state, request, 'TRANSFORMER_CAPACITY');
  }

  const next = {
    schemaVersion: VERSION,
    stateVersion: `pv-station:${state.hour + 1}`,
    revision: state.revision + 1,
    hour: state.hour + 1,
    soc: nextSoc,
    usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
  };
  const gridAfter = gridPowerKw({
    load: loadKw(next.hour),
    pv: pvOutputKw(next.hour),
    essPower: 0,
    charging: chargingAt(next.hour),
  });
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
      // 充电桩接入/离开是行动中外部事件：在桩即混杂，归因保守化
      attributionWindowComplete: charging === 0,
      confounderCount: charging > 0 ? 1 : 0,
    },
    postObservation: {
      schemaVersion: VERSION,
      vector: [
        nextSoc,
        gridAfter / 100,
        Math.round(pvOutputKw(next.hour) / 200 * 1000) / 1000,
        chargingAt(next.hour) / 120,
      ],
      stateVersion: `pv-station:${next.hour}`,
      intervalId: `pv-station:${next.hour}`,
      evidence: [{
        schemaVersion: VERSION,
        kind: 'settlement',
        hour: state.hour,
        gridPowerKw: grid,
        pv,
        charging: cappedCharging,
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
