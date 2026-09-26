# On Behalf, spec

## What it does

On Behalf lets one household run another household's trade, delivery and repair admin,
with both households consenting on their own accounts and their own devices.

An adult child books the plumber. The older relative asks their own Echo "when is the
plumber coming", is told, and says "I need to move it". On Behalf offers the times the
plumber actually has, moves the booking when a time is chosen, and writes to both homes
to say so. The relative can also ask what has been changed at their house and who
changed it, and can pause or end the whole arrangement from their own speaker without
going through anybody.

## Who it is for

The person administering a second household from a distance, and the person living in
that second household.

The research file for this topic found one company, HeyFaye, charging a monthly fee to
do exactly this list of tasks by hand in three Florida towns, and found that every
Alexa+ service provider interface Amazon publishes carries one end-user identifier, one
linked account and one per-user appointment datastore. Nobody has specified the person
acting on somebody else's behalf. That gap is the product.

## The one flow that carries the demo

`npm run demo` runs it end to end over the real protocol: a Streamable HTTP MCP server,
two MCP clients with two different bearer tokens, and no reaching into the database to
make anything true.

1. Nadia types one sentence about what she looks after at her mother's house. Bedrock
   turns it into structured terms she can edit. It grants nothing.
2. Marian accepts, by saying a six character code to her own Echo. The arrangement is
   live from that moment and not before.
3. Nadia finds a plumber and books one into Marian's house.
4. Marian asks her own speaker when the plumber is coming, and who arranged it.
5. Marian says she needs to move it. On Behalf offers three real times. A time On Behalf
   did not offer is refused outright.
6. Both homes get a written confirmation, because nothing here can speak first.
7. Marian asks what has been changed at her house, and gets the whole ledger.
8. Marian asks for gutter work. On Behalf records it and passes it on rather than
   booking it, because somebody else arranges and pays for work at that house.
9. Bedrock argues the held request, after the turn it relates to has already been
   answered.
10. Nadia decides. The model advises; it never acts.
11. It is above the limit Marian set, so it goes back to Marian, who agrees.
12. A booking with health content in it is refused at the boundary.
13. Marian pauses the arrangement from her own speaker. Nadia's next booking is refused.
14. The handover note is written and sent, because it is the only thing that can reach
    Nadia when she is not asking.

The run prints the round trip for every turn. On this machine it is a median of 3 ms
against a 500 ms budget.

## The platform facts this is designed inside

All five of these are constraints from Amazon's own documentation, and each one changed
the design rather than being worked around.

**An add-on cannot speak first.** The Conversation Surface page says the model is
turn-based and the add-on "participates one turn at a time", and nothing in the
permissions, lifecycle or certification pages documents a server-initiated route to a
customer. So every voice tool here answers rather than announces, and there is no tool
whose value would depend on interrupting somebody. The half of the product that has to
reach a person who is not speaking goes out over email and SMS from On Behalf's own
backend, which Policy Requirement 15 mandates for bookings anyway. `what_is_waiting`
exists precisely because nothing can come and find you.

**There is no speaker identity.** Supported Capabilities lists Authentication and
Account Linking and nothing else. On Behalf never tries to work out who is in the room.
It knows which linked account the turn arrived on, and that is the household. The
delegation model is built on that rather than around it: two accounts, linked
separately, on their own devices, and a grant between them.

**You cannot script what Alexa says.** The model composes the spoken sentence from the
returned data. On Behalf therefore guarantees the *facts*, not the sentence:
`src/domain/readback.ts` enforces that every mandatory booking fact is present, that
each fact is true standing alone in any order, that no field reads as an instruction to
the model, and that no identifier is on the spoken channel. Every voice result passes
through it.

**Voice can never be the only path.** Amazon's accessibility guidance requires the
experience to be completable "touch only, including on-screen keyboard, without voice".
The console is that path, it is server-rendered with no JavaScript at all, and
`tests/touch-parity.test.ts` walks the tool registry against the running console and
fails if a tool exists that a person cannot reach with their hands.

**The round trip must be under 500 ms.** No model call, no network call and no remote
lookup is reachable from a tool handler. `tests/no-model-on-read-path.test.ts` walks the
import graph from the MCP server and fails if anything under `src/bedrock/` or any AWS
SDK import becomes reachable. `npm run bench` prints the measured figures.

## Where the model is, and where it is not

Bedrock does three things, all of them off the voice path, all of them after a turn has
already been answered, all with a timeout, a model chain and a working fallback.

1. **Drafting an arrangement** from a sentence the delegate typed. The other household
   still has to accept it on their own device.
2. **Arguing a held request**, so the person deciding has something to read. The
   decision code never reads the recommendation, and a test approves something the
   model wanted declined.
3. **Writing the handover note**, which is what replaces the thing Alexa+ cannot do.

The model never decides, never books and never cancels.

## What it deliberately does not do

- **No health, at all.** Policy Requirement 13 governs health content, and the Alexa+
  permissions model grants one customer's data on their own account with no documented
  delegation to a second person. There is no health category, the category list cannot
  be extended to include one, and free text containing health terms is refused at the
  boundary with a reason. A medical variant would be the most affecting demo available
  and it is not buildable here.
