// ArtifactPlacer
//
// 把 dataObject / dataObjectReference / dataStoreReference / textAnnotation 放在
// 关联节点的上方或下方。
//
// 决策规则：
//   - dataInputAssociation: artifact → task，artifact 放在 task 上方
//   - dataOutputAssociation: task → artifact，artifact 放在 task 下方
//   - association (普通)：artifact 默认放上方
//   - textAnnotation：默认上方
//   - 同 task 同侧多个 artifact：横向铺开
//
// Group 这一期不处理（需要先算 groupedElements 包围框）。

import type { NodeBox } from './types.ts';
import { ARTIFACT_VERTICAL_GAP, ARTIFACT_HORIZONTAL_STEP } from './bpmn-rules.ts';
import type { ArtifactSubtype, AssociationSubtype } from '../loader/types.ts';

export type ArtifactSide = 'above' | 'below';

export interface ArtifactInputArtifact {
  id: string;
  subtype: ArtifactSubtype;
  width: number;
  height: number;
}

export interface ArtifactInputAssociation {
  id: string;
  subtype: AssociationSubtype;
  source: string;
  target: string;
}

export interface ArtifactInput {
  flowNodeBoxes: Map<string, NodeBox>;
  artifacts: ArtifactInputArtifact[];
  associations: ArtifactInputAssociation[];
}

export interface ArtifactOutput {
  /** artifact id → 绝对坐标 */
  artifactBoxes: Map<string, NodeBox>;
  /** artifact id → 哪个 task 在哪边（决定路由方向） */
  artifactSides: Map<string, { hostId: string; side: ArtifactSide }>;
}

// 常量统一从 bpmn-rules.ts 引入
const VERTICAL_GAP = ARTIFACT_VERTICAL_GAP;
const HORIZONTAL_STEP = ARTIFACT_HORIZONTAL_STEP;

export function placeArtifacts(input: ArtifactInput): ArtifactOutput {
  const artifactById = new Map(input.artifacts.map(a => [a.id, a]));

  // 1. 决定每个 artifact 关联到哪个 task / 哪一侧
  const artifactToHost = new Map<string, { hostId: string; side: ArtifactSide }>();
  const twoArtifactAssocs: ArtifactInputAssociation[] = [];
  for (const assoc of input.associations) {
    const srcIsArtifact = artifactById.has(assoc.source);
    const tgtIsArtifact = artifactById.has(assoc.target);
    if (srcIsArtifact && !tgtIsArtifact) {
      const side: ArtifactSide = assoc.subtype === 'dataInputAssociation' ? 'above' : 'above';
      // input 默认上方；textAnnotation/普通 association 也上方
      artifactToHost.set(assoc.source, { hostId: assoc.target, side });
    } else if (tgtIsArtifact && !srcIsArtifact) {
      const side: ArtifactSide = assoc.subtype === 'dataOutputAssociation' ? 'below' : 'above';
      artifactToHost.set(assoc.target, { hostId: assoc.source, side });
    } else if (srcIsArtifact && tgtIsArtifact) {
      twoArtifactAssocs.push(assoc);
    }
  }

  // 1b. 把"两端都是 artifact"的关联里、还没 host 的那一端挂到对端的 host 上（同侧）。
  // 用 fixed-point 迭代以覆盖链式情况（A→B→C 且只有 C 绑了 host 的场景）。
  for (let changed = true; changed; ) {
    changed = false;
    for (const assoc of twoArtifactAssocs) {
      const srcBound = artifactToHost.get(assoc.source);
      const tgtBound = artifactToHost.get(assoc.target);
      if (srcBound && !tgtBound) {
        artifactToHost.set(assoc.target, { hostId: srcBound.hostId, side: srcBound.side });
        changed = true;
      } else if (tgtBound && !srcBound) {
        artifactToHost.set(assoc.source, { hostId: tgtBound.hostId, side: tgtBound.side });
        changed = true;
      }
    }
  }

  // 2. 按 (hostId, side) 分桶，准备水平铺开
  type Bucket = { hostId: string; side: ArtifactSide; ids: string[] };
  const buckets = new Map<string, Bucket>();
  for (const a of input.artifacts) {
    if (a.subtype === 'group') continue;
    if (a.width <= 0 || a.height <= 0) continue;
    const meta = artifactToHost.get(a.id);
    if (!meta) continue; // 无关联或没找到 host
    if (!input.flowNodeBoxes.has(meta.hostId)) continue;
    const key = `${meta.hostId}::${meta.side}`;
    if (!buckets.has(key)) buckets.set(key, { hostId: meta.hostId, side: meta.side, ids: [] });
    buckets.get(key)!.ids.push(a.id);
  }

  // 3. 摆位
  const artifactBoxes = new Map<string, NodeBox>();
  const artifactSides = new Map<string, { hostId: string; side: ArtifactSide }>();
  for (const bucket of buckets.values()) {
    const host = input.flowNodeBoxes.get(bucket.hostId)!;
    const hostCenterX = host.x + host.w / 2;

    // 总宽 = sum(width) + (n-1) * step
    const items = bucket.ids.map(id => artifactById.get(id)!);
    const totalWidth = items.reduce((s, a) => s + a.width, 0) + (items.length - 1) * HORIZONTAL_STEP;
    let cursorX = hostCenterX - totalWidth / 2;
    for (const a of items) {
      const y = bucket.side === 'above'
        ? host.y - VERTICAL_GAP - a.height
        : host.y + host.h + VERTICAL_GAP;
      artifactBoxes.set(a.id, { x: cursorX, y, w: a.width, h: a.height });
      artifactSides.set(a.id, { hostId: bucket.hostId, side: bucket.side });
      cursorX += a.width + HORIZONTAL_STEP;
    }
  }

  return { artifactBoxes, artifactSides };
}
