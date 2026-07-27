// input:  rate-limit view-model, live hook, and shared status components
// output: public rate-limit feature surface for desktop and mobile shells
// pos:    Feature barrel for active-only provider throttle status
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export { buildRateLimitView, formatRateLimitCountdown, type RateLimitView } from './rate-limit-vm';
export { useRateLimitStatus } from './useRateLimitStatus';
export {
  DesktopRateLimitStatus,
  MobileRateLimitStatus,
  MobileRateLimitSheet,
  RateLimitDetails,
} from './RateLimitStatus';
