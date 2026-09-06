# -*- coding: utf-8 -*-
import io

p = 'PAPER.md'
s = io.open(p, encoding='utf-8').read()

def rep(old, new, label):
    global s
    assert old in s, 'anchor not found: ' + label
    s = s.replace(old, new, 1)
    print('ok:', label)

# 摘要后图表说明
rep("**关键词**：Agent 底座；证据闭环；确定性重放；反证驱动演化；领域盲内核；WorldPort；能源行业场景",
"""**关键词**：Agent 底座；证据闭环；确定性重放；反证驱动演化；领域盲内核；WorldPort；能源行业场景

> **图表说明**：本文全部图表由 `scripts/paper/build-figures.mjs` 从真实实验运行中自动收集数据并渲染为零依赖 SVG（`docs/figures/`），每次重跑即重新生成——图表本身可复现。""", 'abstract')

# 2.1 架构图
rep("- **不变量 13**：模型输出只是不可信提议；只有 Kernel 的安全选择、WorldPort 的执行回执和 verify/learn 的证据才能改变连续性状态。\n\n### 2.2",
"""- **不变量 13**：模型输出只是不可信提议；只有 Kernel 的安全选择、WorldPort 的执行回执和 verify/learn 的证据才能改变连续性状态。

![Fig. 1](docs/figures/fig1-architecture.svg)

**图 1**：分层架构与信任边界。Kernel（左，领域盲、纯函数）与 WorldPort 边界（右，全部领域语义）严格分离；下方为不可信模型提议层与可审计账本层，底部为被四层混杂防线实证的证据不变量。

### 2.2""", 'fig1')

# 3 阶梯图
rep("项目累计记录 **125 项任务**（T- 系列基础设施 + F- 系列特性/反证），其中本报告覆盖的 F-114~F-126 共 13 项。",
"""项目累计记录 **125 项任务**（T- 系列基础设施 + F- 系列特性/反证），其中本报告覆盖的 F-114~F-126 共 13 项。

![Fig. 2](docs/figures/fig2-ladder.svg)

**图 2**：版本化学习阶梯。每个台阶由一次反证实验驱动、带历史回放兼容门控（旧账本按其历史语义重放，未知版本 fail-closed）。本报告覆盖区间内新增 v25（多尺度上下文）、v26（长窗口上下文）、v27（再验证信念门控）三个台阶。""", 'fig2')

# 4.1 相位锁定
rep("| v26 双 seed 真实 CLI 360 步 | 成熟窗口 87/120 与 ≥90/120，全部重放一致 | 跨进程、跨 token 置换稳定 |",
"""| v26 双 seed 真实 CLI 360 步 | 成熟窗口 87/120 与 ≥90/120，全部重放一致 | 跨进程、跨 token 置换稳定 |

![Fig. 3](docs/figures/fig3-phase-lock.svg)

**图 3**：周期-7 碰撞世界的相位锁定曲线（30 步滑动窗口当步赢家率，本轮复跑 seed `paper-lock`，收尾窗口 83.3%）。水平参考线为盲选基线（25%）、窗口-2 条件策略的信息论最优（78.6%）与窗口-8 可达上限（100%）。曲线在前 ~150 步越过窗口-2 最优线，证明内核学到了只有窗口-8 上下文才能表达的相位条件策略。""", 'fig3')

# 4.2 驻留
rep("这一更正本身是方法论的证据：**反证实验不仅约束实现，也约束结论**——当实验推翻自己的先前判断时，记录被更正而非掩饰。",
"""这一更正本身是方法论的证据：**反证实验不仅约束实现，也约束结论**——当实验推翻自己的先前判断时，记录被更正而非掩饰。

![Fig. 4](docs/figures/fig4-value-hold.svg)

**图 4**：周期-7 世界 700 步运行的观测值曲线（本轮复跑 seed `paper-hold`，699 个数据点）。红色虚线为目标 400：值上升进入目标邻域并长期运行（末 200 步平均距离 19.7）——越过目标后调度赢家不再是价值最优动作（§4.1 的赢家率度量在此阶段失效），验证了目标驻留行为与度量边界。""", 'fig4')

