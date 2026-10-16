# Vatermark

A web app for signing images with a VRSCTEST identity and verifying embedded
image signatures, with an interface inspired by the
[Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/).
React supplies the interface, a TypeScript
server handles wallet requests and chain lookups, and the included Rust engine
processes images on the CPU. No GPU, local Verus daemon, or Firebase service is
required for local development. Nothing is deployed by the local setup below.

The upstream hosted app is **https://vatermark-9f27a.web.app**. Forks use their
own Firebase project; the repository has no default deployment project or
Hosting site. See [FIREBASE_DEPLOYMENT.md](FIREBASE_DEPLOYMENT.md) for setup,
private storage, Secret Manager credentials, callback routing and release steps.

**Verify** works without a signing key. **Sign** requires your existing testnet
service identity and a compatible mobile wallet. No demonstration identity or
private key is configured in this project.

After signing, an optional **Add image details** step lets the same identity
publish an encrypted title, description, or link. Anyone with the signed image
can read those details during verification, without adding bytes to the image's
watermark. The QR and wallet link contain the unencrypted details; the wallet
encrypts them to an address derived from the image signature before publishing.
The wallet must separately approve this identity update and its network fee.
This feature is deployed on the hosted app. A physical-wallet metadata
publication round trip has not yet been completed.
See [IMAGE_METADATA.md](IMAGE_METADATA.md) for the workflow, encryption design,
and verification limits.

## Research basis

