# Vatermark Cases (beta)

Cases is an addition to Vatermark for clinical images: a case is opened for one
exact image, a reviewer is asked to take it on, they accept or decline, sign
off the review, and the owner closes the case. Every one of those steps is a
statement signed in Verus Mobile by the person it concerns, verified by the
server against VRSCTEST identity state at the signing height, and appended to
a hash-chained log. The log is the source of truth; everything the interface
shows is derived from it.

The promise, worded carefully: *verifiable evidence of who asked whom to take
responsibility for which exact image, who explicitly accepted or declined, and
who attested that the accepted review was completed, under a policy whose text
is bound into every statement*. It is not evidence that a clinician saw,
understood or correctly interpreted an image, and a VerusID is not a
professional licence or an organisational authorisation.

## Where it lives

Cases is folded into one server folder, one front-end folder and one document,
and reaches the app through three one-line touch points. Vatermark's own code
and behaviour are unchanged; where Cases needs something the app does
differently, Cases adapts, never the app.

| Path | What |
| --- | --- |
| `server/cases/protocol.ts` | The pure protocol: statements, event hashes, the state machine, the private store, the public view and the export package. |
| `server/cases/verus.ts` | `CasesVerusAdapter extends VerusAdapter`, like the app's metadata adapter: the case-statement request and callback checks (mirroring the app's own), identity lookup, block reads, statement verification, identity evidence and service attestations. |
| `server/cases/routes.ts` | The HTTP API, mounted after the app's routes so every request has passed the app's session, origin and rate-limit middleware. |
| `server/cases/policy.ts`, `server/cases/anchor.ts` | The bundled policy text and the anchoring interface (unconfigured in this version). |
| `server/cases/verify-package.ts` | The independent verifier, `pnpm cases:verify`. |
| `src/cases/` | The pages, the animated flow and timeline, and the wallet hand-off, in the app's design language. |
| `tests/cases/`, `tests/browser/cases.spec.ts` | Protocol, API, adapter and browser tests. |
| Touch points | The **Cases · beta** button in the app header (`src/App.tsx`), the `/cases` route switch (`src/main.tsx`) and the mount line in `server/app.ts`. |

## Routes

All routes sit under `/api/cases` and share the app's session cookie, origin
check and rate limits. A case number is the capability to read, propose and
export; see Privacy.

| Route | Purpose |
| --- | --- |
| `POST /api/cases` (`image` upload) | Open a draft case: the file is fingerprinted and deleted; only the manifest stays. |
| `POST /api/cases/check` (`image` upload) | Present any copy: exact bytes find their cases; otherwise a 15-minute ticket lets this browser open a case for the file. If the copy carries a Vatermark seal, says by whom. |
| `POST /api/cases/from-ticket` `{ ticket }` | Open a draft from a ticket. |
| `GET /api/cases/:number` | The public view: status, parties, history, the pending step, the steps allowed next. |
| `POST /api/cases/:number/steps` `{ type, actor?, to?, deadline? }` | Propose the next step. The server issues the statement as a wallet request; only the identity it names can make it take effect. |
| `DELETE /api/cases/:number/step` | Withdraw an unsigned step proposed from this browser. |
| `GET /api/cases/:number/export` | The export package, attested by the service identity when signing is configured. |
| `POST`/`GET /api/cases/attestations/:id/response` | Wallet callbacks (POST body or redirect query). The redirect lands on `/cases?caseReturn=<number>[&returnError=<code>]`. Callbacks never set or replace the session cookie. |

## Concepts

