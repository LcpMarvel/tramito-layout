// LabelCollisionResolver — 全局 label 解算
//
// merger/diagram-builder 的 label 摆放是逐条贪心（每条边只看已摆的 label），拥挤区
// 会 whack-a-mole（89 的 3 对 L3 局部实验两连败的根源）。这里做全局面孔：所有
// label 就位后，hill-climbing 找「总叠放面积最小」的位置组合——每次取最重的一对，
// 移动其中可动度高的那个（边 label 沿线滑 > 节点 label 上下左右翻），无可改善就冻结。
//
// 可动集合：edge label（沿自己边各段的上/下/左/右候选）+ gateway/event 的外置 name
//（上下左右四侧）。boundary event label 有专门的 stagger 逻辑（merger），当固定障碍。
// 目标不是叠放面积归零，而是所有 pair 低于 L3 阈值（minArea 叠放比 ≤ 50%）。

import type { BoundsModel, EdgeModel, ShapeModel } from './model-types.ts';

interface Rect { x: number; y: number; width: number; height: number }

interface Mover {
  id: string;
  bounds: BoundsModel;
  candidates: BoundsModel[];
  /** 边 label=2，节点 label=1：同等改善下先动边 label */
  mobility: number;
  /** 已尝试次数上限（防振荡） */
  tries: number;
}

const MAX_ROUNDS = 96;
const MAX_TRIES_PER_MOVER = 4;
const SIDE_GAP = 4;

export function resolveLabelCollisions(
  shapes: ShapeModel[],
  edges: EdgeModel[],
  typeOf: (id: string) => string | undefined,
): void {
  const nodeObstacles: Rect[] = [];
  const movers: Mover[] = [];
  const fixedLabels: Rect[] = [];

  for (const s of shapes) {
    const t = typeOf(s.bpmnElement);
    const isContainer = t === 'participant' || t === 'process' || t === 'lane' || t === 'collaboration'
      || ((t === 'subProcess' || t === 'transaction' || t === 'adHocSubProcess') && s.isExpanded === true);
    if (!isContainer) nodeObstacles.push(s.bounds);
    if (!s.label?.bounds || isContainer) continue;
    if (t === 'boundaryEvent') {
      fixedLabels.push(s.label.bounds); // BE label 归 merger 的 stagger 管，不动
      continue;
    }
    const isExternalName = (t !== undefined && t.toLowerCase().includes('gateway'))
      || (t !== undefined && t.toLowerCase().includes('event'));
    if (!isExternalName) continue;
    movers.push({
      id: `${s.bpmnElement}_label`,
      bounds: s.label.bounds,
      candidates: nodeLabelCandidates(s.bounds, s.label.bounds),
      mobility: 1,
      tries: 0,
    });
  }

  for (const e of edges) {
    if (!e.label?.bounds) continue;
    movers.push({
      id: `${e.bpmnElement}_label`,
      bounds: e.label.bounds,
      candidates: edgeLabelCandidates(e.waypoints, e.label.bounds),
      mobility: 2,
      tries: 0,
    });
  }

  if (movers.length === 0) return;

  const allLabels = () => [
    ...movers.map(m => ({ id: m.id, rect: m.bounds as Rect, mover: m as Mover | undefined })),
    ...fixedLabels.map((r, i) => ({ id: `__fixed_${i}`, rect: r, mover: undefined as Mover | undefined })),
  ];
  const overlapArea = (a: Rect, b: Rect): number => {
    const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return ix * iy;
  };
  // L2 的判据是「label 几何中心落进节点」，角部擦边合法（BPMN 工具惯例）——
  // 严格零重叠会把拥挤区所有候选都毙掉（89 两对就是这么卡死的）。
  const hitsNode = (r: Rect): boolean => nodeObstacles.some(n => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return cx > n.x && cx < n.x + n.width && cy > n.y && cy < n.y + n.height;
  });

  // 某 mover 在某候选位的代价：叠 label 罚 1/px²（目标是 0——L3 的 50% 只是验收地板，
  // 文字压文字在 30% 时人眼已经不能忍：89 的 end_1↔flow_end 1352px 就是）；压节点按
  // L2 判据分级——中心落进节点罚 10⁵（硬违例），角部擦边罚 2/px²（能零擦就零擦）。
  // 离开原位加 0.02/px 的稳定偏好（并列时保持原位）。
  const centerInside = (r: Rect, n: Rect): boolean => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return cx > n.x && cx < n.x + n.width && cy > n.y && cy < n.y + n.height;
  };
  const cost = (m: Mover, c: BoundsModel, others: { id: string; rect: Rect }[]): number => {
    let s = 0;
    for (const o of others) {
      if (o.id === m.id) continue;
      s += overlapArea(c, o.rect);
    }
    for (const n of nodeObstacles) {
      const a = overlapArea(c, n);
      if (a > 0) s += centerInside(c, n) ? 100000 : a * 2;
    }
    s += (Math.abs(c.x - m.bounds.x) + Math.abs(c.y - m.bounds.y)) * 0.02;
    return s;
  };

  const frozen = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const labels = allLabels();
    // 找最重未冻结 pair：任何非零叠放都处理（不只看超 L3 阈值的）——阈值是验收地板，
    // 不是视觉目标。解不动的（两侧都无可改善候选）冻结接受。
    let worst: { a: string; b: string; area: number } | null = null;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const A = labels[i]!, B = labels[j]!;
        const area = overlapArea(A.rect, B.rect);
        if (area <= 0) continue;
        const key = `${A.id}|${B.id}`;
        if (frozen.has(key)) continue;
        if (!worst || area > worst.area) worst = { a: A.id, b: B.id, area };
      }
    }
    if (!worst) return;

    const moverA = labels.find(l => l.id === worst!.a)?.mover;
    const moverB = labels.find(l => l.id === worst!.b)?.mover;
    const candidates = [moverA, moverB]
      .filter((m): m is Mover => m !== undefined && m.tries < MAX_TRIES_PER_MOVER)
      .sort((x, y) => y.mobility - x.mobility);

    let improved = false;
    for (const m of candidates) {
      const others = allLabels().map(l => ({ id: l.id, rect: l.rect }));
      let best: { c: BoundsModel; s: number } | null = null;
      for (const c of m.candidates) {
        if (hitsNode(c)) continue;
        const s = cost(m, c, others);
        if (!best || s < best.s) best = { c, s };
      }
      const current = cost(m, m.bounds, others);
      if (best && best.s < current - 0.5) {
        m.bounds.x = best.c.x;
        m.bounds.y = best.c.y;
        m.tries++;
        improved = true;
        break;
      }
      m.tries++;
    }
    if (!improved) frozen.add(`${worst.a}|${worst.b}`);
  }
}

