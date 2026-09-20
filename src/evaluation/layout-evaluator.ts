// 客观硬/软标准检测库。
//
// 覆盖 CLAUDE.md §1-4 硬标准：
//   E1 端点贴边 / E2 不穿节点 / E3 末段垂直 / E4 waypoint 不出画布
//   N1 不重叠 / N2 不穿出父容器 / N3 容器包住 children / N4 尺寸正确
//   B1 boundary 骑边 / B2 pool 垂直堆叠 / B3 lane 顺序 / B4 sub-lane 缩进
//   L1 节点 label 不远飞 / L2 edge label 不压节点 / L3 多 label 不堆叠
//
// 设计：每个 rule 是独立函数 (parsed) -> Violation[]，互不依赖。
// 解析层一次性把 BPMN XML 拍成 plain object 喂给所有 rule。

import { resolveBackEdges } from '../stages/back-edge-resolver.ts';
import type { FlowNodeType } from '../loader/types.ts';

// ============================================================
// 解析层
// ============================================================

export interface Box { id: string; x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface EdgeRoute { id: string; source: string; target: string; waypoints: Point[]; labelBounds?: Box; bpmnType: EdgeBpmnTag; name?: string }
export type EdgeBpmnTag = 'sequenceFlow' | 'messageFlow' | 'association' | 'dataInputAssociation' | 'dataOutputAssociation';
export type NodeKind =
  | 'task' | 'event' | 'gateway' | 'subProcess' | 'dataObject' | 'boundaryEvent'
  | 'lane' | 'pool' | 'process' | 'collaboration' | 'textAnnotation' | 'other';

export interface ParsedFixture {
  fixture: string;
  totalW: number;
  totalH: number;
  boxes: Map<string, Box>;
  labels: Map<string, Box>;           // shape/edge id → BPMNLabel bounds
  edges: EdgeRoute[];
  kindOf: Map<string, NodeKind>;
  bpmnTagOf: Map<string, string>;     // id → 原 BPMN tag (startEvent / endEvent / intermediateCatchEvent ...)
  beHost: Map<string, string>;        // BE id → host id
  laneOrder: Map<string, string[]>;   // laneSet container id → ordered child lane ids
  flowNodeRefs: Map<string, Set<string>>; // lane id → set of node ids it declares
  childLanesOf: Map<string, string[]>; // parent lane id → ordered sub-lane ids
  participantOrder: string[];         // collaboration's participants in declared order
  nodeOrder: string[];                // flow node ids in XML declaration order（断环的声明序加权用）
  backEdges: Set<string>;             // 语义回边集（BackEdgeResolver 同一套算法）：F1/F3 从分母剔除
  rowOf: Map<string, number>;         // 叶子节点 → 行簇编号（cy 聚类，P6 蛇形折行的行感知）
  rowDirOf: Map<number, 1 | -1>;      // 行簇 → 主导方向（行内非回边的多数 X 方向）
}

const TAG_KIND: Record<string, NodeKind> = {
  task: 'task', userTask: 'task', serviceTask: 'task', sendTask: 'task', receiveTask: 'task',
  scriptTask: 'task', manualTask: 'task', businessRuleTask: 'task', callActivity: 'task',
  startEvent: 'event', endEvent: 'event',
  intermediateCatchEvent: 'event', intermediateThrowEvent: 'event',
  boundaryEvent: 'boundaryEvent',
  exclusiveGateway: 'gateway', parallelGateway: 'gateway', inclusiveGateway: 'gateway',
  eventBasedGateway: 'gateway', complexGateway: 'gateway',
  subProcess: 'subProcess', adHocSubProcess: 'subProcess', transaction: 'subProcess', eventSubProcess: 'subProcess',
  dataObject: 'dataObject', dataObjectReference: 'dataObject', dataStoreReference: 'dataObject',
  textAnnotation: 'textAnnotation',
  lane: 'lane', participant: 'pool', process: 'process', collaboration: 'collaboration',
};

const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set(['lane', 'pool', 'process', 'collaboration', 'subProcess']);

export function parseBpmnLayout(name: string, xml: string): ParsedFixture {
  const boxes = new Map<string, Box>();
  const labels = new Map<string, Box>();
  const edges: EdgeRoute[] = [];
  const kindOf = new Map<string, NodeKind>();
  const bpmnTagOf = new Map<string, string>();
  const beHost = new Map<string, string>();
  const laneOrder = new Map<string, string[]>();
  const flowNodeRefs = new Map<string, Set<string>>();
  const childLanesOf = new Map<string, string[]>();
  const participantOrder: string[] = [];

  // BPMN element ID → kind 映射
  const tagRe = new RegExp(`<bpmn:(${Object.keys(TAG_KIND).join('|')})\\b[^>]*\\bid="([^"]+)"[^>]*(\\/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[1]!;
    const id = m[2]!;
    kindOf.set(id, TAG_KIND[tag]!);
    bpmnTagOf.set(id, tag);
  }

  // boundaryEvent attachedToRef
  const beRe = /<bpmn:boundaryEvent\s[^>]*id="([^"]+)"[^>]*attachedToRef="([^"]+)"/g;
  while ((m = beRe.exec(xml)) !== null) beHost.set(m[1]!, m[2]!);

  // lane flowNodeRefs（含嵌套）。⚠️ 必须先识别自闭合 `<bpmn:lane ... />`——它没 inner，否则
  // 贪心匹配会把下一个 lane 的 inner 错算到自己头上（fixture 35 lane_qc_dept 是空 lane 触发过）
  const selfClosingRe = /<bpmn:lane\s[^>]*id="([^"]+)"[^>]*\/>/g;
  while ((m = selfClosingRe.exec(xml)) !== null) flowNodeRefs.set(m[1]!, new Set<string>());
  // 非自闭合 lane：先把自闭合的 lane 标签从 xml 里剔除，再 lazy 匹配
  const xmlNoSelf = xml.replace(selfClosingRe, '');
  const laneBlockRe = /<bpmn:lane\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn:lane>/g;
  while ((m = laneBlockRe.exec(xmlNoSelf)) !== null) {
    const laneId = m[1]!;
    const inner = m[2]!;
    const refSet = new Set<string>();
    const refRe = /<bpmn:flowNodeRef>([^<]+)<\/bpmn:flowNodeRef>/g;
    let rm: RegExpExecArray | null;
    while ((rm = refRe.exec(inner)) !== null) refSet.add(rm[1]!.trim());
    flowNodeRefs.set(laneId, refSet);
    // 子 lane
    const childIds: string[] = [];
    const childRe = /<bpmn:childLaneSet[^>]*>([\s\S]*?)<\/bpmn:childLaneSet>/;
    const childMatch = childRe.exec(inner);
    if (childMatch) {
      const subLaneRe = /<bpmn:lane\s[^>]*id="([^"]+)"/g;
      let sm: RegExpExecArray | null;
      while ((sm = subLaneRe.exec(childMatch[1]!)) !== null) childIds.push(sm[1]!);
    }
    if (childIds.length > 0) childLanesOf.set(laneId, childIds);
  }

  // top-level laneSet（pool 直接挂的 lane 顺序）
  const laneSetRe = /<bpmn:laneSet\s[^>]*>([\s\S]*?)<\/bpmn:laneSet>/g;
  while ((m = laneSetRe.exec(xml)) !== null) {
    const inner = m[1]!;
    // 只取这一层的 lane id，不进入 childLaneSet
    const topLanes: string[] = [];
    // 简单 depth-aware：用括号匹配比 regex 更稳，但同档 fixture 用 regex 也行
    const topRe = /<bpmn:lane\s[^>]*id="([^"]+)"/g;
    const childSetRe = /<bpmn:childLaneSet[^>]*>[\s\S]*?<\/bpmn:childLaneSet>/g;
    const cleaned = inner.replace(childSetRe, '');
    let tm: RegExpExecArray | null;
    while ((tm = topRe.exec(cleaned)) !== null) topLanes.push(tm[1]!);
    // laneSet 父 = 包含它的 process / subProcess id；这里粗糙地用 laneSet 自身 id 做 key
    // 实际 B3 检测时按"包含同一组 lane 的 process"分组——下面 N3 会重新匹配
    laneOrder.set(`__topLevel_${laneOrder.size}`, topLanes);
  }

  // participant 顺序（collaboration 下）
  const partRe = /<bpmn:participant\s[^>]*id="([^"]+)"/g;
  while ((m = partRe.exec(xml)) !== null) participantOrder.push(m[1]!);

  // gateway default 出边（驳回循环常建模为 default flow——BackEdgeResolver 语义加权需要）
  const gatewayDefault = new Map<string, string>();
  const gwRe = /<bpmn:\w+Gateway\b([^>]*)>/g;
  while ((m = gwRe.exec(xml)) !== null) {
    const attrs = m[1]!;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const def = /\bdefault="([^"]+)"/.exec(attrs)?.[1];
    if (id && def) gatewayDefault.set(id, def);
  }

  // BPMNShape bounds + 内嵌 BPMNLabel bounds
  const shapeRe = /<bpmndi:BPMNShape\s[^>]*bpmnElement="([^"]+)"[^>]*>([\s\S]*?)<\/bpmndi:BPMNShape>/g;
  while ((m = shapeRe.exec(xml)) !== null) {
    const id = m[1]!;
    const inner = m[2]!;
    const bm = /<dc:Bounds[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"[^>]*width="([-\d.]+)"[^>]*height="([-\d.]+)"/.exec(inner);
    if (!bm) continue;
    boxes.set(id, { id, x: +bm[1]!, y: +bm[2]!, w: +bm[3]!, h: +bm[4]! });
    const lm = /<bpmndi:BPMNLabel>\s*<dc:Bounds[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"[^>]*width="([-\d.]+)"[^>]*height="([-\d.]+)"/.exec(inner);
    if (lm) labels.set(id, { id: `${id}_label`, x: +lm[1]!, y: +lm[2]!, w: +lm[3]!, h: +lm[4]! });
  }

  // Edges + waypoints + inline labels。属性顺序不作假设（name 可插在 id 与 sourceRef 之间），
  // 先整段截 attrs 再逐个取。
  const attr = (attrs: string, key: string): string | undefined =>
    new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1];
  const refIdx = new Map<string, { source: string; target: string; bpmnType: EdgeBpmnTag; name?: string }>();
  const refRe = /<bpmn:(sequenceFlow|messageFlow|association|dataInputAssociation|dataOutputAssociation)\s([^>]*)>/g;
  while ((m = refRe.exec(xml)) !== null) {
    const attrs = m[2]!;
    const id = attr(attrs, 'id');
    const source = attr(attrs, 'sourceRef');
    const target = attr(attrs, 'targetRef');
    if (!id || !source || !target) continue;
    const name = attr(attrs, 'name');
    refIdx.set(id, { source, target, bpmnType: m[1]! as EdgeBpmnTag, ...(name !== undefined ? { name } : {}) });
  }
  const edgeRe = /<bpmndi:BPMNEdge\s[^>]*bpmnElement="([^"]+)"[^>]*>([\s\S]*?)<\/bpmndi:BPMNEdge>/g;
  while ((m = edgeRe.exec(xml)) !== null) {
    const id = m[1]!;
    const inner = m[2]!;
    const wps: Point[] = [];
    const wpRe = /<di:waypoint\s+x="([-\d.]+)"\s+y="([-\d.]+)"/g;
    let wm: RegExpExecArray | null;
    while ((wm = wpRe.exec(inner)) !== null) wps.push({ x: +wm[1]!, y: +wm[2]! });
    if (wps.length < 2) continue;
    const refs = refIdx.get(id);
    if (!refs) continue;
    const lm = /<bpmndi:BPMNLabel>\s*<dc:Bounds[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"[^>]*width="([-\d.]+)"[^>]*height="([-\d.]+)"/.exec(inner);
    let labelBounds: Box | undefined;
    if (lm) {
      labelBounds = { id: `${id}_label`, x: +lm[1]!, y: +lm[2]!, w: +lm[3]!, h: +lm[4]! };
      labels.set(id, labelBounds);
    }
    edges.push({ id, source: refs.source, target: refs.target, bpmnType: refs.bpmnType, waypoints: wps, labelBounds, ...(refs.name !== undefined ? { name: refs.name } : {}) });
  }

  // 顶层 plane bounds
  const rootBoundsRe = /<bpmndi:BPMNPlane[\s\S]*?<dc:Bounds[^>]*x="[-\d.]+"[^>]*y="[-\d.]+"[^>]*width="([-\d.]+)"[^>]*height="([-\d.]+)"/.exec(xml);
  let totalW = 0, totalH = 0;
  if (rootBoundsRe) { totalW = +rootBoundsRe[1]!; totalH = +rootBoundsRe[2]!; }
  else {
    for (const b of boxes.values()) { totalW = Math.max(totalW, b.x + b.w); totalH = Math.max(totalH, b.y + b.h); }
  }

  // 语义回边集：与 pipeline 同一套 BackEdgeResolver（直接 import，不复制算法——两处漂移会让
  // F1/F3 的"剔除"与 router 实际当回边处理的边不一致）。evaluator 只有 XML，按声明顺序 +
  // gateway default + edge name 重建 resolver 输入；messageFlow/association 不喂。
  // 跨 process / subprocess 内部的 sequenceFlow 一起喂：它们在图上是独立连通分量，DFS 各走各的。
  const CONTAINER_TAGS = new Set(['lane', 'participant', 'process', 'collaboration']);
  const nodeOrder = [...kindOf.keys()].filter(id => !CONTAINER_TAGS.has(bpmnTagOf.get(id) ?? ''));
  const seqFlows = edges.filter(e => e.bpmnType === 'sequenceFlow');
  const involved = new Set<string>();
  for (const e of seqFlows) { involved.add(e.source); involved.add(e.target); }
  const backEdges = resolveBackEdges({
    nodes: nodeOrder
      .filter(id => involved.has(id))
      .map(id => ({ id, type: (bpmnTagOf.get(id) ?? 'other') as FlowNodeType })),
    edges: seqFlows.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      isDefault: gatewayDefault.get(e.source) === e.id,
      label: e.name,
    })),
  });

  // 行簇与行主导方向（P6 snake 折行的行感知）：叶子节点按 cy 聚簇成行；
  // 行内非回边（非 BE 出边、非 artifact 关联）的多数 X 方向定为该行方向。
  // RTL 行（snake 偶数行）的前进边在 X 上向左——F1/F3/F9 若不看行方向会把刻意折行
  // 误判成回头/画反（71 实测 F1 52%、F3 44%、F9 10 全是误报）。
  const ROW_CLUSTER_TOL = 40;
  const rowOf = new Map<string, number>();
  const rowDirOf = new Map<number, 1 | -1>();
  {
    const leafRows: { id: string; cy: number }[] = [];
    for (const [id, b] of boxes) {
      const k = kindOf.get(id);
      if (!k || CONTAINER_KINDS.has(k) || k === 'boundaryEvent' || k === 'dataObject' || k === 'textAnnotation') continue;
      leafRows.push({ id, cy: b.y + b.h / 2 });
    }
    leafRows.sort((a, b) => a.cy - b.cy);
    const clusters: number[][] = []; // 每簇存成员序号
    const clusterCy: number[] = [];
    for (const n of leafRows) {
      const last = clusters.length - 1;
      if (last >= 0 && Math.abs(n.cy - clusterCy[last]!) <= ROW_CLUSTER_TOL) {
        clusters[last]!.push(leafRows.indexOf(n));
        const members = clusters[last]!;
        clusterCy[last] = members.reduce((s, i) => s + leafRows[i]!.cy, 0) / members.length;
      } else {
        clusters.push([leafRows.indexOf(n)]);
        clusterCy.push(n.cy);
      }
    }
    clusters.forEach((members, rowIdx) => {
      for (const i of members) rowOf.set(leafRows[i]!.id, rowIdx);
    });
    const beIds = new Set(beHost.keys());
    for (const [rowIdx, members] of clusters.entries()) {
      let forward = 0;
      let backward = 0;
      const memberSet = new Set(members.map(i => leafRows[i]!.id));
      for (const e of edges) {
        if (e.bpmnType !== 'sequenceFlow') continue;
        if (backEdges.has(e.id) || beIds.has(e.source)) continue;
        if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
        const sb = boxes.get(e.source)!;
        const tb = boxes.get(e.target)!;
        if ((tb.x + tb.w / 2) > (sb.x + sb.w / 2)) forward++; else backward++;
      }
      rowDirOf.set(rowIdx, forward >= backward ? 1 : -1);
    }
  }

  return { fixture: name, totalW, totalH, boxes, labels, edges, kindOf, bpmnTagOf, beHost, laneOrder, flowNodeRefs, childLanesOf, participantOrder, nodeOrder, backEdges, rowOf, rowDirOf };
}

// ============================================================
// 几何工具
// ============================================================

const TOL_ENDPOINT = 2;          // E1 端点贴边容差（px）
const TOL_OVERLAP = 1;           // N1 节点重叠容差
const TOL_BE_RIDE = 2;           // B1 BE 骑边容差
const TOL_LABEL_NODE = 1;        // L2 label vs node 容差

function boxIntersect(a: Box, b: Box, tol = 0): boolean {
  return a.x + a.w - tol > b.x + tol && b.x + b.w - tol > a.x + tol
      && a.y + a.h - tol > b.y + tol && b.y + b.h - tol > a.y + tol;
}
function boxContains(outer: Box, inner: Box, tol = 0): boolean {
  return outer.x - tol <= inner.x && outer.y - tol <= inner.y
      && outer.x + outer.w + tol >= inner.x + inner.w
      && outer.y + outer.h + tol >= inner.y + inner.h;
}
function pointOnBoxEdge(p: Point, b: Box, tol: number): boolean {
  const onLeft = Math.abs(p.x - b.x) <= tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
  const onRight = Math.abs(p.x - (b.x + b.w)) <= tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
  const onTop = Math.abs(p.y - b.y) <= tol && p.x >= b.x - tol && p.x <= b.x + b.w + tol;
  const onBottom = Math.abs(p.y - (b.y + b.h)) <= tol && p.x >= b.x - tol && p.x <= b.x + b.w + tol;
  return onLeft || onRight || onTop || onBottom;
}
function segmentIntersectsBox(p1: Point, p2: Point, box: Box, inset = 1): boolean {
  const x1 = box.x + inset, y1 = box.y + inset;
  const x2 = box.x + box.w - inset, y2 = box.y + box.h - inset;
  if (x1 >= x2 || y1 >= y2) return false;
  const outcode = (p: Point): number => {
    let c = 0;
    if (p.x < x1) c |= 1; else if (p.x > x2) c |= 2;
    if (p.y < y1) c |= 4; else if (p.y > y2) c |= 8;
    return c;
  };
  let a = p1, b = p2;
  let ca = outcode(a), cb = outcode(b);
  for (let i = 0; i < 4; i++) {
    if ((ca | cb) === 0) return true;
    if ((ca & cb) !== 0) return false;
    const out = ca !== 0 ? ca : cb;
    let nx: number, ny: number;
    if (out & 8) { nx = a.x + (b.x - a.x) * (y2 - a.y) / (b.y - a.y); ny = y2; }
    else if (out & 4) { nx = a.x + (b.x - a.x) * (y1 - a.y) / (b.y - a.y); ny = y1; }
    else if (out & 2) { ny = a.y + (b.y - a.y) * (x2 - a.x) / (b.x - a.x); nx = x2; }
    else { ny = a.y + (b.y - a.y) * (x1 - a.x) / (b.x - a.x); nx = x1; }
    if (out === ca) { a = { x: nx, y: ny }; ca = outcode(a); }
    else { b = { x: nx, y: ny }; cb = outcode(b); }
  }
  return true;
}

// ============================================================
// 检测函数
// ============================================================

export interface Violation { rule: string; fixture: string; detail: string }

function checkE1(p: ParsedFixture): Violation[] {
  // 端点必须在 source / target 节点边线上（容差 ±TOL_ENDPOINT px）
  const vs: Violation[] = [];
  for (const e of p.edges) {
    const srcBox = p.boxes.get(e.source);
    const tgtBox = p.boxes.get(e.target);
    if (!srcBox || !tgtBox) continue;
    const startPt = e.waypoints[0]!;
    const endPt = e.waypoints[e.waypoints.length - 1]!;
    if (!pointOnBoxEdge(startPt, srcBox, TOL_ENDPOINT)) {
      vs.push({ rule: 'E1', fixture: p.fixture, detail: `edge=${e.id} startPoint=(${startPt.x},${startPt.y}) not on source ${e.source} bbox` });
    }
    if (!pointOnBoxEdge(endPt, tgtBox, TOL_ENDPOINT)) {
      vs.push({ rule: 'E1', fixture: p.fixture, detail: `edge=${e.id} endPoint=(${endPt.x},${endPt.y}) not on target ${e.target} bbox` });
    }
  }
  return vs;
}

function checkE2(p: ParsedFixture): Violation[] {
  const vs: Violation[] = [];
  const obstacles: Box[] = [];
  for (const b of p.boxes.values()) {
    const k = p.kindOf.get(b.id);
    if (!k || CONTAINER_KINDS.has(k)) continue;
    obstacles.push(b);
  }
  for (const e of p.edges) {
    for (let i = 0; i < e.waypoints.length - 1; i++) {
      const p1 = e.waypoints[i]!, p2 = e.waypoints[i + 1]!;
      for (const o of obstacles) {
        if (o.id === e.source || o.id === e.target) continue;
        if (segmentIntersectsBox(p1, p2, o)) {
          vs.push({ rule: 'E2', fixture: p.fixture, detail: `edge=${e.id} cuts=${o.id} segIdx=${i}` });
        }
      }
    }
  }
  return vs;
}

function checkE3(p: ParsedFixture): Violation[] {
  // 末段必须 (a) 正交于目标节点的边，且 (b) 从外部进入——不能"从对侧穿透"。
  // (b) 检测：末段方向 + 末段 vs 倒数二段点的位置应该一致——neighbor 在哪侧 wp 就应在哪侧。
  // 如：edge 从上方下来（prev.y < last.y），last 必须在 target 的顶部（last.y ≈ target.top）而非底部
  // 这是 fixture 04 adjustGatewayEndpoint 反向 bug 暴露 E3 没盖到这个 case。
  //
  // BPMN 规范：sequenceFlow 必须正交（4 方向直角折线）；association / messageFlow
  // 不强制正交——A3 'direct'/'polyline preferDirect' 设计允许 2-point 斜线。E3 只对
  // sequenceFlow 执行 orthogonal 检测，但"穿透对侧"检测对所有 edge 类型生效。
  const vs: Violation[] = [];
  for (const e of p.edges) {
    if (e.waypoints.length < 2) continue;
    const last = e.waypoints[e.waypoints.length - 1]!;
    const prev = e.waypoints[e.waypoints.length - 2]!;
    const dx = Math.abs(last.x - prev.x);
    const dy = Math.abs(last.y - prev.y);
    if (dx > 0.5 && dy > 0.5) {
      if (e.bpmnType === 'sequenceFlow') {
        vs.push({ rule: 'E3', fixture: p.fixture, detail: `edge=${e.id} (sequenceFlow) last segment not orthogonal (dx=${dx.toFixed(1)} dy=${dy.toFixed(1)})` });
      }
      continue;
    }
    // 进一步：末段从对侧穿透检测。target 是 source/target 跳过的节点——查它的 bbox。
    const tgtBox = p.boxes.get(e.target);
    if (!tgtBox) continue;
    // 对 gateway，bbox 是菱形外接矩形；判定"末段是否真的从外部进入"用 segment vs box 相交：
    // 末段从 prev 到 last，prev 应该在 box 外（或边上），last 应该在 box 边上。
    // 若 prev → last 跨过 box 的对侧（即末段的"延长线方向"指向 box 外，且 last 落在 box 远端），
    // 那是穿透。
    // inset 2px：cross-pool gap mid Y 与 target.bottom 数值差 1px 的情况是路由算法的舍入产物，
    // 视觉上没问题。只有 prev wp 真的明显落进 target 内部（≥ 2px）才算 E3 违例。
    const insidePrev = pointInsideBox(prev, tgtBox, 2);
    if (insidePrev) {
      vs.push({ rule: 'E3', fixture: p.fixture, detail: `edge=${e.id} last segment enters target=${e.target} from inside (prev=${prev.x.toFixed(0)},${prev.y.toFixed(0)} inside bbox)` });
    }
    // 末段过对侧：last 在 box 的"far face"——离 prev 更远的那条边。
    // 例：prev 在 box 上方（prev.y < box.top），edge 向下；last 应在 box.top，若 last.y ≈ box.bottom 即穿过。
    if (dx < 0.5) {
      // 竖直段
      if (prev.y < tgtBox.y - 0.5 && Math.abs(last.y - (tgtBox.y + tgtBox.h)) < 1) {
        vs.push({ rule: 'E3', fixture: p.fixture, detail: `edge=${e.id} enters target=${e.target} from above but endpoint at bottom (last.y=${last.y.toFixed(0)}, target.top=${tgtBox.y})` });
      }
      if (prev.y > tgtBox.y + tgtBox.h + 0.5 && Math.abs(last.y - tgtBox.y) < 1) {
        vs.push({ rule: 'E3', fixture: p.fixture, detail: `edge=${e.id} enters target=${e.target} from below but endpoint at top` });
      }
    } else {
      // 水平段
      if (prev.x < tgtBox.x - 0.5 && Math.abs(last.x - (tgtBox.x + tgtBox.w)) < 1) {
        vs.push({ rule: 'E3', fixture: p.fixture, detail: `edge=${e.id} enters target=${e.target} from left but endpoint at right` });
      }
      if (prev.x > tgtBox.x + tgtBox.w + 0.5 && Math.abs(last.x - tgtBox.x) < 1) {
        vs.push({ rule: 'E3', fixture: p.fixture, detail: `edge=${e.id} enters target=${e.target} from right but endpoint at left` });
      }
    }
  }
  return vs;
}

function pointInsideBox(p: Point, b: Box, inset: number): boolean {
  return p.x > b.x + inset && p.x < b.x + b.w - inset
      && p.y > b.y + inset && p.y < b.y + b.h - inset;
}

function checkE4(p: ParsedFixture): Violation[] {
  const vs: Violation[] = [];
  const w = p.totalW, h = p.totalH;
  for (const e of p.edges) {
    for (const wp of e.waypoints) {
      if (wp.x < -1 || wp.x > w + 1 || wp.y < -1 || wp.y > h + 1) {
        vs.push({ rule: 'E4', fixture: p.fixture, detail: `edge=${e.id} waypoint (${wp.x},${wp.y}) outside canvas ${w}x${h}` });
        break;
      }
    }
  }
  return vs;
}

function checkN1(p: ParsedFixture): Violation[] {
  // 任意两个非容器叶子节点 bbox 不能相交
  const vs: Violation[] = [];
  const leaves: Box[] = [];
  for (const b of p.boxes.values()) {
    const k = p.kindOf.get(b.id);
    if (!k || CONTAINER_KINDS.has(k)) continue;
    // boundaryEvent 半内半外坐在 host 上，与 host 重叠是正常的——跳过 BE
    if (k === 'boundaryEvent') continue;
    leaves.push(b);
  }
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i]!, c = leaves[j]!;
      if (boxIntersect(a, c, TOL_OVERLAP)) {
        vs.push({ rule: 'N1', fixture: p.fixture, detail: `${a.id} and ${c.id} overlap` });
      }
    }
  }
  return vs;
}

function checkN2(p: ParsedFixture): Violation[] {
  // 节点必须在它所属 lane / pool / subprocess 容器内
  const vs: Violation[] = [];
  // 反向索引：node id → lane id（最近一层）
  const nodeToLane = new Map<string, string>();
  for (const [laneId, refs] of p.flowNodeRefs) {
    for (const nodeId of refs) nodeToLane.set(nodeId, laneId);
  }
  for (const [nodeId, laneId] of nodeToLane) {
    const node = p.boxes.get(nodeId);
    const lane = p.boxes.get(laneId);
    if (!node || !lane) continue;
    if (!boxContains(lane, node, TOL_OVERLAP)) {
      vs.push({ rule: 'N2', fixture: p.fixture, detail: `node=${nodeId} not inside lane=${laneId}` });
    }
  }
  return vs;
}

function checkN3(p: ParsedFixture): Violation[] {
  // 每个 lane 必须包住其所有 flowNodeRef 列出的子节点（叶子）；
  // 每个 lane 也必须包住其 childLanes（嵌套）
  const vs: Violation[] = [];
  for (const [laneId, refs] of p.flowNodeRefs) {
    const lane = p.boxes.get(laneId);
    if (!lane) continue;
    for (const nodeId of refs) {
      const node = p.boxes.get(nodeId);
      if (!node) continue;
      if (!boxContains(lane, node, TOL_OVERLAP)) {
        vs.push({ rule: 'N3', fixture: p.fixture, detail: `lane=${laneId} doesn't contain child=${nodeId}` });
      }
    }
  }
  for (const [parentId, kids] of p.childLanesOf) {
    const parent = p.boxes.get(parentId);
    if (!parent) continue;
    for (const kid of kids) {
      const child = p.boxes.get(kid);
      if (!child) continue;
      if (!boxContains(parent, child, TOL_OVERLAP)) {
        vs.push({ rule: 'N3', fixture: p.fixture, detail: `parent lane=${parentId} doesn't contain sub-lane=${kid}` });
      }
    }
  }
  return vs;
}

