# Friction log — On Behalf

Rows written at the moment they happened, in order. Nothing here was reconstructed at
the end of the build.

The table is the toolchain. The four sections under it are the Alexa+ platform
boundaries, and they needed more room than a table cell. Those four are the ones worth
reading if you work on the add-on toolkit rather than on this app.

| # | Task attempted | Steps taken | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|---|
| 1 | Call the model named in our own build brief as live and verified: `anthropic.claude-sonnet-5` on Bedrock, us-east-1 | `aws sts get-caller-identity` (fine), `aws bedrock list-foundation-models --region us-east-1 --query "modelSummaries[?contains(modelId,'sonnet-5')].modelId"` returned `anthropic.claude-sonnet-5`, then `aws bedrock-runtime invoke-model --model-id anthropic.claude-sonnet-5` | An inference call, since the model is in the account's own catalogue listing | `AccessDeniedException: anthropic.claude-sonnet-5 is not available for this account.` `aws bedrock list-inference-profiles` also returns `us.anthropic.claude-sonnet-5` and `global.anthropic.claude-sonnet-5`, and both fail the same way. Two listing APIs, one entitlement, and the listings do not carry it | Medium (25 min, and it would have been an hour if the error had been less specific) | Probed the inference profile list by hand. `us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-sonnet-4-5-20250929-v1:0` both answer in about 1.5s. On Behalf ships a model preference chain that tries Sonnet 5 first and falls to 4.6, so the build upgrades itself the day access lands | `ListFoundationModels` and `ListInferenceProfiles` both return models the calling account cannot invoke, with nothing in either response distinguishing them. Add an `accessStatus` field to both, or support filtering on entitlement. Today the only way to know what you can call is to call all of them, and the answer arrives at runtime. Worth Amazon knowing this is not a one-off: every Bedrock-calling build we've made hits the identical shape — `anthropic.claude-sonnet-5` lists cleanly and fails closed at invoke time, not just here |
| 2 | Confirm which MCP protocol revision the TypeScript SDK negotiates, because the Alexa+ MCP Toolkit track requires spec 2025-11-25 or later | `npm i @modelcontextprotocol/sdk@^1.30.0`, then grepped `dist/esm/types.js` for the constant | The version to be stated in the package README or the installed package metadata | Not in the README. Found it only as `export const LATEST_PROTOCOL_VERSION = '2025-11-25'` inside a compiled `dist` file. `SUPPORTED_PROTOCOL_VERSIONS` is in the same file and is the list that actually matters for negotiation | Low (10 min) | Read the constant out of `dist/esm/types.js` and pinned a test that asserts the negotiated version on a live initialize handshake, so a dependency bump that drops the revision fails the suite rather than failing certification | Put the supported protocol revisions in `package.json` (an `mcp.protocolVersions` field) or in the package README. A developer shipping against a platform that mandates a specific revision should not have to read compiled output to find out which one they have |
| 3 | Write the app's error classes the ordinary TypeScript way and run it on Node's native TypeScript runtime, with no build step | `class StandbyError extends Error { constructor(readonly code: string, message: string) {...} }`, then `node src/mcp/server.ts` | It to run. Node has executed TypeScript directly since 23, and the brief asks for Node 24 | Constructor parameter properties are not erasable syntax, so the type-stripping runtime rejects them. `tsc` only surfaces it if you have set `erasableSyntaxOnly`, which is not a default, so a project can typecheck clean and fail at runtime | Medium (30 min across six classes) | Set `"erasableSyntaxOnly": true` in tsconfig so the compiler catches it, then wrote each field out as a declaration plus an assignment | The gap is that `erasableSyntaxOnly` is off by default while `node file.ts` is on by default. Either make the flag default on when `module` is `NodeNext`, or have `tsc --init` set it. The failure otherwise lands at runtime in the one place a type checker was supposed to cover |
| 4 | Find out which MCP tool-registration API to use on `@modelcontextprotocol/sdk` 1.30.0 | Opened `dist/esm/server/mcp.d.ts` and read from the top | The first `tool(...)` signature in the file to be the current one | Six `tool(...)` overloads appear first, every one carrying `@deprecated Use registerTool instead` in a JSDoc comment. `registerTool`, the one you want, is below all of them. In the same file, the doc comment for the overloads explains that TypeScript "cannot reliably disambiguate between ToolAnnotations and ZodRawShapeCompat", which is a warning that the API shape is ambiguous by construction | Low (15 min) | Grepped for `registerTool` and used that | Order the declarations so the supported API comes first, and remove the deprecated overloads at the next major. An agent or a new developer reading top to bottom lands on the deprecated call every time |
| 5 | Run a request-scoped MCP server on Streamable HTTP, where the account a turn belongs to arrives in the `Authorization` header | Read `server/streamableHttp.d.ts`, built one `McpServer` and one transport per request with `sessionIdGenerator: undefined` | The stateless path to be documented as the shape to use when authorization is per request | The class doc explains stateful and stateless modes in terms of session IDs and nothing else. Neither mode is described in terms of where per-request credentials go, and the only mention of auth is an `AuthInfo` import. The working pattern (a fresh server per request, closing both on `res.close`) had to be assembled from the type declarations | Medium (40 min) | Fresh `McpServer` plus transport per request, both closed on response close. Measured the cost: p95 4.4 ms including construction, comfortably inside the 500 ms round trip the MCP Toolkit docs ask for | Add one worked example to the Streamable HTTP docs for "authorization arrives per request", which is the normal case for any hosted MCP server and the exact case the Alexa+ MCP Toolkit puts you in. It is the first question anyone building against account linking has |
| 6 | Use `node:sqlite` as the store so the app has no database dependency | `new DatabaseSync(path)`, prepared statements, `.all()` | Plain objects back from a query | Rows come back with a null prototype, so `{...row}` works but `row.hasOwnProperty`, spread into a class, and anything that walks the prototype chain does not. Also an `ExperimentalWarning` on every process start, which is noise in a demo | Low (20 min) | One `rows<T>()` helper that copies each row into an ordinary object, and `--no-warnings` on every script | The null prototype is defensible, but it deserves a line in the `node:sqlite` docs next to `.all()` rather than being something you find by printing an object |
| 7 | Get a reproducible demo out of scheduling code | First cut generated provider availability randomly, so every run of the demo offered different days and every test that touched a slot was flaky | A demo that looks the same twice | It did not, and one test failed about one run in four | Medium (35 min, most of it chasing the flake rather than fixing it) | Availability became a hash of the provider id and the calendar day, so the same provider offers the same slots on the same date on every run, in every test and in the demo. The seed and the demo now share one code path | Not a platform issue. Recorded because it is the single change that made the rest of the build tractable: a demo you can rerun in front of somebody is worth more than one that is merely correct |
| 8 | Show a booking time that is honest for two households in different US timezones | Formatted times with `Intl.DateTimeFormat` against the household's own timezone throughout, then wrote a test that the same instant is a different local hour in each home | The notice window and the agreed hours to just work | They did, but only after moving three separate helpers behind one clock module. The first version compared `getUTCDay()` against a weekday the user had named, which is correct for US timezones and silently wrong east of Greenwich | Low (25 min) | One `clock.ts` that everything reads the time through, and `weekdayIndex()` that asks `Intl` rather than doing UTC arithmetic. The capability engine test now asserts the timezone behaviour explicitly | The MCP Toolkit ships in the United States only, which makes it easy to write date code that is accidentally right. Amazon's own scheduling guidance could say "format in the customer's timezone, never the server's", because a hackathon build will otherwise be one deployment away from being wrong |

