# On Behalf

One household running another household's admin, on Alexa+.

An adult child books the plumber. The older relative asks their own Echo "when is the
plumber coming", and says "I need to move it". On Behalf moves it and writes to both
homes. The relative can ask what has been changed at their house, and can end the whole
arrangement from their own speaker without going through anybody.

It is a self-hosted MCP add-on on Streamable HTTP, spec revision 2025-11-25, plus a
console that does everything the speaker does with your hands instead.

Licence: MIT. See `SPEC.md` for the design and the platform constraints it was built
inside.

## Running it

Node 24 or later. No build step: the TypeScript runs directly.

```bash
npm install
npm run seed -- --story     # two homes, 16 trades, one arrangement, two things waiting
npm run demo                # the whole story, end to end, over the real protocol
npm run console             # the touch surface at http://localhost:4173
npm run mcp                 # the MCP server at http://localhost:4180/mcp
npm run bench               # the round-trip measurement
npm test                    # 294 tests, 9 skipped
```

`npm run demo` needs nothing running first. It starts its own server on a spare port,
connects two MCP clients with two different bearer tokens, and drives every step
through tool calls. Nothing in it reaches into the database to make something true.

To watch it work with the network unplugged:

```bash
STANDBY_NO_MODEL=1 npm run demo
```

Every Bedrock call then takes its fallback path and says so on screen. The demo is the
same length either way.

### The console

`npm run console`, then open `http://localhost:4173` and link an account. There are two:
Marian at Ridgeway, who is being helped, and Nadia at Calder Street, who is helping.
Signing in runs the real authorization code exchange with PKCE S256 against this
server, the same grant the Alexa+ MCP Toolkit requires. The only thing standing in for
Amazon is the consent screen itself.

Things worth clicking:

- **Both homes** puts one household either side of the spine with a shared timeline.
- **The diary**, viewed as Marian, is served in large type with large targets.
- **Waiting** is anything that needs somebody at home to agree.
- **Arrangement** is where terms are set, and where Marian can pause or end it.
  Describing an arrangement in one sentence goes through Bedrock.
- **Decisions** is what is held for Nadia, with "Prepare the reasoning", which is the
  second Bedrock call.
- **Ledger** is every action at a household, who took it, through which surface, and
  under which capability. It downloads as CSV.
- **Written channel** shows every message On Behalf has sent, in full, including retries.

## What is mocked, and where the boundary is

Three things, each marked in the code and on screen.

| Mocked | Where | What is real |
|---|---|---|
| The provider directory and their free times | `src/domain/availability.ts`, `src/seed.ts` | The booking, cancellation and rescheduling logic above it. Availability is a hash of the provider and the date, so the same Thursday comes back on every run and the demo is reproducible. |
| The mail and SMS transport | `src/domain/outbox.ts` | The messages. `deliver()` writes each one to `data/outbox/` as a file you can open, and the retry path is exercised by `STANDBY_OUTBOX_FAIL`. |
| Amazon's own consent screen | `src/web/server.ts` | The OAuth 2.1 authorization code grant underneath it, with PKCE S256 enforced, single-use codes and rotating refresh tokens. |

Nothing else is mocked. The MCP server, the transport, the protocol revision, the
capability engine, the ledger and the three Bedrock calls are all doing the thing they
appear to be doing.

## The model

Bedrock in `us-east-1`, with the region and the credentials taken from the environment;
On Behalf holds no account number and needs none. It tries `us.anthropic.claude-sonnet-5`
first and falls back through `us.anthropic.claude-sonnet-4-6` and
`us.anthropic.claude-sonnet-4-5-20250929-v1:0`. Sonnet 5 appears in our own
model and inference profile listings and still returns AccessDenied on invoke, so it
stays at the head of the chain: the day entitlement lands, On Behalf uses it without a
code change.

The model is used in three places, none of them on the voice path:

1. turning a sentence into a draft arrangement, which the other household then has to
   accept;
2. arguing a request that is held for a decision, which the deciding code never reads;
3. writing the handover note, which is the only thing that can reach somebody who is
   not currently speaking to a device.

Each has a deadline, a model chain and a fallback that produces a usable result without
the network. `STANDBY_NO_MODEL=1` forces every fallback, and the tests run that way.

## The two structural tests

These are the ones worth reading first.

`tests/no-model-on-read-path.test.ts` walks the import graph from the MCP server and
fails if anything under `src/bedrock/`, or any `@aws-sdk/` import, becomes reachable
from a tool handler. The MCP Toolkit requires a round trip under 500 ms and a model
call cannot promise that, so the rule is enforced rather than remembered.

`tests/touch-parity.test.ts` walks the tool registry against the running console and
fails if a tool exists that a person cannot reach with their hands, if any page carries
a script tag, or if a page is only reachable by typing a URL. Amazon's accessibility
guidance requires the whole experience to be completable touch only.

## Measured round trip

`npm run bench`, on this machine, through a real MCP client over Streamable HTTP, with
the server building a fresh `McpServer` per request so the figures are cold:

```
tool                      p50      p95      p99      max      
get_visits                3.3      5.3      9.4      11.1     
what_is_waiting           1.2      1.7      3.6      4.2      
what_changed              2.2      3.1      4.3      4.7      
request_change            4.8      6.3      7.7      8.0      
on_behalf_status          1.2      2.1      4.7      17.6     
list_on_behalf_households 1.6      2.0      5.0      6.6      
find_provider             4.2      4.9      6.9      6.9      
pending_decisions         0.8      1.0      1.3      3.5      

worst p95 across all tools: 6.3 ms, which is 1.3 percent of the budget
```

`tests/latency.test.ts` runs the same harness and fails the suite if the worst p95 goes
over a fifth of the budget, so the headroom is defended rather than noted.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `STANDBY_DB` | `data/standby.db` | Where the database lives. |
| `STANDBY_OUTBOX_DIR` | `data/outbox` | Where delivered messages are written. |
| `STANDBY_OUTBOX_FAIL` | unset | The fake transport rejects any recipient containing this, twice, then succeeds. Used to exercise the retry path. |
| `STANDBY_NO_MODEL` | unset | `1` forces every Bedrock fallback. |
| `STANDBY_MODELS` | the chain above | Comma separated model preference order. |
| `STANDBY_MODEL_TIMEOUT_MS` | `12000` | Deadline on each model call. |
| `PORT` | `4180` | The MCP server. |
| `CONSOLE_PORT` | `4173` | The console. |
| `AWS_REGION` | `us-east-1` | Bedrock region. |

## What this does not do

No health arrangements of any kind, and it cannot be configured to. There is no health
category, the list cannot be extended to one, and free text containing health terms is
refused at the boundary with a reason. Policy Requirement 13 governs health content and
the Alexa+ permissions model has no documented way for one customer to consent on
another's behalf, so a medical variant would be rejected. It is also the most affecting
demo available, and it is not in here on purpose.

It does not identify who is speaking, because the platform cannot. It does not book
anything real. It cannot tell you anything until you ask, except in writing, because an
Alexa+ add-on cannot speak first.
