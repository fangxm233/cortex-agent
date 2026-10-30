/**
 * Which gateway.yaml modes serve which engine route.
 *
 * gateway.yaml groups modes by section, and the `anthropic` section is shared. Claude Code uses
 * it for `plan`, `api`, hand-added relays and Anthropic-protocol custom providers. PI's built-in
 * `anthropic` provider owns exactly one mode there, `pi-anthropic`, so its traffic, quota and rate
 * limits stay apart from Claude Code's even when both are signed in to Anthropic. Every other PI
 * provider owns the section named after it, with the mode of the same name.
 */

export const ANTHROPIC_ENDPOINT = 'anthropic';
export const PI_ANTHROPIC_MODE = 'pi-anthropic';

export interface GatewayRouteRef {
  backend: 'claude' | 'pi';
  provider: string | null;
}

type SectionMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The gateway.yaml section a route's modes live in; null for a PI route with no provider. */
export function gatewayEndpointFor(ref: GatewayRouteRef): string | null {
  return ref.backend === 'claude' ? ANTHROPIC_ENDPOINT : ref.provider;
}

/** The mode PI's generated route for `provider` is written under. */
export function piGatewayMode(provider: string): string {
  return provider === ANTHROPIC_ENDPOINT ? PI_ANTHROPIC_MODE : provider;
}

/** The modes of the route's section that serve it, in declaration order. */
export function routeModes(ref: GatewayRouteRef, sectionModes: readonly string[]): string[] {
  if (gatewayEndpointFor(ref) !== ANTHROPIC_ENDPOINT) return [...sectionModes];
  const forPi = ref.backend === 'pi';
  return sectionModes.filter((mode) => (mode === PI_ANTHROPIC_MODE) === forPi);
}

/** The declared modes serving `ref` in a parsed gateway.yaml endpoint map. */
export function gatewayRouteModes(endpoints: SectionMap | null | undefined, ref: GatewayRouteRef): string[] {
  const endpoint = gatewayEndpointFor(ref);
  if (!endpoint) return [];
  return routeModes(ref, Object.keys(endpoints?.[endpoint] ?? {}));
}
