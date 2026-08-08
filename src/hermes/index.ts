// mupot — Hermes constant-agent barrel (Port 3).
export {
  handleHermesTurn,
  HERMES_ADAPTER,
  HERMES_CAPABILITIES,
  HERMES_DEFAULT_SQUAD_ID,
  HERMES_GATE_OWNER,
  HERMES_OPUS_AGENT_SLUG,
  type HermesChatInput,
  type HermesChatResult,
  type HermesConstantDeps,
} from './constant'
export {
  classifyHermesTurn,
  HERMES_TIER_MODELS,
  parseSolAction,
  stripSolActionTrailer,
  type HermesRouteDecision,
  type HermesTier,
  type SolAction,
} from './model-route'
export { hermesApp, HERMES_CHAT_MAX_CHARS } from './routes'
