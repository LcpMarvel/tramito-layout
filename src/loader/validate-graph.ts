// 纯静态结构校验：把 ELK-BPMN graph 对照"加载器规则"一次性查完，收集全部 issue 返回。
// 不跑布局、无副作用、不依赖 ELK。loader 复用本文件，使校验规则只有一处定义、永不漂移。
//
// WHY 一次性收集而非 fail-fast：消费侧用 LLM 生成 graph，结构错会被加载器抛出自纠重试。
// 单错 throw 会让 AI 改一个撞下一个、一个错烧一个 LLM step；全错列表才能一次喂回去自纠。

export type Severity = 'error' | 'warning';

// 校验 profile = 源语言。'generation'（默认）= LLM 生成的 JSON，最严；
// 'relayout' = 从已存在的合法 BPMN XML 转来的图，跳过"生成专属"规则（目前仅 NON_ASCII_ID）。
export type ValidationProfile = 'generation' | 'relayout';

export interface ValidationIssue {
  code: string; // 机器可读、稳定枚举，如 'BOUNDARY_EVENT_IN_CHILDREN'
  severity: Severity;
  id?: string; // 涉及的元素 id（尽量带上）
  message: string; // 人/AI 可读：错在哪
  hint?: string; // 怎么改（指向正确结构）
}

// 流程体内允许直接出现的 child 类型。WHY 单点定义：UNKNOWN_NODE_TYPE 的判定源头只此一处。
// WHY export：flatToNested / validate-flat 复用同一份类型集，避免「校验器认得、构造器不认」的漂移。
export const EVENT_TYPES = new Set([
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
]);

export const TASK_TYPES = new Set([
  'task',
  'userTask',
  'serviceTask',
  'sendTask',
  'receiveTask',
  'scriptTask',
  'manualTask',
  'businessRuleTask',
  'callActivity',
]);

export const GATEWAY_TYPES = new Set([
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
]);

export const SUBPROCESS_TYPES = new Set(['subProcess', 'adHocSubProcess', 'transaction']);

export const ARTIFACT_TYPES = new Set([
  'dataObject',
  'dataObjectReference',
  'dataStoreReference',
  'textAnnotation',
  'group',
]);

const FLOW_BODY_TYPES = new Set<string>([
  'lane',
  ...EVENT_TYPES,
  ...TASK_TYPES,
  ...GATEWAY_TYPES,
  ...SUBPROCESS_TYPES,
  ...ARTIFACT_TYPES,
]);

// none 的 catch / boundary 事件在 BPMN 里非法（catch 必须有可 catch 之物，boundary 必须挂触发器）；
// 而 none 的 start / end / intermediateThrow 合法。故只对这两类强制 eventDefinitionType。
const EVENT_DEF_REQUIRED = new Set(['intermediateCatchEvent', 'boundaryEvent']);

// 各容器允许的 edge 类型（对齐 loader 构建期的 throw，使两条 unknown-edge throw 也走 validateGraph）。
// messageFlow 单独处理：collaboration 内合法、process/lane 内属 MSGFLOW_NOT_IN_COLLABORATION，不在此集合。
export const ASSOCIATION_EDGE_TYPES = ['association', 'dataInputAssociation', 'dataOutputAssociation'] as const;
const COLLABORATION_EDGE_TYPES = new Set<string>([...ASSOCIATION_EDGE_TYPES]);
const FLOW_EDGE_TYPES = new Set<string>(['sequenceFlow', ...ASSOCIATION_EDGE_TYPES]);

interface RawEdge {
  id?: unknown;
  sources?: unknown;
  targets?: unknown;
  bpmn?: any;
}

type EdgeContainer = 'collaboration' | 'process' | 'lane';

interface EdgeRecord {
  id: string;
  type: string | undefined;
  source: string | undefined;
  target: string | undefined;
  container: EdgeContainer;
  poolId: string | null;
}

