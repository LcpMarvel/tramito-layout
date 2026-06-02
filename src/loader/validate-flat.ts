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
        message: `boundaryEvent ${n.id} 没有 attachedTo，无法确定挂在哪个宿主节点上`,
        hint: '给它加 attachedTo: "<宿主节点 id>"；若它其实是普通流程事件，请把 type 改成 intermediateCatchEvent。',
      });
    }
    if (hasAttached && !r.nodeById.has(n.attachedTo!)) {
      push({
        code: 'BOUNDARY_HOST_MISSING',
        severity: 'error',
        id: n.id,
        message: `boundaryEvent ${n.id} 的 attachedTo 指向 "${n.attachedTo}"，但没有这个节点`,
        hint: `把 attachedTo 改成一个真实存在的节点 id（task / subProcess 等），或补上 id 为 "${n.attachedTo}" 的宿主节点。`,
      });
    } else if (hasAttached && n.attachedTo === n.id) {
      push({
        code: 'BOUNDARY_SELF_ATTACHED',
        severity: 'error',
        id: n.id,
        message: `boundaryEvent ${n.id} 的 attachedTo 指向了自己`,
        hint: 'attachedTo 必须指向另一个节点（它的宿主），不能是自身。',
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
        message: `节点 ${n.id} 的 parent 指向了自己`,
        hint: 'parent 必须指向包裹它的那个 subProcess 节点，不能是自身。',
      });
      continue;
    }
    const p = r.nodeById.get(n.parent);
    if (!p) {
      push({
        code: 'SUBPROCESS_PARENT_MISSING',
        severity: 'error',
        id: n.id,
        message: `节点 ${n.id} 的 parent 指向 "${n.parent}"，但没有这个节点`,
        hint: `把 parent 改成一个真实存在的 subProcess 节点 id，或补上 id 为 "${n.parent}" 的子流程节点。`,
      });
    } else if (!SUBPROCESS_TYPES.has(p.type)) {
      push({
        code: 'SUBPROCESS_PARENT_NOT_SUBPROCESS',
        severity: 'error',
        id: n.id,
        message: `节点 ${n.id} 的 parent "${n.parent}" 类型是 ${p.type}，不是子流程`,
        hint: 'parent 只能指向 subProcess / adHocSubProcess / transaction；普通任务不能内嵌别的节点。',
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
          message: `节点 ${start.id} 的 attachedTo / parent 引用链形成了环`,
          hint: '检查 attachedTo / parent 链，确保它最终指向一个不再向上引用的顶层宿主 / 子流程。',
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
        message: `节点 ${n.id} 的 lane 指向 "${n.lane}"，但没有这个泳道`,
        hint: `把 lane 改成一个真实存在的泳道 id，或在 lanes 里补上 id 为 "${n.lane}" 的泳道。`,
      });
      continue;
    }
    if (nonLeaf.has(lane.id)) {
      push({
        code: 'LANE_NOT_LEAF',
        severity: 'error',
        id: n.id,
        message: `节点 ${n.id} 放在泳道 "${lane.id}" 上，但该泳道还有子泳道`,
        hint: '有子泳道的父泳道不能直接放流程节点；把节点改挂到某个叶子（最内层）子泳道上。',
      });
    }
    if (n.pool && lane.pool && n.pool !== lane.pool) {
      push({
        code: 'LANE_POOL_MISMATCH',
        severity: 'error',
        id: n.id,
        message: `节点 ${n.id} 的 pool="${n.pool}" 与其泳道 "${lane.id}" 所属 pool="${lane.pool}" 不一致`,
        hint: '去掉 node.pool（让它跟随泳道），或把泳道改成同一个 pool 下的泳道。',
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
        message: `泳道 ${l.id} 的 parentLane 指向了自己`,
        hint: 'parentLane 必须指向另一个（更外层的）泳道，不能是自身。',
      });
      continue;
    }
    const parent = r.laneById.get(l.parentLane);
    if (!parent) {
      push({
        code: 'LANE_PARENT_MISSING',
        severity: 'error',
        id: l.id,
        message: `泳道 ${l.id} 的 parentLane 指向 "${l.parentLane}"，但没有这个泳道`,
        hint: `把 parentLane 改成一个真实存在的泳道 id，或补上 id 为 "${l.parentLane}" 的父泳道；顶层泳道请省略 parentLane。`,
      });
    } else if (r.hasPools && l.pool && parent.pool && l.pool !== parent.pool) {
      push({
        code: 'LANE_PARENT_POOL_MISMATCH',
        severity: 'error',
        id: l.id,
        message: `泳道 ${l.id}（pool=${l.pool}）的 parentLane "${parent.id}" 属于另一个 pool=${parent.pool}`,
        hint: '嵌套泳道必须和父泳道在同一个 pool 内。',
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
        message: `节点 ${n.id} 的 pool 指向 "${n.pool}"，但没有这个泳池`,
        hint: `把 pool 改成一个真实存在的 pool id，或在 pools 里补上 id 为 "${n.pool}" 的泳池。`,
      });
    }
  }
  for (const l of r.lanes) {
    if (typeof l.pool === 'string' && l.pool.length > 0 && !poolIds.has(l.pool)) {
      push({
        code: 'LANE_POOL_MISSING',
        severity: 'error',
        id: l.id,
        message: `泳道 ${l.id} 的 pool 指向 "${l.pool}"，但没有这个泳池`,
        hint: `把 pool 改成一个真实存在的 pool id，或补上 id 为 "${l.pool}" 的泳池。`,
      });
    } else if (r.pools.length > 1 && (typeof l.pool !== 'string' || l.pool.length === 0)) {
      push({
        code: 'LANE_POOL_REQUIRED',
        severity: 'error',
        id: l.id,
        message: `有多个 pool 时，泳道 ${l.id} 必须用 pool 指明归属`,
        hint: '给该泳道加 pool: "<它所属的 pool id>"。',
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
        message: `有多个 pool 时，节点 ${n.id} 没有 pool 也没有可解析的 lane，无法确定它属于哪个泳池`,
        hint: '给它加 pool: "<所属 pool id>"，或加 lane 指到某个已声明 pool 的泳道上。',
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
        message: `边 ${e.id} 的两端 (${e.source} → ${e.target}) 跨越了子流程边界，sequenceFlow 不能穿过子流程的框`,
        hint: '让两端在同一层（都在该子流程内、或都在外层）；要表达子流程的进入/退出，应连到子流程节点本身，而不是它内部的节点。',
      });
    }
    if (!crossPool && e.type === 'messageFlow') {
      push({
        code: 'MSGFLOW_INTRA',
        severity: 'warning',
        id: e.id,
        message: `边 ${e.id} 标记为 messageFlow，但两端在同一个进程内；已按 sequenceFlow 处理`,
        hint: 'messageFlow 只用于跨 pool 通信；同进程内的连线请用 sequenceFlow（type 省略即可）。',
      });
    }
  }
}
