# Test identity gift cards

The **Get started** button gives a visitor a pre-created native VRSCTEST identity
and 1 VRSCTEST in a Verus Mobile gift card. Key generation, identity registration,
and funding run only on the operator's local machine. The web app atomically
assigns one existing card without network checks or claim quotas.
It does not run a daemon, generate gift keys, register identities, or submit
claim transactions.

The upstream feature is deployed at **https://vatermark-9f27a.web.app**. Its hosted
pool was initialized with 99 cards; the one card already issued locally was
excluded. Upstream local issuance is disabled to prevent duplicate distribution.
Forks must create their own cards and private inventory; none are included in
the repository. The following completed-batch record describes the upstream
deployment, not a prerequisite or an inventory available to forks.

## Upstream completed batch — 14 October 2026

Batch `1ea3dc234cfb5781a4dc4a785689f3d0` contains **100 confirmed native
identities and 100 gift cards**, each funded with exactly 1 VRSCTEST before claim
fees. All 100 were imported locally. One was subsequently issued locally; the
remaining 99 were imported into the private Firebase inventory.
All 207 batch transactions are confirmed. Exact net cost was **2,200.0401
VRSCTEST**: 2,000 for gift registrations after rebates, 100 for the two referral
anchors, 100 for gift balances, and 0.0401 in other transaction fees. This excludes
the previously created root identity.

Private files (bearer secrets; do not publish):

- Inventory: `.data/gift-batches/1ea3dc234cfb5781a4dc4a785689f3d0.inventory.json`
- Resumable journal: `.data/gift-batches/1ea3dc234cfb5781a4dc4a785689f3d0.state.json`
- Original local allocations: `.data/gifts/state.json`
- Filtered hosted inventory: `.data/gift-batches/1ea3dc234cfb5781a4dc4a785689f3d0.hosted.inventory.json`
- Live allocations: private bucket object `gifts/state-v1.json`

Open **Get started** on the deployed website and press the claim button to
receive a card. Testnet must be enabled in Verus Mobile. Local image signing and
verification remain available, while local gift issuance stays disabled.
Keep the local allocation state so future imports continue excluding its issued card.

An independent read-only audit verified every card's key derivation, active
identity authority, confirmed registration, three referral rebates, exact
unspent funding, and native signatures through the SDK, `verifysignature`, and
`verifyhash`. A changed-message check failed as expected. The audit imported no
keys and claimed no cards. Automated release tests also make no gift claims.
Repeated generation of the completed journal and repeated inventory import were
also verified to be no-ops. API/tool tests and desktop/mobile browser tests
passed.

## Native identities and referral costs

Gift names have the form `brightotter.vrsctest@`, with a randomly selected
adjective and noun. These are native identities, not subidentities under
`vatermark.vrsctest@`. Native registration avoids the token launch currently
blocked by VRSCTEST's notification oracle.

The local operator retains three referral identities, starting with the existing
`vatermark.vrsctest@`. Each gift registration refers to the end of that chain.
A referred registration pays 80 VRSCTEST up front and sends 20 to each of three
referral ancestors, giving a net registration cost of 20. All three recipients
remain controlled by the local daemon wallet. Referral proceeds do not go to
the gift cards.

For the initial batch of 100, allow approximately:

| Item | Net VRSCTEST |
| --- | ---: |
| Two additional referral anchors | 100 |
| 100 native gift registrations | 2,000 |
| 1 VRSCTEST per gift card | 100 |
| Transaction fees | Additional small fees |

The original Vatermark registration was already paid for. Its earlier 210
VRSCTEST launch funding remains under the operator's control; the rejected
token launch did not spend its 200 VRSCTEST definition fee.

## Generate another batch locally

Use Node 22.13 or later and install the project's dependencies. The generator
uses the local Verus CLI and its existing daemon configuration. It checks that
the connected chain is VRSCTEST before submitting transactions. Set `VERUS_CLI`
if the CLI is not in the adjacent `VerusCoin` checkout or the usual Desktop
installation location. No RPC credentials belong in the web app.

First create a private plan:

```sh
node --import tsx scripts/generate-gifts.ts --count 100
```

This prints a journal path under `.data/gift-batches/`. It creates keys but sends
no transactions. Execute that exact journal:

```sh
node --import tsx scripts/generate-gifts.ts --state .data/gift-batches/BATCH.state.json --execute
```

Run only one generator against this daemon wallet at a time. The tool saves
each signed transaction before broadcasting, waits for confirmations, verifies
identity authority and funding, and only then exports `BATCH.inventory.json`.
Commitments use independent fee outputs to avoid a long chain of unconfirmed
transactions. Registrations also use separate operator-controlled funding addresses, each prefunded with 80.001 VRSCTEST, and are processed in bounded groups. This avoids the daemon selecting a pending transaction’s already-spent inputs. The prefunding remains in the operator wallet and is not an additional net charge. A failed registration is replaced automatically only when a confirmed transaction from the same journal proves its conflicting inputs were spent; the original bytes are retained for audit.

After interruption, resume the **same journal** with the same command. Do not
start a fresh batch to retry an unfinished one. A completed journal reports its
existing inventory instead of creating or funding more cards. Keep the journals
so later batches avoid previously selected names.

An interrupted generator can leave `.generator.lock` beside the journal. It
fails closed rather than automatically removing an existing lock. To recover:

1. Stop every gift generator using this daemon wallet, including background
   processes. Check the numeric PID in `.data/gift-batches/.generator.lock` and
   verify that process has exited. Do not remove a lock merely because it is old.
2. Once no generator is running, remove **only** that lock:
   `rm .data/gift-batches/.generator.lock`. If you chose another batch directory,
   use its `.generator.lock` instead. Keep every journal and saved transaction.
3. Resume the same `BATCH.state.json` with `--execute`; do not create a replacement
   batch. An empty or malformed lock also requires confirming that all writers
   have stopped before manual removal.

The old 200-subidentity plan is retained separately as an unfinished historical
file. It is not a distributable inventory and must not be imported.

## Gift contents and wallet compatibility

Each card is an unsigned, testnet `GenericRequest` containing one
`SpendableKeyDetailsOrdinalVDXFObject`. It carries 32 bytes of independently
generated BIP39 entropy, with no password encryption. The request's wallet
deeplink is also the QR payload.

Address derivation matches Verus Mobile: convert entropy to the exact English
24-word mnemonic, SHA-256 its UTF-8 text, apply the wallet's bit clamping, and
derive its compressed secp256k1 R-address. This is not a BIP32 account path.
The identity has one primary address, with itself as recovery and revocation
authority. Claiming in Mobile changes primary control to the recipient wallet.

Each card is funded with exactly 1 VRSCTEST **before** the wallet's claim fee.
The combined identity-and-funds claim normally deducts approximately 0.0002
VRSCTEST. Enable testnet and experimental deeplinks in Verus Mobile, claim the
card, wait for confirmation, then select the identity when signing an image.

These QR codes are bearer secrets. Anyone with a card's link or seed can claim
it until the wallet's claim confirms. Do not post screenshots or put inventories
in source control, static hosting, logs, or a publicly shared download folder.

## Import and test locally

Only import a completed inventory, never the generation journal:

```sh
node --import tsx scripts/import-gifts.ts --file .data/gift-batches/BATCH.inventory.json
```

The default destination is `.data/gifts/state.json`. Input and state files use
private permissions (`0600`) inside private directories. Import validates the
wallet encoding, derived funding address, native identity ID, and duplicates.
Repeating an import preserves all existing claims and adds no duplicate cards.
If the app uses a custom `DATA_DIR` or `GIFTS_STATE_FILE`, pass the matching
absolute destination with `--state /private/path/state.json`; the import command
does not load the app's `.env` configuration.

Back up the runtime state along with the original inventories. Do not delete or
replace `state.json` to add a batch: it records which cards have already been
issued. If that state is lost, restore it before serving the existing inventory;
reimporting into an empty state could issue previously allocated cards again.

Configure the local `.env`:

```dotenv
HOST=127.0.0.1
GIFTS_ENABLED=true
```

Keep `PUBLIC_ORIGIN` blank to use the configured localhost port, then run
`node --import tsx server/index.ts`. Open **Get started** and press the claim
button to receive a card. QR generation happens in the browser. Reloading or
reopening the dialog retrieves the same card for that browser session.

A phone can scan a gift QR from the desktop without connecting to the desktop's
localhost server. To open the web app from another device, configure its LAN
address as described in the README.

## Claim protection and server work

