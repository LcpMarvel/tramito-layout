// 扁平输入的前端诊断：用「扁平词汇」（parent / attachedTo / lane / pool / parentLane）直接校验作者写的字段。
//
// WHY 不只靠 validateGraph(flatToNested(flat))：flatToNested 是「转换」，会把引用错的元素丢位/改形，
// 等校验器拿到嵌套结构时，出错的 flat 字段已经不存在或换了样子——只能冒出 EDGE_ENDPOINT_MISSING 这种
// 「指向不明」的二手错误，hint 还在让模型去加它已经声明过的节点。这一层在转换前用原始 flat 字段报错，
// 错误码/消息/hint 都说作者看得懂的话（「attachedTo 指向的 X 不存在」「这个泳道有子泳道、不能直接放节点」）。
//
// 与 validateGraph 的分工：本层只查「扁平专属的引用/归属错」；其余语义错（缺 eventDef、并行未收束、
// 排他默认分支非法、重复 id、悬空边端点……）仍交给 validateGraph 在嵌套产物上查。两层都不 fail-fast，
// 各自收齐全部 issue。

import { createFlatResolver, type FlatResolver } from './flat-resolve.ts';
import { SUBPROCESS_TYPES, type ValidationIssue } from './validate-graph.ts';
import type { FlatBpmn, FlatNode, FlatLane } from './flat-types.ts';

export function validateFlatStructure(flat: FlatBpmn): ValidationIssue[] {
  const r = createFlatResolver(flat);
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);

  checkBoundaryRefs(r, push);
  checkParentRefs(r, push);
  checkReferenceCycles(r, push);
  checkLaneRefs(r, push);
  checkParentLaneRefs(r, push);
  checkPoolRefs(r, push);
  checkNodePoolResolvable(r, push);
  checkEdges(r, push);

  return issues;
}

// ---- boundary：attachedTo 必须指向一个存在的宿主，boundaryEvent 必须带 attachedTo ----
function checkBoundaryRefs(r: FlatResolver, push: (i: ValidationIssue) => void) {
  for (const n of r.nodes) {
    const hasAttached = typeof n.attachedTo === 'string' && n.attachedTo.length > 0;
    if (n.type === 'boundaryEvent' && !hasAttached) {
      push({
        code: 'BOUNDARY_NOT_ATTACHED',
        severity: 'error',
        id: n.id,
        message: `boundaryEvent ${n.id} has no attachedTo, so its host node cannot be determined`,
        hint: 'Add attachedTo: "<host node id>"; if it is actually a plain flow event, change its type to intermediateCatchEvent.',
      });
    }
    if (hasAttached && !r.nodeById.has(n.attachedTo!)) {
      push({
        code: 'BOUNDARY_HOST_MISSING',
        severity: 'error',
        id: n.id,
        message: `boundaryEvent ${n.id}: attachedTo points to "${n.attachedTo}", but no such node exists`,
        hint: `Change attachedTo to an existing node id (task / subProcess, ...), or add a host node with id "${n.attachedTo}".`,
      });
    } else if (hasAttached && n.attachedTo === n.id) {
      push({
        code: 'BOUNDARY_SELF_ATTACHED',
        severity: 'error',
        id: n.id,
        message: `boundaryEvent ${n.id}: attachedTo points to itself`,
        hint: 'attachedTo must point to another node (its host), not to itself.',
      });
    }
  }
}

// ---- parent：必须指向一个存在的、且是子流程类型的节点 ----
function checkParentRefs(r: FlatResolver, push: (i: ValidationIssue) => void) {
  for (const n of r.nodes) {
    if (typeof n.parent !== 'string' || n.parent.length === 0) continue;
    if (n.parent === n.id) {
      push({
        code: 'SUBPROCESS_PARENT_SELF',
        severity: 'error',
        id: n.id,
        message: `node ${n.id}: parent points to itself`,
        hint: 'parent must point to the subProcess node that contains it, not to itself.',
      });
      continue;
    }
    const p = r.nodeById.get(n.parent);
    if (!p) {
      push({
        code: 'SUBPROCESS_PARENT_MISSING',
        severity: 'error',
        id: n.id,
        message: `node ${n.id}: parent points to "${n.parent}", but no such node exists`,
        hint: `Change parent to an existing subProcess node id, or add a subprocess node with id "${n.parent}".`,
      });
    } else if (!SUBPROCESS_TYPES.has(p.type)) {
      push({
        code: 'SUBPROCESS_PARENT_NOT_SUBPROCESS',
        severity: 'error',
        id: n.id,
        message: `node ${n.id}: its parent "${n.parent}" has type ${p.type}, which is not a subprocess`,
        hint: 'parent may only point to subProcess / adHocSubProcess / transaction; regular tasks cannot contain other nodes.',
      });
    }
  }
}