/** 节点外置 name 的四侧候选（当前位在第一个 = 稳定偏好） */
function nodeLabelCandidates(node: BoundsModel, cur: BoundsModel): BoundsModel[] {
  const w = cur.width, h = cur.height;
  const cx = node.x + node.width / 2 - w / 2;
  const cy = node.y + node.height / 2 - h / 2;
  return [
    { ...cur },
    { x: cx, y: node.y + node.height + SIDE_GAP, width: w, height: h },      // 下（BPMN 惯例位）
    { x: cx, y: node.y - h - SIDE_GAP, width: w, height: h },                // 上
    { x: node.x + node.width + SIDE_GAP, y: cy, width: w, height: h },       // 右
    { x: node.x - w - SIDE_GAP, y: cy, width: w, height: h },                // 左
  ];
}

/** 边 label 沿线候选：每条够长的水平/垂直段的 1/4、1/2、3/4 处，上/下（左/右）错开 */
function edgeLabelCandidates(wps: { x: number; y: number }[], cur: BoundsModel): BoundsModel[] {
  const w = cur.width, h = cur.height;
  const out: BoundsModel[] = [{ ...cur }];
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i]!, b = wps[i + 1]!;
    if (Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.x - b.x) >= 40) {
      for (const f of [0.25, 0.5, 0.75]) {
        const cx = a.x + (b.x - a.x) * f - w / 2;
        out.push({ x: cx, y: a.y - h - SIDE_GAP, width: w, height: h });
        out.push({ x: cx, y: a.y + SIDE_GAP, width: w, height: h });
      }
    } else if (Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) >= 40) {
      for (const f of [0.25, 0.5, 0.75]) {
        const cy = a.y + (b.y - a.y) * f - h / 2;
        out.push({ x: a.x - w - SIDE_GAP, y: cy, width: w, height: h });
        out.push({ x: a.x + SIDE_GAP, y: cy, width: w, height: h });
      }
    }
  }
  return out;
}
