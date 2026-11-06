// Shared raincode gateway adapter core, used by both
// dsh-plugins-raincode-skill and dsh-plugins-raincode-routing.

export {
  RaincodeAdapter,
  type RaincodeConnectionOptions,
  type RaincodeAdapterOptions,
  type RaincodeModel,
} from './adapter.js'

export { readLiveConfig, resolveSettingsNamespace, volatileField, liveValue } from './live.js'

export { serializeRequest } from './serialize.js'
export { translate, mapFinishReason, mapUsage } from './translate.js'
export { parseSse } from './sse.js'

export {
  acquireGatewayManager,
  createGatewayManager,
  defaultProfileFor,
  gatewayBin,
  isLoopbackBaseURL,
  pluginRegistryPath,
  readDshCurrentModel,
  syncProfiles,
  writeRegistry,
  type RaincodeProfile,
} from './gateway.js'