# 4.3 突变检验（用不含引号歧义的锚点）
rep("前三层单独突变均被余层拦截，四层同时关闭才放行——宪法不变量 5「双层校验、不能单点信任」的实证。",
"""前三层单独突变均被余层拦截，四层同时关闭才放行——宪法不变量 5「双层校验、不能单点信任」的实证。

![Fig. 8](docs/figures/fig8-mutation.svg)

**图 8**：挑战套件突变检验结果——每个判别器在注入其针对的缺陷后都将隔离子实验空间的运行判为 FALSIFIED（10/10，绿色柱）。「永远 PASS 的挑战证伪力为零」：本检验证明套件的每个判别器都真实有效。""", 'fig8')

# 5 SOC 图
rep("**真实模型行业闭环**：glm-5.3-flash 在工商储能场景 4 步提议全部被采纳、零拒绝、重放一致——同一套 Kernel 契约从合成世界无缝延伸到行业世界。",
"""**真实模型行业闭环**：glm-5.3-flash 在工商储能场景 4 步提议全部被采纳、零拒绝、重放一致——同一套 Kernel 契约从合成世界无缝延伸到行业世界。

![Fig. 5](docs/figures/fig5-ciess-soc.svg)

**图 5**：工商储能场景 72 步（每小时一步）的 SOC 曲线（本轮复跑 seed `paper-ci-ess`）。绿色实线为 SOC，红色/黄色虚线为 BMS 下限（10%）与上限（95%）——内核的谷充峰放循环使 SOC 在边界内往复，24 小时窗口最大波动超过 30%（行业判据），全程零越限。""", 'fig5')

# vpp 图
rep("| **VPP 虚拟电厂**（vpp） | [聚合出力, 跟踪偏差, 调度指令]；双站点 ±30kW 步进 | 96 步收尾平均跟踪偏差 <38kW（指令幅度 ±30）、重放一致 |",
"""| **VPP 虚拟电厂**（vpp） | [聚合出力, 跟踪偏差, 调度指令]；双站点 ±30kW 步进 | 96 步收尾平均跟踪偏差 <38kW（指令幅度 ±30）、重放一致 |

![Fig. 6](docs/figures/fig6-vpp-tracking.svg)

**图 6**：VPP 场景 96 步的调度指令（红）与两站点聚合出力（蓝）跟踪曲线（本轮复跑 seed `paper-vpp`，收尾 24 步平均偏差 21.7kW）。出力对指令阶跃的追赶直接可视化了两站点 ±30kW 步进调节的学习行为。""", 'fig6')

# ems 图
rep("调试过程修复了三处世界缺陷（restore 清零被递减覆盖产生无主 pending、模式切换步误建无主 pending、feedback 键集不符契约），全部 fail-closed 拦截。",
"""调试过程修复了三处世界缺陷（restore 清零被递减覆盖产生无主 pending、模式切换步误建无主 pending、feedback 键集不符契约），全部 fail-closed 拦截。

![Fig. 7](docs/figures/fig7-ems-demand.svg)

**图 7**：EMS 场景 96 步的本地负荷（蓝）与需量峰值（紫）曲线，红色虚线为 250kW 合同需量（本轮复跑 seed `paper-ems`，全程需量峰值 260kW，仅探索期小幅超出合同 4%）。DR 削减步的负荷凹陷与恢复反弹的抬升清晰可见——反弹由延迟反馈通道归因到原 shed 动作，不冒充本步成果。""", 'fig7')

# 附录
rep("| 提交 | 14 个（`0617c13..47dd751`+），全部推送 GitHub |",
"""| 提交 | 16 个（`0617c13..0b7e6f4`+），全部推送 GitHub |
| 论文图表 | 8 幅 SVG（`docs/figures/`），由 `scripts/paper/build-figures.mjs` 从真实实验运行自动生成 |""", 'appendix-a')
rep("| 治理文档 | `.specify/constitution.md`、`spec.md`、`design.md`、`plan.md` |",
"| 治理文档 | `.specify/constitution.md`、`spec.md`、`design.md`、`plan.md` |\n| 图表构建器 | `scripts/paper/build-figures.mjs`（重跑即重新收集数据并渲染） |", 'appendix-b')

io.open(p, 'w', encoding='utf-8').write(s)
print('PAPER.md illustrated:', s.count('docs/figures/'), 'figure references')