// 悬空边端点的 hint：区分「打错 id」与「漏声明节点」两种成因，把 LLM 导向正确的修法。
// WHY：泛化的「端点必须存在」会被模型误读成"删掉这条边"，但绝大多数实际成因是模型把
// 经过某网关的连线全写了、却忘了在 children 里 emit 这个网关节点。判据：
//   - 被 ≥2 条边引用 → 它是有入/出度的枢纽节点，几乎不可能是打错的孤立 id，必是漏声明；
//   - id 形如 gateway* → 直接点名是网关，并给出网关类型，省得模型猜。
// 两种情况都明确要求"补节点、别删边"。
function missingEndpointHint(id: string, refCount: number): string {
  const looksLikeGateway = /gateway/i.test(id);
  if (refCount >= 2 || looksLikeGateway) {
    const typeHint = looksLikeGateway
      ? '它看起来是个网关：用 exclusiveGateway / parallelGateway / inclusiveGateway 之一声明'
      : '把它作为节点声明';
    return `"${id}" 被 ${refCount} 条连线引用，却没有在 children / lane.children 里声明为节点——你很可能漏写了这个节点。${typeHint}，加进对应 lane.children；不要删掉这些连线。`;
  }
  return '端点必须是树内存在的节点 id（flow node / boundaryEvent / artifact / 黑盒池）；若该 id 是打错的，改成真实节点 id。';
}

class Validator {
  readonly issues: ValidationIssue[] = [];
  // profile 决定哪些"生成路径专属"规则生效。relayout 的源是已存在的合法 BPMN XML，不能拿生成约束去卡它。
  private readonly profile: ValidationProfile;
  // 整棵树的 id 出现序列，用于 DUPLICATE_ID（一次报一个重复 id）。
  private readonly idSeen = new Map<string, number>();
  // edge 端点可达集合：flow node / boundaryEvent / artifact / participant。不含 lane。
  private readonly reachable = new Set<string>();
  // id → 所属 pool（participant id；单 process 时为 process id）。用于 SEQFLOW_CROSS_POOL。
  private readonly poolOf = new Map<string, string>();
  private readonly nodeType = new Map<string, string>();
  private readonly edges: EdgeRecord[] = [];
  private readonly sequenceFlowIds = new Set<string>();
  // exclusiveGateway id → bpmn.default（声明的默认流 id）。
  private readonly exclusiveDefaults = new Map<string, string>();

  constructor(profile: ValidationProfile) {
    this.profile = profile;
  }

  add(issue: ValidationIssue): void {
    this.issues.push(issue);
  }

  registerId(id: unknown): id is string {
    if (typeof id !== 'string' || id.length === 0) return false;
    this.idSeen.set(id, (this.idSeen.get(id) ?? 0) + 1);
    // NON_ASCII_ID 是生成路径专属：LLM 应把中文放 name 而非 id。但 relayout 的源是已存在的合法
    // BPMN XML，XML NCName 本就允许非 ASCII（如中文）id，不能用生成约束去拒绝它。
    if (this.profile === 'generation' && !/^[\x00-\x7F]*$/.test(id)) {
      this.add({
        code: 'NON_ASCII_ID',
        severity: 'error',
        id,
        message: `id "${id}" 含非 ASCII 字符（如中文）`,
        hint: 'id 只能用 ASCII（字母/数字/下划线）；中文名称放到 bpmn.name，不要放 id。',
      });
    }
    return true;
  }

  run(root: any): void {
    const children = root.children as any[];
    for (const top of children) {
      this.walkTop(top);
    }
    // 没有任何 process / collaboration ⇒ 后端 model-builder / diagram-builder 会抛“无可编译根”。
    // 提升为前端规则，避免空图/全废节点的输入逃到后端被误标成 ICE。
    if (!children.some((c) => c?.bpmn?.type === 'process' || c?.bpmn?.type === 'collaboration')) {
      this.add({
        code: 'EMPTY_GRAPH',
        severity: 'error',
        message: 'graph 里没有任何 process 或 collaboration，无法编译出图',
        hint: 'children 至少要有一个 type 为 "process"（单池）或 "collaboration"（多池）的顶层元素。',
      });
    }
    this.finalize();
  }

