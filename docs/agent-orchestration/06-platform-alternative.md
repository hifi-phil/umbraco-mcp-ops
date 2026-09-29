# 6. Platform alternative: Azure

[← Previous: Technical elements](05-technical-elements.md) | [Index](00-index.md) | [Next: Build phases →](07-build-phases.md)

---

The design is platform-agnostic. The transition table and reducer are pure
logic and don't know what they run on, so this is a hosting decision rather
than an architectural one.

Azure has a closer match to the Durable Object than anything else does.

| Cloudflare | Azure |
|---|---|
| Worker | Azure Function, HTTP trigger |
| Durable Object per issue | **Durable Entity** per issue |
| DO alarm | Durable Functions timer / delayed signal |
| D1 | Azure SQL, or Table Storage for an append-only log |
| Worker secrets | Key Vault or app settings |

Durable Entities are the same concept as a DO — an addressable object with
state, guaranteed to process one operation at a time. `Entity("issue",
"412")` gives us per-issue serialisation for free. Both are the actor model.

## Pros

**It's a .NET shop.** Written in C#, colleagues can read and maintain it. A
TypeScript Worker is something only one person owns. This is the strongest
argument and it isn't technical.

**House platform.** Azure is already familiar territory, with existing
answers for Entra ID, procurement and compliance questions. (No claims about
data residency without checking current DPA terms.)

**Orchestrations as well as entities.** If a node later needs to be genuinely
multi-step and deterministic, Durable Functions has somewhere to put it.

## Cons

**More ceremony.** Durable Functions needs a storage account for its own
state — another thing to provision and understand. Cloudflare's equivalent is
one `wrangler.toml`.

**Cold starts** on the Consumption plan. Not a real problem for webhooks, but
occasionally a couple of seconds.

**Costs more** than the $5/month floor, though still small. Harder to reason
about than a flat minimum.

**Heavier local dev** — storage emulator and tooling, versus `wrangler dev`.

## Recommendation

Choose on who maintains it, not on the platform. If this becomes a
team-owned system, Azure and C# is probably right despite being slightly more
work.

Either way it doesn't block starting. Nothing in Phases 1–3 is
platform-specific, and shadow mode can run as a plain GitHub Action before
either platform is picked — see [07-build-phases.md](07-build-phases.md).

---

[Next: 07 — Build phases →](07-build-phases.md)
