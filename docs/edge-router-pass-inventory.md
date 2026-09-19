# edge-router pass 盘点（卡 5.0，2026-09-20）

> 只读产出：`routeEdges()` 装配顺序里的每个决策点 / 后处理 pass 是什么、哪个 fixture
> 推出来的、已知冲突、**P5 轨道分配接管后的去留**。行号基于 2026-09-20 HEAD
> （`188fee3`+）。P5 的目标不是再加 pass，而是用轨道分配替换掉其中一半。

## 一、装配顺序（src/stages/edge-router/index.ts 的 routeEdges）

### 逐边前的全局决策

| # | 决策点 | 位置 | 干什么 | 证据 fixture | P5 去留 |
|---|---|---|---|---|---|
| 0 | `classify` | classifier.ts | edge → EdgeType（forward/branch/back/cross-lane/boundary-to-handler…） | — | **保留**（语义层，与几何正交） |
| 1 | `detectFanInBundles` | bundle.ts:48 | 共 sink 的「≥2 长程 gateway 入边」拓扑识别 | 39 | **保留**（拓扑识别，5.2 只换走廊算法） |
| 2 | `allocateChannels` | channel.ts | 同 bucket 边按 source.x 排序给固定偏移序号 | — | **5.1 替换**（bucket 偏移 → 层间隙轨道） |
| 2b | `planGatewayForkAnchors` | index.ts ~340 | 发散网关部分出边改 top/bottom 顶点出（分叉可见性） | 38 | **保留**（锚点语义） |
| 2c | `planReversePairAnchors` | index.ts ~417 | A↔B 双向对的回边改侧面进 target | 37 | **保留**（锚点语义） |

### 逐边 shaping（step 3 循环内）

| # | 决策点 | 干什么 | 证据 | P5 去留 |
|---|---|---|---|---|
| 3a | `resolveAnchorsForGeometry` | cross-lane 边按横向远近改 left/right 进入 | 41/44 | 保留 |
| 3b | `collectObstacles` + `shapePath` | 按 EdgeType 套模板（Z/L/拱/dive-first/side-exit-Z/jog 吸收/forward-skip 拱侧） | 大量 | 模板保留；**5.1 接管 forward 边的竖直段位置**后，Z 形的 trunkX 不再各算各的 |
| 3c | BE dive-first（path-shaper `tryBoundaryDiveFirst`） | boundary→handler 三形态潜行道（浅窗直行/深窗近侧/深窗底边） | 80/13/77（用户目检） | **保留**（自带走廊语义，5.1 明确不抢） |
| 3d | 分支 side-exit Z（`trySideExitZ`） | branch L 中段撞节点时从 source 侧边出 | 62（用户目检） | 保留 |

### 后处理 pass（按执行顺序——顺序即优先级，lessons 第 7 条）

| # | pass | 位置 | 干什么 | 证据 | P5 去留 |
|---|---|---|---|---|---|
| B1 | `busifyForwardStep` | index.ts:889 | 共 source 的 forward-step 统一 trunkX（共干→分叉） | — | **5.1 替换**（trunkX=轨道 x） |
| B2 | `busifyFanInToSink` | index.ts:932 | 归一束重写：hSide 侧进 → 竖直总线 → 上下走廊（`pickCleanCorridorY` maximin 选 y） | 39/40 | **5.2 替换**（走廊 y = 行间轨道分配） |
| B2b | `busifyParallelJoinToGateway` | index.ts:1158 | ≥5 路 task→gateway 归一竖直总线 | 72（用户目检） | **5.1 替换**（与 B1 同类） |
| D | `detourRoutesAroundLocalObstacles` | index.ts:597 + local-obstacle-detour.ts | 撞节点的边局部绕障（滑动/微扰收敛） | 17 等 | 保留为安全网，轨道成熟后降级为断言 |
| F | `finalizeRoutePortsForRoutes` | index.ts:465 | 端口侧校正 + `ensureTargetArrowTailStub`（箭头直入 20px stub） | — | **保留**（E1/E3 力学，永在最后区域） |
| F7 | `nudgeHorizontalSegmentsOffDividers` | index.ts:627 | 贴 lane 分隔线(<8px)的水平段推开 | 36 | **5.2 替换**（轨道天生避开分隔线） |
| F8 | `nudgeParallelSegmentsApart` | index.ts:686 | 近平行段(dy<10)推开 ≥12px；推不动时并线共享干线（99 加的退路） | 40/99 | **5.2 替换**大半（轨道唯一性消灭近平行） |
| FL | `keepIntraLaneBackEdgeInsideLane` | index.ts:212 | 同 lane 回边拱夹回 lane 内 | 40 | **5.2 替换**（回边轨道按嵌套深度内轨） |

## 二、已知 pass 冲突（P5 必须解决的清单）

1. **finalize tail-stub 会改写水平段 Y**（target 箭头直入把倒数第二段拉到
   end.y±20）→ F7/F8 **必须**排在 finalize 之后（36 的 4px 案例写在其注释里）。
   轨道分配若在 shaping 期定 y，finalize 仍可能破坏——轨道 x 只管竖直段则无此冲突。
2. **F7 只懂「离分隔线远」不懂「留在本 lane」** → keepIntraLaneBackEdgeInsideLane
   必须排最后把拱夹回来（40）。两个 pass 对同一拱各拉一边 = lessons 第 7 条原型。
3. **F8 与归一走廊**：走廊束是固定锚（skipIds），其它边推不开时并线（99 的
   tryMergeOnto）；并线又可能与第三段挤出新叠线——三重检查后仍偶发（23 escalation
   的 S-jog，本 session 观测，归 5.2）。
4. **pickCleanCorridorY maximin 在拥挤带失灵**：带内 4 条 avoid 时只剩 8.5px
   净空（99 实测打点）。轨道分配必须有「带不够就推层」的能力（Compactor 允许）。
5. **channel.ts 的 bucket 偏移在 busify 重写后大多作废**（busify 直接改 wp1/wp2），
   真正活下来的只有拱形公式里的 `channel * CHANNEL_GAP`——两套错开机制并存但
   作用域不同，5.1 收编时注意别把拱侧错开也删了。

## 三、P5 的替换映射（5.1/5.2 的验收对照）

- **5.1 竖直轨道（层间隙）**接管：allocateChannels 的 bucket、B1/B2b 的 trunkX、
  F8 对 forward 段的大半、同源扇出 label 的独占轨（56/90 的 L3 从源头消失）。
  验收锚点：101 缠线（F10 7→≤3）、56/57/59、F12 101/56 归 0。
- **5.2 行间走廊轨道**接管：B2 的 pickCleanCorridorY、F7、FL、F8 对回边段。
  验收锚点：39/54 走廊骑行、47/48/49 回边间距、23 的 S-jog。
- **不抢的地盘**：3c dive-first 潜行道、compensation direct 端口、2b/2c/3a 锚点
  语义、finalize 的 E1/E3 力学。
- **删 pass 节奏（5.3）**：每接管一类边删对应 pass + 补一条单测；目标 index.ts
  从当前 ~1250 行降到 ≤600。