  private walkTop(top: any): void {
    const type = top?.bpmn?.type;
    this.registerId(top?.id);
    if (type === 'collaboration') {
      for (const child of asArray(top.children)) {
        if (child?.bpmn?.type === 'participant') {
          this.walkParticipant(child);
        } else {
          this.add({
            code: 'UNKNOWN_NODE_TYPE',
            severity: 'error',
            id: child?.id,
            message: `collaboration 下只能直接放 participant，但 id=${child?.id} 的类型是 ${child?.bpmn?.type}`,
            hint: 'collaboration.children 只放 participant；其它节点放进 participant 的 process body。',
          });
        }
      }
      this.walkEdges(top.edges, 'collaboration', null);
    } else if (type === 'process') {
      this.walkProcessBody(top, top.id);
    } else {
      this.add({
        code: 'UNKNOWN_NODE_TYPE',
        severity: 'error',
        id: top?.id,
        message: `顶层节点只能是 collaboration 或 process，但 id=${top?.id} 的类型是 ${type}`,
        hint: '把流程放进 process（单池）或 collaboration（多池）。',
      });
    }
  }

  private walkParticipant(p: any): void {
    this.registerId(p?.id);
    if (typeof p?.id === 'string') {
      // 黑盒池本身可作 messageFlow 端点，故 pool id 进可达集合。
      this.reachable.add(p.id);
      this.poolOf.set(p.id, p.id);
    }
    const children = asArray(p.children);
    const flaggedBlackBox = p?.bpmn?.isBlackBox === true;
    if (flaggedBlackBox) {
      if (p?.bpmn?.processRef || children.length > 0) {
        this.add({
          code: 'BLACKBOX_POOL_HAS_BODY',
          severity: 'error',
          id: p?.id,
          message: `participant ${p?.id} 标记 isBlackBox 但仍带 ${p?.bpmn?.processRef ? 'processRef' : 'children'}`,
          hint: '黑盒池不应有内部结构：要么去掉 isBlackBox 并补全 process body，要么删掉 processRef/children。',
        });
      }
      return; // 黑盒池无内部，不再下钻
    }
    if (children.length === 0) return; // 无 children 视为黑盒，无可校验内部
    // loader 约定：participant 若只裹一层 process，则用内层做 body。pool id 仍归 participant。
    if (children.length === 1 && children[0]?.bpmn?.type === 'process') {
      this.registerId(children[0]?.id); // 内层 process 的 id 也要进重复检测
      this.walkProcessBody(children[0], p.id);
    } else {
      this.walkProcessBody(p, p.id);
    }
  }

  // 注意：body node 的 id 由调用方登记（walkTop / walkParticipant / walkFlowNode），
  // 这里不再 registerId，否则 top-level process 与 subProcess 会被重复计数误报 DUPLICATE_ID。
  private walkProcessBody(node: any, poolId: string): void {
    const children = asArray(node.children);
    const hasLanes = children.some((c) => c?.bpmn?.type === 'lane');
    if (hasLanes && node?.layoutOptions?.['elk.partitioning.activate'] !== true) {
      this.add({
        code: 'LANE_PARTITION_INCOMPLETE',
        severity: 'warning',
        id: node?.id,
        message: `用了泳道但 ${node?.id} 缺 elk.partitioning.activate`,
        hint: '在该 participant/process 的 layoutOptions 上设 "elk.partitioning.activate": true。',
      });
    }
    for (const c of children) {
      if (c?.bpmn?.type === 'lane') {
        this.walkLane(c, poolId);
      } else {
        // 有泳道时，flow node 必须挂进 lane.children，不能直接挂在 body 下。
        this.walkFlowNode(c, poolId, hasLanes);
      }
    }
    this.walkEdges(node.edges, 'process', poolId);
  }

