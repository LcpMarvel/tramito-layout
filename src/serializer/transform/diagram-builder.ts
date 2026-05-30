/**
 * Diagram Builder
 * Handles building the visual diagram (shapes and edges) from a layouted graph.
 * This module is responsible for converting layouted node positions into
 * BPMN DI (Diagram Interchange) format.
 */

import type { LayoutedGraph } from '../types/elk-output';
import type { IoSpecification } from '../types/elk-bpmn';
import {
  IO_SPEC_DATA_HEIGHT,
  IO_SPEC_DATA_WIDTH,
  IO_SPEC_GAP_BELOW,
  IO_SPEC_LABEL_GAP,
  IO_SPEC_LABEL_LINE_HEIGHT,
  IO_SPEC_ROW_GAP,
  ioSpecLabelMaxWidth,
} from '../../layout/node-sizes.ts';
import type {
  DiagramModel,
  ShapeModel,
  EdgeModel,
  PointModel,
  DefinitionsModel,
  LayoutedNode,
  LayoutedEdge,
  NodePosition,
  NodeOffset,
  NodeBpmnInfo,
} from './model-types';

interface ExplicitDataInputAssociation {
  id: string;
  sourceRefs: string[];
  targetRef?: string;
}

interface ExplicitDataOutputAssociation {
  id: string;
  sourceRefs: string[];
  targetRef?: string;
}

// ============================================================================
// 工具：扫描 graph 找所有被 callActivity 引用的 process id
// ============================================================================

/**
 * 递归扫整张 graph，收集所有 callActivity 的 calledElement → reusable process id 集合。
 * 这些 process 在 BPMN XML 里以**定义**形式存在（让 calledElement 引用有效），但**不应**
 * 出现在 BPMNDiagram 里——否则它们的 children 会以 ghost shape 形式污染输出。
 */
function collectCalledProcessIds(graph: LayoutedGraph): Set<string> {
  const ids = new Set<string>();
  function walk(node: { bpmn?: { type?: string; calledElement?: string }; children?: unknown[] } | undefined): void {
    if (!node) return;
    const type = node.bpmn?.type;
    const called = node.bpmn?.calledElement;
    if (type === 'callActivity' && called) ids.add(called);
    for (const c of node.children ?? []) walk(c as typeof node);
  }
  for (const child of graph.children ?? []) walk(child as Parameters<typeof walk>[0]);
  return ids;
}

function rangesOverlap(aX: number, aW: number, bX: number, bW: number): boolean {
  return aX < bX + bW && bX < aX + aW;
}

// ============================================================================
// Diagram Builder
// ============================================================================

