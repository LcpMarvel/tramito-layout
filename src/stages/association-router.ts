// AssociationRouter
//
// 给 dataInputAssociation / dataOutputAssociation / association 三类边算 waypoints。
// 不依赖 lane / pool 信息：artifact 已经被 ArtifactPlacer 摆在 host 上下方，
// 走法非常直接 —— bottom↔top 或 top↔bottom 直线 / 短 Z。
//
// 输出走 EdgeRoute 同一结构，但 edgeType 用 'association'。

import type { Anchor, EdgeRoute, NodeBox, Waypoint } from './types.ts';
import { anchorPoint } from './edge-router/anchor.ts';
import type { ArtifactSide } from './artifact-placer.ts';
import { detourAroundLocalObstacles } from './edge-router/local-obstacle-detour.ts';
import { makeBoxPort } from './edge-router/port.ts';

export interface AssociationRouteInput {
  /** 边 id → 端点 box 与两端各自的 artifactSide（host 端用 null） */
  edges: AssociationEdgeInput[];
  obstacles?: NodeBox[];
}

export interface AssociationEdgeInput {
  id: string;
  sourceId: string;
  targetId: string;
  sourceBox: NodeBox;
  targetBox: NodeBox;
  /** source 是 artifact 时给出其相对 host 的位置；source 是 host 时为 null */
  srcArtifactSide: ArtifactSide | null;
  /** target 是 artifact 时给出其相对 host 的位置；target 是 host 时为 null */
  tgtArtifactSide: ArtifactSide | null;
}

export interface AssociationRouteOutput {
  routes: Map<string, EdgeRoute>;
}

const isVertical = (a: Anchor) => a === 'top' || a === 'bottom';

export function routeAssociations(input: AssociationRouteInput): AssociationRouteOutput {
  const routes = new Map<string, EdgeRoute>();
  for (const e of input.edges) {
    const { srcAnchor, tgtAnchor } = pickAnchors(e);
    const start = anchorPoint(e.sourceBox, srcAnchor);
    const end = anchorPoint(e.targetBox, tgtAnchor);

    const waypoints = buildWaypoints(start, end, srcAnchor, tgtAnchor);
    const detoured = detourAroundLocalObstacles({
      edgeId: e.id,
      waypoints,
      obstacles: (input.obstacles ?? []).filter(
        (box) => !sameBox(box, e.sourceBox) && !sameBox(box, e.targetBox),
      ),
      sourceSelf: e.sourceBox,
      targetSelf: e.targetBox,
    });

    routes.set(e.id, {
      edgeId: e.id,
      edgeType: 'forward-step', // 占位，association 不细分
      sourcePort: makeBoxPort(e.sourceId, srcAnchor, detoured.waypoints[0]!),
      targetPort: makeBoxPort(e.targetId, tgtAnchor, detoured.waypoints[detoured.waypoints.length - 1]!),
      waypoints: detoured.waypoints,
      channel: 0,
    });
  }

  function sameBox(a: NodeBox, b: NodeBox): boolean {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }
  return { routes };
}

function pickAnchors(e: AssociationEdgeInput): { srcAnchor: Anchor; tgtAnchor: Anchor } {
  const { srcArtifactSide, tgtArtifactSide, sourceBox, targetBox } = e;

  // 两端都是 artifact：按几何方位挑最近的两条边。
  if (srcArtifactSide && tgtArtifactSide) {
    const sx = sourceBox.x + sourceBox.w / 2;
    const sy = sourceBox.y + sourceBox.h / 2;
    const tx = targetBox.x + targetBox.w / 2;
    const ty = targetBox.y + targetBox.h / 2;
    const dx = tx - sx;
    const dy = ty - sy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0
        ? { srcAnchor: 'right', tgtAnchor: 'left' }
        : { srcAnchor: 'left',  tgtAnchor: 'right' };
    }
    return dy >= 0
      ? { srcAnchor: 'bottom', tgtAnchor: 'top' }
      : { srcAnchor: 'top',    tgtAnchor: 'bottom' };
  }

  // source 是 artifact：artifact.near ↔ host.near
  // artifact 在 host 上方 ⇒ artifact.bottom → host.top
  // artifact 在 host 下方 ⇒ artifact.top    → host.bottom
  if (srcArtifactSide) {
    return srcArtifactSide === 'above'
      ? { srcAnchor: 'bottom', tgtAnchor: 'top' }
      : { srcAnchor: 'top',    tgtAnchor: 'bottom' };
  }

  // target 是 artifact：host.near ↔ artifact.near
  // artifact 在 host 上方 ⇒ host.top    → artifact.bottom
  // artifact 在 host 下方 ⇒ host.bottom → artifact.top
  if (tgtArtifactSide) {
    return tgtArtifactSide === 'above'
      ? { srcAnchor: 'top',    tgtAnchor: 'bottom' }
      : { srcAnchor: 'bottom', tgtAnchor: 'top' };
  }

  throw new Error(`[association-router] association edge ${e.id} has no artifact endpoint`);
}

function buildWaypoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  srcAnchor: Anchor,
  tgtAnchor: Anchor,
): Waypoint[] {
  const srcVertical = isVertical(srcAnchor);
  const tgtVertical = isVertical(tgtAnchor);

  if (srcVertical && tgtVertical) {
    if (Math.abs(start.x - end.x) < 0.5) return [start, end];
    const midY = (start.y + end.y) / 2;
    return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
  }
  if (!srcVertical && !tgtVertical) {
    if (Math.abs(start.y - end.y) < 0.5) return [start, end];
    const midX = (start.x + end.x) / 2;
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
  }
  // 一端垂直一端水平：单拐 L
  if (srcVertical) {
    return [start, { x: end.x, y: start.y }, end];
  }
  return [start, { x: start.x, y: end.y }, end];
}
