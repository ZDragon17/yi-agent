// 能源行业场景共享设备模型库。
// 全部函数为纯确定性计算：同样的状态与动作永远产生同样的下一状态，
// 满足 yi-agent 的确定性重放契约。领域语义只存在于 WorldPort 边界，
// Kernel 永远只看到数值观测向量、ValueSpec 与不透明 action token。

export const TOU_TARIFF = {
  // 分时电价（元/kWh）：谷 / 平 / 峰
  valley: 0.35,
  flat: 0.70,
  peak: 1.20,
  // 观测通道归一化的中位电价：price' = price - median，
  // 使关系签名（r1: 符号模式）天然区分峰谷方向。
  median: 0.70,
};

// 24 时段（每步 1 小时）的电价档位：0 谷 / 1 平 / 2 峰
// 工商业典型双充一放日曲线：00-07 谷，08-10 峰，11-17 平，18-21 峰，22-23 平。
export const PRICE_LEVELS_BY_HOUR = [
  0, 0, 0, 0, 0, 0, 0, 0, // 00:00-07:59 谷
  2, 2, 2, // 08:00-10:59 早峰
  1, 1, 1, 1, 1, 1, // 11:00-16:59 平
  2, 2, 2, 2, // 17:00-20:59 晚峰
  1, 1, 1, // 21:00-23:59 平
];
if (PRICE_LEVELS_BY_HOUR.length !== 24) throw new Error('tariff table must cover 24 hours');

export function tariffForHour(hour) {
  const level = PRICE_LEVELS_BY_HOUR[hour % 24];
  return { level, price: [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][level] };
}

export function priceChannel(hour) {
  // 归一化电价观测通道：峰为正、谷为负、平近零
  return tariffForHour(hour).price - TOU_TARIFF.median;
}

// ---- 电池（BMS 边界内的 SOC 动力学） ----

export const BATTERY = {
  capacityKWh: 800, // 电池额定能量
  ratedPowerKw: 100, // 额定充/放功率
  efficiency: 0.95, // 双向效率
  socMin: 10, // BMS 放电下限（%）
  socMax: 95, // BMS 充电上限（%）
};

export function batteryStep(soc, powerKw, hours = 1) {
  // powerKw > 0 充电，< 0 放电；库仑效率计入
  const deltaSoc = (powerKw * hours * (powerKw > 0 ? BATTERY.efficiency : 1 / BATTERY.efficiency) * 100) / BATTERY.capacityKWh;
  return Math.round(Math.min(100, Math.max(0, soc + deltaSoc)) * 1000) / 1000;
}

export function batteryAllows(soc, powerKw) {
  // BMS 边界按动作后的终点 SOC 判定：起点在界内但动作会越界的动作不可行
  const next = batteryStep(soc, powerKw);
  if (next < BATTERY.socMin || next > BATTERY.socMax) return false;
  return true;
}

// ---- 光伏（工商业屋顶，晴天基准曲线 + 云遮挡系数） ----

export function pvOutputKw(hour, cloudFactor = 1) {
  // 06:00-18:00 的钟形出力，峰值 200kW
  const t = (hour % 24) - 12; // -6..+6
  if (t < -6 || t > 6) return 0;
  const shape = Math.cos((t / 6) * (Math.PI / 2)); // 0..1
  return Math.round(200 * shape * cloudFactor * 1000) / 1000;
}

// ---- 工商业负荷（工作日基准曲线，kW） ----

export function loadKw(hour) {
  const table = [
    60, 55, 50, 50, 55, 70, 100, 150, // 00-07
    220, 240, 250, 240, 180, 200, 220, 230, // 08-15
    220, 240, 260, 250, 230, 180, 120, 90, // 16-23
  ];
  return table[hour % 24];
}

// ---- 电表（功率平衡与电费计量） ----

export function gridPowerKw({ load, pv, essPower, charging = 0 }) {
  // 并网点功率：>0 从电网购电，<0 上送（本场景假设不允许上送，由世界拒绝）
  return Math.round((load + charging - pv + essPower) * 1000) / 1000;
}

export function energyCostYuan(gridPowerKw, price, hours = 1) {
  return Math.max(0, gridPowerKw) * price * hours;
}

// ---- 充电桩（确定性接入序列：给定时步返回在桩充电负荷） ----

export function chargingLoadKw(stepIndex, scheduleKw = []) {
  return scheduleKw[stepIndex % Math.max(1, scheduleKw.length)] ?? 0;
}

// ---- VPP 指令曲线（调度中心按步下发的聚合出力指令，kW） ----

export function vppCommandKw(stepIndex) {
  // 相邻指令变化 ≤ 50kW：与两站单步合计调节力（±60kW）匹配
  const curve = [30, 30, 0, 0, -20, -20, 20, 20, -30, -30, 30, 30, 0, 0, -10, -10];
  return curve[stepIndex % curve.length];
}

// ---- 逆变器（并网/离网双模式，有功/无功设定，轻载效率降额） ----

export const INVERTER = {
  ratedActiveKw: 200, // 额定有功输出
  ratedApparentKva: 220, // 额定视在容量（无功占用 S=√(P²+Q²)）
  // 负载率 → 效率 分段线性曲线：轻载降额是逆变器的真实特性
  etaCurve: [[0.1, 0.90], [0.3, 0.95], [0.5, 0.97], [1.0, 0.98]],
};

export function inverterEfficiency(loadRatio) {
  const curve = INVERTER.etaCurve;
  if (loadRatio <= curve[0][0]) return curve[0][1];
  for (let index = 1; index < curve.length; index += 1) {
    if (loadRatio <= curve[index][0]) {
      const [x0, y0] = curve[index - 1];
      const [x1, y1] = curve[index];
      return y0 + (y1 - y0) * (loadRatio - x0) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

export function inverterOutput(dcKw, { mode = 'grid', qRatio = 0 } = {}) {
  // 并网模式：DC 输入经效率曲线输出有功；无功设定占用视在容量
  // （S=√(P²+Q²) ≤ 额定视在），qRatio 为无功/额定有功比（0~0.5）。
  // 离网模式：只带本地负荷，出力 = min(可用交流, 本地负荷)。
  const activeKw = Math.round(dcKw * inverterEfficiency(dcKw / INVERTER.ratedActiveKw) * 1000) / 1000;
  const qMax = Math.sqrt(Math.max(0, INVERTER.ratedApparentKva ** 2 - activeKw ** 2));
  const reactiveKvar = Math.round(Math.min(qRatio * INVERTER.ratedActiveKw, qMax) * 1000) / 1000;
  return { activeKw, reactiveKvar, mode, islanded: mode === 'island' };
}

// ---- DR 需求响应资源（HVAC 群：削减有持续时间与恢复反弹） ----

export const DR_RESOURCE = {
  shedKw: 40, // 单次削减负荷
  reboundKw: 10, // 恢复反弹（压缩机回补）
  durationSteps: 3, // 削减持续时间
};