| Term | Meaning |
| --- | --- |
| **Case** | One workflow against one artifact. Identified by an opaque random case number `VC-XXXX-XXXX-XXXX` (Crockford base32, 60 random bits). |
| **Artifact manifest** | `sha-256` digest of the exact source bytes, byte count, media type sniffed from the bytes, and image dimensions when decodable. The server keeps the manifest and never the file or its name. Original clinical files stay in the clinic's own storage, unmodified. |
| **Event** | A canonical statement, the actor's native Verus signature over it, the actor's identity evidence (chain records at the signing height and at acceptance) and the resulting event hash. Appended only after verification; never edited. |
| **Owner** | The actor of `CASE_CREATED`. Assigns, withdraws unanswered requests, closes and reopens. |
| **Assignee** | The identity named by the open `TASK_ASSIGNED` that has not yet been answered. |
| **Responsible** | The actor of the latest `TASK_ACCEPTED` whose task has not been handed on and accepted by someone else. Completes the review; may hand the task on. |
| **Pending step** | At most one outstanding wallet request per case: the statement the next event will carry, the identity that must sign it, and its expiry. A newer proposal replaces an unsigned step; expiry or replacement leaves no event. |
| **Anchor** | The status of the event hash's commitment to the Verus chain: `pending`, `anchored` or `failed`. Never shown as anchored without transaction evidence. |

## State machine

The status is a projection of the accepted events. Transitions not listed are
refused before a statement is even offered for signature; the verifier applies
the same table to a package.

| From | Event | Signer | To |
| --- | --- | --- | --- |
| `draft` | `CASE_CREATED` | the identity the proposer names; it becomes owner | `open` |
| `open`, `rejected`, `completed`, `reopened` | `TASK_ASSIGNED` | owner | `assigned` |
| `assigned` | `TASK_ASSIGNED` (replaces the unanswered request) | owner, or the responsible identity if one holds the task | `assigned` |
| `accepted` | `TASK_ASSIGNED` (hand-off) | owner or responsible | `assigned` |
| `assigned` | `TASK_ACCEPTED` | assignee, naming the open task | `accepted` |
| `assigned` | `TASK_REJECTED` | assignee, naming the open task | the status before the request (`rejected` when there was none) |
| `assigned` | `TASK_WITHDRAWN` | owner, naming the open task and its assignee | the status before the request |
| `accepted` | `REVIEW_COMPLETED` | responsible, naming the accepted task | `completed` |
| `open`, `rejected`, `completed`, `reopened` | `CASE_CLOSED` | owner | `closed` |
| `closed` | `CASE_REOPENED` | owner | `reopened` |

A declined or withdrawn hand-off returns the case to `accepted` with the
previous responsible identity still responsible. An accepted review cannot be
closed over: it must be completed, or handed to someone who accepts it, first.
`open` and `reopened` behave identically. The assignee may be the owner; a
self-assigned review still takes two separate signatures. Each `TASK_ASSIGNED`
creates a new task identifier, and answers name the task they answer, so a late
answer to a replaced request is refused.

## Canonical statement

The signer sees and signs exactly this UTF-8 text. Lines are joined by a single
LF (0x0A); there is no trailing newline, no other whitespace, and every value
is canonical (lower-case hex, decimal integers without leading zeros, UTC
times with second precision). Optional lines are omitted entirely when not
applicable.

```text
clinical-workflow-event/v1
<meaning sentence for the type>
type:<TYPE>
case:VC-XXXX-XXXX-XXXX
seq:<n>                          1 for CASE_CREATED, then +1 per event
prev:<64 hex>                    hash of the previous event; 64 zeros for seq 1
artifact:sha-256:<64 hex>
actor:<i-address>                the identity that must sign this statement
actor-name:<name@>               its VerusID name, for the reader
to:<i-address>                   TASK_ASSIGNED, TASK_WITHDRAWN
to-name:<name@>                  same
task:<16 hex>                    TASK_ASSIGNED, TASK_ACCEPTED, TASK_REJECTED, TASK_WITHDRAWN, REVIEW_COMPLETED
deadline:<YYYY-MM-DDTHH:MM:SSZ>  TASK_ASSIGNED, when the assigner requested one
policy:<policy id>               [a-z0-9.-]{1,64}
policy-hash:<64 hex>             SHA-256 of the policy text
block:<height>:<64 hex>          the VRSCTEST block the server observed when issuing the statement
at:<YYYY-MM-DDTHH:MM:SSZ>        when the statement was issued for signature
nonce:<40 hex>                   the wallet request identifier; unique per statement
```