---

## The add-on cannot speak first, and that is most of the product ideas gone

**Task.** Work out whether On Behalf could tell a household that a contractor was at the
door, or that a booking window was about to close, without being asked.

**Steps.** Read the Conversation Surface page for the add-on toolkit. The docs live at
`https://developer.amazon.com/docs/alexaplus/add-ons/<slug>.html` — the `.html` is part
of the path, and every guess without it 404s. `--compressed` is also required or Amazon
returns gzip that reads as binary noise and looks like a failed fetch:

```
curl -sL --compressed -A "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" \
  https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-conversation-surface.html
```

**Expected.** Some notification primitive. Proactive Events exist on the older Alexa
Skills stack, so the reasonable assumption is that add-ons inherit something like them.

**Actual.** They do not. The page states the model plainly: *"Alexa+ uses a turn-based
conversational model... your add-on participates one turn at a time."* There is no
proactive channel in the toolkit at all. The add-on is a set of tools a model may call
during a turn the customer started, and it has no way to start a turn.

**Severity.** It decides what the product can be. Every idea whose value is catching
someone before a deadline, a renewal, a delivery or an appointment is gone on this
track, unless the customer happens to ask on the right day.

**What we did instead, and what it cost.** On Behalf was designed as a delegation record
rather than an alerting product. The household grants a standing arrangement in advance
— categories, a spend cap, hours, a notice window — and the add-on's job on any given
turn is to answer honestly about what that arrangement currently permits and what has
already happened under it. Nothing is ever pushed.