export class DiagramBuilder {
  // Map to track boundary event positions: id -> { x, y, width, height }
  private boundaryEventPositions: Map<string, NodePosition> = new Map();
  // Map: boundary event id -> host node id (used to detour around host when routing out-edges)
  private boundaryHosts: Map<string, string> = new Map();
  // Map to track all node positions for edge routing: id -> { x, y, width, height }
  private nodePositions: Map<string, NodePosition> = new Map();
  // Map to track the offset used for each node (for edge coordinate transformation)
  private nodeOffsets: Map<string, NodeOffset> = new Map();
  // Map to track node BPMN metadata for gateway detection
  private nodeBpmn: Map<string, NodeBpmnInfo> = new Map();
  // ioSpecification data objects: dataObjectId -> owner task id. Used so we
  // know which data shapes belong to which task when routing edges, since data
  // objects synthesized for a task should NOT be treated as obstacles for
  // edges whose source/target is that same task.
  private dataObjectOwners: Map<string, string> = new Map();
  /**
   * Build the diagram model from a layouted graph
   */
  build(graph: LayoutedGraph, definitions: DefinitionsModel): DiagramModel {
    // Reset all maps
    this.boundaryEventPositions.clear();
    this.boundaryHosts.clear();
    this.nodePositions.clear();
    this.nodeOffsets.clear();
    this.dataObjectOwners.clear();
    this.nodeBpmn.clear();

    const shapes: ShapeModel[] = [];
    const edges: EdgeModel[] = [];

    // Find the main bpmn element for the plane
    const mainElement = definitions.rootElements[0];
    if (!mainElement) {
      throw new Error('Cannot create BPMN diagram: definitions.rootElements is empty. The graph must contain at least one process or collaboration.');
    }
    const planeElement = mainElement.type === 'collaboration' ? mainElement.id : mainElement.id;

    // Identify "callable definition" processes：被某个 callActivity 的 calledElement 引用的
    // top-level process。这些 process 的 bpmn:process 元素必须保留在 definitions 里（让
    // calledElement 引用有效），但**不能**出现在 BPMNDiagram 里（它们是定义级、不是实例化的
    // 可视化流程）。fixture 22 触发：之前 sub_start/sub_task_review/sub_end 这些 ghost
    // shape 会被写进 BPMN XML、超出 BPMNPlane bounds，污染 E1/E4/N1 客观检测。
    const calledProcessIds = collectCalledProcessIds(graph);

    // Build shapes and edges
    for (const child of graph.children) {
      if (child.bpmn?.type === 'process' && calledProcessIds.has(child.id)) continue;
      this.collectShapesAndEdges(child as LayoutedNode, shapes, edges);
    }

    // L3：gateway 默认把 name 标签放在菱形正上方，但「合并 gateway」常有竖直入边从上方顶点
    // 进入——标签就压在箭头上、和入边 label 糊在一起（layout-loop 在 42 揪出此 bug）。这里
    // 用已建好的绝对坐标 edges 判断 gateway 上方是否被竖直边占用，占用则把标签挪到空闲侧。
    this.placeGatewayLabelsOffEdges(shapes, edges);

    return {
      id: `BPMNDiagram_${graph.id}`,
      name: 'BPMNDiagram',
      plane: {
        id: `BPMNPlane_${graph.id}`,
        bpmnElement: planeElement,
        shapes,
        edges,
      },
    };
  }

  /**
   * Get stored node positions (for external access if needed)
   */
  getNodePositions(): Map<string, NodePosition> {
    return this.nodePositions;
  }