The meaning sentence is fixed per type and is part of the protocol, so a
signer always reads in plain language what they attest to:

| Type | Sentence |
| --- | --- |
| `CASE_CREATED` | `I open this case and take ownership of its workflow.` |
| `TASK_ASSIGNED` | `I ask the named identity to take responsibility for reviewing this artifact.` |
| `TASK_ACCEPTED` | `I accept responsibility for reviewing this artifact under the named policy.` |
| `TASK_REJECTED` | `I decline the requested review responsibility.` |
| `TASK_WITHDRAWN` | `I withdraw the review request I made to the named identity.` |
| `REVIEW_COMPLETED` | `I attest that I completed the assigned review of this artifact under the named policy.` |
| `CASE_CLOSED` | `I close this case.` |
| `CASE_REOPENED` | `I reopen this case.` |

The server writes every line: `seq`, `prev`, `task` and `nonce` from the
accepted history and the wallet request; `actor` from the role the state
machine requires, or, for `CASE_CREATED`, from the identity the proposer names;
`to` from the identity the proposer names. Named identities are resolved on
VRSCTEST by name (`name@`) or i-address when the step is proposed and must be
active then. Names are the chain's base names with an `@` suffix; they are for
the reader, and the i-addresses are authoritative.

The policy identifier names the deploying organisation's written definition of
what each event means; `policy-hash` binds the exact text, which also ships in
export packages. This version bundles `vatermark-cases-policy-v1`
(`server/cases/policy.ts`), which defines each event and says explicitly that
`REVIEW_COMPLETED` attests completion of the accepted task, not a diagnosis,
a report or the correctness of any finding.

## Signature and verification

Statements travel through the same Verus Mobile flow as Vatermark image
signing, with a second statement profile: the service identity signs a
`DataPacketRequest` whose single signable object is the statement, Mobile
returns a signed `GenericResponse` over the service's callback URL (which
carries a random step identifier, never the case number), and the server
verifies the request binding, network, response and inner signatures, and the
signer's identity authority at the signature's own block height
(`minimumsignatures = 1`, primary addresses in force at that height). The
checks in `CasesVerusAdapter.createCaseRequest` and `verifyCaseResponse` mirror
the app's `createRequest` and `verifyResponse` line for line; only the accepted
text differs, so an image request can never be mistaken for a case step or the
other way round. The native digest is the standard Verus one:

```text
SHA256(system_id || height_u32_le || identity_id
       || CompactSize(19) || "Verus signed data:\n" || SHA256(UTF8(statement)))
```

Acceptance rules, all of which the verifier re-checks from the package:

1. **Signer is the actor.** The identity that produced the signature must be
   the `actor` line. Any other identity, however valid its signature, is
   refused with `WRONG_IDENTITY` and the step stays open. The owner of a case
   is therefore the identity named when it was opened.
2. **Signing height is bounded.** The height embedded in the signature must be
   at least the statement's `block` height minus `BLOCK_TOLERANCE` (5 blocks,
   because a wallet's node may trail the server's), at most the current chain
   tip, and not below the previous event's signing height. This prevents a key
   that was later rotated out, or an identity later revoked, from signing new
   events "in the past". Refusal code: `STALE_SIGNATURE`.
3. **Identity state.** The identity must not be revoked at the signing height
   and must be active now. A later key rotation does not invalidate an earlier
   event; the record keeps, per event, the identity record at the signing
   height and the current record seen at acceptance, and derives a key state
   (`unchanged`, `rotated`, `revoked`) that the interface and verifier show.
4. **History unchanged.** The statement's `seq` and `prev` must still match
   the accepted log when the signature arrives.

Identity state is fetched from `https://api.verustest.net`. It is the
configured source of chain state, not an independently validated proof.

