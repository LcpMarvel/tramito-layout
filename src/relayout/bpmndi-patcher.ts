import type { DiagramModel, EdgeModel, ShapeModel } from '../serializer/transform/model-types.ts';

const BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';
const DC_NS = 'http://www.omg.org/spec/DD/20100524/DC';
const DI_NS = 'http://www.omg.org/spec/DD/20100524/DI';

export function patchBpmndi(xml: string, diagram: DiagramModel, semanticIds: ReadonlySet<string>): string {
  const fragment = renderDiagram(diagram, semanticIds);
  const withoutDiagrams = removeExistingDiagrams(xml);
  const withNamespaces = ensureDefinitionsNamespaces(withoutDiagrams);
  return insertDiagram(withNamespaces, fragment);
}

function renderDiagram(diagram: DiagramModel, semanticIds: ReadonlySet<string>): string {
  const shapes = diagram.plane.shapes.filter((shape) => semanticIds.has(shape.bpmnElement));
  const edges = diagram.plane.edges.filter((edge) => semanticIds.has(edge.bpmnElement));
  const lines = [
    `  <bpmndi:BPMNDiagram id="${escapeAttr(diagram.id)}" name="${escapeAttr(diagram.name)}">`,
    `    <bpmndi:BPMNPlane id="${escapeAttr(diagram.plane.id)}" bpmnElement="${escapeAttr(diagram.plane.bpmnElement)}">`,
    ...shapes.flatMap((shape) => renderShape(shape)),
    ...edges.flatMap((edge) => renderEdge(edge)),
    '    </bpmndi:BPMNPlane>',
    '  </bpmndi:BPMNDiagram>',
  ];
  return lines.join('\n');
}

function renderShape(shape: ShapeModel): string[] {
  const attrs = [
    `id="${escapeAttr(shape.id)}"`,
    `bpmnElement="${escapeAttr(shape.bpmnElement)}"`,
  ];
  if (shape.isExpanded !== undefined) attrs.push(`isExpanded="${shape.isExpanded ? 'true' : 'false'}"`);
  if (shape.isHorizontal !== undefined) attrs.push(`isHorizontal="${shape.isHorizontal ? 'true' : 'false'}"`);
  const lines = [
    `      <bpmndi:BPMNShape ${attrs.join(' ')}>`,
    `        ${renderBounds(shape.bounds)}`,
  ];
  if (shape.label?.bounds) {
    lines.push('        <bpmndi:BPMNLabel>');
    lines.push(`          ${renderBounds(shape.label.bounds)}`);
    lines.push('        </bpmndi:BPMNLabel>');
  }
  lines.push('      </bpmndi:BPMNShape>');
  return lines;
}

function renderEdge(edge: EdgeModel): string[] {
  const lines = [
    `      <bpmndi:BPMNEdge id="${escapeAttr(edge.id)}" bpmnElement="${escapeAttr(edge.bpmnElement)}">`,
    ...edge.waypoints.map((point) => `        <di:waypoint x="${formatNumber(point.x)}" y="${formatNumber(point.y)}" />`),
  ];
  if (edge.label?.bounds) {
    lines.push('        <bpmndi:BPMNLabel>');
    lines.push(`          ${renderBounds(edge.label.bounds)}`);
    lines.push('        </bpmndi:BPMNLabel>');
  }
  lines.push('      </bpmndi:BPMNEdge>');
  return lines;
}

function renderBounds(bounds: { x: number; y: number; width: number; height: number }): string {
  return `<dc:Bounds x="${formatNumber(bounds.x)}" y="${formatNumber(bounds.y)}" width="${formatNumber(bounds.width)}" height="${formatNumber(bounds.height)}" />`;
}

function removeExistingDiagrams(xml: string): string {
  // 注释/CDATA 里出现 </BPMNDiagram> 文本会把非贪婪正则提前截断，留下半截标签。
  // 先在搜索副本里把这些段替成等长空白，再按 index 从原文删除真正的 BPMNDiagram 节点。
  const searchable = maskCommentsAndCdata(xml);
  const re = /\s*<(?:[A-Za-z_][\w.-]*:)?BPMNDiagram\b[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?BPMNDiagram>/g;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(searchable)) !== null) {
    out += xml.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  out += xml.slice(cursor);
  return out;
}

function maskCommentsAndCdata(xml: string): string {
  let out = '';
  let i = 0;
  while (i < xml.length) {
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      const stop = end === -1 ? xml.length : end + 3;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      const stop = end === -1 ? xml.length : end + 3;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += xml[i]!;
    i++;
  }
  return out;
}

function ensureDefinitionsNamespaces(xml: string): string {
  const match = /<([A-Za-z_][\w.-]*:)?definitions\b([^>]*)>/m.exec(xml);
  if (!match) throw new Error('[relayout] BPMN XML is missing a definitions root element');
  const full = match[0]!;
  const additions: string[] = [];
  if (!/\sxmlns:bpmndi\s*=/.test(full)) additions.push(`xmlns:bpmndi="${BPMNDI_NS}"`);
  if (!/\sxmlns:dc\s*=/.test(full)) additions.push(`xmlns:dc="${DC_NS}"`);
  if (!/\sxmlns:di\s*=/.test(full)) additions.push(`xmlns:di="${DI_NS}"`);
  if (additions.length === 0) return xml;
  const replacement = full.replace(/>$/, ` ${additions.join(' ')}>`);
  return xml.slice(0, match.index) + replacement + xml.slice(match.index + full.length);
}

function insertDiagram(xml: string, fragment: string): string {
  const closing = /<\/([A-Za-z_][\w.-]*:)?definitions>\s*$/m.exec(xml);
  if (!closing) throw new Error('[relayout] BPMN XML is missing a closing definitions tag');
  return `${xml.slice(0, closing.index).trimEnd()}\n${fragment}\n${xml.slice(closing.index)}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`[relayout] cannot serialize non-finite DI coordinate ${value}`);
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