  private walkLane(lane: any, poolId: string): void {
    this.registerId(lane?.id);
    if (lane?.layoutOptions?.['elk.partitioning.partition'] === undefined) {
      this.add({
        code: 'LANE_PARTITION_INCOMPLETE',
        severity: 'warning',
        id: lane?.id,
        message: `lane ${lane?.id} 缺 elk.partitioning.partition`,
        hint: '在该 lane 的 layoutOptions 上设 "elk.partitioning.partition": <序号>，自上而下从 0 递增。',
      });
    }
    for (const c of asArray(lane.children)) {
      if (c?.bpmn?.type === 'lane') {
        this.walkLane(c, poolId); // nested lane
      } else {
        this.walkFlowNode(c, poolId, false);
      }
    }
    // lane 自带 edges 不合规也要抓 messageFlow 错放
    this.walkEdges(lane.edges, 'lane', poolId);
  }

  private walkFlowNode(c: any, poolId: string, mustBeInLane: boolean): void {
    const type = c?.bpmn?.type as string | undefined;
    if (!type) {
      this.registerId(c?.id);
      this.add({
        code: 'CHILD_WITHOUT_TYPE',
        severity: 'error',
        id: c?.id,
        message: `child id=${c?.id} 缺 bpmn.type`,
        hint: '每个节点都要有 bpmn.type，例如 "task" / "startEvent" / "exclusiveGateway"。',
      });
      return;
    }
    if (this.registerId(c?.id)) {
      this.reachable.add(c.id);
      this.poolOf.set(c.id, poolId);
      this.nodeType.set(c.id, type);
    }

    if (type === 'boundaryEvent') {
      const host = typeof c?.attachedToRef === 'string' ? c.attachedToRef : undefined;
      this.add({
        code: 'BOUNDARY_EVENT_IN_CHILDREN',
        severity: 'error',
        id: c?.id,
        message: `boundaryEvent ${c?.id} 出现在 children 里`,
        hint: host
          ? `把 ${c?.id} 从 children 移除，放进宿主节点 ${host} 的 boundaryEvents 数组（${host}.boundaryEvents[]）。`
          : '边界事件不进 children；给它补 attachedToRef 指向宿主，并放进该宿主的 boundaryEvents 数组（host.boundaryEvents[]）。',
      });
      return;
    }

    if (!FLOW_BODY_TYPES.has(type)) {
      this.add({
        code: 'UNKNOWN_NODE_TYPE',
        severity: 'error',
        id: c?.id,
        message: `节点 ${c?.id} 的类型 "${type}" 不在允许集合内`,
        hint: '只能用受支持的 event/task/gateway/subProcess/dataObject/textAnnotation/group 类型。',
      });
      return;
    }

    // artifact（dataObject/textAnnotation/group）不被泳道分区，可合法地停在 body 级，不算 misplaced。
    if (mustBeInLane && !ARTIFACT_TYPES.has(type)) {
      this.add({
        code: 'LANE_NODE_MISPLACED',
        severity: 'error',
        id: c?.id,
        message: `用了泳道，但 ${c?.id} 直接挂在 process body 下而非 lane.children`,
        hint: '存在 lane 时，所有 flow node 必须放进某个 lane 的 children。',
      });
    }

    if (EVENT_TYPES.has(type)) {
      this.checkEventDef(c, type);
    }

    if (type === 'exclusiveGateway') {
      const def = c?.bpmn?.default;
      if (typeof def === 'string' && def.length > 0 && typeof c?.id === 'string') {
        this.exclusiveDefaults.set(c.id, def);
      }
    }

    this.checkIoSpec(c);

    if (SUBPROCESS_TYPES.has(type)) {
      this.walkProcessBody(c, poolId); // subProcess body 递归（执行序最早，结构同 process body）
    }

    for (const be of asArray(c.boundaryEvents)) {
      if (this.registerId(be?.id)) {
        this.reachable.add(be.id);
        this.poolOf.set(be.id, poolId);
        this.nodeType.set(be.id, 'boundaryEvent');
      }
      this.checkEventDef(be, 'boundaryEvent');
    }
  }