## Event hash and chain

```text
event_hash = SHA256( UTF8(statement) || 0x0A || native_signature_bytes )
```

`native_signature_bytes` is the 73-byte compact Verus signature (version 2,
SHA256, height, one 65-byte signature). The next statement's `prev` line is
this hash and `seq` increments by one. Within a presented sequence, reordering,
insertion or removal of an interior event is detectable from the hashes alone,
because every statement names the exact history its signer saw. Removal of
trailing events is **not**: every prefix of an accepted log is itself a
consistent log. Completeness is established only by comparing the head hash
and event count against an independent reference: a fresh export, the live
case, the export attestation below, or, once anchoring is enabled, an anchored
head.

A signed statement cannot be applied twice: its `seq`, `prev` and `nonce` fit
one position. An exact wallet retry of a finished step is acknowledged without
re-verification; a different response for a finished step is refused.

## Concurrency and proposals

Only one pending step exists per case, so two valid signatures never compete
for the same `seq`. Anyone holding the case number may propose a step, because
a proposal has no effect until the named identity signs it. A newer proposal
replaces an unsigned step (the replaced request is refused with `JOB_CLOSED`),
so nobody can block a case by planting proposals; the browser that proposed a
step may also withdraw it. The interface marks a step that was proposed from
another browser. Steps expire after `SIGN_JOB_TTL_MINUTES`. Updates to one case
are serialised on the server and written atomically. Housekeeping (expired
tickets, abandoned drafts, anchoring progress) runs on demand with requests,
throttled; nothing runs in the background.

## Anchoring

Each event carries an anchor record:

```json
{ "status": "pending" | "anchored" | "failed", "commitment": "<event_hash>",
  "txid": "...", "height": 123, "confirmations": 6, "updatedAt": 0, "detail": "..." }
```

The commitment is the event hash. This version ships the anchoring interface
(`server/cases/anchor.ts`) with an **unconfigured** implementation: every event
stays `pending` and the interface says so. A Verus-node anchorer (one
transaction per responsibility-critical event, with a batch/Merkle variant
later) is the next step; it needs a funded testnet address and a node that
accepts transaction submission. Whatever the implementation, an event becomes
`anchored` only when a transaction id and inclusion height are recorded, and
nothing promotes `pending` or `failed` to `anchored` on its own.

## Export package

`GET /api/cases/:number/export` returns `clinical-workflow-export/v1`:

```json
{
  "schema": "clinical-workflow-export/v1", "network": "VRSCTEST", "exportedAt": "2026-10-15T10:30:00Z",
  "case": { "number": "VC-…", "policy": { "id": "…", "hash": "…", "text": "…" },
            "artifact": { "digestAlgorithm": "sha-256", "digest": "…", "bytes": 0, "mediaType": "image/jpeg", "width": 0, "height": 0, "manifestVersion": 1 } },
  "events": [ { "seq": 1, "type": "CASE_CREATED", "statement": "…", "hash": "…", "prev": "000…",
                "signature": { "native": "<base64 73 bytes>", "identityId": "i…", "name": "…", "height": 0, "systemId": "i…" },
                "acceptedAt": 0, "anchor": { … } } ],
  "identities": { "i…": { "name": "…", "snapshots": [ { "height": 0, "record": { …getidentity result… } } ], "current": { … } } },
  "attestation": { "statement": "clinical-workflow-export-attestation/v1\ncase:VC-…\nevents:4\nhead:…\nat:…",
                   "native": "<base64>", "identityId": "<service i-address>", "name": "…", "height": 0 }
}
```

The package contains no file names, no patient data and no image bytes. Status,
owner, assignee and responsible are not included: they are derived by replaying
the events. `signature.identityId`, `.height` and `.systemId` are convenience
copies that must equal the actor line, the height embedded in the signature and
VRSCTEST. `acceptedAt`, names, identity snapshots and anchor records are
server-asserted, not signed, and are labelled so by the verifier.