- A direct button press requests a card; the server validates the request and
  atomically assigns an available card to the browser session.
- An HttpOnly, SameSite cookie owns the allocation. There is no inventory-list
  or card-by-ID endpoint. Other sessions cannot retrieve that allocation.
- A committed allocation is never returned to the available pool. Lost HTTP
  responses and retries retrieve the same card.
- Claims have no network cooldown, hourly/daily quota, request-rate limit, or
  service-level concurrent-claim cap. New assignments store no network data.
  Existing assignments with legacy network hashes remain readable.
- File locking plus atomic replacement protects local claims. Hosted claims
  use an object generation condition, preserving uniqueness across instances.
- The server performs local checks and small private JSON reads/writes.
  It makes no daemon or third-party verification calls for gift issuance.

A new browser session can receive another card until the inventory is exhausted.
The ownership cookie expires 24 hours after it is created. Clearing cookies or letting that cookie expire loses access to a
previously assigned card, so users should complete the wallet claim promptly.

If a local process crashes while holding `state.json.lock`, stop all inventory
writers before removing that lock. The server deliberately does not steal locks
based on age. Hosted generation checks need no lock cleanup.

## Add inventory to Firebase

Do not upload a gift inventory to Firebase Hosting. Before moving a batch that
was used locally, set local `GIFTS_ENABLED=false` and restart or stop that local
server. Leave local issuance disabled after migration so both environments
cannot hand out the same remaining cards. Keep the original runtime state; its
assignments remain excluded even after browser cookies expire.

Optionally export a private candidate for offline review. This writes no cloud
data and prints only counts and its output path:

```sh
node --import tsx scripts/import-gifts.ts --file .data/gift-batches/BATCH.inventory.json \
  --exclude-assigned-state .data/gifts/state.json \
  --export-unassigned .data/gift-batches/BATCH.hosted.inventory.json
```

Import directly from the original inventory using the same exclusion state and
an authenticated Firebase CLI login. Select your own project and private bucket
(the bucket must be the app's configured `JOB_STORAGE_BUCKET`):

```sh
FIREBASE_PROJECT_ID=your-project-id
JOB_STORAGE_BUCKET="${FIREBASE_PROJECT_ID}-private-jobs"
node --import tsx scripts/import-gifts.ts --file .data/gift-batches/BATCH.inventory.json \
  --exclude-assigned-state .data/gifts/state.json \
  --cloud --project "$FIREBASE_PROJECT_ID" \
  --bucket "$JOB_STORAGE_BUCKET"
```

The importer locks the local source while filtering and merging, checks every
input card against its original local record, and omits all assigned cards.
Repeated imports preserve existing cloud claims and add no duplicate cards.
If a locally assigned card is already present in cloud storage, import stops
for reconciliation. It also refuses cloud import without the exclusion option
when the default local runtime contains that batch. For a custom local runtime,
always provide its actual path with `--exclude-assigned-state`; do not substitute
an empty state. New batches never used locally can omit the exclusion option.

This command uploads private inventory only. It does not deploy code, change
IAM, replace existing assignments, or generate new cards. It refuses buckets
outside the specified project or without uniform access, enforced public
access prevention, and non-public bucket IAM. Bucket lifecycle deletion must
exclude `gifts/state-v1.json`; restrict short-lived image deletion to `jobs/`.
Unknown lifecycle fields or deletion rules that could match gift state stop the
import. Authentication tokens stay in memory and are never printed. Keep
`firebase` on PATH, or set `FIREBASE_TOOLS_DIR` to its installed package directory.

After a successful import, set `GIFTS_ENABLED=true` on your hosted app to read inventory from
the private bucket. The runtime uses private object `gifts/state-v1.json` in the
configured `JOB_STORAGE_BUCKET`. Local and hosted claims use the same allocation
logic. Gift endpoints bypass the common API rate limiter and have no network
checks, so visitors behind the same Firebase proxy can each receive a card.
The browser session retrieves its existing assignment on retries; inventory
storage, session ownership, and atomic assignment keep each card private and
prevent the same card being assigned to different recipients.

The protocol implementation was checked against the adjacent Verus-Mobile gift
card flow, verus-typescript-primitives, and VerusCoin daemon source. The local
tests use synthetic, unfunded keys; real inventories remain under `.data/`.