// ---- attachedTo / parent 形成的环（自指已在上面单独报；这里抓长度≥2 的环）----
function checkReferenceCycles(r: FlatResolver, push: (i: ValidationIssue) => void) {
  // 每个节点沿 attachedTo→parent 链向上走，撞回起点即成环。自指（长度 1）已由 *_SELF_* 覆盖，这里只报多节点环。
  for (const start of r.nodes) {
    const seen = new Set<string>([start.id]);
    let cur: FlatNode | undefined = start;
    let steps = 0;
    while (cur && steps < r.nodes.length + 1) {
      const nextId =
        typeof cur.attachedTo === 'string' && r.nodeById.has(cur.attachedTo)
          ? cur.attachedTo
          : typeof cur.parent === 'string' && r.nodeById.has(cur.parent)
            ? cur.parent
            : undefined;
      if (nextId === undefined) break;
      if (nextId === start.id && steps >= 1) {
        push({
          code: 'REFERENCE_CYCLE',
          severity: 'error',
          id: start.id,
          message: `the attachedTo / parent reference chain of node ${start.id} forms a cycle`,
          hint: 'Inspect the attachedTo / parent chain and make sure it eventually reaches a top-level host / subprocess that no longer references upward.',
        });
        break;
      }
      if (seen.has(nextId)) break; // 环不含起点：由该环上某个起点的遍历报出，避免重复
      seen.add(nextId);
      cur = r.nodeById.get(nextId);
      steps++;
    }
  }
}

const laneChildrenIndex = (lanes: FlatLane[]) => {
  const hasChild = new Set<string>();
  for (const l of lanes) if (typeof l.parentLane === 'string') hasChild.add(l.parentLane);
  return hasChild;
};

// ---- node.lane：必须指向存在的泳道、该泳道须是叶子、且与 node.pool 不冲突 ----
function checkLaneRefs(r: FlatResolver, push: (i: ValidationIssue) => void) {
  if (r.lanes.length === 0) return;
  const nonLeaf = laneChildrenIndex(r.lanes);
  for (const n of r.nodes) {
    if (typeof n.lane !== 'string' || n.lane.length === 0) continue;
    const lane = r.laneById.get(n.lane);
    if (!lane) {
      push({
        code: 'LANE_REF_MISSING',
        severity: 'error',
        id: n.id,
        message: `node ${n.id}: lane points to "${n.lane}", but no such lane exists`,
        hint: `Change lane to an existing lane id, or add a lane with id "${n.lane}" to lanes.`,
      });
      continue;
    }
    if (nonLeaf.has(lane.id)) {
      push({
        code: 'LANE_NOT_LEAF',
        severity: 'error',
        id: n.id,
        message: `node ${n.id} is placed in lane "${lane.id}", but that lane has child lanes`,
        hint: 'A parent lane with child lanes cannot directly hold flow nodes; move the node into one of the leaf (innermost) child lanes.',
      });
    }
    if (n.pool && lane.pool && n.pool !== lane.pool) {
      push({
        code: 'LANE_POOL_MISMATCH',
        severity: 'error',
        id: n.id,
        message: `node ${n.id} has pool="${n.pool}", which conflicts with pool="${lane.pool}" of its lane "${lane.id}"`,
        hint: 'Remove node.pool (let it follow the lane), or switch the lane to one under the same pool.',
      });
    }
  }
}

// ---- lane.parentLane：必须指向存在的泳道、不自指、不跨池 ----
function checkParentLaneRefs(r: FlatResolver, push: (i: ValidationIssue) => void) {
  for (const l of r.lanes) {
    if (typeof l.parentLane !== 'string' || l.parentLane.length === 0) continue;
    if (l.parentLane === l.id) {
      push({
        code: 'LANE_PARENT_SELF',
        severity: 'error',
        id: l.id,
        message: `lane ${l.id}: parentLane points to itself`,
        hint: 'parentLane must point to another (outer) lane, not to itself.',
      });
      continue;
    }
    const parent = r.laneById.get(l.parentLane);
    if (!parent) {
      push({
        code: 'LANE_PARENT_MISSING',
        severity: 'error',
        id: l.id,
        message: `lane ${l.id}: parentLane points to "${l.parentLane}", but no such lane exists`,
        hint: `Change parentLane to an existing lane id, or add a parent lane with id "${l.parentLane}"; omit parentLane for top-level lanes.`,
      });
    } else if (r.hasPools && l.pool && parent.pool && l.pool !== parent.pool) {
      push({
        code: 'LANE_PARENT_POOL_MISMATCH',
        severity: 'error',
        id: l.id,
        message: `lane ${l.id} (pool=${l.pool}): its parentLane "${parent.id}" belongs to a different pool=${parent.pool}`,
        hint: 'A nested lane must stay in the same pool as its parent lane.',
      });
    }
  }
}

