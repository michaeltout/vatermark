# Vatermark image worker

Build: `cargo build --release --locked --bin vatermark-worker`.
Test: `cargo test --release --locked`.

Each invocation reads one JSON object from stdin until EOF, writes one JSON object
on stdout, then exits. No hosted command runs a daemon, wallet, or network request.
The original `vatermark` CLI remains available for development separately.

The service supplies absolute private paths; browser filenames must never become
worker paths. Output paths must not already exist. Unix output permissions are
0600. Successful responses contain `ok: true`. Failures contain
`{"ok":false,"error":{"code":"...","message":"..."}}` and exit status 1.

Commands:

```text
{cmd:"prepare", input, normalized_output}
  -> {ok,width,height,previewPath,prepared}

{cmd:"inspect", input}
  -> {ok,profile,flags,identityId,systemId,testnet,signingHeight,width,height,
      message,messageHex,helperHex,signatureHex,envelopeBytes}

{cmd:"verify", input, identity}
  -> {ok,verification,nativeSignature,signerAddress}

{cmd:"finalize", input, output, prepared, identityId, nativeSignature, identity}
  -> {ok,width,height,verification,nativeSignature,report}
```

`prepared` is a private server record with `profile`, `flags`, `systemId`, `width`,
`height`, `helperHex`, `quantized`, `message`, `commitment`, and `sourceSha256`.
It must be retained unchanged with the normalized PNG. Source SHA256 covers
little-endian width and height followed by RGB8 pixels; it binds private job state
and is not part of the robust watermark. Finalization remeasures the source and
compares all prepared fields, verifies the approved signature, embeds the packet,
encodes PNG, decodes it, and verifies it before writing an output file.

`identity` is server-fetched historical authority, never image/browser metadata:

```text
{id: [20 raw bytes], system_id: [20 raw bytes], testnet: true,
 height: <signature height>, min_sigs: 1, revoked: false,
 primary_addresses: ["R..."]}
```

Its `height` is the requested signature height; the chain record's update height
may precede it. The service validates effective historical state and current
revocation policy separately. Inspection alone does not establish authenticity.

Inputs are PNG/JPEG up to 96 MiB and 24 million decoded pixels. Alpha must be fully
opaque at its original precision. EXIF orientation is applied before converting to
RGB8, preparing features, or previewing the normalized PNG. Existing native size
and capacity constraints apply. Signature profiles 0x31 and 0x41 are verifiable;
preparation creates profile 0x41 with implicit VRSCTEST. The worker rejects other
networks/systems. No signing key is passed to this process.

Error codes: `invalid_request`, `invalid_image`, `io_error`,
`unsupported_network`, `unsupported_profile`, `no_watermark`, and
`authentication_failed`. `no_watermark` means no supported frame could be
recovered; it does not establish that the image never contained a watermark.

`tests/fixtures/mobile-profile.json` is an independently generated canonical
record/message/native-digest vector for cross-language SDK validation. Tests use
clearly local fixture identities and do not assert on-chain identity ownership.
