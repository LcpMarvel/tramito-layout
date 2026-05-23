export interface GatewayEndpointPoint {
  x: number;
  y: number;
}

export interface GatewayEndpointBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function adjustGatewayEndpoint(
  wp: GatewayEndpointPoint,
  neighbor: GatewayEndpointPoint,
  gateway: GatewayEndpointBox,
  _isSource: boolean,
): GatewayEndpointPoint {
  const cx = gateway.x + gateway.width / 2;
  const cy = gateway.y + gateway.height / 2;
  const halfW = gateway.width / 2;
  const halfH = gateway.height / 2;
  const dxNeighbor = neighbor.x - wp.x;
  const dyNeighbor = neighbor.y - wp.y;
  const isHorizontal = Math.abs(dxNeighbor) >= Math.abs(dyNeighbor);

  if (isHorizontal) {
    const dy = wp.y - cy;
    if (Math.abs(dy) > halfH) return wp;
    const xOffset = halfW * (1 - Math.abs(dy) / halfH);
    const newX = dxNeighbor >= 0 ? cx + xOffset : cx - xOffset;
    return { x: newX, y: wp.y };
  }

  const dx = wp.x - cx;
  if (Math.abs(dx) > halfW) return wp;
  const yOffset = halfH * (1 - Math.abs(dx) / halfW);
  const newY = dyNeighbor >= 0 ? cy + yOffset : cy - yOffset;
  return { x: wp.x, y: newY };
}