function checkN4(p: ParsedFixture): Violation[] {
  // task=100×80（label 可让宽变化），event=36×36，gateway=50×50。
  // 容差：event/gateway ±1px；task 高度 ±1px（宽度允许任意）
  const vs: Violation[] = [];
  for (const b of p.boxes.values()) {
    const k = p.kindOf.get(b.id);
    if (!k) continue;
    if (k === 'event' || k === 'boundaryEvent') {
      if (Math.abs(b.w - 36) > 1 || Math.abs(b.h - 36) > 1) {
        vs.push({ rule: 'N4', fixture: p.fixture, detail: `${k}=${b.id} size=${b.w}x${b.h}, expected 36x36` });
      }
    } else if (k === 'gateway') {
      if (Math.abs(b.w - 50) > 1 || Math.abs(b.h - 50) > 1) {
        vs.push({ rule: 'N4', fixture: p.fixture, detail: `gateway=${b.id} size=${b.w}x${b.h}, expected 50x50` });
      }
    } else if (k === 'task') {
      // task 高度严格 80（label 不会撑高），宽度 ≥ 100
      if (b.h < 79 || b.h > 81 || b.w < 99) {
        vs.push({ rule: 'N4', fixture: p.fixture, detail: `task=${b.id} size=${b.w}x${b.h}, expected width≥100 height=80` });
      }
    }
  }
  return vs;
}

