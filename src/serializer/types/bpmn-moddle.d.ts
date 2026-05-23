declare module 'bpmn-moddle' {
  interface ModdleElement {
    $type: string;
    id?: string;
    [key: string]: unknown;
  }

  interface ToXMLResult {
    xml: string;
  }

  interface ToXMLOptions {
    format?: boolean;
    preamble?: boolean;
  }

  class BpmnModdle {
    constructor();
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(element: ModdleElement, options?: ToXMLOptions): Promise<ToXMLResult>;
  }

  export default BpmnModdle;
}