The cost is real and worth naming. A delegation product that cannot notify has to make
the pull moment carry all the weight, so the state has to be legible in one spoken turn
with no follow-up. That constraint is why every tool returns a small fixed set of named
fields rather than a paragraph, and it is why the console exists at all: the web page
carries everything a turn cannot.

**Suggestion.** Say this on the add-on overview page, not four pages in. "Add-ons
respond; they cannot initiate" belongs in the first paragraph a developer reads, because
it eliminates a whole category of idea and everyone will design one before finding out.
If a proactive channel is planned, a sentence about the intent would let people build
toward it rather than around it.

## Alexa+ knows the account, never the person in the room

**Task.** Decide whether a delegation product could distinguish the person who granted
the delegation from the person exercising it.

**Steps.** Read
`https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-supported-capabilities.html`,
then the account-linking and authentication pages beside it.

**Expected.** Something in the identity family. Voice ID is a shipped Alexa feature and
household profiles are a shipped Alexa feature, so some person-level context seemed
likely to reach an add-on.

**Actual.** The Supported Capabilities page lists exactly two things: Authentication and
Account Linking. Identity arrives as a single linked OAuth account and nothing else. No
Voice ID, no person context, no household context. An add-on cannot tell who in the room
is talking, and cannot tell whether the speaker is the account holder.

**Severity.** High for this product specifically, since "who is allowed to approve this"
is the entire subject matter.

**What we did instead.** The household is modelled as one principal, because that is
what the platform hands us, and every delegated authority is a record a human typed into
the console rather than something inferred from a voice. A tool response never says "you
are allowed to do this"; it says which named person the arrangement was granted to and
by whom, and leaves the room to notice if the wrong person is standing there. The
authorization checks are all server-side against the linked account, and a second
household's records are unreachable regardless of what any turn says.

The honest limit, which is in the product's own copy: on a shared Echo, On Behalf cannot
tell a resident from a houseguest. We say so rather than implying a check that does not
exist.

**Suggestion.** Two things. State on the Supported Capabilities page that speaker
identity is not available, in those words, because a developer who knows Alexa has Voice
ID will otherwise assume it is reachable and find out late. And if a coarse signal is
ever exposed — "this is the account holder" as a boolean, with no name attached — that
alone would let a class of household-authority products exist without exposing anything
about who anyone is.

## You cannot script what Alexa says, so we stopped trying to guarantee a sentence

This is the constraint that changed the architecture, and it is the one we would most
want the toolkit team to see written down by somebody outside Amazon.

**Task.** Guarantee that before a household member approves a visit, the exact
conditions of that approval are stated out loud. That is the safety case for the whole
product: a delegation you did not hear is a delegation you did not make.

**Steps.** Read the tools and schema design page:

```
curl -sL --compressed -A "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" \
  https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html
```

**Expected.** Some form of verbatim slot. Classic Alexa skills return `outputSpeech`,
so the assumption going in was that an add-on could hand back a sentence and have it
spoken.

**Actual.** It cannot. The page says it directly: *"You can't 'script' what Alexa
says."* The Conversation Surface page completes the picture: *"Alexa incorporates your
returned data into the voice response."* You return structured data; the model composes
the sentence. There is no verbatim channel anywhere in the toolkit.