function checkB1(p: ParsedFixture): Violation[] {
  // BE 中心点必须在 host 的某条边上（容差 ±2px）
  const vs: Violation[] = [];
  for (const [beId, hostId] of p.beHost) {
    const be = p.boxes.get(beId);
    const host = p.boxes.get(hostId);
    if (!be || !host) continue;
    const cx = be.x + be.w / 2;
    const cy = be.y + be.h / 2;
    const onEdge = pointOnBoxEdge({ x: cx, y: cy }, host, TOL_BE_RIDE);
    if (!onEdge) {
      vs.push({ rule: 'B1', fixture: p.fixture, detail: `BE=${beId} center=(${cx},${cy}) not on host=${hostId} edge` });
    }
  }
  return vs;
}

function checkB2(p: ParsedFixture): Violation[] {
  // collaboration 里多个 pool 必须垂直堆叠：不能横向重叠或 Y 顺序混乱
  // 判定：按声明顺序，pool[i+1].y >= pool[i].y + pool[i].h - tol，pool 之间最小 Y 间距 ≥ 20
  const vs: Violation[] = [];
  if (p.participantOrder.length < 2) return vs;
  const pools = p.participantOrder.map(id => p.boxes.get(id)).filter((b): b is Box => !!b);
  for (let i = 0; i < pools.length - 1; i++) {
    const a = pools[i]!, b = pools[i + 1]!;
    if (boxIntersect(a, b, TOL_OVERLAP)) {
      vs.push({ rule: 'B2', fixture: p.fixture, detail: `pool=${a.id} overlaps pool=${b.id}` });
    }
    // Y 间距
    const gap = b.y - (a.y + a.h);
    if (gap < 0) {
      vs.push({ rule: 'B2', fixture: p.fixture, detail: `pool=${b.id}.y=${b.y} above pool=${a.id} bottom=${a.y + a.h}` });
    } else if (gap < 20 - TOL_OVERLAP) {
      vs.push({ rule: 'B2', fixture: p.fixture, detail: `pool=${a.id}→${b.id} gap=${gap.toFixed(1)} < 20px` });
    }
  }
  return vs;
}

function checkB3(p: ParsedFixture): Violation[] {
  // pool 的直接 lane 按 BPMN laneSet 声明顺序，Y 单调递增
  const vs: Violation[] = [];
  for (const order of p.laneOrder.values()) {
    if (order.length < 2) continue;
    const ys: { id: string; y: number }[] = [];
    for (const lid of order) {
      const b = p.boxes.get(lid);
      if (b) ys.push({ id: lid, y: b.y });
    }
    for (let i = 0; i < ys.length - 1; i++) {
      if (ys[i + 1]!.y < ys[i]!.y - TOL_OVERLAP) {
        vs.push({ rule: 'B3', fixture: p.fixture, detail: `lanes out of declared order: ${ys[i]!.id}(y=${ys[i]!.y}) → ${ys[i + 1]!.id}(y=${ys[i + 1]!.y})` });
      }
    }
  }
  return vs;
}

function checkB4(p: ParsedFixture): Violation[] {
  // sub-lane 应该 X = parent.x + 30，width = parent.w - 30，右边界对齐父
  const vs: Violation[] = [];
  for (const [parentId, kids] of p.childLanesOf) {
    const parent = p.boxes.get(parentId);
    if (!parent) continue;
    for (const kid of kids) {
      const child = p.boxes.get(kid);
      if (!child) continue;
      const expectedX = parent.x + 30;
      const expectedW = parent.w - 30;
      const expectedRight = parent.x + parent.w;
      const childRight = child.x + child.w;
      if (Math.abs(child.x - expectedX) > 1) {
        vs.push({ rule: 'B4', fixture: p.fixture, detail: `sub-lane=${kid}.x=${child.x}, expected ${expectedX} (parent.x+30)` });
      }
      if (Math.abs(child.w - expectedW) > 1) {
        vs.push({ rule: 'B4', fixture: p.fixture, detail: `sub-lane=${kid}.w=${child.w}, expected ${expectedW}` });
      }
      if (Math.abs(childRight - expectedRight) > 1) {
        vs.push({ rule: 'B4', fixture: p.fixture, detail: `sub-lane=${kid} right=${childRight}, expected ${expectedRight}` });
      }
    }
  }
  return vs;
}

function checkL1(p: ParsedFixture): Violation[] {
  // 节点 label 距离节点 ≤ 30px（label center 到节点 bbox 任一点距离）
  const vs: Violation[] = [];
  const LIMIT = 30;
  for (const [ownerId, lab] of p.labels) {
    const owner = p.boxes.get(ownerId);
    if (!owner) continue; // edge label 在另一规则里
    const labCx = lab.x + lab.w / 2;
    const labCy = lab.y + lab.h / 2;
    const dx = Math.max(owner.x - (lab.x + lab.w), lab.x - (owner.x + owner.w), 0);
    const dy = Math.max(owner.y - (lab.y + lab.h), lab.y - (owner.y + owner.h), 0);
    const dist = Math.hypot(dx, dy);
    if (dist > LIMIT) {
      vs.push({ rule: 'L1', fixture: p.fixture, detail: `label of ${ownerId} far from node (dist=${dist.toFixed(1)} > ${LIMIT})` });
    }
  }
  return vs;
}

function checkL2(p: ParsedFixture): Violation[] {
  // edge label 几何中心不能落在节点 bbox 内（与 CLAUDE.md "压住节点" 一致；轻微擦边/角部
  // 重叠不算——BPMN 工具普遍允许。fixture 22 "通过"/"拒绝" 标签角部 5×12 px 擦到下一个
  // task，但 label 中心在 task 外，视觉上完全可读。
  const vs: Violation[] = [];
  const obstacles: Box[] = [];
  for (const b of p.boxes.values()) {
    const k = p.kindOf.get(b.id);
    if (!k || CONTAINER_KINDS.has(k)) continue;
    obstacles.push(b);
  }
  for (const e of p.edges) {
    if (!e.labelBounds) continue;
    const lb = e.labelBounds;
    const cx = lb.x + lb.w / 2;
    const cy = lb.y + lb.h / 2;
    for (const o of obstacles) {
      if (cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h) {
        vs.push({ rule: 'L2', fixture: p.fixture, detail: `edge label=${e.id} center (${cx.toFixed(0)},${cy.toFixed(0)}) inside node=${o.id}` });
      }
    }
  }
  // 节点 name 标签(gateway/event 的外置 name)也不能压住**别的**节点。盲区由来:gateway name
  // 以前不发显式 bounds、检测器看不到;现在 diagram-builder 会发(见 placeGatewayLabelsOffEdges),
  // 故能补检。判据同 edge label:label 几何中心落进非 owner 节点 box 才算(容忍角部擦边)。
  for (const [ownerId, lab] of p.labels) {
    if (!p.boxes.has(ownerId)) continue;           // edge label 的 owner 不在 boxes → 上面已处理
    const ok = p.kindOf.get(ownerId);
    if (ok && CONTAINER_KINDS.has(ok)) continue;    // pool/lane/subProcess 容器自身的 name 不算
    const cx = lab.x + lab.w / 2;
    const cy = lab.y + lab.h / 2;
    for (const o of obstacles) {
      if (o.id === ownerId) continue;
      if (cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h) {
        vs.push({ rule: 'L2', fixture: p.fixture, detail: `node label=${ownerId} center (${cx.toFixed(0)},${cy.toFixed(0)}) inside node=${o.id}` });
      }
    }
  }
  return vs;
}