  // gateway 的 name 标签默认放菱形正上方,但两类碰撞要躲:
  //   1. 合并 gateway 顶部被竖直**入边**占用 → name 压在箭头上(排他/并行合并)。
  //   2. diverge gateway 的某条分叉**出边的 label** 落进了 name 的上方 y-band → name 和边
  //      label 糊成一坨(fixture 42 的「包容分叉」撞「VIP客户」:分支朝右上走,label 正好和
  //      name 同高)。这是 node-name 撞 edge-label,不是撞箭头,故 occupied.has('top') 为 false。
  // 重定位优先级:下 > 右 > 左(各自要求该侧无端点占用、且落点不压任何 edge label);都不行
  // 再保持上方但水平挪开(优先朝远离 colliding edge label 的一侧),最后才退回 shaft 错开。
  private placeGatewayLabelsOffEdges(shapes: ShapeModel[], edges: EdgeModel[]): void {
    const TOL = 3;
    const endpointsOf = (e: EdgeModel): PointModel[] => {
      const n = e.waypoints.length;
      return n >= 2 ? [e.waypoints[0]!, e.waypoints[n - 1]!] : [];
    };
    const edgeLabels = edges
      .map((e) => e.label?.bounds)
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
    const overlaps = (
      ax: number, ay: number, aw: number, ah: number,
      bx: number, by: number, bw: number, bh: number,
    ): boolean => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
    const hitsEdgeLabel = (x: number, y: number, w: number, h: number): boolean =>
      edgeLabels.some((el) => overlaps(x, y, w, h, el.x, el.y, el.width, el.height));

    for (const shape of shapes) {
      if (!this.isGatewayType(this.nodeBpmn.get(shape.bpmnElement)?.type)) continue;
      const lb = shape.label?.bounds;
      if (!lb) continue;
      const b = shape.bounds;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const occupied = new Set<'top' | 'bottom' | 'left' | 'right'>();
      const topShaftXs: number[] = [];
      for (const e of edges) {
        for (const p of endpointsOf(e)) {
          if (p.x < b.x - TOL || p.x > b.x + b.width + TOL || p.y < b.y - TOL || p.y > b.y + b.height + TOL) continue;
          if (Math.abs(p.y - b.y) <= TOL) { occupied.add('top'); topShaftXs.push(p.x); }
          else if (Math.abs(p.y - (b.y + b.height)) <= TOL) occupied.add('bottom');
          else if (Math.abs(p.x - b.x) <= TOL) occupied.add('left');
          else if (Math.abs(p.x - (b.x + b.width)) <= TOL) occupied.add('right');
        }
      }

      const lw = lb.width;
      const lh = lb.height;
      const defaultHitsLabel = hitsEdgeLabel(lb.x, lb.y, lw, lh);
      // 默认上方摆放既没被入边占,也没和任何 edge label 冲突 → 保持不动(最小扰动)。
      if (!occupied.has('top') && !defaultHitsLabel) continue;

      const tryPlace = (x: number, y: number): boolean => {
        if (hitsEdgeLabel(x, y, lw, lh)) return false;
        lb.x = x; lb.y = y; return true;
      };

      // diverge 情形(顶部没被入边占,只是 name 撞了某条出边的 label):name 不在任何 shaft 上,
      // 最干净的修法是**保持上方居中、把它再抬高到那条 edge label 之上**——gateway 正上方通常
      // 是空的,而两侧常被相邻合并 gateway 的 name / 分支占住(往左挪会撞上一个合并 gateway 名)。
      if (!occupied.has('top')) {
        const colliding = edgeLabels.filter((el) =>
          overlaps(lb.x, lb.y, lw, lh, el.x, el.y, el.width, el.height));
        if (colliding.length) {
          const minTop = Math.min(...colliding.map((el) => el.y));
          const liftedY = minTop - 4 - lh;
          // 只在抬高后 name 仍贴着 gateway(到节点上沿 gap ≤ 26,留足 L1 的 30px 容差)才采用;
          // 否则(edge label 本就在更高处)抬上去会把 name 甩离节点、触发 L1——此时宁可保持
          // 默认轻微擦边(基线本就容忍),也不甩飞。
          if (b.y - (liftedY + lh) <= 26 && tryPlace(cx - lw / 2, liftedY)) continue;
        }
      }

      if (!occupied.has('bottom') && tryPlace(cx - lw / 2, b.y + b.height + 4)) continue;
      if (!occupied.has('right') && tryPlace(b.x + b.width + 4, cy - lh / 2)) continue;
      if (!occupied.has('left') && tryPlace(b.x - lw - 4, cy - lh / 2)) continue;

      // 兜底:顶部被入边占且四侧都腾不开 → 沿竖直 shaft 右侧错开,至少躲开箭头。
      if (occupied.has('top')) {
        const shaftX = topShaftXs.length ? Math.max(...topShaftXs) : cx;
        lb.x = shaftX + 6; lb.y = b.y - lh - 4;
      }
    }
  }