**Severity.** It invalidates a design, not a line of code. Any product whose safety
argument rests on a specific sentence reaching the speaker is impossible on this track,
and we had written one.

**What we did instead: guarantee the fact set, because the sentence cannot be
guaranteed.** `what_is_waiting`, the tool a household's own turn calls to check whether
anything needs them, returns a visit awaiting agreement as six fields and nothing
else: `provider`, `service`, `day`, `time`, `price`, `askedBy`. An arrangement awaiting
acceptance comes back the same way, as `askedBy`, `covers`, `limit`. Once accepted,
`list_standby_households` on the delegate's own turn adds `noticeHours` and the allowed
`hours` window. No field on any of these is a sentence, a summary or a paragraph; each
is a name, a number, a time or a short closed-vocabulary string. Whatever Alexa composes
can only be built out of that field set, because it is the only material she has. We
cannot promise the household hears a particular form of words. We can promise that every
condition of
the grant is in front of the composer and that nothing outside the grant is.

That is a weaker property than a scripted readback and it is weaker in a way that
matters, so it is written into the product rather than glossed. A composed sentence can
drop a field. It cannot invent one.

**The defect this constraint produced in our own code, which is the part worth
reporting.** The structural test `tests/no-model-on-read-path.test.ts` asserts that
`src/mcp/server.ts` does not import `src/bedrock/*`, so no model call can sit on a
latency-sensitive voice path. It passes, and it is honest about what it checks. But it
checks that the *module* is unreachable, not that model-*written text* is. A weekly
brief composed by Bedrock on the console POST was persisted to SQLite by
`src/web/server.ts`, and the `latest_brief` tool read that row back out and returned it
as a fact for Alexa to speak. Model prose reached the voice path through a database,
with no import anywhere near it.

The guard that should have caught it, `assertNoHealthContent` in
`src/domain/screening.ts`, was written and correct and applied only to human-typed text.
The screening that does run on the voice path checked identifiers — digit runs, emails,
addresses — and not health terms or directives. So the page footer's promise that the
product "covers no health arrangements of any kind, and cannot be configured to" was one
stored paragraph away from being false, and the stored paragraph was also a way to put
instructions in front of Alexa's own response composer.

The fix is one line: run the health and readback assertions inside the shared
`screenResult` wrapper in `registry.ts`, where every current and future tool already
passes through. The lesson is not one line. **On a platform where the model composes the
sentence, "the model is not on this path" has to mean data, not imports.** A guard that
is right about typed text and never runs on model text is a guard that documents an
intention.

**Suggestion.** The tools and schema page says you cannot script the response and then
moves on. It should go one step further and say what to do about it, because the answer
is not obvious and it is the same answer for everyone: return the smallest closed set of
fields that makes every legal sentence safe, and treat anything you would have wanted to
script as a schema problem. A worked example of a confirmation readback built that way,
next to the sentence that rules out scripting, would be the single most useful page on
the site for anyone building something with consequences.

## Policy section 3 and policy section 15 point opposite ways

**Task.** Work out whether a confirmation readback is even permitted, given that it
states arrangements about a named person out loud in a room.

**Steps.** Read `policy-requirements.html` end to end rather than stopping at the
prohibition.

**Expected.** One rule.

**Actual.** Section 3 bans reciting *"private personal information via voice"*. Read
alone, that kills the readback and probably the product. Section 15 mandates the
opposite for bookings: *"Your add-on must confirm relevant booking details via voice
before executing"*, and requires the add-on to *"read back booking details and
cancellation policy, then request confirmation before cancelling"*. Section 14 shows
where the line actually sits — rejection *"if it collects PII in-experience or displays
sensitive information on home cards"*, with a four-digit voice PIN for sensitive
functions.

So section 3 aims at identifiers and named sensitive classes, not at any fact about a
person. "The cleaner is booked for Thursday at two" is mandated by section 15, not
banned by section 3. Health is genuinely out, because section 13 lands on top of it.

**Severity.** Medium as time, high as a near-miss. We came close to abandoning the
readback on the strength of section 3 alone, which would have removed the one mechanism
that makes the product defensible.