function checkL3(p: ParsedFixture): Violation[] {
  // CLAUDE.md §4.L3："多个 boundary event 或多条 edge 在同一区域时，label 必须错开"。
  // 纳入两类 label 做两两叠放检测:edge label 之间、以及 node name(gateway/event 外置 name)
  // 与 edge label / 别的 node name 之间。gateway name 撞分支出边 label(如 42「包容分叉」撞
  // 「VIP客户」)正是 L3 该守的盲区——以前因 gateway 不发显式 bounds 漏检。容器(pool/lane/
  // subProcess)的 name 不纳入:它和内部元素 label 必然"同区域"但不算堆叠。
  const vs: Violation[] = [];
  const labs: Box[] = [];
  for (const [ownerId, lab] of p.labels) {
    const k = p.kindOf.get(ownerId);
    if (k && CONTAINER_KINDS.has(k)) continue;
    labs.push(lab);
  }
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) {
      const a = labs[i]!, b = labs[j]!;
      if (!boxIntersect(a, b, 0)) continue;
      const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const iaArea = ix * iy;
      const aArea = a.w * a.h, bArea = b.w * b.h;
      const minArea = Math.min(aArea, bArea);
      if (minArea > 0 && iaArea / minArea > 0.5) {
        vs.push({ rule: 'L3', fixture: p.fixture, detail: `labels ${a.id} and ${b.id} stacked (overlap=${(iaArea / minArea * 100).toFixed(0)}%)` });
      }
    }
  }
  return vs;
}

export const ALL_CHECKS: { rule: string; fn: (p: ParsedFixture) => Violation[] }[] = [
  { rule: 'E1', fn: checkE1 },
  { rule: 'E2', fn: checkE2 },
  { rule: 'E3', fn: checkE3 },
  { rule: 'E4', fn: checkE4 },
  { rule: 'N1', fn: checkN1 },
  { rule: 'N2', fn: checkN2 },
  { rule: 'N3', fn: checkN3 },
  { rule: 'N4', fn: checkN4 },
  { rule: 'B1', fn: checkB1 },
  { rule: 'B2', fn: checkB2 },
  { rule: 'B3', fn: checkB3 },
  { rule: 'B4', fn: checkB4 },
  { rule: 'L1', fn: checkL1 },
  { rule: 'L2', fn: checkL2 },
  { rule: 'L3', fn: checkL3 },
];

// ============================================================
// 软标准（CLAUDE.md §SOFT）：F1-F5 指标 + 阈值判定
// ============================================================
//
// 与硬标准不同：F 类输出**指标值 + 阈值通过**（不是"违例计数"）。判定标准基于
// CLAUDE.md 给出的"能改尽量改但不阻塞"语义，所以阈值偏宽松——不过线代表"明显失分"，
// 边线 case 当 OK 处理。

export interface SoftMetric {
  rule: string;
  fixture: string;
  value: number;
  display: string;     // 表格里显示的字符串（如 "92%" / "3.2"）
  pass: boolean;
  detail?: string;     // pass=false 时的额外说明
}

/** 边的行主导方向：同排行内边跟随其行方向（snake RTL 行向左为前进）；跨行边恒 LTR。 */
function edgeRowDir(p: ParsedFixture, e: { source: string; target: string }): 1 | -1 {
  const r = p.rowOf.get(e.source);
  if (r === undefined || p.rowOf.get(e.target) !== r) return 1;
  return p.rowDirOf.get(r) ?? 1;
}

/**
 * F1 主流方向一致：sequence flow（同 pool 内）target.x > source.x 的比例 ≥ 85%。
 * 排除：boundary BE→handler 边、cross-pool（messageFlow / 跨 participant 节点）、artifact 关联。
 * 排除：语义回边（p.backEdges——循环结构里**必须**向后的边，如驳回循环）。回边留在分母里
 * 会让 45/47/48/54 这类 fixture 天然 fail，噪声淹没真正的 N 形回头（80 的"正常履约"）。
 * 只看同排边（同 F3/F9）：跨排 carriage-return / 分支落行是折行的固有形态，不算方向不一致。
 */
function checkF1(p: ParsedFixture): SoftMetric {
  let total = 0;
  let forward = 0;
  let excluded = 0;
  const beIds = new Set(p.beHost.keys());
  for (const e of p.edges) {
    if (beIds.has(e.source)) continue;
    if (p.backEdges.has(e.id)) { excluded++; continue; }
    const sb = p.boxes.get(e.source);
    const tb = p.boxes.get(e.target);
    if (!sb || !tb) continue;
    const sk = p.kindOf.get(e.source);
    const tk = p.kindOf.get(e.target);
    if (sk === 'dataObject' || tk === 'dataObject' || sk === 'textAnnotation' || tk === 'textAnnotation') continue;
    // 跨 pool（messageFlow）排除：source 与 target 不在同一 pool
    if (!sameOwnerPool(p, e.source, e.target)) continue;
    const sCx = sb.x + sb.w / 2;
    const tCx = tb.x + tb.w / 2;
    if (Math.abs(sb.y + sb.h / 2 - (tb.y + tb.h / 2)) > F9_SAME_ROW_TOL) continue; // 换排不算回头（同 F3/F9）
    total++;
    const dir = edgeRowDir(p, e);
    if (dir === 1 ? tCx > sCx : sCx > tCx) forward++;
  }
  const ratio = total > 0 ? forward / total : 1;
  const pass = ratio >= 0.8;  // CLAUDE.md 允许 convergence gateway 把分支收回（产生少量 back-edge）
  const suffix = excluded > 0 ? `剔${excluded}` : '';
  return {
    rule: 'F1', fixture: p.fixture, value: ratio,
    display: total === 0 ? 'n/a' : `${(ratio * 100).toFixed(0)}%${suffix}`,
    pass,
    detail: pass ? undefined : `${forward}/${total} same-pool edges forward${excluded > 0 ? ` (剔 ${excluded} 语义回边)` : ''}, ratio ${(ratio * 100).toFixed(0)}% < 80%`,
  };
}

/** 判断两个节点是否同属一个 participant（pool）。无 participant 时（无 collaboration），永远 true。 */
function sameOwnerPool(p: ParsedFixture, aId: string, bId: string): boolean {
  if (p.participantOrder.length === 0) return true;
  const owner = (nid: string): string | null => {
    const nb = p.boxes.get(nid);
    if (!nb) return null;
    for (const pid of p.participantOrder) {
      const pool = p.boxes.get(pid);
      if (pool && boxContains(pool, nb, 5)) return pid;
    }
    return null;
  };
  const oa = owner(aId);
  const ob = owner(bId);
  return oa !== null && oa === ob;
}

/**
 * F2 Spine 居中：CLAUDE.md 字面 "start → end 主干（spine）应位于其层的垂直中心"。
 * spine ≠ 所有节点的中位线（那会被分支节点数量不对称拖偏，例如 fixture 31 的 6 上+5 下），
 * spine = **start/end event 的平均 cy**。Start/end 是 spine 的端点，本来就应该位于 container 中线。
 *
 * 度量：对每个非空 leaf lane 或无 lane 的 pool，找其内部的 startEvent / endEvent 节点，
 * 取它们的平均 cy，与 container 中线比。容差 ≤ 20%（spine 端点不应远离中线）。
 * 没有 start/end event 的 container 跳过（如纯子流程片段，无 spine 概念）。
 */
function checkF2(p: ParsedFixture): SoftMetric {
  let maxOffsetRatio = 0;
  let detail = '';
  const evaluate = (containerId: string, container: Box, memberIds: Iterable<string>): void => {
    const ys: number[] = [];
    for (const nid of memberIds) {
      const n = p.boxes.get(nid);
      if (!n) continue;
      const tag = p.bpmnTagOf.get(nid);
      // 仅 start/end event（不是 intermediate event——中间事件可能在任意分支上，会拖偏 spine 估计）
      if (tag !== 'startEvent' && tag !== 'endEvent') continue;
      ys.push(n.y + n.h / 2);
    }
    if (ys.length === 0) return;
    const meanY = ys.reduce((s, y) => s + y, 0) / ys.length;
    const cy = container.y + container.h / 2;
    const ratio = container.h > 0 ? Math.abs(meanY - cy) / container.h : 0;
    if (ratio > maxOffsetRatio) {
      maxOffsetRatio = ratio;
      detail = `${containerId}: start/end mean Y ${meanY.toFixed(0)} vs center ${cy.toFixed(0)}, offset=${(ratio * 100).toFixed(0)}%`;
    }
  };
  // 叶子 lane
  for (const [laneId, refs] of p.flowNodeRefs) {
    if (refs.size === 0) continue;
    const lane = p.boxes.get(laneId);
    if (!lane) continue;
    evaluate(`lane=${laneId}`, lane, refs);
  }
  // 无 lane 的 pool
  for (const pid of p.participantOrder) {
    const pool = p.boxes.get(pid);
    if (!pool) continue;
    let hasLane = false;
    for (const lid of p.flowNodeRefs.keys()) {
      const lane = p.boxes.get(lid);
      if (lane && boxContains(pool, lane, 5)) { hasLane = true; break; }
    }
    if (hasLane) continue;
    const members: string[] = [];
    for (const [nid, n] of p.boxes) {
      const k = p.kindOf.get(nid);
      if (!k || CONTAINER_KINDS.has(k) || k === 'boundaryEvent') continue;
      if (boxContains(pool, n, 5)) members.push(nid);
    }
    evaluate(`pool=${pid}`, pool, members);
  }
  // 无 collaboration 的纯 process top-level：直接看所有节点
  if (p.participantOrder.length === 0) {
    // 找顶层 process 容器
    for (const [id, b] of p.boxes) {
      if (p.kindOf.get(id) !== 'process') continue;
      const members: string[] = [];
      for (const [nid, n] of p.boxes) {
        const k = p.kindOf.get(nid);
        if (!k || CONTAINER_KINDS.has(k) || k === 'boundaryEvent') continue;
        if (boxContains(b, n, 5)) members.push(nid);
      }
      evaluate(`process=${id}`, b, members);
    }
  }
  // 阈值 30%：boundary handler / 展开 subprocess / ioSpec 都会把 pool 高度撑大，把 start/end
  // 推到上半部。这种情况是视觉正确（主流程在上，附属物在下），不算失分。
  const pass = maxOffsetRatio <= 0.30;
  return {
    rule: 'F2', fixture: p.fixture, value: maxOffsetRatio,
    display: `${(maxOffsetRatio * 100).toFixed(0)}%`,
    pass,
    detail: pass ? undefined : detail,
  };
}

/**
 * F3 不 backtrack：同 pool sequence flow 中"明显往回"（source.cx > target.cx + 一个 task 宽）
 * 的比例 ≤ 5%。CLAUDE.md 注："可以接受 convergence gateway 把分支收回主线"——所以阈值
 * 必须容许少量 back edge（多分支收敛常见）。
 * 只数同排边（|Δcy| ≤ SAME_ROW_TOL，同 F9）：跨排边是折行 carriage-return / 分支落行，
 * X 跨度由行宽决定，不是 N 形回头（全库实测：F3 的回头分子里同排边为 0 条）。
 */
const F9_BACKWARD_TOL = 10;
const F9_SAME_ROW_TOL = 60;
function checkF3(p: ParsedFixture): SoftMetric {
  let total = 0;
  let back = 0;
  let excluded = 0;
  const beIds = new Set(p.beHost.keys());
  const examples: string[] = [];
  for (const e of p.edges) {
    if (beIds.has(e.source)) continue;
    if (p.backEdges.has(e.id)) { excluded++; continue; }
    const sb = p.boxes.get(e.source);
    const tb = p.boxes.get(e.target);
    if (!sb || !tb) continue;
    const sk = p.kindOf.get(e.source);
    const tk = p.kindOf.get(e.target);
    if (sk === 'dataObject' || tk === 'dataObject' || sk === 'textAnnotation' || tk === 'textAnnotation') continue;
    if (!sameOwnerPool(p, e.source, e.target)) continue;
    const sCx = sb.x + sb.w / 2;
    const tCx = tb.x + tb.w / 2;
    if (Math.abs(sb.y + sb.h / 2 - (tb.y + tb.h / 2)) > F9_SAME_ROW_TOL) continue; // 换排不算回头
    total++;
    // 行主导方向感知：RTL 行（snake）里向左是前进，不算回头
    if ((sCx - tCx) * edgeRowDir(p, e) > 100) {
      back++;
      if (examples.length < 3) examples.push(e.id);
    }
  }
  const ratio = total > 0 ? back / total : 0;
  const pass = ratio <= 0.15;  // 收敛 gateway / handler 回主线常产生少量 back edge
  const suffix = excluded > 0 ? `剔${excluded}` : '';
  return {
    rule: 'F3', fixture: p.fixture, value: ratio,
    display: total === 0 ? 'n/a' : `${(ratio * 100).toFixed(0)}%${suffix}`,
    pass,
    detail: pass ? undefined : `${back}/${total} back edges${excluded > 0 ? ` (剔 ${excluded} 语义回边)` : ''} (${examples.join(', ')})`,
  };
}

/**
 * F4 宽高比：totalW / totalH ≤ 6.0。CLAUDE.md 字面 "避免超过 4:1"，但线性长流程（4-5 个
 * task 一行）天然就 5:1+——这是 BPMN 流程的自然形态，没有办法压缩。6:1 是"明显失分"的
 * 实际拐点（之外应该考虑改成多行布局或分支共享 Y）。
 */