  /**
   * Collect shapes and edges recursively
   * @param offsetX - Parent container's absolute X offset
   * @param offsetY - Parent container's absolute Y offset
   * @param insideParticipant - Whether we are inside a participant container
   */
  private collectShapesAndEdges(
    node: LayoutedNode,
    shapes: ShapeModel[],
    edges: EdgeModel[],
    offsetX: number = 0,
    offsetY: number = 0,
    insideParticipant: boolean = false
  ): void {
    // Add shape for this node (if it has coordinates)
    if (node.x !== undefined && node.y !== undefined) {
      const absoluteX = offsetX + node.x;
      const absoluteY = offsetY + node.y;
      const visualWidth = node.width ?? 100;
      const nodeHeight = node.height ?? 80;

      // Store node position for edge routing
      // For events, include the label area below the node in the bounds
      // to help edge labels avoid overlapping with node labels
      let effectiveHeight = nodeHeight;
      if (this.isEventType(node.bpmn?.type) && node.labels && node.labels.length > 0) {
        // Events have labels below them - extend the effective height
        const labelHeight = node.labels[0]?.height ?? 14;
        effectiveHeight = nodeHeight + 4 + labelHeight; // 4px gap + label height
      }

      const nodePosition: NodePosition = {
        x: absoluteX,
        y: absoluteY,
        width: visualWidth,
        height: effectiveHeight,
      };
      this.nodePositions.set(node.id, nodePosition);

      // Store node BPMN metadata for gateway detection
      if (node.bpmn) {
        this.storeNodeBpmn(node.id, { type: node.bpmn.type, isExpanded: node.bpmn.isExpanded });
      }

      // Store the offset used for this node (needed for edge coordinate transformation)
      this.nodeOffsets.set(node.id, { x: offsetX, y: offsetY });

      shapes.push(this.buildShape(node, offsetX, offsetY));

      // Process ioSpecification dataInput/dataOutput shapes for tasks/activities only
      // These are visual representations of task inputs/outputs positioned around the task
      // Skip for process-level ioSpecification (process type should not have visual data shapes)
      const nodeType = node.bpmn?.type;
      const isTaskOrActivity = nodeType && (
        nodeType.includes('Task') ||
        nodeType === 'task' ||
        nodeType === 'callActivity' ||
        nodeType === 'subProcess' ||
        nodeType === 'transaction' ||
        nodeType === 'adHocSubProcess'
      );

      if (isTaskOrActivity) {
        const ioSpec = (node.bpmn as { ioSpecification?: IoSpecification } | undefined)?.ioSpecification;
        if (ioSpec) {
          this.buildIoSpecificationShapes(node, ioSpec, shapes, edges, absoluteX, absoluteY, visualWidth, nodeHeight);
        }
      }
    }

    // Calculate offset for children
    // Containers that offset their children: pools (participants), lanes, and expanded subprocesses
    const isExpandedSubprocess = node.bpmn?.isExpanded === true &&
      (node.bpmn?.type === 'subProcess' || node.bpmn?.type === 'transaction' ||
       node.bpmn?.type === 'adHocSubProcess' || node.bpmn?.type === 'eventSubProcess' ||
       (node.bpmn as { triggeredByEvent?: boolean })?.triggeredByEvent === true);

    const isPoolOrLane = node.bpmn?.type === 'participant' || node.bpmn?.type === 'lane';

    // Process nested inside participant also acts as a container for coordinate offsets
    const isNestedProcess = node.bpmn?.type === 'process' && insideParticipant;

    const isContainer = isExpandedSubprocess || isPoolOrLane || isNestedProcess;

    const childOffsetX = isContainer ? offsetX + (node.x ?? 0) : offsetX;
    const childOffsetY = isContainer ? offsetY + (node.y ?? 0) : offsetY;

    // Track if we're entering a participant
    const childInsideParticipant = insideParticipant || node.bpmn?.type === 'participant';

    // Process children
    if (node.children) {
      for (const child of node.children) {
        this.collectShapesAndEdges(child as LayoutedNode, shapes, edges, childOffsetX, childOffsetY, childInsideParticipant);
      }
    }

    // Process boundary events. Coordinates come from the layout pipeline
    // (decoration-placer via merger) as absolute values; this stage
    // must not recompute them — the old `spacing = nodeWidth / (beCount+1)`
    // formula packed 36-wide events into 25-px slots on a 100-wide host and
    // overlapped them visually (violates B1).
    if (node.boundaryEvents) {
      node.boundaryEvents.forEach((be) => {
        if (typeof be.x !== 'number' || typeof be.y !== 'number') {
          throw new Error(`[serializer] boundary event ${be.id} missing absolute coordinates from layout pipeline`);
        }
        const beWidth = be.width ?? 36;
        const beHeight = be.height ?? 36;
        const beX = be.x;
        const beY = be.y;

        this.boundaryEventPositions.set(be.id, { x: beX, y: beY, width: beWidth, height: beHeight });
        this.boundaryHosts.set(be.id, node.id);

        const labelText = be.bpmn?.name ?? '';
        const label = be.labels?.[0];
        if (labelText && (label?.x === undefined || label?.y === undefined)) {
          throw new Error(`[serializer] boundary event label ${be.id} is missing stage-computed bounds`);
        }
        const labelModel = labelText && label && typeof label.x === 'number' && typeof label.y === 'number'
          ? { bounds: { x: label.x, y: label.y, width: label.width ?? 24, height: label.height ?? 14 } }
          : undefined;

        shapes.push({
          id: `${be.id}_di`,
          bpmnElement: be.id,
          bounds: { x: beX, y: beY, width: beWidth, height: beHeight },
          label: labelModel,
        });
      });
    }

    // Process edges
    // Edge waypoints from ELK are relative to the source node's parent container,
    // not necessarily the edge's container. We use the source node's stored offset.
    if (node.edges) {
      for (const edge of node.edges) {
        if (!edge.sections || edge.sections.length === 0) continue;
        // Check if edge has absolute coordinates (set by rearrangePools for message flows)
        const hasAbsoluteCoords = (edge as { _absoluteCoords?: boolean })._absoluteCoords === true;
        // Check if edge has pool-relative coordinates (set by recalculatePoolEdges for pool edges with lanes)
        const hasPoolRelativeCoords = (edge as { _poolRelativeCoords?: boolean })._poolRelativeCoords === true;

        if (hasAbsoluteCoords) {
          // Edge already has absolute coordinates - don't add offset
          edges.push(this.buildEdge(edge, 0, 0));
        } else if (hasPoolRelativeCoords) {
          // Edge waypoints are relative to pool (already include lane offsets within pool)
          // Use container's offset (pool's offset), not source node's offset
          edges.push(this.buildEdge(edge, offsetX + (node.x ?? 0), offsetY + (node.y ?? 0)));
        } else {
          const sourceId = edge.sources?.[0];
          // Use the source node's offset if available, otherwise fall back to childOffset
          const sourceOffset = sourceId ? this.nodeOffsets.get(sourceId) : undefined;
          const edgeOffsetX = sourceOffset?.x ?? childOffsetX;
          const edgeOffsetY = sourceOffset?.y ?? childOffsetY;
          edges.push(this.buildEdge(edge, edgeOffsetX, edgeOffsetY));
        }
      }
    }
  }