**Workaround.** Read the whole policy document before designing. That is not much of a
workaround.

**Suggestion.** Section 3 needs a pointer to section 15. One clause — "see section 15 for
booking confirmations, which are required" — turns a contradiction into a rule with an
exception. As written, a careful developer who reads the prohibition and acts on it
builds a worse product than one who reads less carefully.

## Two smaller things about filming and testing on this track

**The web simulator takes typed input.** Without an Echo device, an Alexa+ demo is a
video of somebody typing at a simulator. The rules do allow a simulated web experience
for this track, and they are explicit about it, which is fair and generous. It is still
worth saying that the honest framing of such a video is "here is the add-on responding",
not "here is a person talking to Alexa", and the difference shows on camera.

**The Home Services test script needs an Echo Show.** The published test flow assumes a
screen. A developer with an Echo Dot, or with no device at all, cannot run it as written
and has no reduced version to fall back on.

**Voice can never be the only path, by platform rule**, and this one is good news
reported as friction only because it surprised us. The accessibility guidance requires
the experience to be completable *"touch only, including on-screen keyboard, without
voice"*. That means a web console is not a compromise a voice-first product makes under
time pressure; it is required. We would rather have known that on day one than
discovered it while feeling guilty about building a web page.

---

## Product feedback answers

**Tools, APIs and SDKs used.** `@modelcontextprotocol/sdk` 1.30.0 (server, Streamable
HTTP transport, `registerTool` with zod schemas) for the 21 tools; OAuth 2.1 with
authorization code grant and PKCE S256 for account linking, which the toolkit mandates
and checks; `@aws-sdk/client-bedrock-runtime` Converse for the three composition calls,
all of them off the voice path; `node:sqlite` for storage; `node --test` as the runner;
no framework beyond that.

**Onboarding, zero to hello world.** Bedrock was the smoothest part: credentials already
resolved from the environment, one CLI Converse call to sanity-check a model id, then
the SDK. The MCP Toolkit side was slower, and the time went to the two questions the
docs do not answer directly — which protocol revision the SDK actually negotiates, and
where per-request authorization goes in a stateless Streamable HTTP server. Both are
answerable from type declarations and compiled output in under an hour. Neither should
be.

**What worked.** OAuth 2.1 with mandatory PKCE, checked at deploy, is the right call and
was the least troublesome part of the build. Streamable HTTP with a fresh server per
request measured at 4.4 ms p95, so the stateless pattern costs nothing against the
500 ms budget. `Converse` is the right abstraction: system prompt, messages,
`inferenceConfig`, done. And the platform's refusal to let us script a sentence pushed
us into a better design than the one we had.

**What needs work.** In order: no proactive channel and no statement on the overview
page that there is not; no speaker identity and no statement that there is not; section 3
of the policy contradicting section 15 with no cross-reference; `ListFoundationModels`
and `ListInferenceProfiles` returning models the account cannot invoke; the SDK's
protocol revision living only in compiled output; the deprecated `tool()` overloads
sitting above `registerTool` in the declarations. The last two are the MCP SDK rather
than Amazon.

**Amazon Devices Builder Tools.** Not used. The Builder Tools MCP server and Agent
Skills are the first item under "Start here" on the Resources page and we went straight
to the docs instead. What would have made us install it: a line saying which of the
questions above it can answer. "Documentation search" does not read as "it knows which
MCP protocol revision the toolkit requires", and that is the question we actually had.

**Would we build with these again?** Yes for the MCP Toolkit, with the constraints
understood up front. The turn-based model and the unscriptable response are limits, not
defects, and a product designed inside them is more honest than one that assumes a
notification channel. Not for anything that needs to know who is speaking, and not for
anything in health.

## One thing we would tell the next team

You cannot guarantee what Alexa says, so stop trying and guarantee what she is given.
Decide the smallest set of named facts that makes every sentence composable from them
safe, return only those, and then go and check that no model-written string reaches that
set through a database, a cache or a file. Ours did, through a SQLite round trip, under a
structural test that proved no model module was imported. The import check was true and
the property it stood for was not.
