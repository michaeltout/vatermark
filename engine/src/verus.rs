//! Compact VerusID signatures. Trust in identity state comes from the caller or
//! an explicitly selected local Verus daemon; no chain proof is embedded.
//!
//! Vatermark profiles 0x31 and 0x41 fix native signature version 2, SHA256 (hash type 5),
//! and Verus's standard PREFIX. Earlier prototype profiles are unsupported.
//! Serialization follows ../VerusCoin/src/pbaas/crosschainrpc.cpp
//! CIdentitySignature::IdentitySignatureHash, not a Bitcoin message signature.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ripemd::Ripemd160;
use secp256k1::{ecdsa::RecoverableSignature, ecdsa::RecoveryId, Message, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, path::PathBuf, process::Command};

pub const PROFILE: u8 = 0x31;
/// Mobile-compatible UTF-8 commitment profile; the original profile stays unchanged.
pub const MOBILE_PROFILE: u8 = 0x41;
pub const PREFIX: &str = "Verus signed data:\n";
pub const HAS_SYSTEM_ID: u8 = 0x01;
pub const TESTNET: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub version_type: u8,
    pub flags: u8,
    pub identity_id: [u8; 20],
    pub explicit_system_id: Option<[u8; 20]>,
    pub block_height: u32,
    pub signature: [u8; 64],
}

impl Envelope {
    pub fn new(
        identity_id: [u8; 20],
        explicit_system_id: Option<[u8; 20]>,
        testnet: bool,
        block_height: u32,
    ) -> Self {
        Self {
            version_type: PROFILE,
            flags: u8::from(explicit_system_id.is_some()) | (u8::from(testnet) << 1),
            identity_id,
            explicit_system_id,
            block_height,
            signature: [0; 64],
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        self.signing_prefix()?;
        if self.flags & !(HAS_SYSTEM_ID | TESTNET) != 0
            || (self.flags & HAS_SYSTEM_ID != 0) != self.explicit_system_id.is_some()
        {
            return Err("invalid or reserved image signature flags".into());
        }
        if self.identity_id == [0; 20] || self.system_id() == [0; 20] {
            return Err("identity and system IDs must be nonzero".into());
        }
        if self.block_height == 0 {
            return Err("a nonzero signing block height is required".into());
        }
        Ok(())
    }

    /// Both Vatermark profiles use the standard native signing prefix.
    pub fn signing_prefix(&self) -> Result<&'static str, String> {
        match self.version_type {
            PROFILE | MOBILE_PROFILE => Ok(PREFIX),
            _ => {
                Err("unsupported image signature profile (expected Vatermark 0x31 or 0x41)".into())
            }
        }
    }

    /// Metadata to bind into the application message. Height is separately bound
    /// by Verus's native signature digest and may advance during the signing RPC.
    pub fn metadata_bytes(&self) -> Vec<u8> {
        let mut bytes = vec![self.version_type, self.flags];
        bytes.extend_from_slice(&self.identity_id);
        if let Some(system) = self.explicit_system_id {
            bytes.extend_from_slice(&system);
        }
        bytes
    }

    pub fn system_id(&self) -> [u8; 20] {
        self.explicit_system_id
            .unwrap_or_else(|| default_system_id(self.flags & TESTNET != 0))
    }

    pub fn encode(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let mut bytes = self.metadata_bytes();
        bytes.extend_from_slice(&self.block_height.to_le_bytes());
        bytes.extend_from_slice(&self.signature);
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 2 {
            return Err("truncated identity signature envelope".into());
        }
        let explicit = bytes[1] & HAS_SYSTEM_ID != 0;
        let expected = if explicit { 110 } else { 90 };
        if bytes.len() != expected {
            return Err(format!(
                "identity signature envelope must be {expected} bytes"
            ));
        }
        let height_offset = if explicit { 42 } else { 22 };
        let result = Self {
            version_type: bytes[0],
            flags: bytes[1],
            identity_id: bytes[2..22].try_into().unwrap(),
            explicit_system_id: explicit.then(|| bytes[22..42].try_into().unwrap()),
            block_height: u32::from_le_bytes(
                bytes[height_offset..height_offset + 4].try_into().unwrap(),
            ),
            signature: bytes[height_offset + 4..].try_into().unwrap(),
        };
        result.validate()?;
        Ok(result)
    }