  /**
   * Check if a node type is an event type
   */
  private isEventType(type?: string): boolean {
    if (!type) return false;
    return type.includes('Event') || type === 'startEvent' || type === 'endEvent' ||
           type === 'intermediateThrowEvent' || type === 'intermediateCatchEvent';
  }

  /**
   * Check if a node type is a gateway type
   */
  private isGatewayType(type?: string): boolean {
    if (!type) return false;
    return type.includes('Gateway');
  }

  /**
   * Store node BPMN metadata for later gateway detection
   */
  private storeNodeBpmn(nodeId: string, bpmn: NodeBpmnInfo): void {
    this.nodeBpmn.set(nodeId, bpmn);
  }

  /**
   * Build shapes for ioSpecification dataInputs and dataOutputs
   * Positions: dataInputs below-left of the task (stacked vertically),
   *            dataOutputs below-right of the task (stacked vertically)
   * Only the topmost item in each stack has a dashed association edge to the task
   */
  private buildIoSpecificationShapes(
    node: LayoutedNode,
    ioSpec: IoSpecification,
    shapes: ShapeModel[],
    edges: EdgeModel[],
    taskX: number,
    taskY: number,
    taskWidth: number,
    taskHeight: number
  ): void {
    // Position dataInputs below the task, aligned to the left side, stacked vertically
    const dataInputs = ioSpec.dataInputs ?? [];
    const inputStartX = taskX; // Start from task's left edge
    const dataOutputs = ioSpec.dataOutputs ?? [];
    const outputStartX = taskX + taskWidth - IO_SPEC_DATA_WIDTH; // Align to right edge
    const labelMaxWidth = ioSpecLabelMaxWidth(taskWidth);
    let rowY = taskY + taskHeight + IO_SPEC_GAP_BELOW;
    const rowCount = Math.max(dataInputs.length, dataOutputs.length);
    const explicitInputAssociations = this.getExplicitDataInputAssociations(node);
    const explicitOutputAssociations = this.getExplicitDataOutputAssociations(node);
    const hasExplicitInputAssociations = explicitInputAssociations !== undefined;
    const hasExplicitOutputAssociations = explicitOutputAssociations !== undefined;
    const renderedInputAssociations = new Set<string>();
    const renderedOutputAssociations = new Set<string>();

    for (let index = 0; index < rowCount; index++) {
      const dataInput = dataInputs[index];
      const dataOutput = dataOutputs[index];
      let inputLabelHeight = 0;
      let outputLabelHeight = 0;
      let labelsOverlap = false;
      if (dataInput?.name) {
        const inputLabelWidth = this.estimateTextWidth(dataInput.name, labelMaxWidth);
        inputLabelHeight = this.estimateLabelLines(dataInput.name, inputLabelWidth) * IO_SPEC_LABEL_LINE_HEIGHT;
        if (dataOutput?.name) {
          const outputLabelWidth = this.estimateTextWidth(dataOutput.name, labelMaxWidth);
          outputLabelHeight = this.estimateLabelLines(dataOutput.name, outputLabelWidth) * IO_SPEC_LABEL_LINE_HEIGHT;
          const inputLabelX = inputStartX + (IO_SPEC_DATA_WIDTH - inputLabelWidth) / 2;
          const outputLabelX = outputStartX + (IO_SPEC_DATA_WIDTH - outputLabelWidth) / 2;
          labelsOverlap = rangesOverlap(inputLabelX, inputLabelWidth, outputLabelX, outputLabelWidth);
        }
      } else if (dataOutput?.name) {
        const outputLabelWidth = this.estimateTextWidth(dataOutput.name, labelMaxWidth);
        outputLabelHeight = this.estimateLabelLines(dataOutput.name, outputLabelWidth) * IO_SPEC_LABEL_LINE_HEIGHT;
      }

      if (dataInput) {
        const inputId = dataInput.id ?? `${node.id}_input_${index}`;
        const inputX = inputStartX;
        const inputY = rowY;

        this.dataObjectOwners.set(inputId, node.id);

        // Store position for edge routing
        this.nodePositions.set(inputId, {
          x: inputX,
          y: inputY,
          width: IO_SPEC_DATA_WIDTH,
          height: IO_SPEC_DATA_HEIGHT,
        });

        const shape: ShapeModel = {
          id: `${inputId}_di`,
          bpmnElement: inputId,
          bounds: {
            x: inputX,
            y: inputY,
            width: IO_SPEC_DATA_WIDTH,
            height: IO_SPEC_DATA_HEIGHT,
          },
        };

        // Add label below the data object
        if (dataInput.name) {
          const labelWidth = this.estimateTextWidth(dataInput.name, labelMaxWidth);
          const centeredX = inputX + (IO_SPEC_DATA_WIDTH - labelWidth) / 2;
          shape.label = {
            bounds: {
              x: centeredX,
              y: inputY + IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP,
              width: labelWidth,
              height: inputLabelHeight,
            },
          };
        }

        shapes.push(shape);

        const associations = explicitInputAssociations?.filter((association) =>
          association.sourceRefs.includes(inputId) && (!association.targetRef || association.targetRef === node.id),
        ) ?? [];
        if (hasExplicitInputAssociations) {
          for (const association of associations) {
            if (renderedInputAssociations.has(association.id)) continue;
            renderedInputAssociations.add(association.id);
            edges.push(this.buildIoAssociationEdge(association.id, inputX, inputY, taskY + taskHeight, 'input'));
          }
        } else if (index === 0) {
          edges.push(this.buildIoAssociationEdge(`${inputId}_assoc`, inputX, inputY, taskY + taskHeight, 'input'));
        }
      }

      // Position dataOutputs below the task, aligned to the right side, stacked vertically
      if (dataOutput) {
        const outputId = dataOutput.id ?? `${node.id}_output_${index}`;
        const outputX = outputStartX;
        const outputY = labelsOverlap
          ? rowY + IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP + inputLabelHeight + IO_SPEC_ROW_GAP
          : rowY;

        this.dataObjectOwners.set(outputId, node.id);

        // Store position for edge routing
        this.nodePositions.set(outputId, {
          x: outputX,
          y: outputY,
          width: IO_SPEC_DATA_WIDTH,
          height: IO_SPEC_DATA_HEIGHT,
        });

        const shape: ShapeModel = {
          id: `${outputId}_di`,
          bpmnElement: outputId,
          bounds: {
            x: outputX,
            y: outputY,
            width: IO_SPEC_DATA_WIDTH,
            height: IO_SPEC_DATA_HEIGHT,
          },
        };

        // Add label below the data object
        if (dataOutput.name) {
          const labelWidth = this.estimateTextWidth(dataOutput.name, labelMaxWidth);
          const centeredX = outputX + (IO_SPEC_DATA_WIDTH - labelWidth) / 2;
          shape.label = {
            bounds: {
              x: centeredX,
              y: outputY + IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP,
              width: labelWidth,
              height: outputLabelHeight,
            },
          };
        }

        shapes.push(shape);

        const associations = explicitOutputAssociations?.filter((association) =>
          association.targetRef === outputId && (association.sourceRefs.length === 0 || association.sourceRefs.includes(node.id)),
        ) ?? [];
        if (hasExplicitOutputAssociations) {
          for (const association of associations) {
            if (renderedOutputAssociations.has(association.id)) continue;
            renderedOutputAssociations.add(association.id);
            edges.push(this.buildIoAssociationEdge(association.id, outputX, outputY, taskY + taskHeight, 'output'));
          }
        } else if (index === 0) {
          edges.push(this.buildIoAssociationEdge(`${outputId}_assoc`, outputX, outputY, taskY + taskHeight, 'output'));
        }
      }

      const rowLabelHeight = labelsOverlap
        ? inputLabelHeight + IO_SPEC_ROW_GAP + IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP + outputLabelHeight
        : Math.max(inputLabelHeight, outputLabelHeight);
      rowY += IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP + rowLabelHeight + IO_SPEC_ROW_GAP;
    }
  }