  // ioSpecification 的 dataInputs/dataOutputs 出现空/非对象条目时，loader 的 makeFlowNode 会在 .name 上崩、
  // model-builder 也会 throw。提升为前端规则，给出可定位的 id 而非 ICE。
  private checkIoSpec(c: any): void {
    const ioSpec = c?.bpmn?.ioSpecification;
    if (!ioSpec) return;
    for (const key of ['dataInputs', 'dataOutputs'] as const) {
      const list = ioSpec[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        this.add({
          code: 'IO_SPEC_EMPTY_ENTRY',
          severity: 'error',
          id: c?.id,
          message: `${c?.id} 的 ioSpecification.${key} 不是数组`,
          hint: `ioSpecification.${key} 必须是对象数组，每项形如 { id, name }。`,
        });
        continue;
      }
      list.forEach((entry: unknown, i: number) => {
        if (entry === null || typeof entry !== 'object') {
          this.add({
            code: 'IO_SPEC_EMPTY_ENTRY',
            severity: 'error',
            id: c?.id,
            message: `${c?.id} 的 ioSpecification.${key}[${i}] 是空/非对象条目`,
            hint: `删掉该空条目，或补成 { id, name } 形式的对象。`,
          });
        }
      });
    }
  }

  private checkEventDef(node: any, type: string): void {
    if (!EVENT_DEF_REQUIRED.has(type)) return;
    if (!node?.bpmn?.eventDefinitionType) {
      this.add({
        code: 'EVENT_MISSING_EVENT_DEF',
        severity: 'error',
        id: node?.id,
        message: `${type} ${node?.id} 缺 eventDefinitionType`,
        hint: 'catch/boundary 事件必须声明 eventDefinitionType（如 message/timer/error/signal/conditional）。',
      });
    }
  }

  private walkEdges(edges: unknown, container: EdgeContainer, poolId: string | null): void {
    for (const e of asArray(edges) as RawEdge[]) {
      this.registerId(e?.id);
      const id = typeof e?.id === 'string' ? e.id : '<no-id>';
      const type = typeof e?.bpmn?.type === 'string' ? e.bpmn.type : undefined;
      const source = firstString(e?.sources);
      const target = firstString(e?.targets);
      this.edges.push({ id, type, source, target, container, poolId });
      if (type === 'sequenceFlow' && typeof e?.id === 'string') {
        this.sequenceFlowIds.add(e.id);
      }
      if (type === 'messageFlow') {
        if (container !== 'collaboration') {
          this.add({
            code: 'MSGFLOW_NOT_IN_COLLABORATION',
            severity: 'error',
            id,
            message: `messageFlow ${id} 出现在 ${container} 的 edges 里`,
            hint: '跨池 messageFlow 只放在 collaboration.edges；池内连线用 sequenceFlow。',
          });
        }
      } else {
        // 迁移 loader 的 "unknown edge type" / "unknown collaboration edge type" throw，
        // 保证未知/错放的 edge 类型也在 validateGraph 阶段被聚合，而不是构建期单抛。
        const allowed = container === 'collaboration' ? COLLABORATION_EDGE_TYPES : FLOW_EDGE_TYPES;
        if (type === undefined || !allowed.has(type)) {
          this.add({
            code: 'UNKNOWN_EDGE_TYPE',
            severity: 'error',
            id,
            message: `edge ${id} 在 ${container} 里的类型 ${type === undefined ? '缺失' : `"${type}"`} 不被允许`,
            hint:
              container === 'collaboration'
                ? 'collaboration.edges 只放 messageFlow 或 association 类；sequenceFlow 放进对应 participant。'
                : '池内 edges 只放 sequenceFlow 或 association 类；跨池连线用 collaboration 的 messageFlow。',
          });
        }
      }
    }
  }

