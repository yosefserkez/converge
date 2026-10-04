// Converge setup: types for bindings that the operator adds to wrangler.toml.
// worker-configuration.d.ts is generated and protected, so this file extends Env.
declare namespace Cloudflare {
  interface Env {
    VIEW_COUNTER: DurableObjectNamespace<import("./storage/viewCounter.js").ViewCounter>
  }
}
