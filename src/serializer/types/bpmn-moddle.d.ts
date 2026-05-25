declare module 'bpmn-moddle' {
  interface ModdleElement {
    $type: string;
    id?: string;
    [key: string]: unknown;
  }

  interface ToXMLResult {
    xml: string;
  }

  interface FromXMLResult {
    rootElement: ModdleElement;
    warnings: Error[];
  }

  interface ToXMLOptions {
    format?: boolean;
    preamble?: boolean;
  }

  class BpmnModdle {
    constructor();
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    fromXML(xml: string): Promise<FromXMLResult>;
    toXML(element: ModdleElement, options?: ToXMLOptions): Promise<ToXMLResult>;
  }

  export default BpmnModdle;
}
