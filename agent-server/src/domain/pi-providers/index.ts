// input:  custom provider model, stores and service modules
// output: the public custom PI provider API
// pos:    Entry point of the PI provider domain
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export {
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_NAME_RE,
  GATEWAY_PLACEHOLDER_KEY,
  customProviderBaseUrl,
  gatewayAuthStyle,
  gatewayEndpoint,
  validateCustomProvider,
  type CustomProviderApi,
  type CustomProviderInput,
  type CustomProviderIssue,
  type CustomProviderModelSpec,
} from './custom-provider-model.js';

export {
  USER_PI_MODELS_PATH,
  isCustomProviderEntry,
  readCustomProviderEntries,
  readProvidersBlock,
} from './models-json-store.js';

export { GATEWAY_CONFIG_PATH, type GatewayRouteSpec } from './gateway-route-store.js';

export {
  defaultCustomProviderStores,
  getCustomProvider,
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProviderFailure,
  type CustomProviderRemoval,
  type CustomProviderResult,
  type CustomProviderStores,
  type CustomProviderView,
} from './custom-provider-service.js';