Vatermark's current image authentication and watermarking design is adapted from
[Semi-Fragile Image Authentication based on CFD and 3-Bit Quantization
(arXiv:1608.02291)](https://arxiv.org/abs/1608.02291), by Aleksey Zhuvikin,
Valery Korzhik, and Guillermo Morales-Luna (2016). It signs image-derived
features and embeds the signature plus feature-correction data using Haar
wavelets and LDPC error correction.

Our Rust implementation adds VerusID signing and color anchors, with explicit
choices for quantization, framing, and coding. See
[AUTHENTICATION.md](AUTHENTICATION.md) for the implementation details and limits.

The engine also retains the earlier standalone DFT–DCT byte-watermark experiment,
based on [Hybrid blind robust image watermarking technique based on DFT-DCT and
Arnold transform (arXiv:1911.00753)](https://arxiv.org/abs/1911.00753), by Mohamed
Hamidi, Mohamed El Haziti, Hocine Cherifi, and Mohammed El Hassouni (journal
publication 2018; arXiv submission 2019). The web authentication profiles use the
Haar-based design above.

These links are research citations. Paper PDFs, figures, and the authors'
research software are not bundled in this repository. The papers retain their
own copyright and license terms; any MIT license adopted for Vatermark's
original code does not relicense them or third-party dependencies.

## Run locally

Requirements: Node.js **22.13 or newer**, pnpm **11.5.2**, and the stable Rust
toolchain with Cargo. Use the pnpm version recorded in `package.json` (Corepack
can select it automatically).

If you use nvm, run `nvm use` in this directory first. If `pnpm` is not on your
PATH or points to an older Node installation, use `corepack pnpm` in place of
`pnpm` in the commands below.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build:engine
pnpm dev
```

Open **http://127.0.0.1:5173**. The TypeScript server serves the API and Vite
development interface together. The Rust worker is self-contained under
`engine/`; `build:engine` compiles it to `bin/vatermark-worker`. A binary already
built for this machine can be reused, but rebuild after engine changes or when
moving to another machine.

For a local production-build check:

```sh
pnpm build
pnpm start
```

This still runs locally. Publishing requires the separate deployment steps above.

## Configuration

Settings are read from `.env` on server startup. Restart the server after changes.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1`; bind another interface only when needed for phone access |
| `PORT` | `5173` |
| `VERUS_RPC_URL` | `https://api.verustest.net`; public VRSCTEST chain data |
| `VATERMARK_SERVICE_ID` | Existing VRSCTEST service identity i-address; needed for Sign |
| `VATERMARK_SERVICE_WIF` | Secret WIF authorized to sign for that service identity |
| `WALLET_RESPONSE_MODE` | `redirect`; use `post` for HTTPS binary POST callbacks |
| `PUBLIC_ORIGIN` | Callback origin, with no path; defaults to `http://127.0.0.1:5173` in redirect mode (uses configured port/TLS) |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | Optional certificate and key for direct local HTTPS |
| `DATA_DIR` | `.data`; private uploaded images and persisted signing jobs |
| `JOB_STORAGE_BUCKET` | Unset locally; activates private Cloud Storage persistence and hosted defaults |
| `MAX_UPLOAD_BYTES` | `100663296` (96 MiB) |
| `WORKER_CONCURRENCY` | `2`; bounded parallel Rust workers |
| `SIGN_JOB_TTL_MINUTES` | `15`; wallet approval window |
| `OUTPUT_TTL_MINUTES` | `60`; completed-image retention |
| `VATERMARK_WORKER` | `bin/vatermark-worker`; optional alternative worker executable |

Decoded images are limited to **24 million pixels**. Keep `.env`, private data,
and local TLS keys out of source control; their default paths are ignored.
Never prefix the service WIF with `VITE_`: that namespace is for browser-visible
configuration. The WIF stays in the TypeScript service, signs locally, and is
not sent to the browser, Rust worker, wallet QR, or RPC endpoint.

The service identity must be active and use `minimumsignatures = 1`, with the
configured WIF controlling an authorized primary key. It signs the website's
request. The user's identity selected in Mobile signs the image. These are
different signatures; signing an image does not submit a chain transaction.
The service identity address is public in wallet requests; its WIF remains secret.

## Verify an image

1. Open **Verify an image** and choose a PNG or JPEG.
2. Select **Verify signature**.
3. Review the result and the signing identity's name, i-address, and height.
4. If the identity has published optional details for this image, read the
   decrypted title, description, or link below the signature result. Metadata
   retrieval failures are shown separately and do not invalidate the signature.

The server extracts the watermark and looks up historical and current identity
records through `https://api.verustest.net`. It verifies with the keys authorized
at the signing height, so ordinary later key rotations do not replace that
authority. A currently revoked signer is reported separately. RPC failures are
reported as unavailable chain data rather than invalid signatures.

Only VRSCTEST is supported. The app checks existing Vatermark profile `0x31` and
the new mobile profile `0x41`; another network or unsupported profile is not
interpreted as a testnet signature. Neither a service WIF nor a wallet connection
is required for this mode.
Optional image-details lookup also requires `VATERMARK_SERVICE_ID` to identify
the publishing service's public content namespace; it does not require that
service's WIF.

## Sign with Verus Mobile

Configure the service identity and WIF first. The Sign
mode stays disabled with a setup explanation if the service configuration cannot
be used.

**Redirect is the default.** Mobile opens its browser with a signed
`GenericResponse` in the callback URL, so local testing does not require HTTPS
or a public server. For a physical phone on the same network, configure:

```dotenv
HOST=0.0.0.0
PORT=5173
WALLET_RESPONSE_MODE=redirect
PUBLIC_ORIGIN=http://192.168.1.42:5173
```

Replace the example IP with the computer's actual LAN address and restart the
server. Open that origin in the browser. A phone's `localhost` refers to the
phone; it cannot reach the laptop that way. The loopback default is useful when
the returning browser runs on the development computer, such as a compatible
simulator setup. Redirect changes the response transport, not network reachability.

To retain the previous transport, set `WALLET_RESPONSE_MODE=post` and an HTTPS
`PUBLIC_ORIGIN` trusted by the phone. A trusted HTTPS reverse proxy or local TLS
certificate (`TLS_CERT_PATH` and `TLS_KEY_PATH`) works. This project does not
create certificates, alter trust settings, or deploy any service. Use HTTPS for
a public deployment; plain HTTP here is for local testing.

1. In a compatible Verus Mobile build, enable **experimental deeplinks** in
   General settings and link an eligible VRSCTEST identity.
2. In Vatermark, choose **Sign an image**, upload it, and select
   **Create signing request**.
3. Scan the QR with Mobile, or use **Open wallet** on the phone.
4. Select your identity, approve the request, and tap **Complete** in Mobile.
   In redirect mode, Mobile opens the browser to return the signed response.
   The initiating browser keeps polling and receives the finished image. If
   Mobile returns to that same browser, Vatermark restores the signing job;
   otherwise the phone shows guidance to return to the original browser.
5. Download the PNG after the server embeds the user's signature and verifies
   the actual finished image. You can then upload that PNG in Verify mode.
6. Optionally select **Add image details**, enter up to **512 UTF-8 bytes** of
   title, description, and/or link, and create a second wallet request containing
   those details. The wallet encrypts them and requests approval of the identity
   update with the **same signing identity**. This publishes a
   chain transaction with a network fee; the signed image remains downloadable
   throughout. Use **Check publication** after the wallet returns.

The image-signing QR contains a signed `DataPacketRequest` with a short image commitment,
not the image itself. Redirect mode emits exactly one `ResponseURI.TYPE_REDIRECT`;
Mobile appends unpadded base64url response bytes under
`GENERIC_RESPONSE_DEEPLINK_VDXF_KEY.vdxfid`
(`i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC`) to
`/api/sign-jobs/:id/response`. POST mode emits only `TYPE_POST` and sends those
bytes as `application/octet-stream` to the same endpoint. Mobile prefers POST
when both are present, so the request never advertises both transports.

Both routes use the same acceptance function. The server checks the request
binding, expected message, network,
identity authority, and both response signatures before embedding the user's
inner signature. It uses the pinned GitHub versions of `verusid-ts-client`,
`verus-typescript-primitives`, and `verusd-rpc-ts-client`; no sibling repository
is needed at runtime.

After processing a redirect, the server sends a 303 to a clean app URL without
the response bytes; the app removes the return parameters from the address bar.
Callbacks use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
Returning from a wallet never replaces the initiating browser's session cookie
or grants another browser access to the private image. Exact accepted retries
are idempotent across both transports; malformed, expired, and mismatched
responses cannot finalize a job. When testing behind a proxy, omit callback query
strings from access logs: Mobile necessarily puts the signed response in the URL.
Start and return on the same hostname to resume in one browser (`localhost`,
`127.0.0.1`, and a LAN IP have different cookies). If callback validation fails
temporarily, send it again from the wallet or scan the pending request again;
the app does not retain unaccepted response bytes after cleaning the URL.

The lockfile and `pnpm-workspace.yaml` also pin the official VerusCoin
`bitcoin-ops` source tarball at commit
`a5f8f56e658301bc39881d41740b3a0010530efd`. The fork's package file whitelist
omits `evals.json`, which its BitGo consumer requires; using the complete official
source archive retains that file. The primitives and RPC overrides keep the SDKs
on matching revisions and avoid incompatible duplicate class definitions.

For current Mobile compatibility, the callback parser accepts outer signature
wrapper version `0` only in its known standard testnet layout, as well as the
normal wrapper `1`. It still requires the native v2/SHA256 signature, all request
and message bindings, and successful cryptographic verification. Inner data
signatures remain wrapper `1`; this is not a general legacy-signature fallback.

Jobs are private to the originating browser session. Keep the browser's cookies
and use the same origin while waiting or downloading. Requests expire after
15 minutes by default; completed images are retained for 60 minutes. Cancellation
and expiry schedule private-data cleanup. Job state is stored under `.data` so
accepted work can resume across server restarts. The MVP uses a single server
process; it is not a shared multi-instance job queue.
The server bounds simultaneous image requests and callback validations, and
applies per-address request limits. A reverse proxy's clients share its address's
limit; the MVP does not trust arbitrary forwarded IP headers.

## Image support and authentication limits

- PNG and JPEG, arbitrary aspect ratios and odd dimensions. No automatic resize.
- Each dimension must be at least **32 pixels**, and
  `2 × floor(width / 8) × floor(height / 8) >= 8192`. For example, both
  **512 × 512** and **1024 × 256** have sufficient watermark capacity.
- A fully opaque alpha channel is removed. Actual transparency is rejected.
- The prepared preview reflects the image used for signing. Output is PNG;
  original file metadata is not retained. Optional identity-hosted details are
  stored on chain separately from the image.

Vatermark verifies a signature over a reconstructed image descriptor. It is
experimental robust authentication, not a cryptographic hash of every pixel.
Some same-size JPEG compression is tolerated; cropping, resizing, or other
changes may prevent recovery. Known descriptor collisions mean a verified
result does **not** establish authorship, ownership, or exact image integrity.
An unsuccessful extraction does not establish that the image never had a
watermark. Chain state comes from the configured RPC service and is not an
independently validated chain proof.

See [AUTHENTICATION.md](AUTHENTICATION.md) for the algorithm and known limits,
[WATERMARK_FORMAT.md](WATERMARK_FORMAT.md) for the compact envelope, and
[WEB_APP_BRIEF.md](WEB_APP_BRIEF.md) for the full protocol and intended acceptance
criteria. The worker interface is documented in [engine/WORKER.md](engine/WORKER.md).

## Checks

```sh
pnpm check
pnpm test
pnpm test:engine
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The SDK, image-worker, and web tests are separate from a real Mobile integration
test. A complete physical-wallet QR → callback → signed-download cycle has
**not been exercised with a supplied service identity**. Configure your own
testnet identity and complete the flow above before relying on that integration.
Browser tests with synthetic API responses validate interface behavior only.
The optional details feature has separate encryption, protocol, API, and browser
tests. Those checks do not deploy the application or broadcast identity updates.
Its real-wallet approval, transaction publication, and subsequent verification
must still be exercised explicitly; see [IMAGE_METADATA.md](IMAGE_METADATA.md).

## Test identity gift cards

The **Get started** flow distributes pre-created native VRSCTEST identities
through private Verus Mobile gift cards. Generation and funding happen on the
operator's local daemon; the web app assigns stored cards through a direct claim
button, without network cooldowns or claim quotas. Assigned cards remain private
to their browser session. Forks must generate and import their own inventory
before enabling this feature. See [GIFT_CARDS.md](GIFT_CARDS.md) for generation,
private Firebase imports, and the upstream deployment record.

## Cases (beta)

The **Cases · beta** button in the header opens a signed review workflow for
clinical images: open a case for one exact image, ask a colleague to review it,
and get their acceptance, decline and sign-off back as statements they sign in
Verus Mobile. Every step is verified against VRSCTEST identity state and
appended to a hash-chained log that can be exported and checked anywhere with
`pnpm cases:verify`. The feature is folded into `server/cases/`, `src/cases/`
and [CASES.md](CASES.md); the app's own code and signing flow are unchanged.
Cases can be opened and found without a service identity; signing steps needs
the same configuration as image signing above.