The **attestation** is the service identity's signature over the case number,
event count, head hash and export time. It attests that the server held exactly
this log at that moment, which makes a truncated or altered copy of an export
attributable and lets two exports that disagree prove server misbehaviour. It
is trust in the service identity, not a chain proof.

## Verify an export anywhere

```sh
pnpm cases:verify <export.json> [--offline] [--rpc <https url>]
```

The verifier needs no application database. It prints the case number, event
count and head hash, then per event:

1. **Structure**: schema; statement grammar and meaning sentence; `seq` and
   `prev` links; constant artifact digest and policy binding, with the policy
   text matching its digest; nonce uniqueness; the hash recomputed from
   statement and signature bytes; `signature.identityId` equal to the actor
   line and `signature.height` equal to the embedded height; non-decreasing
   issuing blocks and signing heights, with signing height within tolerance
   of the issuing block.
2. **Workflow**: the transition is legal under the state machine and the actor
   held the role it requires, judged only from the prior events in the package;
   answers name the open or accepted task.
3. **Signature**: the native signature verifies for the actor at the embedded
   height against identity state fetched from VRSCTEST, or, offline, against
   the package's own snapshot, reported as self-reported.
4. **Block**: online, the issuing block hash is on VRSCTEST at that height.
5. **Identity now** and **keys since signing**: active or revoked now, and
   whether the primary addresses changed since the signing height; offline,
   `unknown`.
6. **Anchor**: the recorded status and transaction id, always reported as
   "recorded by the server, not verified". The verifier does not yet look
   transactions up; it never reports an anchor as verified without doing so.

It also verifies the export attestation against the service identity, prints
the derived status and parties, and exits non-zero if any structural, workflow,
signature, block or attestation check fails.

## Privacy rules

- Case numbers are opaque and random. Holding one grants reading, proposing
  and exporting; treat the number and any export as a read capability, and
  share them only with the people who should follow the case.
- The server stores the artifact manifest, never the file or its name. Even a
  digest can be linkable when it is the digest of a real clinical file.
- Statements and events contain identities, digests, hashes, times and policy
  identifiers only; there are no free-text fields.
- Wallet callback URLs carry a random step identifier, never the case number.
- Nothing is published on chain yet; when anchoring is enabled, only event
  hashes are committed. Hashes and timing can still be linkable; a privacy
  review belongs before real clinical use.

## Optional watermark derivative

Vatermark's robust watermark remains available for distribution copies: a
watermarked derivative with its own digest, linked to the source manifest.
This version keeps the app's signing and verification routes untouched and
uses the engine only when a presented copy's bytes match no case: it then
reports whether the copy carries a verifiable Vatermark seal and by whom. A
`DERIVATIVE_SEALED` event type is reserved for a later version.

## Run it locally

Cases needs nothing beyond the app's own setup (see the README): with
`VATERMARK_SERVICE_ID`, `VATERMARK_SERVICE_WIF` and a phone-reachable
`PUBLIC_ORIGIN`, steps can be signed in Verus Mobile; without them, cases can
still be opened, found and exported, and the pages say plainly that nobody can
sign yet. Open the app and press **Cases · beta** in the header, or go to
`/cases`. Case records live in `DATA_DIR/cases/`. This is a VRSCTEST preview:
use test images, not real patient scans.

## Limitations

- VRSCTEST only; no credential layer: a VerusID is not evidence of professional
  standing or organisational authorisation.
- No login or personal queues; a case is reached by its number or by
  presenting the exact artifact bytes. No owner transfer.
- An unanswered assignment is not evidence that the assignee was notified of
  or saw the request; this version records no delivery or access events.
- No escalation, deadline enforcement, comments or corrections
  (`EVENT_SUPERSEDED`); deadlines are recorded on assignments and displayed.
- A package proves the events it contains, never that no later event exists;
  see Event hash and chain.
- Anchoring is pending-only until a node anchorer is configured, and the
  verifier does not yet confirm transactions.