function checkF4(p: ParsedFixture): SoftMetric {
  const ratio = p.totalH > 0 ? p.totalW / p.totalH : 0;
  const pass = ratio <= 6.0;
  return {
    rule: 'F4', fixture: p.fixture, value: ratio,
    display: `${ratio.toFixed(1)}`,
    pass,
    detail: pass ? undefined : `aspect ${ratio.toFixed(1)}:1 > 6:1`,
  };
}

/**
 * F5 同层节点 X 对齐：CLAUDE.md 字面"同一逻辑层级的节点应对齐"——左→右流程中"同一层级"
 * 在 BPMN/Sugiyama 中体现为"在分支/汇合中共享 cx 列的节点"（同一 layer 多分支并排）。
 *
 * 度量：聚类 cx ≤ 15px 容差，跳过纯线性流程（所有节点自成一列）。对存在共享列（多节点列）
 * 的 fixture，要求每个共享列内节点的 cx 标准差 ≤ 2px（即 ELK 输出的"列"必须精确对齐，
 * 而不是 ±10px 散乱）。
 *
 * 纯线性流程（每 layer 1 节点）n/a——没有"对齐"的概念，不算失分也不算通过。
 */
function checkF5(p: ParsedFixture): SoftMetric {
  const leaves: { id: string; cx: number; cy: number }[] = [];
  for (const [id, b] of p.boxes) {
    const k = p.kindOf.get(id);
    if (!k || CONTAINER_KINDS.has(k)) continue;
    if (k === 'boundaryEvent' || k === 'dataObject' || k === 'textAnnotation') continue;
    leaves.push({ id, cx: b.x + b.w / 2, cy: b.y + b.h / 2 });
  }
  if (leaves.length < 4) {
    return { rule: 'F5', fixture: p.fixture, value: 1, display: 'n/a', pass: true };
  }
  leaves.sort((a, b) => a.cx - b.cx);
  // 聚类容差紧到 5px：ELK 同 layer 节点天然 cx 一致，差几 px 就不是"应当同列"。
  // 之前 15px 太宽，会把相邻 layer 的不同节点误聚（fixture 03 的 start_conditional(338)
  // 与 throw_message(352) 差 14px 本来不是同列，被误判 std=7px > 2px → 失分）。
  const cols: typeof leaves[] = [];
  const CX_TOL = 5;
  for (const l of leaves) {
    const last = cols[cols.length - 1];
    if (last) {
      const meanLastCx = last.reduce((s, n) => s + n.cx, 0) / last.length;
      if (Math.abs(l.cx - meanLastCx) <= CX_TOL) { last.push(l); continue; }
    }
    cols.push([l]);
  }
  const multiCols = cols.filter(c => c.length >= 2);
  if (multiCols.length === 0) {
    return { rule: 'F5', fixture: p.fixture, value: 1, display: 'n/a', pass: true };
  }
  // 共享列内 cx 应精确对齐（std ≤ 2px）
  let alignedCols = 0;
  for (const col of multiCols) {
    const cxs = col.map(n => n.cx);
    const mean = cxs.reduce((s, x) => s + x, 0) / cxs.length;
    const std = Math.sqrt(cxs.reduce((s, x) => s + (x - mean) ** 2, 0) / cxs.length);
    if (std <= 2) alignedCols++;
  }
  const ratio = alignedCols / multiCols.length;
  const pass = ratio >= 0.9;
  return {
    rule: 'F5', fixture: p.fixture, value: ratio,
    display: `${(ratio * 100).toFixed(0)}%`,
    pass,
    detail: pass ? undefined : `${alignedCols}/${multiCols.length} shared X-cols aligned (std ≤ 2px), ${(ratio * 100).toFixed(0)}% < 90%`,
  };
}

/**
 * F6 Fan-in 归一率：多条决策分支（gateway 出边）汇入同一 sink 时，是否聚成「一根共享干线 +
 * 单点进入」，而不是各自横穿画布从不同高度扎进 sink（fixture 39 的驳回归一诉求）。
 *
 * 硬+软标准本来量不到 edge bundling——一束散乱的 fan-in 边可以全程不穿节点、端点都贴边，
 * 硬标准全过却很乱。F6 专门补这个缺口。
 *
 * 度量（与 edge-router/bundle.ts 的判据对齐，但只看几何结果、不依赖内部 edgeType）：
 *   - **限定 sink**：同 pool 入边里有 ≥2 条「长程」（source/target 不同 lane）的 target。
 *   - **成员**：该 sink 所有 gateway 出发的入边（分支/驳回）。
 *   - **归一**：成员按 (进入侧, 干线坐标) 聚类，最大簇占比即该 sink 的归一率；F6 = 各 sink 平均。
 *
 * **只观测、不设硬门**（pass 恒 true）：先攒样本看分布，避免单一 fixture 把阈值定偏。
 */
