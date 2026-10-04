import { DurableObject } from "cloudflare:workers"

// Converge setup: Durable Object for the VIEW_COUNTER binding. The storage task
// implements it. Use one object per paste (for example idFromName(pasteName)).
// A Durable Object processes its requests one at a time and its storage is
// strongly consistent, so a view count kept here cannot be read stale.
export class ViewCounter extends DurableObject<Env> {}