// ---- pool 引用：node.pool / lane.pool 指向存在的 pool；多池时 lane 必须声明 pool ----
function checkPoolRefs(r: FlatResolver, push: (i: ValidationIssue) => void) {
  if (!r.hasPools) return;
  const poolIds = new Set(r.pools.map((p) => p.id));
  for (const n of r.nodes) {
    if (typeof n.pool === 'string' && n.pool.length > 0 && !poolIds.has(n.pool)) {
      push({
        code: 'NODE_POOL_MISSING',
        severity: 'error',
        id: n.id,
        message: `node ${n.id}: pool points to "${n.pool}", but no such pool exists`,
        hint: `Change pool to an existing pool id, or add a pool with id "${n.pool}" to pools.`,
      });
    }
  }
  for (const l of r.lanes) {
    if (typeof l.pool === 'string' && l.pool.length > 0 && !poolIds.has(l.pool)) {
      push({
        code: 'LANE_POOL_MISSING',
        severity: 'error',
        id: l.id,
        message: `lane ${l.id}: pool points to "${l.pool}", but no such pool exists`,
        hint: `Change pool to an existing pool id, or add a pool with id "${l.pool}" to pools.`,
      });
    } else if (r.pools.length > 1 && (typeof l.pool !== 'string' || l.pool.length === 0)) {
      push({
        code: 'LANE_POOL_REQUIRED',
        severity: 'error',
        id: l.id,
        message: `with multiple pools, lane ${l.id} must declare its owning pool via pool`,
        hint: 'Add pool: "<the id of the pool it belongs to>" to this lane.',
      });
    }
  }
}

// ---- 多池时：每个「自身参与布局」的流程节点都必须能解析出归属池 ----
function checkNodePoolResolvable(r: FlatResolver, push: (i: ValidationIssue) => void) {
  if (r.pools.length < 2) return; // 单池/无池：归属唯一容器，不会无解
  for (const n of r.nodes) {
    if (r.isBoundary(n) || r.isInner(n)) continue; // 跟随宿主 / 父子流程，由其归属决定
    if (r.poolOfNode(n.id) === undefined) {
      push({
        code: 'NODE_POOL_UNRESOLVED',
        severity: 'error',
        id: n.id,
        message: `with multiple pools, node ${n.id} has no pool and no resolvable lane, so its owning pool cannot be determined`,
        hint: 'Add pool: "<owning pool id>" to it, or add a lane pointing to a lane that declares its pool.',
      });
    }
  }
}

// ---- 边：sequenceFlow 不得跨子流程边界；同进程作用域内的 messageFlow 归正为 sequenceFlow（告警）----
function checkEdges(r: FlatResolver, push: (i: ValidationIssue) => void) {
  for (const e of r.edges) {
    if (!r.nodeById.has(e.source) || !r.nodeById.has(e.target)) continue; // 悬空端点交给 validateGraph
    const sp = r.poolOfNode(e.source);
    const tp = r.poolOfNode(e.target);
    const crossPool = sp !== undefined && tp !== undefined && sp !== tp;
    const ss = r.subOf(e.source);
    const ts = r.subOf(e.target);

    if (!crossPool && ss !== ts) {
      // 同池（或单进程）但两端不在同一子流程作用域：sequenceFlow 不能穿越子流程边界。
      push({
        code: 'SEQFLOW_CROSS_SUBPROCESS',
        severity: 'error',
        id: e.id,
        message: `edge ${e.id} (${e.source} → ${e.target}) crosses a subprocess boundary; sequenceFlow cannot cross the frame of a subprocess`,
        hint: 'Keep both endpoints on the same level (both inside the subprocess, or both outside); to express entering/leaving a subprocess, connect to the subprocess node itself, not to nodes inside it.',
      });
    }
    if (!crossPool && e.type === 'messageFlow') {
      push({
        code: 'MSGFLOW_INTRA',
        severity: 'warning',
        id: e.id,
        message: `edge ${e.id} is marked messageFlow, but both endpoints are in the same process; it has been treated as a sequenceFlow`,
        hint: 'messageFlow is only for cross-pool communication; use sequenceFlow for in-process connections (just omit type).',
      });
    }
  }
}