  private finalize(): void {
    this.reportDuplicates();
    this.reportEdges();
    this.reportExclusiveDefaults();
    this.reportParallelJoins();
  }

  private reportDuplicates(): void {
    for (const [id, count] of this.idSeen) {
      if (count > 1) {
        this.add({
          code: 'DUPLICATE_ID',
          severity: 'error',
          id,
          message: `id "${id}" 在全树出现 ${count} 次`,
          hint: '每个元素 id 必须全局唯一，给重复者改名。',
        });
      }
    }
  }

  private reportEdges(): void {
    // 先统计每个"被引用但不在树里"的端点 id 被多少条边引用：引用越多越像漏声明的枢纽节点，
    // missingEndpointHint 据此把 feedback 导向"补节点"而非"删边"。
    const missingRefCount = new Map<string, number>();
    for (const e of this.edges) {
      for (const side of ['source', 'target'] as const) {
        const ep = e[side];
        if (ep !== undefined && !this.reachable.has(ep)) {
          missingRefCount.set(ep, (missingRefCount.get(ep) ?? 0) + 1);
        }
      }
    }

    for (const e of this.edges) {
      for (const side of ['source', 'target'] as const) {
        const endpoint = e[side];
        if (endpoint === undefined) {
          this.add({
            code: 'EDGE_ENDPOINT_MISSING',
            severity: 'error',
            id: e.id,
            message: `edge ${e.id} 缺 ${side} 端点`,
            hint: `edge.${side === 'source' ? 'sources' : 'targets'} 必须是非空数组，首项指向真实节点 id。`,
          });
        } else if (!this.reachable.has(endpoint)) {
          this.add({
            code: 'EDGE_ENDPOINT_MISSING',
            severity: 'error',
            id: e.id,
            message: `edge ${e.id} 的 ${side} "${endpoint}" 不指向任何已知节点`,
            hint: missingEndpointHint(endpoint, missingRefCount.get(endpoint) ?? 1),
          });
        }
      }
      if (e.type === 'sequenceFlow' && e.source && e.target) {
        const sp = this.poolOf.get(e.source);
        const tp = this.poolOf.get(e.target);
        if (sp !== undefined && tp !== undefined && sp !== tp) {
          this.add({
            code: 'SEQFLOW_CROSS_POOL',
            severity: 'error',
            id: e.id,
            message: `sequenceFlow ${e.id} 两端跨池（${sp} → ${tp}）`,
            hint: 'sequenceFlow 不能跨 participant；跨池请改用 collaboration 里的 messageFlow。',
          });
        }
      }
      // 注意：不校验“association 必须有 artifact 端点”——compensation association（boundary event ↔
      // 补偿处理 activity）是合法的、两端都非 artifact。association-router 的 no-artifact throw 实际只在
      // 真正畸形输入上触发，归为 ICE（由编译边界包装），不在前端拦，否则会误杀合法补偿关联（见 fixture 13）。
    }
  }

  private reportExclusiveDefaults(): void {
    for (const [gwId, def] of this.exclusiveDefaults) {
      if (!this.sequenceFlowIds.has(def)) {
        // 列出该网关真实的出向 sequenceFlow，模型可直接从中挑一个当 default，无需自己猜。
        const outgoing = this.edges
          .filter((e) => e.type === 'sequenceFlow' && e.source === gwId)
          .map((e) => e.id);
        const candidates = outgoing.length > 0 ? outgoing.join(' / ') : '（该网关当前没有任何出向 sequenceFlow）';
        this.add({
          code: 'EXCLUSIVE_DEFAULT_INVALID',
          severity: 'error',
          id: gwId,
          message: `exclusiveGateway ${gwId} 的 default "${def}" 不指向任何 sequenceFlow`,
          hint: `把 default 改成该网关的一条出向 sequenceFlow id；可选：${candidates}。`,
        });
      }
    }
  }