function checkF6(p: ParsedFixture): SoftMetric {
  const laneOf = new Map<string, string>();
  for (const [laneId, refs] of p.flowNodeRefs) {
    for (const nid of refs) if (!laneOf.has(nid)) laneOf.set(nid, laneId);
  }
  const isGateway = (id: string): boolean => /Gateway$/.test(p.bpmnTagOf.get(id) ?? '');

  const incoming = new Map<string, EdgeRoute[]>();
  for (const e of p.edges) {
    if (!sameOwnerPool(p, e.source, e.target)) continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }

  let ratioSum = 0;
  let qualifying = 0;
  let detail = '';
  for (const [target, ins] of incoming) {
    const tb = p.boxes.get(target);
    if (!tb) continue;
    const longRange = ins.filter((e) => {
      const sl = laneOf.get(e.source);
      const tl = laneOf.get(e.target);
      return sl !== undefined && tl !== undefined && sl !== tl;
    });
    if (longRange.length < 2) continue; // 触发门槛与 bundle.ts 一致
    const members = ins.filter((e) => isGateway(e.source) && e.waypoints.length >= 2);
    if (members.length < 2) continue;

    qualifying++;
    const groups = new Map<string, number>();
    const tcx = tb.x + tb.w / 2;
    const tcy = tb.y + tb.h / 2;
    for (const e of members) {
      const end = e.waypoints[e.waypoints.length - 1]!;
      const pen = e.waypoints[e.waypoints.length - 2]!;
      const vertical = Math.abs(pen.x - end.x) <= 2;
      const side = vertical
        ? (end.y <= tcy ? 'top' : 'bottom')
        : (end.x <= tcx ? 'left' : 'right');
      // 干线坐标：竖直进入看 x、水平进入看 y；量化到 2px 视作「同一根干线」。
      // 早先用 8px 太松——差 5px 的两条「几乎重叠但没真合并」也被算成同一根，
      // 给叠糊版打了 100% 的假分。收紧到 2px 才能区分「真合一根」与「挤在一起」。
      const trunk = Math.round((vertical ? pen.x : pen.y) / 2);
      const key = `${side}:${trunk}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const largest = Math.max(...groups.values());
    const ratio = largest / members.length;
    ratioSum += ratio;
    if (ratio < 1 && !detail) {
      detail = `${target}: ${largest}/${members.length} fan-in edges share one trunk+side`;
    }
  }

  if (qualifying === 0) {
    return { rule: 'F6', fixture: p.fixture, value: 1, display: 'n/a', pass: true };
  }
  const value = ratioSum / qualifying;
  return {
    rule: 'F6', fixture: p.fixture, value,
    display: `${(value * 100).toFixed(0)}%`,
    pass: true, // 只观测不设硬门
    detail: value < 1 ? detail : undefined,
  };
}

/**
 * F7 边-分隔线净空：水平 edge 段不应紧贴 lane 分隔线跑（视觉上分不清是流程线还是泳道边）。
 * 这是硬标准量不到的「丑但合规」：边没穿节点、端点都贴边，却贴着泳道线。
 *
 * 度量：统计「较长(>30px)的水平 edge 段」中，离任一 lane 上/下边界 < 8px(且不正好压在线上)的条数。
 * 0 条 = 干净。无 lane 的图 n/a。
 */
const F7_CLEARANCE = 8;
function checkF7(p: ParsedFixture): SoftMetric {
  const dividers = laneDividerYs(p);
  if (dividers.length === 0) return { rule: 'F7', fixture: p.fixture, value: 0, display: 'n/a', pass: true };
  let tooClose = 0;
  let worst = Infinity;
  let ex = '';
  for (const e of p.edges) {
    for (let i = 0; i < e.waypoints.length - 1; i++) {
      const a = e.waypoints[i]!;
      const b = e.waypoints[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) continue;            // 仅水平段
      if (Math.abs(a.x - b.x) < 30) continue;           // 忽略短 stub（入节点的最后一小段）
      for (const d of dividers) {
        const dist = Math.abs(a.y - d);
        if (dist > 0.5 && dist < F7_CLEARANCE) {
          tooClose++;
          if (dist < worst) { worst = dist; ex = `${e.id}@y${Math.round(a.y)} 距分隔线${d}仅${dist.toFixed(0)}px`; }
          break;
        }
      }
    }
  }
  return {
    rule: 'F7', fixture: p.fixture, value: tooClose,
    display: `${tooClose}`, pass: tooClose === 0,
    detail: tooClose === 0 ? undefined : `${tooClose} 段贴分隔线(<${F7_CLEARANCE}px)，最近 ${ex}`,
  };
}

/**
 * F8 近平行边间距：两条不同 edge 的同向段若 dy<10px 且 x 区间重叠，视觉上叠成一条糊线。
 * 也是硬标准量不到的「丑但合规」（fan-in 归一早期版叠 5px 即此类）。
 *
 * 度量：统计这样的水平段对数。0 = 干净。
 */
const F8_MIN_GAP = 10;
function checkF8(p: ParsedFixture): SoftMetric {
  const segs: { id: string; y: number; x1: number; x2: number }[] = [];
  for (const e of p.edges) {
    for (let i = 0; i < e.waypoints.length - 1; i++) {
      const a = e.waypoints[i]!;
      const b = e.waypoints[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) continue;
      if (Math.abs(a.x - b.x) < 20) continue;
      segs.push({ id: e.id, y: a.y, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) });
    }
  }
  let pairs = 0;
  let ex = '';
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.id === t.id) continue;
      const dy = Math.abs(s.y - t.y);
      const overlap = Math.min(s.x2, t.x2) - Math.max(s.x1, t.x1);
      if (dy > 0.5 && dy < F8_MIN_GAP && overlap > 20) {
        pairs++;
        if (!ex) ex = `${s.id}@y${Math.round(s.y)} ∥ ${t.id}@y${Math.round(t.y)} dy=${dy.toFixed(0)}`;
      }
    }
  }
  return {
    rule: 'F8', fixture: p.fixture, value: pairs,
    display: `${pairs}`, pass: pairs === 0,
    detail: pairs === 0 ? undefined : `${pairs} 对近平行叠线(dy<${F8_MIN_GAP}px)，如 ${ex}`,
  };
}

/**
 * F9 X 顺序与拓扑顺序一致：feedback-2026-06-11 的蛇形回归（gateway 被甩到最左、其拓扑前驱
 * 在最右）E/N/B/L 全过、F3 也量不到——F3 只看比例，蛇形图的回头边占比可能不高，且它把
 * 真回头边和被画反的主干边混在一起。F9 把两者分开：先在边图上 DFS 标记**真**回头边
 * （成环边），剩下的 DAG 边都是主干/分支，要求 X 单调向前；同排（cy 接近）却明显向左的
 * DAG 边即「拓扑顺序被画反」。折行链的换行边（target 掉到下一排）不算——那是有意换行。
 */
function checkF9(p: ParsedFixture): SoftMetric {
  const beIds = new Set(p.beHost.keys());
  interface Cand { id: string; source: string; target: string }
  const adj = new Map<string, Cand[]>();
  const inDeg = new Map<string, number>();
  const candidates: Cand[] = [];
  for (const e of p.edges) {
    if (beIds.has(e.source)) continue;
    const sb = p.boxes.get(e.source);
    const tb = p.boxes.get(e.target);
    if (!sb || !tb) continue;
    const sk = p.kindOf.get(e.source);
    const tk = p.kindOf.get(e.target);
    if (sk === 'dataObject' || tk === 'dataObject' || sk === 'textAnnotation' || tk === 'textAnnotation') continue;
    if (!sameOwnerPool(p, e.source, e.target)) continue;
    const cand: Cand = { id: e.id, source: e.source, target: e.target };
    candidates.push(cand);
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(cand);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  if (candidates.length === 0) {
    return { rule: 'F9', fixture: p.fixture, value: 0, display: 'n/a', pass: true };
  }

  // DFS 标记成环边。根选 in-degree 0 的节点（start event）优先，保证沿主流方向走，
  // 标出来的 back 边贴近 BPMN 语义（驳回/重做 loop）。
  const back = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const dfs = (u: string): void => {
    state.set(u, 1);
    for (const c of adj.get(u) ?? []) {
      const st = state.get(c.target) ?? 0;
      if (st === 1) back.add(c.id);
      else if (st === 0) dfs(c.target);
    }
    state.set(u, 2);
  };
  const roots = [...adj.keys()].sort((a, b) => (inDeg.get(a) ?? 0) - (inDeg.get(b) ?? 0));
  for (const u of roots) if ((state.get(u) ?? 0) === 0) dfs(u);

  const cxOf = (id: string): number => {
    const b = p.boxes.get(id)!;
    return b.x + b.w / 2;
  };
  let reversed = 0;
  let ex = '';
  for (const c of candidates) {
    if (back.has(c.id)) continue;
    const sb = p.boxes.get(c.source)!;
    const tb = p.boxes.get(c.target)!;
    const sCx = sb.x + sb.w / 2;
    const tCx = tb.x + tb.w / 2;
    const sCy = sb.y + sb.h / 2;
    const tCy = tb.y + tb.h / 2;
    // X 向前或几乎平（snake RTL 行内向左为前进，不算画反）
    if ((sCx - tCx) * edgeRowDir(p, c) <= F9_BACKWARD_TOL) continue;
    if (Math.abs(sCy - tCy) > F9_SAME_ROW_TOL) continue; // 换排（折行/分支落行）不算画反
    // 收敛豁免（同 CLAUDE.md F3 注）：target 另有非回头入边从左侧正常进入 → 本边是两侧
    // 分支汇入居中 sink 的 fan-in（fixture 23 双 handler 汇入 end_error），不是主干画反。
    const isConvergence = candidates.some((o) =>
      o !== c && o.target === c.target && !back.has(o.id) && cxOf(o.source) < tCx - F9_BACKWARD_TOL);
    if (isConvergence) continue;
    reversed++;
    if (!ex) ex = `${c.id} (${c.source}→${c.target}, cx ${Math.round(sCx)}→${Math.round(tCx)})`;
  }
  return {
    rule: 'F9', fixture: p.fixture, value: reversed,
    display: `${reversed}`, pass: reversed === 0,
    detail: reversed === 0 ? undefined : `${reversed} 条非回头边同排却向左（拓扑顺序被画反），如 ${ex}`,
  };
}

// lane 上/下边界 Y（去重、取整）。供 F7 判断边是否贴泳道线。
function laneDividerYs(p: ParsedFixture): number[] {
  const ys: number[] = [];
  for (const laneId of p.flowNodeRefs.keys()) {
    const b = p.boxes.get(laneId);
    if (b) { ys.push(b.y, b.y + b.h); }
  }
  return [...new Set(ys.map((y) => Math.round(y)))];
}

/**
 * F10 边交叉数：sequenceFlow 两两线段求交（正交折线，只算横×竖的**真交叉**——严格不等式，
 * T 型汇入/共享端点/共线重叠都不算：fan-in 归一的合流是视觉正确，共线重叠归 F8）。
 * messageFlow 不喂（跨池虚线交叉是 BPMN 常态，入了只会制造噪声）。
 *
 * 只观测、不设固定阈值（同 F6）：交叉数没有绝对合格线，门禁是 card 0.3 的 baseline 对比。
 */
function checkF10(p: ParsedFixture): SoftMetric {
  interface Seg { edgeId: string; horizontal: boolean; x1: number; y1: number; x2: number; y2: number }
  const segs: Seg[] = [];
  for (const e of p.edges) {
    if (e.bpmnType !== 'sequenceFlow') continue;
    for (let i = 0; i < e.waypoints.length - 1; i++) {
      const a = e.waypoints[i]!, b = e.waypoints[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) continue; // 零长段
      const horizontal = Math.abs(a.y - b.y) <= 0.5;
      segs.push({
        edgeId: e.id, horizontal,
        x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
        x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
      });
    }
  }
  let crossings = 0;
  let ex = '';
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!, t = segs[j]!;
      if (s.edgeId === t.edgeId) continue;
      if (s.horizontal === t.horizontal) continue; // 平行/共线不算交叉
      const h = s.horizontal ? s : t;
      const v = s.horizontal ? t : s;
      // 严格不等式：交点必须落在两段的**内部**，端点接触（fan-in 合流、共享节点出口）不算
      if (v.x1 > h.x1 && v.x1 < h.x2 && h.y1 > v.y1 && h.y1 < v.y2) {
        crossings++;
        if (!ex) ex = `${s.edgeId} × ${t.edgeId} @(${Math.round(v.x1)},${Math.round(h.y1)})`;
      }
    }
  }
  return {
    rule: 'F10', fixture: p.fixture, value: crossings,
    display: `${crossings}`, pass: true,
    detail: crossings === 0 ? undefined : `${crossings} 处边交叉，如 ${ex}`,
  };
}

/**
 * F11 平均拐点数：Σ(waypoints−2)/edges ≤ 2.0。每条边平均多于 2 个弯说明路由在绕远——
 * 要么摆位没给边留路（P4 主干），要么路由在互相打架（P5 轨道）。
 */
function checkF11(p: ParsedFixture): SoftMetric {
  const flowEdges = p.edges.filter(e => e.bpmnType === 'sequenceFlow');
  if (flowEdges.length === 0) return { rule: 'F11', fixture: p.fixture, value: 0, display: 'n/a', pass: true };
  const bends = flowEdges.reduce((s, e) => s + Math.max(0, e.waypoints.length - 2), 0);
  const avg = bends / flowEdges.length;
  const pass = avg <= 2.0;
  return {
    rule: 'F11', fixture: p.fixture, value: avg,
    display: avg.toFixed(1), pass,
    detail: pass ? undefined : `avg bends ${avg.toFixed(2)} > 2.0 (${bends} bends / ${flowEdges.length} edges)`,
  };
}

/**
 * F12 骑行段：水平段贴着**非端点**节点的顶/底边线跑（±4px 带内、不含内部——内部归 E2），
 * 且与该节点 x 区间重叠 ≥ 50% 节点宽。没穿过节点，但视觉上像穿过那一行——101 的
 * f_integration_join 沿 task_test_api 边线跑满 100px 就是这类（E2 全过）。
 */
function checkF12(p: ParsedFixture): SoftMetric {
  const obstacles: Box[] = [];
  for (const b of p.boxes.values()) {
    const k = p.kindOf.get(b.id);
    if (!k || CONTAINER_KINDS.has(k)) continue;
    obstacles.push(b);
  }
  let riding = 0;
  let ex = '';
  for (const e of p.edges) {
    for (let i = 0; i < e.waypoints.length - 1; i++) {
      const a = e.waypoints[i]!, b = e.waypoints[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) continue;                 // 仅水平段
      if (Math.abs(a.x - b.x) < 20) continue;                // 忽略短 stub
      const sx1 = Math.min(a.x, b.x), sx2 = Math.max(a.x, b.x);
      for (const o of obstacles) {
        if (o.id === e.source || o.id === e.target) continue;
        const insideY = a.y > o.y + 1 && a.y < o.y + o.h - 1; // 穿内部 = E2 的活，不重复记
        if (insideY) continue;
        const dy = a.y <= o.y ? o.y - a.y : a.y - (o.y + o.h);
        if (dy > 4) continue;                                 // 只算贴边线 ±4px
        const overlap = Math.min(sx2, o.x + o.w) - Math.max(sx1, o.x);
        if (overlap >= 0.5 * o.w) {
          riding++;
          if (!ex) ex = `${e.id} 贴 ${o.id} 边线 (y=${Math.round(a.y)}, overlap=${Math.round(overlap)}/${Math.round(o.w)})`;
          break;                                              // 一段只记一次
        }
      }
    }
  }
  return {
    rule: 'F12', fixture: p.fixture, value: riding,
    display: `${riding}`, pass: riding === 0,
    detail: riding === 0 ? undefined : `${riding} 段贴节点边线骑行，如 ${ex}`,
  };
}

/**
 * F13 空白率：1 − Σ节点面积 / 内容 bbox 面积 ≤ 0.85。pool/lane/process 不算节点；
 * subProcess 整体算一个节点（children 不重复计）。空白率过高说明布局松散/被拉长。
 */
function checkF13(p: ParsedFixture): SoftMetric {
  let nodeArea = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let counted = 0;
  for (const b of p.boxes.values()) {
    const k = p.kindOf.get(b.id);
    if (!k || k === 'lane' || k === 'pool' || k === 'process' || k === 'collaboration') continue;
    if (CONTAINER_KINDS.has(k) && k !== 'subProcess') continue;
    // subProcess 的 children 不再单独计（面积已含在 subProcess 内）
    let insideSub = false;
    for (const [sid, sb] of p.boxes) {
      if (p.kindOf.get(sid) !== 'subProcess' || sid === b.id) continue;
      if (boxContains(sb, b, 1)) { insideSub = true; break; }
    }
    if (insideSub) continue;
    nodeArea += b.w * b.h;
    counted++;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (counted === 0 || maxX <= minX || maxY <= minY) {
    return { rule: 'F13', fixture: p.fixture, value: 0, display: 'n/a', pass: true };
  }
  const bboxArea = (maxX - minX) * (maxY - minY);
  const ratio = 1 - nodeArea / bboxArea;
  const pass = ratio <= 0.85;
  return {
    rule: 'F13', fixture: p.fixture, value: ratio,
    display: `${(ratio * 100).toFixed(0)}%`, pass,
    detail: pass ? undefined : `whitespace ${(ratio * 100).toFixed(0)}% > 85% (nodes ${Math.round(nodeArea)} / bbox ${Math.round(bboxArea)})`,
  };
}

/**
 * F14 主干拐点：start→end 最短路径（BFS，sequenceFlow 有向图）上所有边的拐点总数
 * ≤ 2 × 路径上 gateway 数。主干是观众眼睛走的那条线——它每多一个弯，图就难读一分；
 * gateway 是合法拐点的唯一来源（进出分支换行各 1）。多 start/end 取各对里最差。
 * 换行边（source/target cy 差 > 60px，如 13 的整行 wrap）免 2 个弯——折行本身就要 2 弯，
 * 那是有意换行不是 spine 抖动（同 F9 的换排豁免）。
 */
const F14_ROW_CHANGE_TOL = 60;
function checkF14(p: ParsedFixture): SoftMetric {
  const adj = new Map<string, { edgeId: string; target: string }[]>();
  const edgeBends = new Map<string, number>();
  for (const e of p.edges) {
    if (e.bpmnType !== 'sequenceFlow') continue;
    const sb = p.boxes.get(e.source);
    const tb = p.boxes.get(e.target);
    if (!sb || !tb) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push({ edgeId: e.id, target: e.target });
    const raw = Math.max(0, e.waypoints.length - 2);
    const rowChange = Math.abs((sb.y + sb.h / 2) - (tb.y + tb.h / 2)) > F14_ROW_CHANGE_TOL;
    edgeBends.set(e.id, rowChange ? Math.max(0, raw - 2) : raw);
  }
  const starts = p.nodeOrder.filter(id => p.bpmnTagOf.get(id) === 'startEvent');
  const ends = new Set(p.nodeOrder.filter(id => p.bpmnTagOf.get(id) === 'endEvent'));
  if (starts.length === 0 || ends.size === 0) {
    return { rule: 'F14', fixture: p.fixture, value: 0, display: 'n/a', pass: true };
  }
  let worstBends = -1;
  let worstGateways = 0;
  let worstPath = '';
  for (const s of starts) {
    // BFS 最短路径（边数最少）；parent 记录回溯
    const parent = new Map<string, { via: string; from: string }>();
    const queue: string[] = [s];
    const seen = new Set([s]);
    while (queue.length > 0) {
      const u = queue.shift()!;
      if (ends.has(u)) break;
      for (const { edgeId, target } of adj.get(u) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        parent.set(target, { via: edgeId, from: u });
        queue.push(target);
      }
    }
    for (const e of ends) {
      if (!parent.has(e)) continue;
      // 回溯
      const nodes: string[] = [e];
      let bends = 0;
      let cur = e;
      while (cur !== s) {
        const pr = parent.get(cur)!;
        bends += edgeBends.get(pr.via) ?? 0;
        cur = pr.from;
        nodes.push(cur);
      }
      nodes.reverse();
      const gateways = nodes.filter(n => p.kindOf.get(n) === 'gateway').length;
      if (bends > worstBends) {
        worstBends = bends;
        worstGateways = gateways;
        worstPath = `${s}→${e}`;
      }
    }
  }
  if (worstBends < 0) return { rule: 'F14', fixture: p.fixture, value: 0, display: 'n/a', pass: true };
  const limit = 2 * worstGateways;
  const pass = worstBends <= limit;
  return {
    rule: 'F14', fixture: p.fixture, value: worstBends,
    display: `${worstBends}/${limit}`, pass,
    detail: pass ? undefined : `spine ${worstPath}: ${worstBends} bends > 2 × ${worstGateways} gateways`,
  };
}

export const ALL_SOFT_CHECKS: { rule: string; fn: (p: ParsedFixture) => SoftMetric }[] = [
  { rule: 'F1', fn: checkF1 },
  { rule: 'F2', fn: checkF2 },
  { rule: 'F3', fn: checkF3 },
  { rule: 'F4', fn: checkF4 },
  { rule: 'F5', fn: checkF5 },
  { rule: 'F6', fn: checkF6 },
  { rule: 'F7', fn: checkF7 },
  { rule: 'F8', fn: checkF8 },
  { rule: 'F9', fn: checkF9 },
  { rule: 'F10', fn: checkF10 },
  { rule: 'F11', fn: checkF11 },
  { rule: 'F12', fn: checkF12 },
  { rule: 'F13', fn: checkF13 },
  { rule: 'F14', fn: checkF14 },
];

// ============================================================
// Public evaluation API
// ============================================================

export interface FixtureXml {
  fixture: string;
  xml: string;
}

export interface EvaluationOptions {
  ruleFilter?: ReadonlySet<string> | null;
  hardOnly?: boolean;
  softOnly?: boolean;
}

export interface HardEvaluation {
  checks: typeof ALL_CHECKS;
  cells: Map<string, Map<string, Violation[]>>;
  ruleTotals: Map<string, number>;
  grandTotal: number;
  dirtyFixtures: number;
}

export interface SoftEvaluation {
  checks: typeof ALL_SOFT_CHECKS;
  cells: Map<string, Map<string, SoftMetric>>;
  failCount: Map<string, number>;
  dirtyFixtures: number;
  failsByFixture: { fixture: string; mets: SoftMetric[] }[];
}

export interface LayoutEvaluation {
  parsed: ParsedFixture[];
  hard?: HardEvaluation;
  soft?: SoftEvaluation;
}

export type HardRuleId = 'E1' | 'E2' | 'E3' | 'E4' | 'N1' | 'N2' | 'N3' | 'N4' | 'B1' | 'B2' | 'B3' | 'B4' | 'L1' | 'L2' | 'L3';

export interface AiLayoutViolation {
  fixture: string;
  ruleId: HardRuleId;
  severity: 'hard';
  subject: {
    kind: 'node' | 'edge' | 'pool' | 'lane' | 'label';
    id: string;
  };
  relatedSubjects: Array<{
    kind: 'node' | 'edge' | 'pool' | 'lane' | 'label';
    id: string;
  }>;
  evidence: {
    message: string;
    actual?: unknown;
    expected?: unknown;
    geometry?: Record<string, unknown>;
  };
  suspectedStages: string[];
  sourceHints: Array<{
    path: string;
    symbol?: string;
    reason: string;
  }>;
}

export interface SerializableEvaluation {
  generatedAt: string;
  summary: {
    fixtureCount: number;
    hardViolationCount: number;
    hardDirtyFixtures: number;
    softDirtyFixtures: number;
  };
  hard?: {
    rules: string[];
    totals: Record<string, number>;
    violations: AiLayoutViolation[];
  };
  soft?: {
    rules: string[];
    failCount: Record<string, number>;
    metrics: Array<{
      fixture: string;
      rule: string;
      value: number;
      display: string;
      pass: boolean;
      detail?: string;
    }>;
  };
  fixtures: Array<{
    fixture: string;
    hardViolationCount: number;
    softFailures: string[];
    status: 'pass' | 'hard-fail' | 'soft-regression';
  }>;
}

export function allRuleIds(): string[] {
  return [...ALL_CHECKS.map(c => c.rule), ...ALL_SOFT_CHECKS.map(c => c.rule)];
}

export function expandRuleFilter(tokens: string[]): Set<string> {
  const expanded = new Set<string>();
  const ids = allRuleIds();
  for (const token of tokens) {
    if (token.length === 1) {
      for (const ruleId of ids) if (ruleId.startsWith(token)) expanded.add(ruleId);
    } else {
      expanded.add(token);
    }
  }
  return expanded;
}

export function evaluateBpmnXmlFixtures(fixtures: FixtureXml[], options: EvaluationOptions = {}): LayoutEvaluation {
  return evaluateParsedFixtures(
    fixtures.map(({ fixture, xml }) => parseBpmnLayout(fixture, xml)),
    options,
  );
}

export function evaluateParsedFixtures(parsed: ParsedFixture[], options: EvaluationOptions = {}): LayoutEvaluation {
  const ruleFilter = options.ruleFilter ?? null;
  const checks = ALL_CHECKS.filter(c => !ruleFilter || ruleFilter.has(c.rule));
  const softChecks = ALL_SOFT_CHECKS.filter(c => !ruleFilter || ruleFilter.has(c.rule));
  const runHard = !options.softOnly && checks.length > 0;
  const runSoft = !options.hardOnly && softChecks.length > 0;

  const result: LayoutEvaluation = { parsed };

  if (runHard) {
    const cells = new Map<string, Map<string, Violation[]>>();
    const ruleTotals = new Map<string, number>();
    let grandTotal = 0;
    let dirtyFixtures = 0;
    for (const p of parsed) {
      const row = new Map<string, Violation[]>();
      let dirty = false;
      for (const c of checks) {
        const vs = c.fn(p);
        row.set(c.rule, vs);
        ruleTotals.set(c.rule, (ruleTotals.get(c.rule) ?? 0) + vs.length);
        if (vs.length > 0) dirty = true;
      }
      if (dirty) dirtyFixtures++;
      cells.set(p.fixture, row);
    }
    for (const rule of checks) grandTotal += ruleTotals.get(rule.rule) ?? 0;
    result.hard = { checks, cells, ruleTotals, grandTotal, dirtyFixtures };
  }

  if (runSoft) {
    const cells = new Map<string, Map<string, SoftMetric>>();
    const failCount = new Map<string, number>();
    let dirtyFixtures = 0;
    const failsByFixture: { fixture: string; mets: SoftMetric[] }[] = [];
    for (const p of parsed) {
      const row = new Map<string, SoftMetric>();
      const fails: SoftMetric[] = [];
      for (const c of softChecks) {
        const m = c.fn(p);
        row.set(c.rule, m);
        if (!m.pass) {
          fails.push(m);
          failCount.set(c.rule, (failCount.get(c.rule) ?? 0) + 1);
        }
      }
      if (fails.length > 0) {
        dirtyFixtures++;
        failsByFixture.push({ fixture: p.fixture, mets: fails });
      }
      cells.set(p.fixture, row);
    }
    result.soft = { checks: softChecks, cells, failCount, dirtyFixtures, failsByFixture };
  }

  return result;
}

export function serializeLayoutEvaluation(result: LayoutEvaluation, generatedAt = new Date().toISOString()): SerializableEvaluation {
  const fixtures = result.parsed.map(p => {
    const hardViolationCount = result.hard
      ? Array.from(result.hard.cells.get(p.fixture)?.values() ?? []).reduce((s, vs) => s + vs.length, 0)
      : 0;
    const softFailures = result.soft
      ? Array.from(result.soft.cells.get(p.fixture)?.values() ?? []).filter(m => !m.pass).map(m => m.rule)
      : [];
    return {
      fixture: p.fixture,
      hardViolationCount,
      softFailures,
      status: hardViolationCount > 0
        ? 'hard-fail' as const
        : softFailures.length > 0
          ? 'soft-regression' as const
          : 'pass' as const,
    };
  });

  const hard = result.hard
    ? {
      rules: result.hard.checks.map(c => c.rule),
      totals: Object.fromEntries(Array.from(result.hard.ruleTotals.entries())),
      violations: collectAiViolations(result),
    }
    : undefined;
  const soft = result.soft
    ? {
      rules: result.soft.checks.map(c => c.rule),
      failCount: Object.fromEntries(Array.from(result.soft.failCount.entries())),
      metrics: Array.from(result.soft.cells.entries()).flatMap(([fixture, row]) =>
        Array.from(row.values()).map(metric => ({
          fixture,
          rule: metric.rule,
          value: metric.value,
          display: metric.display,
          pass: metric.pass,
          ...(metric.detail ? { detail: metric.detail } : {}),
        })),
      ),
    }
    : undefined;

  return {
    generatedAt,
    summary: {
      fixtureCount: result.parsed.length,
      hardViolationCount: result.hard?.grandTotal ?? 0,
      hardDirtyFixtures: result.hard?.dirtyFixtures ?? 0,
      softDirtyFixtures: result.soft?.dirtyFixtures ?? 0,
    },
    ...(hard ? { hard } : {}),
    ...(soft ? { soft } : {}),
    fixtures,
  };
}

export function formatEvaluationJson(result: LayoutEvaluation): string {
  return `${JSON.stringify(serializeLayoutEvaluation(result), null, 2)}\n`;
}

// ============================================================
// Baseline 对比（卡 0.3）
// ============================================================
//
// baseline 是"人看过 PNG 确认好看"那一刻的快照；--compare 是之后所有改动的门禁。
// 容差按指标类型分档（%类 ±2 点 / 计数类 +1 / 比值类 +5%）；pass→fail 翻转不受容差保护。

export interface FixtureBaseline {
  hard: Record<string, number>;
  soft: Record<string, number>;
}

export interface LayoutBaseline {
  generatedAt: string;
  fixtures: Record<string, FixtureBaseline>;
}

export function buildBaseline(result: LayoutEvaluation, generatedAt = new Date().toISOString()): LayoutBaseline {
  const fixtures: Record<string, FixtureBaseline> = {};
  for (const p of result.parsed) {
    const hard: Record<string, number> = {};
    for (const c of result.hard?.checks ?? []) {
      hard[c.rule] = result.hard?.cells.get(p.fixture)?.get(c.rule)?.length ?? 0;
    }
    const soft: Record<string, number> = {};
    for (const c of result.soft?.checks ?? []) {
      const m = result.soft?.cells.get(p.fixture)?.get(c.rule);
      if (m) soft[c.rule] = m.value;
    }
    fixtures[p.fixture] = { hard, soft };
  }
  return { generatedAt, fixtures };
}

/** 软指标方向与容差表。lowerBetter=false 的指标（F1/F5/F6 是"好的占比"）下降才算变差。 */
const SOFT_DIRECTION: Record<string, { lowerBetter: boolean; tolerance: (base: number) => number }> = {
  F1: { lowerBetter: false, tolerance: () => 0.02 },
  F2: { lowerBetter: true, tolerance: () => 0.02 },
  F3: { lowerBetter: true, tolerance: () => 0.02 },
  F4: { lowerBetter: true, tolerance: (b) => b * 0.05 },
  F5: { lowerBetter: false, tolerance: () => 0.02 },
  F6: { lowerBetter: false, tolerance: () => 0.02 },
  F7: { lowerBetter: true, tolerance: () => 1 },
  F8: { lowerBetter: true, tolerance: () => 1 },
  F9: { lowerBetter: true, tolerance: () => 1 },
  F10: { lowerBetter: true, tolerance: () => 1 },
  F11: { lowerBetter: true, tolerance: (b) => b * 0.05 },
  F12: { lowerBetter: true, tolerance: () => 1 },
  F13: { lowerBetter: true, tolerance: () => 0.02 },
  F14: { lowerBetter: true, tolerance: () => 1 },
};

export interface BaselineDiff {
  hardRegressions: { fixture: string; rule: string; before: number; after: number }[];
  softRegressions: { fixture: string; rule: string; before: number; after: number }[];
  improvements: { fixture: string; rule: string; before: number; after: number }[];
  missingFixtures: string[];   // baseline 有、当前跑不到（被删/改名）
  newFixtures: string[];       // 当前有、baseline 没有（新增 fixture，提示人审后补 baseline）
}

export function compareWithBaseline(result: LayoutEvaluation, baseline: LayoutBaseline): BaselineDiff {
  const diff: BaselineDiff = { hardRegressions: [], softRegressions: [], improvements: [], missingFixtures: [], newFixtures: [] };
  const current = buildBaseline(result, baseline.generatedAt);
  for (const fx of Object.keys(baseline.fixtures)) {
    if (!current.fixtures[fx]) diff.missingFixtures.push(fx);
  }
  for (const [fx, cur] of Object.entries(current.fixtures)) {
    const base = baseline.fixtures[fx];
    if (!base) { diff.newFixtures.push(fx); continue; }
    for (const [rule, after] of Object.entries(cur.hard)) {
      const before = base.hard[rule] ?? 0;
      if (after > before) diff.hardRegressions.push({ fixture: fx, rule, before, after });
      else if (after < before) diff.improvements.push({ fixture: fx, rule, before, after });
    }
    for (const [rule, after] of Object.entries(cur.soft)) {
      const before = base.soft[rule];
      if (before === undefined) continue;
      const dir = SOFT_DIRECTION[rule] ?? { lowerBetter: true, tolerance: () => 0 };
      const delta = after - before;
      const worse = dir.lowerBetter ? delta > 0 : delta < 0;
      const better = dir.lowerBetter ? delta < 0 : delta > 0;
      if (worse && Math.abs(delta) > dir.tolerance(before)) {
        diff.softRegressions.push({ fixture: fx, rule, before, after });
      } else if (better && Math.abs(delta) > dir.tolerance(before)) {
        diff.improvements.push({ fixture: fx, rule, before, after });
      }
    }
  }
  return diff;
}

export function formatCompareReport(diff: BaselineDiff, baselinePath: string): string {
  const out: string[] = [];
  out.push(`\nCompare vs baseline ${baselinePath}`);
  out.push('='.repeat(60));
  if (diff.hardRegressions.length > 0) {
    out.push(`\n✗ 硬标准新增违例 ${diff.hardRegressions.length} 处：`);
    for (const r of diff.hardRegressions) out.push(`  [${r.rule}] ${r.fixture}: ${r.before} → ${r.after}`);
  } else {
    out.push('\n✓ 硬标准无新增违例');
  }
  if (diff.softRegressions.length > 0) {
    out.push(`\n✗ 软指标变差 ${diff.softRegressions.length} 项（超容差）：`);
    for (const r of diff.softRegressions) out.push(`  [${r.rule}] ${r.fixture}: ${r.before} → ${r.after}`);
  } else {
    out.push('✓ 软指标无变差');
  }
  if (diff.improvements.length > 0) {
    out.push(`\n↑ 变好 ${diff.improvements.length} 项：`);
    for (const r of diff.improvements) out.push(`  [${r.rule}] ${r.fixture}: ${r.before} → ${r.after}`);
  }
  if (diff.missingFixtures.length > 0) out.push(`\n⚠ baseline 有但当前缺失：${diff.missingFixtures.join(', ')}`);
  if (diff.newFixtures.length > 0) out.push(`⚠ 新 fixture（人审 PNG 后 --save-baseline 补录）：${diff.newFixtures.join(', ')}`);
  out.push('');
  return out.join('\n');
}

export function collectAiViolations(result: LayoutEvaluation): AiLayoutViolation[] {
  if (!result.hard) return [];
  const out: AiLayoutViolation[] = [];
  for (const [fixture, row] of result.hard.cells) {
    for (const [rule, violations] of row) {
      for (const violation of violations) {
        out.push(toAiViolation(fixture, rule as HardRuleId, violation.detail));
      }
    }
  }
  return out;
}

function toAiViolation(fixture: string, ruleId: HardRuleId, detail: string): AiLayoutViolation {
  const subject = inferSubject(ruleId, detail);
  const relatedSubjects = inferRelatedSubjects(detail, subject);
  return {
    fixture,
    ruleId,
    severity: 'hard',
    subject,
    relatedSubjects,
    evidence: {
      message: detail,
      geometry: inferGeometry(detail),
    },
    suspectedStages: suspectedStagesForRule(ruleId),
    sourceHints: sourceHintsForRule(ruleId),
  };
}

function inferSubject(ruleId: HardRuleId, detail: string): AiLayoutViolation['subject'] {
  const edge = /\bedge=([^\s)]+)/.exec(detail);
  if (edge) return { kind: 'edge', id: edge[1]! };
  const be = /\bBE=([^\s)]+)/.exec(detail);
  if (be) return { kind: 'node', id: be[1]! };
  const node = /\b(?:node|task|gateway|event|boundaryEvent)=([^\s,)]+)/.exec(detail);
  if (node) return { kind: 'node', id: node[1]! };
  const pool = /\bpool=([^\s→]+)/.exec(detail);
  if (pool) return { kind: 'pool', id: pool[1]! };
  const lane = /\b(?:lane|sub-lane|parent lane)=([^\s,)]+)/.exec(detail);
  if (lane) return { kind: 'lane', id: lane[1]! };
  const label = /\blabel(?: of|=)?\s*([^\s,)]+)/.exec(detail);
  if (label) return { kind: 'label', id: label[1]! };
  const firstId = /([A-Za-z_][\w.-]*)/.exec(detail);
  if (ruleId.startsWith('E')) return { kind: 'edge', id: firstId?.[1] ?? 'unknown' };
  if (ruleId.startsWith('B')) return { kind: ruleId === 'B2' ? 'pool' : 'node', id: firstId?.[1] ?? 'unknown' };
  if (ruleId.startsWith('L')) return { kind: 'label', id: firstId?.[1] ?? 'unknown' };
  return { kind: 'node', id: firstId?.[1] ?? 'unknown' };
}

function inferRelatedSubjects(
  detail: string,
  subject: AiLayoutViolation['subject'],
): AiLayoutViolation['relatedSubjects'] {
  const related: AiLayoutViolation['relatedSubjects'] = [];
  const add = (kind: AiLayoutViolation['subject']['kind'], id: string): void => {
    if (id === subject.id && kind === subject.kind) return;
    if (related.some(r => r.id === id && r.kind === kind)) return;
    related.push({ kind, id });
  };
  for (const match of detail.matchAll(/\b(?:source|target|host|child|cuts)=([A-Za-z_][\w.-]*)/g)) {
    add(match[0].startsWith('host=') || match[0].startsWith('child=') || match[0].startsWith('cuts=')
      ? 'node'
      : 'node', match[1]!);
  }
  for (const match of detail.matchAll(/\bpool=([A-Za-z_][\w.-]*)/g)) add('pool', match[1]!);
  for (const match of detail.matchAll(/\blane=([A-Za-z_][\w.-]*)/g)) add('lane', match[1]!);
  const overlap = /^([A-Za-z_][\w.-]*) and ([A-Za-z_][\w.-]*) overlap/.exec(detail);
  if (overlap) {
    add('node', overlap[1]!);
    add('node', overlap[2]!);
  }
  return related;
}

function inferGeometry(detail: string): Record<string, unknown> {
  const geometry: Record<string, unknown> = {};
  const point = /\(([-\d.]+),([-\d.]+)\)/.exec(detail);
  if (point) geometry.point = { x: Number(point[1]), y: Number(point[2]) };
  const size = /size=([-\d.]+)x([-\d.]+)/.exec(detail);
  if (size) geometry.size = { w: Number(size[1]), h: Number(size[2]) };
  const segIdx = /segIdx=(\d+)/.exec(detail);
  if (segIdx) geometry.segmentIndex = Number(segIdx[1]);
  const gap = /gap=([-\d.]+)/.exec(detail);
  if (gap) geometry.gap = Number(gap[1]);
  return geometry;
}

function suspectedStagesForRule(ruleId: HardRuleId): string[] {
  if (ruleId.startsWith('E')) return ['edge-router', 'association-router', 'merger', 'serializer'];
  if (ruleId === 'N1') return ['elk-placement', 'lane-constrainer', 'decoration-placer', 'artifact-placer', 'pool-overflow-rebalancer'];
  if (ruleId === 'N2' || ruleId === 'N3') return ['lane-constrainer', 'pool-composer', 'subprocess-translator', 'pool-overflow-rebalancer', 'merger'];
  if (ruleId === 'N4') return ['loader', 'elk-placement', 'decoration-placer', 'merger', 'serializer'];
  if (ruleId === 'B1') return ['decoration-placer', 'pool-overflow-rebalancer', 'merger'];
  if (ruleId === 'B2') return ['pool-composer', 'pool-overflow-rebalancer', 'merger'];
  if (ruleId === 'B3' || ruleId === 'B4') return ['lane-constrainer', 'pool-composer', 'merger'];
  return ['label-placer', 'merger', 'serializer'];
}

function sourceHintsForRule(ruleId: HardRuleId): AiLayoutViolation['sourceHints'] {
  const hints: AiLayoutViolation['sourceHints'] = [];
  if (ruleId.startsWith('E')) {
    hints.push(
      { path: 'src/stages/edge-router/path-shaper.ts', symbol: 'shapePath', reason: 'Main sequence/message edge waypoints are shaped here.' },
      { path: 'src/stages/edge-router/port.ts', symbol: 'finalizeRoutePorts', reason: 'Final route endpoints and ports are snapped to node boundaries here.' },
      { path: 'src/stages/association-router.ts', symbol: 'routeAssociations', reason: 'Association/data association waypoints are generated here.' },
    );
  } else if (ruleId === 'B1') {
    hints.push({ path: 'src/stages/decoration-placer.ts', symbol: 'placeDecorations', reason: 'Boundary events are positioned against host nodes here.' });
  } else if (ruleId.startsWith('B') || ruleId === 'N2' || ruleId === 'N3') {
    hints.push(
      { path: 'src/stages/lane-constrainer.ts', symbol: 'laneConstrain', reason: 'Lane bands and lane-local node Y positions are produced here.' },
      { path: 'src/stages/pool-composer.ts', symbol: 'poolCompose', reason: 'Pool stacking and absolute lane/node coordinates are produced here.' },
      { path: 'src/stages/merger.ts', symbol: 'merge', reason: 'Stage coordinates are written back into LayoutedGraph containers here.' },
    );
  } else if (ruleId.startsWith('L')) {
    hints.push(
      { path: 'src/stages/label-placer.ts', symbol: 'pickLabelPosition', reason: 'Edge label candidate selection and collision avoidance live here.' },
      { path: 'src/stages/merger.ts', symbol: 'placeEdgeLabel', reason: 'Edge labels are materialized into the LayoutedGraph here.' },
    );
  } else {
    hints.push({ path: 'src/stages/elk-placement.ts', symbol: 'elkPlacement', reason: 'Primary flow node dimensions and first-pass positions come from this stage.' });
  }
  return hints;
}

export function formatEvaluationReport(result: LayoutEvaluation, verbose = true): string {
  const out: string[] = [];
  const parsedAll = result.parsed;
  const fixtureColW = Math.max(...parsedAll.map(p => p.fixture.length), 10);

  if (result.hard) {
    const hard = result.hard;
    const ruleNames = hard.checks.map(c => c.rule);
    const ruleColW = 4;
    out.push(`\nHard rules — ${parsedAll.length} fixtures × ${hard.checks.length} rules (violation count, · = clean)`);
    out.push('='.repeat(fixtureColW + ruleColW * ruleNames.length + 4));
    let header = ' '.repeat(fixtureColW + 2);
    for (const r of ruleNames) header += r.padStart(ruleColW);
    out.push(header);
    for (const p of parsedAll) {
      const row = hard.cells.get(p.fixture);
      if (!row) throw new Error(`Missing hard evaluation row for fixture ${p.fixture}`);
      let line = p.fixture.padEnd(fixtureColW + 2);
      for (const r of ruleNames) {
        const n = row.get(r)?.length ?? 0;
        line += (n === 0 ? '·' : String(n)).padStart(ruleColW);
      }
      out.push(line);
    }
    out.push('='.repeat(fixtureColW + ruleColW * ruleNames.length + 4));
    let totalLine = 'TOTAL'.padEnd(fixtureColW + 2);
    for (const r of ruleNames) totalLine += String(hard.ruleTotals.get(r) ?? 0).padStart(ruleColW);
    out.push(totalLine);
    out.push(`\n${hard.dirtyFixtures}/${parsedAll.length} fixtures dirty (hard), ${hard.grandTotal} total violations`);

    if (verbose && hard.grandTotal > 0) {
      out.push('\nHard violation details:');
      for (const p of parsedAll) {
        const row = hard.cells.get(p.fixture);
        if (!row) throw new Error(`Missing hard evaluation row for fixture ${p.fixture}`);
        for (const r of ruleNames) {
          for (const v of row.get(r) ?? []) out.push(`  [${v.rule}] ${v.fixture}: ${v.detail}`);
        }
      }
    }
  }

  if (result.soft) {
    const soft = result.soft;
    const ruleNames = soft.checks.map(c => c.rule);
    const softColW = 8;
    out.push(`\nSoft metrics — ${parsedAll.length} fixtures × ${soft.checks.length} rules (value, ✗ = below threshold)`);
    out.push('='.repeat(fixtureColW + softColW * ruleNames.length + 4));
    let header = ' '.repeat(fixtureColW + 2);
    for (const r of ruleNames) header += r.padStart(softColW);
    out.push(header);
    for (const p of parsedAll) {
      const row = soft.cells.get(p.fixture);
      if (!row) throw new Error(`Missing soft evaluation row for fixture ${p.fixture}`);
      let line = p.fixture.padEnd(fixtureColW + 2);
      for (const r of ruleNames) {
        const m = row.get(r);
        if (!m) throw new Error(`Missing soft metric ${r} for fixture ${p.fixture}`);
        const text = m.pass ? m.display : `✗${m.display}`;
        line += text.padStart(softColW);
      }
      out.push(line);
    }
    out.push('='.repeat(fixtureColW + softColW * ruleNames.length + 4));
    let totalLine = 'fail'.padEnd(fixtureColW + 2);
    for (const r of ruleNames) totalLine += String(soft.failCount.get(r) ?? 0).padStart(softColW);
    out.push(totalLine);
    out.push(`\n${soft.dirtyFixtures}/${parsedAll.length} fixtures below threshold on ≥ 1 soft metric`);

    if (verbose && soft.dirtyFixtures > 0) {
      out.push('\nSoft metric details:');
      for (const { fixture, mets } of soft.failsByFixture) {
        for (const m of mets) out.push(`  [${m.rule}] ${fixture}: ${m.detail}`);
      }
    }
  }

  out.push('');
  return out.join('\n');
}