    /// Import ONLY the agreed v2/SHA256/single-key native format. Version 1 uses
    /// a different hash profile and must not silently be interpreted as version 2.
    pub fn import_native_signature(&mut self, base64: &str) -> Result<(), String> {
        let bytes = BASE64
            .decode(base64)
            .map_err(|e| format!("invalid native signature Base64: {e}"))?;
        if bytes.len() != 73 || bytes[0] != 2 || bytes[1] != 5 || bytes[6] != 1 || bytes[7] != 65 {
            return Err("requires one native Verus v2/SHA256 compact signature (73 bytes)".into());
        }
        if !(27..=34).contains(&bytes[8]) {
            return Err("invalid native signature recovery header".into());
        }
        secp256k1::ecdsa::Signature::from_compact(&bytes[9..])
            .map_err(|e| format!("invalid ECDSA signature: {e}"))?;
        self.block_height = u32::from_le_bytes(bytes[2..6].try_into().unwrap());
        self.signature.copy_from_slice(&bytes[9..]);
        self.validate()
    }

    fn native_signature(&self, header: u8) -> String {
        let mut bytes = vec![2, 5];
        bytes.extend_from_slice(&self.block_height.to_le_bytes());
        bytes.extend_from_slice(&[1, 65, header]);
        bytes.extend_from_slice(&self.signature);
        BASE64.encode(bytes)
    }
}

/// Identity state *as of height*. A file containing this structure is a trust
/// input, not evidence that an identity exists on a chain. Use VerusCli to query
/// independently trusted chain state for actual VerusID authentication. The web
/// worker receives this structure from the caller without invoking a CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub id: [u8; 20],
    pub system_id: [u8; 20],
    pub testnet: bool,
    pub height: u32,
    pub min_sigs: u32,
    pub revoked: bool,
    pub primary_addresses: Vec<String>,
}

