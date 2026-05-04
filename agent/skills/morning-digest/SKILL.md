# Morning Digest

Compose a daily digest of notebook activity for the group chat.

## Instructions

1. Search the notebook for entries from the past 24 hours: `router_search` with `since: "24h"`
2. Use web search to find news relevant to what people are working on
3. Write the digest following the format and constraints below
4. Post it to the group chat

## Format

Exactly 3 paragraphs. Each paragraph:
- Covers one person's entry or contribution
- 2-3 sentences max (NEVER 4)
- Contains a linked source — a news item, blog post, paper, or product launch found via web search
- Stands completely alone — no bridging between paragraphs ("rhymes with," "converges with," "same problem from a different angle")

After the 3 paragraphs, add a question that reframes one specific topic from the digest.

## Voice

Short declarative sentences. Let facts land. No throat-clearing.

Embed search results as facts with links, not as "I searched and found."

The question should reframe something, not ask what they plan to do next.

## Good Example

@bob is spec'ing agent sandboxes — a third of a CPU core, 2-4GB RAM, no GPU. Docker shipped microVM support in Desktop 4.40 last month, built on Firecracker. Rivet already reverse-engineered the API and published an SDK for orchestrating coding agents inside them: https://rivet.gg/blog/docker-microvm-sdk

@carol's ZK pipeline finally verifies end-to-end. Four bugs stacked — the last was a P-256 curve point that serialized differently in the circuit than in the test harness. Polygon shipped their Type 1 ZK prover to mainnet last Tuesday — it proves unmodified Ethereum blocks: https://polygon.technology/blog/type-1-prover

@dan is building a vibroacoustic art car. Subwoofers mounted to the chassis so you feel the music through the frame. He's tuning resonance frequencies to specific body parts.

Stripe's agents fail on timeouts. Your resilience layer retries on timeouts. But what should an agent do when a timeout means the downstream service succeeded and just didn't respond?

## Bad Examples (DO NOT do these)

BAD — no news, forces connections:
"@alice's capability-based auth is converging with your visibility model in interesting ways. Both of you are grappling with the fundamental question of who can do what."

BAD — throat-clearing, no new information:
"Let's look at what's been happening. @carol finally got her ZK pipeline working, which is a significant milestone that speaks to the broader challenge of moving zero-knowledge proofs from theory to production."

BAD — vague question, over-synthesis:
"With @alice on auth, @bob on sandboxes, and you on visibility, the entire community seems to be converging on a unified theory of trust. Where do you think this is all heading?"

BAD — bridging between paragraphs:
"@alice shipped capability-based auth. Your `to` field is the same problem from a different angle."

## Constraints

- Use 2-5 web searches to find relevant real-world context
- Format links as plain URLs (not markdown) for Telegram compatibility
- Keep it under 800 characters total so it reads well on mobile
- No emoji unless the community has asked for them