  private reportParallelJoins(): void {
    const inCount = new Map<string, number>();
    const outCount = new Map<string, number>();
    for (const e of this.edges) {
      if (e.type !== 'sequenceFlow') continue;
      if (e.source) outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1);
      if (e.target) inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1);
    }
    const forks: string[] = [];
    let joinCount = 0;
    for (const [id, type] of this.nodeType) {
      if (type !== 'parallelGateway') continue;
      const out = outCount.get(id) ?? 0;
      const inn = inCount.get(id) ?? 0;
      if (out > 1 && inn <= 1) forks.push(id);
      if (inn > 1) joinCount += 1;
    }
    // WHY 仅在"完全没有 join 网关"时告警：balanced fork/join 是常态，避免在合法图上刷屏。
    // 全是 fork、一个 join 都没有，才是高度可疑的"分叉未收束"。
    if (forks.length > 0 && joinCount === 0) {
      for (const id of forks) {
        this.add({
          code: 'PARALLEL_JOIN_MISSING',
          severity: 'warning',
          id,
          message: `parallelGateway ${id} 有多条 fork 出向，但全图没有任何 parallelGateway 做 join`,
          hint: '并行分支通常应由一个 parallelGateway 收束（join）；确认是否漏了汇合网关。',
        });
      }
    }
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 静态校验一份 ELK-BPMN graph，返回全部 issue（空数组 = 通过）。
 * error 阻断（不该进布局）；warning 不阻断（可疑但能画）。同步、无副作用、不依赖 ELK。
 *
 * profile 默认 'generation'（最严，面向 LLM 生成的 JSON）；relayout 路径传 'relayout' 跳过生成专属规则。
 */
export function validateGraph(
  rawJson: unknown,
  options: { profile?: ValidationProfile } = {},
): ValidationIssue[] {
  if (!isRecord(rawJson)) {
    return [{
      code: 'INVALID_GRAPH_ROOT',
      severity: 'error',
      message: 'graph 必须是 BPMN definitions 对象',
      hint: '顶层应是 { id, children: [...] } 的对象。',
    }];
  }
  if (!Array.isArray(rawJson.children)) {
    return [{
      code: 'MISSING_CHILDREN',
      severity: 'error',
      id: typeof rawJson.id === 'string' ? rawJson.id : undefined,
      message: 'graph 缺 children 数组',
      hint: '顶层 definitions 必须含 children（collaboration / process 列表）。',
    }];
  }
  const v = new Validator(options.profile ?? 'generation');
  v.run(rawJson);
  return v.issues;
}

function formatIssueLine(issue: ValidationIssue): string {
  const where = issue.id ? ` (id=${issue.id})` : '';
  const fix = issue.hint ? ` 修复: ${issue.hint}` : '';
  return `- [${issue.code}]${where} ${issue.message}.${fix}`;
}

/**
 * 把 validateGraph 的结果格式化成一段可直接回喂给 LLM 的中文 feedback。
 * WHY 收进包内：保证消费侧每次喂给模型的结构一致、不漂移；error 与 warning 分组，
 * 顶部给明确指令（逐条修正后重输完整 graph），让模型能照着 code+id+hint 确定性自纠。
 *
 * 无 error 也无 warning → 返回 ''（消费侧据此判断"通过、无需回喂"）。
 */
export function formatIssuesForFeedback(issues: ValidationIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (errors.length === 0 && warnings.length === 0) return '';

  const blocks: string[] = [];
  if (errors.length > 0) {
    blocks.push(
      `你上一版 graph 有 ${errors.length} 处结构错误（必须全部修正，否则无法进入布局）。` +
        `请逐条修正后重新输出**完整** graph（不要只输出片段或 diff）：`,
      errors.map(formatIssueLine).join('\n'),
    );
  }
  if (warnings.length > 0) {
    blocks.push(
      `另有 ${warnings.length} 处警告（不阻断，但建议确认是否符合本意）：`,
      warnings.map(formatIssueLine).join('\n'),
    );
  }
  return blocks.join('\n\n');
}