impl Identity {
    fn validate_for(&self, envelope: &Envelope) -> Result<(), String> {
        envelope.validate()?;
        if self.id != envelope.identity_id
            || self.system_id != envelope.system_id()
            || self.testnet != (envelope.flags & TESTNET != 0)
            || self.height != envelope.block_height
        {
            return Err("trusted identity state does not match signature identity, system, network, or height".into());
        }
        if self.revoked {
            return Err("identity was revoked at the requested height".into());
        }
        if self.min_sigs != 1 || self.primary_addresses.is_empty() {
            return Err(
                "compact profile requires a valid identity with minimumsignatures = 1".into(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Verification {
    pub signer_address: String,
    pub native_signature: String,
}

pub fn verify(
    envelope: &Envelope,
    message: &[u8],
    identity: &Identity,
) -> Result<Verification, String> {
    identity.validate_for(envelope)?;
    let authorized: Vec<[u8; 20]> = identity
        .primary_addresses
        .iter()
        .map(|address| decode_address(address, 60))
        .collect::<Result<_, _>>()?;
    let secp = Secp256k1::verification_only();
    let digest = Message::from_digest(signature_digest(envelope, message)?);
    let mut ordinary = secp256k1::ecdsa::Signature::from_compact(&envelope.signature)
        .map_err(|e| format!("invalid ECDSA signature: {e}"))?;
    ordinary.normalize_s();
    for recovery in 0..4 {
        let id = RecoveryId::try_from(recovery).map_err(|e| e.to_string())?;
        let signature = RecoverableSignature::from_compact(&envelope.signature, id)
            .map_err(|e| format!("invalid recoverable signature: {e}"))?;
        let Ok(public) = secp.recover_ecdsa(digest, &signature) else {
            continue;
        };
        if secp.verify_ecdsa(digest, &ordinary, &public).is_err() {
            continue;
        }
        for compressed in [true, false] {
            let bytes = if compressed {
                public.serialize().to_vec()
            } else {
                public.serialize_uncompressed().to_vec()
            };
            let key_id = hash160(&bytes);
            if authorized.contains(&key_id) {
                return Ok(Verification {
                    signer_address: encode_address(&key_id, 60),
                    native_signature: envelope
                        .native_signature(27 + recovery as u8 + if compressed { 4 } else { 0 }),
                });
            }
        }
    }
    Err("image signature does not match any authorized identity signing key".into())
}

/// Exact v2/SHA256 IdentitySignatureHash with empty VDXF/bound-hash arrays.
/// Empty arrays are OMITTED (not serialized as zero-length vectors).
pub fn signature_digest(envelope: &Envelope, message: &[u8]) -> Result<[u8; 32], String> {
    envelope.validate()?;
    let prefix = envelope.signing_prefix()?;
    let mut preimage = Vec::new();
    preimage.extend_from_slice(&envelope.system_id());
    preimage.extend_from_slice(&envelope.block_height.to_le_bytes());
    preimage.extend_from_slice(&envelope.identity_id);
    // The standard prefix is short, so its CompactSize is one byte.
    preimage.push(prefix.len() as u8);
    preimage.extend_from_slice(prefix.as_bytes());
    preimage.extend_from_slice(&Sha256::digest(message));
    Ok(Sha256::digest(preimage).into())
}

/// Explicit local fixture signing, not a claim of on-chain identity ownership.
/// Never use a publicly distributed fixture secret for a real identity.
pub fn sign_fixture(
    envelope: &mut Envelope,
    message: &[u8],
    secret: [u8; 32],
) -> Result<Identity, String> {
    envelope.validate()?;
    let secp = Secp256k1::new();
    let secret =
        SecretKey::from_byte_array(secret).map_err(|e| format!("invalid fixture secret: {e}"))?;
    let public = secret.public_key(&secp);
    let signature = secp.sign_ecdsa_recoverable(
        Message::from_digest(signature_digest(envelope, message)?),
        &secret,
    );
    envelope.signature = signature.serialize_compact().1;
    Ok(Identity {
        id: envelope.identity_id,
        system_id: envelope.system_id(),
        testnet: envelope.flags & TESTNET != 0,
        height: envelope.block_height,
        min_sigs: 1,
        revoked: false,
        primary_addresses: vec![encode_address(&hash160(&public.serialize()), 60)],
    })
}

/// Root name IDs: Hash160(SHA256d(lowercase name)), as in CIdentity::GetID with
/// a null parent. Mainnet VRSC is independently checked against its source-tree
/// i-address test vector below. These bytes are serialized uint160/address bytes.
pub fn default_system_id(testnet: bool) -> [u8; 20] {
    let name: &[u8] = if testnet { b"vrsctest" } else { b"vrsc" };
    hash160(&Sha256::digest(Sha256::digest(name)))
}

fn hash160(bytes: &[u8]) -> [u8; 20] {
    Ripemd160::digest(Sha256::digest(bytes)).into()
}

fn encode_address(id: &[u8; 20], prefix: u8) -> String {
    let mut bytes = vec![prefix];
    bytes.extend_from_slice(id);
    bs58::encode(bytes).with_check().into_string()
}

fn decode_address(address: &str, prefix: u8) -> Result<[u8; 20], String> {
    let bytes = bs58::decode(address)
        .with_check(Some(prefix))
        .into_vec()
        .map_err(|e| format!("invalid address: {e}"))?;
    if bytes.len() != 21 {
        return Err("address must contain a 20-byte identifier".into());
    }
    Ok(bytes[1..].try_into().unwrap())
}

pub fn encode_identity_id(id: &[u8; 20]) -> String {
    encode_address(id, 102)
}
pub fn decode_identity_id(address: &str) -> Result<[u8; 20], String> {
    decode_address(address, 102)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A subprocess adapter for an explicitly selected CLI/node. No shell, wallet
/// file, private-key export, wallet unlocking, or transaction RPC is used.
#[derive(Debug, Clone)]
pub struct VerusCli {
    pub executable: PathBuf,
    /// For example `-testnet` or `-chain=...`; use a separately trusted node.
    pub args: Vec<OsString>,
}

#[derive(Debug, Clone)]
pub struct ChainContext {
    pub system_id: [u8; 20],
    pub testnet: bool,
    pub height: u32,
}

impl VerusCli {
    fn call(&self, method: &str, arguments: &[String]) -> Result<Value, String> {
        let output = Command::new(&self.executable)
            .args(&self.args)
            .arg("-rpcclienttimeout=30")
            .arg(method)
            .args(arguments)
            .output()
            .map_err(|e| format!("cannot run selected Verus CLI: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Verus {method} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("invalid Verus {method} JSON: {e}"))
    }

    pub fn context(&self) -> Result<ChainContext, String> {
        let info = self.call("getinfo", &[])?;
        Ok(ChainContext {
            system_id: decode_identity_id(required_str(&info, "chainid")?)?,
            testnet: info["testnet"].as_bool().ok_or("getinfo missing testnet")?,
            height: required_u32(&info, "blocks")?,
        })
    }

    fn checked_context(&self, envelope: &Envelope) -> Result<ChainContext, String> {
        envelope.validate()?;
        let context = self.context()?;
        if context.system_id != envelope.system_id()
            || context.testnet != (envelope.flags & TESTNET != 0)
        {
            return Err("selected Verus node is on a different system or network".into());
        }
        if context.height < envelope.block_height {
            return Err("selected Verus node has not reached the signing height".into());
        }
        Ok(context)
    }

    /// Resolve a user-selected identity on the selected node before constructing
    /// the application message. Non-root systems require the explicit ID field.
    pub fn prepare(&self, identity_name: &str, explicit_system: bool) -> Result<Envelope, String> {
        let context = self.context()?;
        if !explicit_system && context.system_id != default_system_id(context.testnet) {
            return Err("non-default Verus system requires an explicit system ID".into());
        }
        let response = self.call(
            "getidentity",
            &[identity_name.to_owned(), context.height.to_string()],
        )?;
        let id = decode_identity_id(required_str(&response["identity"], "identityaddress")?)?;
        let envelope = Envelope::new(
            id,
            explicit_system.then_some(context.system_id),
            context.testnet,
            context.height,
        );
        identity_from_rpc(&response, &envelope)?.validate_for(&envelope)?;
        Ok(envelope)
    }

    pub fn lookup_identity(&self, envelope: &Envelope) -> Result<Identity, String> {
        self.checked_context(envelope)?;
        let response = self.call(
            "getidentity",
            &[
                encode_identity_id(&envelope.identity_id),
                envelope.block_height.to_string(),
            ],
        )?;
        let identity = identity_from_rpc(&response, envelope)?;
        identity.validate_for(envelope)?;
        Ok(identity)
    }

    /// Invoke only in response to an explicit signing action for this identity.
    /// The application message must use metadata_bytes(), not encode(), because
    /// signdata chooses the final height atomically inside the daemon.
    pub fn sign(&self, envelope: &mut Envelope, message: &[u8]) -> Result<Identity, String> {
        if envelope.version_type != PROFILE {
            return Err(
                "new signatures require Vatermark profile 0x31 with the standard Verus prefix"
                    .into(),
            );
        }
        self.lookup_identity(envelope)?;
        let mut request = native_message_request(envelope, message)?;
        request["createmmr"] = json!(false);
        let response = self.call("signdata", &[request.to_string()])?;
        if decode_identity_id(required_str(&response, "address")?)? != envelope.identity_id
            || decode_identity_id(required_str(&response, "systemid")?)? != envelope.system_id()
            || required_str(&response, "hashtype")? != "sha256"
        {
            return Err(
                "Verus signing response has inconsistent identity/system/hash context".into(),
            );
        }
        // signdata signs with every available primary key, even when minSigs=1.
        // Keep one compact signature, then verify its authority below. This does
        // not reduce a multisig threshold: lookup_identity has already required 1.
        envelope.import_native_signature(&first_native_signature(required_str(
            &response,
            "signature",
        )?)?)?;
        let identity = self.lookup_identity(envelope)?;
        let verification = verify(envelope, message, &identity)?;
        self.verify_native(envelope, message, &verification)?;
        Ok(identity)
    }

    pub fn verify_on_chain(
        &self,
        envelope: &Envelope,
        message: &[u8],
    ) -> Result<Verification, String> {
        let identity = self.lookup_identity(envelope)?;
        let verification = verify(envelope, message, &identity)?;
        // Historical identity state is explicitly checked above. The native RPC
        // additionally applies the node's current identity/revocation policy.
        self.verify_native(envelope, message, &verification)?;
        Ok(verification)
    }

    fn verify_native(
        &self,
        envelope: &Envelope,
        message: &[u8],
        verification: &Verification,
    ) -> Result<(), String> {
        let mut request = native_message_request(envelope, message)?;
        request["checklatest"] = json!(false);
        request["signature"] = json!(verification.native_signature);
        let response = self.call("verifysignature", &[request.to_string()])?;
        if required_str(&response, "signaturestatus")? != "verified" {
            return Err("native Verus verification did not report a complete signature".into());
        }
        Ok(())
    }
}

/// Keep native signing and verification aligned with local digest selection.
fn native_message_request(envelope: &Envelope, message: &[u8]) -> Result<Value, String> {
    envelope.validate()?;
    Ok(json!({
        "address": encode_identity_id(&envelope.identity_id),
        "messagehex": hex(message), "prefixstring": envelope.signing_prefix()?,
        "hashtype": "sha256"
    }))
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("Verus response missing string {field}"))
}

fn first_native_signature(encoded: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|e| format!("invalid native signature Base64: {e}"))?;
    if bytes.len() < 7 || bytes[0] != 2 || bytes[1] != 5 {
        return Err("requires native Verus v2/SHA256 signatures".into());
    }
    let count = bytes[6] as usize;
    if !(1..=25).contains(&count) || bytes.len() != 7 + 66 * count {
        return Err("invalid native signature vector".into());
    }
    for signature in bytes[7..].chunks_exact(66) {
        if signature[0] != 65 || !(27..=34).contains(&signature[1]) {
            return Err("invalid native compact signature record".into());
        }
    }
    let mut single = bytes[..73].to_vec();
    single[6] = 1;
    Ok(BASE64.encode(single))
}

fn required_u32(value: &Value, field: &str) -> Result<u32, String> {
    value[field]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| format!("Verus response missing u32 {field}"))
}

fn identity_from_rpc(response: &Value, envelope: &Envelope) -> Result<Identity, String> {
    let value = &response["identity"];
    let id = decode_identity_id(required_str(value, "identityaddress")?)?;
    let system_id = decode_identity_id(required_str(value, "systemid")?)?;
    let record_height = required_u32(response, "blockheight")?;
    if record_height > envelope.block_height {
        return Err("Verus returned an identity update newer than the signing height".into());
    }
    if !matches!(required_u32(value, "version")?, 1..=3) {
        return Err("unsupported Verus identity version".into());
    }
    let flags = required_u32(value, "flags")?;
    let addresses = value["primaryaddresses"]
        .as_array()
        .ok_or("missing primaryaddresses")?;
    let primary_addresses = addresses
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "non-string primary address".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    for address in &primary_addresses {
        decode_address(address, 60)?;
    }
    Ok(Identity {
        id,
        system_id,
        testnet: envelope.flags & TESTNET != 0,
        height: envelope.block_height,
        min_sigs: required_u32(value, "minimumsignatures")?,
        revoked: flags & 0x8000 != 0 || required_str(response, "status")? != "active",
        primary_addresses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(explicit: bool, testnet: bool) -> (Envelope, Identity) {
        let mut envelope = Envelope::new([3; 20], explicit.then_some([9; 20]), testnet, 123456);
        let identity = sign_fixture(
            &mut envelope,
            b"image descriptor + helpers + settings",
            [1; 32],
        )
        .unwrap();
        (envelope, identity)
    }

    #[test]
    fn native_root_identifier_known_mainnet_vector() {
        // ../VerusCoin/src/wallet/rpcwallet.cpp contains this VRSC i-address.
        assert_eq!(
            encode_identity_id(&default_system_id(false)),
            "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
        );
        assert_ne!(default_system_id(false), default_system_id(true));
        for network in [false, true] {
            let id = default_system_id(network);
            assert_eq!(decode_identity_id(&encode_identity_id(&id)).unwrap(), id);
        }
    }

    #[test]
    fn native_sha256_digest_has_independent_openssl_vector() {
        let envelope = Envelope::new([3; 20], Some([9; 20]), false, 123456);
        // Constructed independently with the C++ serialization order and checked
        // with OpenSSL SHA256 (not a roundtrip through our signer/verifier).
        assert_eq!(
            hex(&signature_digest(&envelope, b"image descriptor + helpers + settings").unwrap()),
            "73f4a069782cee486ee2e5278c7cb81290e52b40a61127e6cb499d9498390b76"
        );
    }

    #[test]
    fn signatures_reject_unsupported_profiles() {
        let message = b"image descriptor + helpers + settings";
        let mut envelope = Envelope::new([3; 20], None, false, 123456);
        let identity = sign_fixture(&mut envelope, message, [1; 32]).unwrap();
        let serialized = envelope.encode().unwrap();
        let decoded = Envelope::decode(&serialized).unwrap();
        verify(&decoded, message, &identity).unwrap();
        for profile in [0x11, 0x21, 0x51] {
            envelope.version_type = profile;
            assert!(verify(&envelope, message, &identity).is_err());
            assert!(sign_fixture(&mut envelope, message, [1; 32]).is_err());
        }
    }

    #[test]
    fn native_rpc_requests_use_the_exact_profile_prefix() {
        let mut envelope = Envelope::new([3; 20], None, false, 123456);
        assert_eq!(envelope.version_type, PROFILE);
        assert_eq!(PREFIX.as_bytes(), b"Verus signed data:\n");
        assert_eq!(PREFIX.len(), 19);
        let request = native_message_request(&envelope, b"image message").unwrap();
        assert_eq!(request["prefixstring"], PREFIX);
        assert_eq!(request["messagehex"], "696d616765206d657373616765");
        assert_eq!(request["hashtype"], "sha256");
        assert_eq!(
            request["address"],
            encode_identity_id(&envelope.identity_id)
        );
        for profile in [0x11, 0x21, 0x51] {
            envelope.version_type = profile;
            assert!(native_message_request(&envelope, b"image message").is_err());
            assert!(signature_digest(&envelope, b"image message").is_err());
        }
    }

    #[test]
    fn wallet_signing_rejects_unsupported_profiles_before_contacting_a_node() {
        let mut envelope = Envelope::new([3; 20], None, false, 123456);
        let cli = VerusCli {
            executable: PathBuf::from("/nonexistent/verus-cli"),
            args: vec![],
        };
        for profile in [0x11, 0x21, 0x41, 0x51] {
            envelope.version_type = profile;
            let error = cli.sign(&mut envelope, b"image message").unwrap_err();
            assert!(error.contains("new signatures require Vatermark profile 0x31"));
        }
    }

    #[test]
    fn sizes_roundtrip_and_native_reconstruction() {
        for explicit in [false, true] {
            for testnet in [false, true] {
                let (envelope, identity) = fixture(explicit, testnet);
                let bytes = envelope.encode().unwrap();
                assert_eq!(bytes.len(), if explicit { 110 } else { 90 });
                assert_eq!(Envelope::decode(&bytes).unwrap(), envelope);
                let checked = verify(
                    &envelope,
                    b"image descriptor + helpers + settings",
                    &identity,
                )
                .unwrap();
                let native = BASE64.decode(&checked.native_signature).unwrap();
                assert_eq!(native.len(), 73);
                let mut imported = Envelope::new(
                    envelope.identity_id,
                    envelope.explicit_system_id,
                    testnet,
                    1,
                );
                imported
                    .import_native_signature(&checked.native_signature)
                    .unwrap();
                assert_eq!(imported, envelope);
            }
        }
    }

    #[test]
    fn wrong_message_identity_authority_height_and_network_fail() {
        let (envelope, identity) = fixture(false, false);
        let msg = b"image descriptor + helpers + settings";
        assert!(verify(&envelope, b"different image", &identity).is_err());
        for mutation in 0..8 {
            let mut id = identity.clone();
            match mutation {
                0 => id.id[0] ^= 1,
                1 => id.system_id[0] ^= 1,
                2 => id.height += 1,
                3 => id.testnet = true,
                4 => id.revoked = true,
                5 => id.min_sigs = 2,
                6 => id.primary_addresses.clear(),
                _ => id.primary_addresses[0] = encode_address(&[0; 20], 60),
            }
            assert!(verify(&envelope, msg, &id).is_err());
        }
        let mut changed = envelope.clone();
        changed.block_height += 1;
        let mut same_height_id = identity.clone();
        same_height_id.height = changed.block_height;
        assert!(verify(&changed, msg, &same_height_id).is_err());
    }

    #[test]
    fn strict_envelope_and_native_profile_validation() {
        let (envelope, identity) = fixture(false, false);
        let mut bytes = envelope.encode().unwrap();
        bytes[1] |= 4;
        assert!(Envelope::decode(&bytes).is_err());
        assert!(Envelope::decode(&bytes[..89]).is_err());
        assert!(Envelope::decode(&[0; 110]).is_err());
        let result = verify(
            &envelope,
            b"image descriptor + helpers + settings",
            &identity,
        )
        .unwrap();
        let mut native = BASE64.decode(result.native_signature).unwrap();
        native[1] = 4;
        assert!(envelope
            .clone()
            .import_native_signature(&BASE64.encode(native))
            .is_err());
        let mut unknown = envelope;
        unknown.version_type = 0x51;
        assert!(unknown.encode().is_err());
    }

    #[test]
    fn one_of_many_native_signatures_can_fit_one_threshold_profile() {
        let (envelope, identity) = fixture(false, false);
        let checked = verify(
            &envelope,
            b"image descriptor + helpers + settings",
            &identity,
        )
        .unwrap();
        let one = BASE64.decode(&checked.native_signature).unwrap();
        let mut multiple = one.clone();
        multiple[6] = 2;
        multiple.extend_from_slice(&one[7..]);
        assert_eq!(
            first_native_signature(&BASE64.encode(multiple)).unwrap(),
            checked.native_signature
        );
        assert!(first_native_signature(&BASE64.encode([2, 5, 0, 0, 0, 0, 255])).is_err());
    }

    #[test]
    fn supports_uncompressed_identity_key_address() {
        let (envelope, mut identity) = fixture(false, false);
        let key = SecretKey::from_byte_array([1; 32])
            .unwrap()
            .public_key(&Secp256k1::new());
        identity.primary_addresses =
            vec![encode_address(&hash160(&key.serialize_uncompressed()), 60)];
        let result = verify(
            &envelope,
            b"image descriptor + helpers + settings",
            &identity,
        )
        .unwrap();
        assert!((27..=30).contains(&BASE64.decode(result.native_signature).unwrap()[8]));
    }

    #[test]
    fn rpc_identity_requires_historical_active_matching_state() {
        let (envelope, identity) = fixture(false, false);
        let mut response = json!({"status":"active", "blockheight":123450,
            "identity":{"version":3, "identityaddress":encode_identity_id(&identity.id),
                "systemid":encode_identity_id(&identity.system_id), "flags":0,
                "minimumsignatures":1,"primaryaddresses":identity.primary_addresses}});
        identity_from_rpc(&response, &envelope)
            .unwrap()
            .validate_for(&envelope)
            .unwrap();
        response["blockheight"] = json!(123457);
        assert!(identity_from_rpc(&response, &envelope).is_err());
    }
}