  private buildIoAssociationEdge(
    associationId: string,
    dataX: number,
    dataY: number,
    taskBottomY: number,
    direction: 'input' | 'output',
  ): EdgeModel {
    const dataCenterX = dataX + IO_SPEC_DATA_WIDTH / 2;
    const dataTopY = dataY;
    return {
      id: `${associationId}_di`,
      bpmnElement: associationId,
      waypoints: direction === 'input'
        ? [
          { x: dataCenterX, y: dataTopY },
          { x: dataCenterX, y: taskBottomY },
        ]
        : [
          { x: dataCenterX, y: taskBottomY },
          { x: dataCenterX, y: dataTopY },
        ],
    };
  }

  private getExplicitDataInputAssociations(node: LayoutedNode): ExplicitDataInputAssociation[] | undefined {
    const bpmn = node.bpmn as { dataInputAssociations?: unknown } | undefined;
    if (!bpmn || !Array.isArray(bpmn.dataInputAssociations)) return undefined;
    return bpmn.dataInputAssociations
      .map((association) => this.normalizeDataAssociation(association))
      .filter((association): association is ExplicitDataInputAssociation => association !== undefined);
  }

  private getExplicitDataOutputAssociations(node: LayoutedNode): ExplicitDataOutputAssociation[] | undefined {
    const bpmn = node.bpmn as { dataOutputAssociations?: unknown } | undefined;
    if (!bpmn || !Array.isArray(bpmn.dataOutputAssociations)) return undefined;
    return bpmn.dataOutputAssociations
      .map((association) => this.normalizeDataAssociation(association))
      .filter((association): association is ExplicitDataOutputAssociation => association !== undefined);
  }