- **No real bookings.** The provider directory and their free times are local fixtures.
  Availability is a hash of the provider and the date, so the same Thursday comes back
  on every run. Marked as a mock in the code, in the console and in the README.
- **No mail or SMS provider.** Messages are real; the transport writes them to a folder.
- **It does not identify who is speaking**, because the platform cannot.
- **It does not spend without a ceiling**, move a visit to a time nobody offered, or
  cancel without reading the policy back first.

## Design

Written down before any component was — revised twice below: once when the shell
changed to a fixed rail, and again when the first version of that rail turned out to
have kept its own palette and its own type instead of Cutaway's. That second revision
is this one.

**Direction: Cutaway, exactly, not as a loose structural hint.** Told directly that
the first pass looked the same before and after — which was the proof it hadn't
actually followed the reference — this pass takes Cutaway's (`agentic-cinema/cutaway`)
own values rather than a structural gesture toward them: its light ground (`#FAFAFA`
page, `#FFFFFF` card), its ink (`#141414`) and greys (`#8A8A8A` muted, `#E7E7E7`
line), its orange (`#F2571B`, with `#FDF0EB` as its own tint), its Inter/JetBrains
Mono type stack, its 7–9px radii, its card and pill and chip shapes. The one colour
this app adds that Cutaway's file has no need of is a destructive red (`--danger`,
`#C0392B`) — Cutaway has no delete or revoke action anywhere in it, and this whole
product turns on ending an arrangement in one press, so it needed a colour their file
never had to choose. It is pitched at the same lightness and saturation as their own
gold and green so it reads as one more member of the family rather than a third
style. See `src/web/style.ts`'s header comment for the full account, token by token.

Warmth still means exactly one thing beyond decoration — "you are acting inside
somebody else's home", or "this is waiting on you" — the same restraint as before,
now carried by Cutaway's own gold (`#C99A22`, their "interrogation" swatch) instead of
an invented wheat.

**Shell: a fixed left rail, Cutaway's own grid.** `.app{display:grid;grid-template-
columns:212px 1fr}`, a sticky `.side`, a `.main` holding a `.top` bar (breadcrumb,
avatar) above a padded `.body` — all taken as-is, including the top bar Cutaway has
and the first pass's redesign didn't. The rail holds, top to bottom: the mark, the
authority band, the household list ("Looking at"), the navigation, and the signed-in
account — because that is what this product needs a permanent rail for, not because
Cutaway's own rail holds those things (it holds a project name and four nav labels).
Where On Behalf needed a component Cutaway has no page for, it is built from Cutaway's
own pieces — the `.intent` callout for the authority band and the readback panel, the
`.ep` card for the roster rows — rather than a fourth style arriving from nowhere.

The one measured deviation is width: Cutaway's 212px holds a label; On Behalf's rail
also carries a full sentence ("You are acting for Marian at Ridgeway... may book, move
and cancel plumbing, heating... up to 200 dollars a visit... Runs to September 25,
2027") that 212px wraps into a ladder of one or two words a line. 220px — Inter sets
narrower than the previous pass's serif at the same size, so the gap needed turned out
to be small — wraps the same sentence into three or four ordinary short lines instead.
Below 860px — the width the two-home comparison view already gives up its own two
columns at — the rail stops being fixed and becomes an ordinary block above the
content; nothing in it becomes unreachable, it is still every link and form, just
stacked rather than pinned, which is what "responsive" means for a console with no
client JavaScript.

**Type.** Inter for everything, JetBrains Mono for tool names, timings and the
readback panel's fact keys — Cutaway's own two families, and the only two it names.
The first pass vendored Newsreader and Source Sans 3 instead and reserved the serif
for people's and places' names; that distinction is gone. A name still reads
differently from a label, but by weight (700, `-0.01em` tracking) rather than by a
second typeface, because Cutaway's own type system has exactly one. Both families are
self-hosted as woff2, recorded in `ATTRIBUTION.md`, same reasoning as before: a
judge's machine without the right fallback installed was rendering Georgia, which was
a real defect independent of which reference this pass follows.

**This does collide with the standing rule that every project in this hackathon gets
a distinct UI, on purpose.** That rule holds that each project still picks its own
palette — borrowing how a good interface is put together is fine, copying a design
system is not — and Cutaway's own orange `#F2571B` is already taken elsewhere in the
batch. This pass takes it anyway, on a direct, twice-repeated instruction for this
one app specifically: follow Cutaway exactly, palette included, because the first
attempt's compliance with "borrow the structure, keep your own palette" was
indistinguishable from not having followed the reference at all. This is a
deliberate, recorded exception to the standing rule, scoped to this one app.

## Build

Node 24 or later, TypeScript run natively with no build step, `node:sqlite` for storage,
`@modelcontextprotocol/sdk` on Streamable HTTP at spec revision 2025-11-25, and
`@aws-sdk/client-bedrock-runtime` in the three places listed above. Licence MIT.