  private normalizeDataAssociation(value: unknown): ExplicitDataInputAssociation | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (!id) return undefined;
    const sourceRefsValue = record.sourceRefs;
    const sourceRefs = Array.isArray(sourceRefsValue)
      ? sourceRefsValue.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
      : [];
    const targetRef = typeof record.targetRef === 'string' && record.targetRef.length > 0
      ? record.targetRef
      : undefined;
    return { id, sourceRefs, targetRef };
  }

  /**
   * Estimate text width for label sizing (simplified)
   */
  private estimateTextWidth(text: string, maxWidth = 150): number {
    let width = 0;
    for (const char of text) {
      // CJK characters are wider
      if (char.charCodeAt(0) > 255) {
        width += 14;
      } else {
        width += 7;
      }
    }
    return Math.max(IO_SPEC_DATA_WIDTH, Math.min(width, maxWidth));
  }

  /**
   * Find node BPMN metadata by id
   */
  private findNodeBpmn(nodeId: string): NodeBpmnInfo | undefined {
    return this.nodeBpmn.get(nodeId);
  }

  /**
   * Estimate number of lines needed for a label based on text and width
   * Uses approximate character width of 14px for CJK and 7px for ASCII
   */
  private estimateLabelLines(text: string, maxWidth: number): number {
    if (!text || maxWidth <= 0) return 1;

    let currentLineWidth = 0;
    let lines = 1;

    for (const char of text) {
      // CJK characters are wider
      const charWidth = char.charCodeAt(0) > 255 ? 14 : 7;

      if (currentLineWidth + charWidth > maxWidth) {
        lines++;
        currentLineWidth = charWidth;
      } else {
        currentLineWidth += charWidth;
      }
    }

    return lines;
  }

  /**
   * Build a shape model
   */
  private buildShape(node: LayoutedNode, offsetX: number = 0, offsetY: number = 0): ShapeModel {
    const absoluteX = offsetX + (node.x ?? 0);
    const absoluteY = offsetY + (node.y ?? 0);
    const visualHeight = node.height ?? 80;
    const visualWidth = node.width ?? 100;

    const shape: ShapeModel = {
      id: `${node.id}_di`,
      bpmnElement: node.id,
      bounds: {
        x: absoluteX,
        y: absoluteY,
        width: visualWidth,
        height: visualHeight,
      },
    };

    // Add isExpanded for subprocesses
    if (node.bpmn?.isExpanded !== undefined) {
      shape.isExpanded = node.bpmn.isExpanded;
    }

    // Add isHorizontal for pools/lanes
    if (node.bpmn?.type === 'participant' || node.bpmn?.type === 'lane') {
      shape.isHorizontal = true;
    }

    // Add label positioning for elements that need external labels
    // Priority: use explicit labels data if present, otherwise generate from bpmn.name
    const nodeWidth = node.width ?? 36;
    const nodeHeight = node.height ?? 36;
    const label = node.labels?.[0];
    const labelText = node.bpmn?.name ?? label?.text ?? '';

    if (this.isEventType(node.bpmn?.type) && labelText) {
      // For events (circles), position the label below the shape (bpmn-js default behavior)
      const labelWidth = label?.width ?? 100;
      const labelHeight = label?.height ?? 14;

      // Position label below the event circle, horizontally centered (using absolute coords)
      shape.label = {
        bounds: {
          x: absoluteX + (nodeWidth - labelWidth) / 2,
          y: absoluteY + nodeHeight + 4, // 4px gap below the circle
          width: labelWidth,
          height: labelHeight,
        },
      };
    } else if (this.isGatewayType(node.bpmn?.type) && labelText) {
      // For gateways (diamonds), position the label above the shape to avoid overlap with nodes below
      const labelWidth = label?.width ?? 100;
      // Calculate label height based on text content (may need multiple lines)
      const estimatedLines = this.estimateLabelLines(labelText, labelWidth);
      const labelHeight = estimatedLines * 14; // 14px per line

      // Position label above the gateway diamond, horizontally centered
      // Adjust Y position upward based on label height
      shape.label = {
        bounds: {
          x: absoluteX + (nodeWidth - labelWidth) / 2,
          y: absoluteY - labelHeight - 4, // 4px gap above the diamond
          width: labelWidth,
          height: labelHeight,
        },
      };
    } else if (label?.x !== undefined && label?.y !== undefined) {
      // For other elements with explicit label positioning, use ELK-calculated position
      shape.label = {
        bounds: {
          x: absoluteX + label.x,
          y: absoluteY + label.y,
          width: label?.width ?? 100,
          height: label?.height ?? 20,
        },
      };
    }

    return shape;
  }

  /**
   * Build an edge model
   */
  private buildEdge(edge: LayoutedEdge, offsetX: number = 0, offsetY: number = 0): EdgeModel {
    let waypoints: PointModel[] = [];
    for (const section of edge.sections) {
      waypoints.push({ x: offsetX + section.startPoint.x, y: offsetY + section.startPoint.y });
      if (section.bendPoints) {
        for (const bp of section.bendPoints) {
          waypoints.push({ x: offsetX + bp.x, y: offsetY + bp.y });
        }
      }
      waypoints.push({ x: offsetX + section.endPoint.x, y: offsetY + section.endPoint.y });
    }

    const edgeModel: EdgeModel = {
      id: `${edge.id}_di`,
      bpmnElement: edge.id,
      waypoints,
    };

    // Edge labels are placed by the layout stages; serializer only emits DI.
    if (edge.labels && edge.labels.length > 0) {
      const label = edge.labels[0];
      const labelWidth = label?.width ?? 50;
      const labelHeight = label?.height ?? 14;
      if (label?.x === undefined || label?.y === undefined) {
        throw new Error(`[serializer] edge label ${edge.id} is missing stage-computed bounds`);
      }

      edgeModel.label = {
        bounds: {
          x: label.x,
          y: label.y,
          width: labelWidth,
          height: labelHeight,
        },
      };
    }

    return edgeModel;
  }

}
