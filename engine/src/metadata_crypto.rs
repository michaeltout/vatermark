//! Image-held metadata capabilities and Verus `signdata` data-descriptor encryption.
//!
//! This implements CDataDescriptor::WrapEncrypted / CVDXFEncryptor, not a new
//! cipher format: Sapling Jubjub agreement, Zcash_SaplingKDF, and IETF
//! ChaCha20-Poly1305. It uses the Sapling primitives used by VerusCoin/librustzcash
//! (04343e16f1d0078ff4529890240ebf082410e3df). No wallet or proving parameters are
//! needed. Encryption is not a signature; the identity update authorizes the
//! published record, and any nested signdata signature must be checked separately.
//!
//! The image signature is a bearer capability. Public chain records contain only
//! its independent locator, recipient address and ciphertext, never the incoming
//! viewing key, SSK, image signature, or master seed. Do not fund these addresses:
//! this scheme intentionally does not derive a spending key.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bech32::ToBase32;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use ff::Field;
use group::{cofactor::CofactorGroup, Group, GroupEncoding};
use rand::rngs::OsRng;
use sapling_crypto::{Diversifier, SaplingIvk};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub const MAX_METADATA_BYTES: usize = 16 * 1024;
const MAX_DESCRIPTOR_BYTES: usize = MAX_METADATA_BYTES + 1024;
const DESCRIPTOR_KEY: &str = "i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv";
const MIME: &str = "application/json";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MetadataContext {
    pub profile: u8,
    pub identity_id: String,
    pub system_id: String,
    pub native_signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublicCapability {
    pub version: u8,
    pub z_address: String,
    pub locator: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EncryptedMetadata {
    pub version: u8,
    pub z_address: String,
    pub locator: String,
    pub datadescriptor: Value,
}

struct Capability {
    ivk: SaplingIvk,
    diversifier: Diversifier,
    public: PublicCapability,
}

impl Drop for Capability {
    fn drop(&mut self) {
        // jubjub::Fr does not implement Zeroize. Clear its owning slot; avoid
        // claiming this erases every compiler-created copy of field arithmetic.
        self.ivk.0 = jubjub::Fr::ZERO;
    }
}

fn identity_bytes(value: &str) -> Result<[u8; 20], String> {
    let bytes = bs58::decode(value)
        .with_check(None)
        .into_vec()
        .map_err(|_| "metadata context has an invalid identity address")?;
    if bytes.len() != 21 || bytes[0] != 102 || bytes[1..].iter().all(|v| *v == 0) {
        return Err("metadata context requires a nonzero i-address".into());
    }
    Ok(bytes[1..].try_into().unwrap())
}

fn capability(context: &MetadataContext) -> Result<Capability, String> {
    if !matches!(context.profile, 0x31 | 0x41) {
        return Err("unsupported image signature profile for metadata".into());
    }
    let mut native = Zeroizing::new(
        BASE64
            .decode(&context.native_signature)
            .map_err(|_| "invalid native image signature")?,
    );
    if native.len() != 73
        || native[0..2] != [2, 5]
        || native[6..8] != [1, 65]
        || !(27..=34).contains(&native[8])
        || native[2..6] == [0; 4]
    {
        return Err("metadata requires a Verus v2/SHA256 single-key image signature".into());
    }
    let mut signature = secp256k1::ecdsa::Signature::from_compact(&native[9..])
        .map_err(|_| "invalid native image signature")?;
    signature.normalize_s();
    native[9..].copy_from_slice(&signature.serialize_compact());
    // The recovery header is reconstructed rather than carried by the watermark.
    // Normalize S and omit this header so equivalent signatures derive one key.
    let mut material = Zeroizing::new(vec![1, context.profile]);
    material.extend_from_slice(&identity_bytes(&context.identity_id)?);
    material.extend_from_slice(&identity_bytes(&context.system_id)?);
    material.extend_from_slice(&native[..8]);
    material.extend_from_slice(&native[9..]);
    let seed = Zeroizing::new(blake3::derive_key(
        "Vatermark image metadata capability v1",
        &material,
    ));
    let mut wide = Zeroizing::new([0; 64]);
    let mut hasher =
        blake3::Hasher::new_derive_key("Vatermark image metadata Sapling incoming viewing key v1");
    hasher.update(seed.as_ref());
    hasher.finalize_xof().fill(wide.as_mut());
    let scalar = jubjub::Fr::from_bytes_wide(&wide);
    if bool::from(scalar.is_zero()) {
        return Err("invalid derived metadata viewing key".into());
    }
    let ivk = SaplingIvk(scalar);
    let mut diversifier = None;
    for counter in 0u32..1024 {
        let mut input = Zeroizing::new(Vec::with_capacity(36));
        input.extend_from_slice(seed.as_ref());
        input.extend_from_slice(&counter.to_le_bytes());
        let bytes = blake3::derive_key("Vatermark image metadata Sapling diversifier v1", &input);
        let candidate = Diversifier(bytes[..11].try_into().unwrap());
        if candidate.g_d().is_some() {
            diversifier = Some(candidate);
            break;
        }
    }
    let diversifier = diversifier.ok_or("cannot derive metadata Sapling diversifier")?;
    let address = ivk
        .to_payment_address(diversifier)
        .ok_or("cannot derive metadata Sapling address")?;
    // Verus mainnet AND VRSCTEST use the main Sapling HRP `zs`. VRSCTEST is
    // a PBaaS chain; it is not Zcash's separate `-testnet` parameter set.
    let z_address = bech32::encode(
        "zs",
        address.to_bytes().to_base32(),
        bech32::Variant::Bech32,
    )
    .map_err(|_| "cannot encode metadata Sapling address")?;
    let locator = hex::encode(blake3::derive_key(
        "Vatermark image metadata public locator v1",
        seed.as_ref(),
    ));
    Ok(Capability {
        ivk,
        diversifier,
        public: PublicCapability {
            version: 1,
            z_address,
            locator,
        },
    })
}

/// Derives only public values. This function does not verify image authentication;
/// callers must first authenticate the image and obtain its reconstructed signature.
pub fn derive_public(context: &MetadataContext) -> Result<PublicCapability, String> {
    Ok(capability(context)?.public.clone())
}

fn symmetric_key(
    secret: &jubjub::Fr,
    public: &jubjub::ExtendedPoint,
    epk: &[u8; 32],
) -> Zeroizing<[u8; 32]> {
    let shared = (public * secret).clear_cofactor();
    let digest = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"Zcash_SaplingKDF")
        .to_state()
        .update(&shared.to_bytes())
        .update(epk)
        .finalize();
    Zeroizing::new(digest.as_bytes().try_into().unwrap())
}

fn put_vector(out: &mut Vec<u8>, data: &[u8]) {
    if data.len() < 253 {
        out.push(data.len() as u8);
    } else {
        out.push(253);
        out.extend_from_slice(&(data.len() as u16).to_le_bytes());
    }
    out.extend_from_slice(data);
}

fn wrap_plaintext(plaintext: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if plaintext.is_empty() || plaintext.len() > MAX_METADATA_BYTES {
        return Err("metadata must contain between 1 and 16384 bytes".into());
    }
    let mut descriptor = Zeroizing::new(vec![1, 64]); // native VARINT version + MIME flag
    put_vector(&mut descriptor, plaintext);
    put_vector(&mut descriptor, MIME.as_bytes());
    let mut wrapped = Zeroizing::new(identity_bytes(DESCRIPTOR_KEY)?.to_vec());
    wrapped.push(1); // CVDXF version
    put_vector(&mut wrapped, &descriptor);
    Ok(wrapped)
}

/// Produces the same native encrypted descriptor format as Verus signdata's
/// encrypttoaddress path. Fresh randomness is mandatory despite a fixed recipient.
pub fn encrypt(context: &MetadataContext, plaintext: &[u8]) -> Result<EncryptedMetadata, String> {
    let cap = capability(context)?;
    let wrapped = wrap_plaintext(plaintext)?;
    let esk = loop {
        let v = jubjub::Fr::random(OsRng);
        if !bool::from(v.is_zero()) {
            break v;
        }
    };
    let base = cap
        .diversifier
        .g_d()
        .ok_or("invalid metadata diversifier")?;
    let epk = (base * esk).to_bytes();
    let recipient = jubjub::ExtendedPoint::from(base * cap.ivk.0);
    let key = symmetric_key(&esk, &recipient, &epk);
    let cipher =
        ChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| "invalid encryption key")?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&[0; 12]), wrapped.as_slice())
        .map_err(|_| "metadata encryption failed")?;
    Ok(EncryptedMetadata {
        version: 1,
        z_address: cap.public.z_address.clone(),
        locator: cap.public.locator.clone(),
        datadescriptor: json!({"version": 1, "flags": 5, "objectdata": hex::encode(ciphertext), "epk": hex::encode(epk)}),
    })
}

struct Reader<'a> {
    input: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or("invalid data descriptor length")?;
        let value = self
            .input
            .get(self.offset..end)
            .ok_or("truncated data descriptor")?;
        self.offset = end;
        Ok(value)
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn varint(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..5 {
            let byte = self.byte()?;
            if value > (u32::MAX >> 7) {
                return Err("data descriptor integer overflow".into());
            }
            value = (value << 7) | (byte & 0x7f) as u32;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            value = value
                .checked_add(1)
                .ok_or("data descriptor integer overflow")?;
        }
        Err("invalid data descriptor integer".into())
    }
    fn vector(&mut self, maximum: usize) -> Result<&'a [u8], String> {
        let first = self.byte()?;
        let length = match first {
            0..=252 => first as usize,
            253 => {
                let n = u16::from_le_bytes(self.take(2)?.try_into().unwrap()) as usize;
                if n < 253 {
                    return Err("noncanonical data descriptor length".into());
                }
                n
            }
            _ => return Err("oversized data descriptor length".into()),
        };
        if length > maximum {
            return Err("oversized data descriptor field".into());
        }
        self.take(length)
    }
    fn end(&self) -> Result<(), String> {
        if self.offset != self.input.len() {
            Err("trailing data descriptor bytes".into())
        } else {
            Ok(())
        }
    }
}

fn unwrap_plaintext(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut reader = Reader {
        input: bytes,
        offset: 0,
    };
    if reader.take(20)? != identity_bytes(DESCRIPTOR_KEY)? || reader.varint()? != 1 {
        return Err("encrypted payload is not a native Verus data descriptor".into());
    }
    let body = reader.vector(MAX_DESCRIPTOR_BYTES)?;
    reader.end()?;
    let mut inner = Reader {
        input: body,
        offset: 0,
    };
    if inner.varint()? != 1 {
        return Err("unsupported inner data descriptor version".into());
    }
    let flags = inner.varint()?;
    // A plaintext descriptor may carry a salt, label or MIME type. Never accept
    // hidden nested decryption keys or recursive ciphertext from this profile.
    if flags & !(2 | 32 | 64) != 0 {
        return Err("unsupported inner data descriptor flags".into());
    }
    let data = inner.vector(MAX_METADATA_BYTES)?.to_vec();
    if flags & 32 != 0 {
        inner.vector(64)?;
    }
    if flags & 64 != 0 {
        inner.vector(128)?;
    }
    if flags & 2 != 0 {
        inner.vector(32)?;
    }
    inner.end()?;
    Ok(data)
}

/// Authenticates/decrypts a native descriptor using only an authenticated image's
/// capability. Public descriptors carrying IVK/SSK are rejected as privacy errors.
pub fn decrypt(context: &MetadataContext, descriptor: &Value) -> Result<Vec<u8>, String> {
    let object = descriptor
        .as_object()
        .ok_or("metadata descriptor must be an object")?;
    if object.len() != 4
        || object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("flags").and_then(Value::as_u64) != Some(5)
    {
        return Err("metadata descriptor must contain only encrypted data and epk".into());
    }
    let epk_hex = object
        .get("epk")
        .and_then(Value::as_str)
        .ok_or("missing metadata epk")?;
    let cipher_hex = object
        .get("objectdata")
        .and_then(Value::as_str)
        .ok_or("missing metadata ciphertext")?;
    if epk_hex.len() != 64 || cipher_hex.len() < 32 || cipher_hex.len() > MAX_DESCRIPTOR_BYTES * 2 {
        return Err("invalid metadata ciphertext size".into());
    }
    let epk: [u8; 32] = hex::decode(epk_hex)
        .map_err(|_| "invalid metadata epk")?
        .try_into()
        .unwrap();
    let point = Option::<jubjub::ExtendedPoint>::from(jubjub::ExtendedPoint::from_bytes(&epk))
        .ok_or("invalid metadata ephemeral point")?;
    if bool::from(point.clear_cofactor().is_identity()) {
        return Err("invalid metadata ephemeral point".into());
    }
    let ciphertext = hex::decode(cipher_hex).map_err(|_| "invalid metadata ciphertext")?;
    let cap = capability(context)?;
    let key = symmetric_key(&cap.ivk.0, &point, &epk);
    let cipher =
        ChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| "invalid decryption key")?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&[0; 12]), ciphertext.as_slice())
            .map_err(|_| "metadata cannot be decrypted with this signed image")?,
    );
    unwrap_plaintext(&plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context() -> MetadataContext {
        let mut native = vec![2, 5, 100, 0, 0, 0, 1, 65, 31];
        native.extend_from_slice(&[1; 64]);
        MetadataContext {
            profile: 0x41,
            identity_id: "i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv".into(),
            system_id: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq".into(),
            native_signature: BASE64.encode(native),
        }
    }
    #[test]
    fn roundtrip_randomized_ciphertext_and_private_fields_absent() {
        let context = context();
        let first = encrypt(&context, br#"{"title":"Example"}"#).unwrap();
        let second = encrypt(&context, br#"{"title":"Example"}"#).unwrap();
        assert_eq!(first.locator, second.locator);
        assert_eq!(first.z_address, second.z_address);
        assert_ne!(first.datadescriptor, second.datadescriptor);
        assert_eq!(
            decrypt(&context, &first.datadescriptor).unwrap(),
            br#"{"title":"Example"}"#
        );
        let serialized = serde_json::to_string(&first).unwrap();
        for forbidden in [&context.native_signature, "ivk", "ssk"] {
            assert!(!serialized.contains(forbidden));
        }
        assert_eq!(first.datadescriptor.as_object().unwrap().len(), 4);
    }
    #[test]
    fn capability_is_bound_to_signature_identity_system_and_profile() {
        let original = context();
        let encrypted = encrypt(&original, b"private metadata").unwrap();
        for field in 0..4 {
            let mut changed = original.clone();
            match field {
                0 => {
                    let mut native = BASE64.decode(&changed.native_signature).unwrap();
                    native[20] ^= 1;
                    changed.native_signature = BASE64.encode(native);
                }
                1 => changed.identity_id = changed.system_id.clone(),
                2 => changed.system_id = changed.identity_id.clone(),
                _ => changed.profile = 0x31,
            }
            assert_ne!(derive_public(&changed).unwrap().locator, encrypted.locator);
            assert!(decrypt(&changed, &encrypted.datadescriptor).is_err());
        }
    }
    #[test]
    fn recovery_header_and_high_s_are_canonicalized() {
        let original = context();
        let mut changed = original.clone();
        let mut native = BASE64.decode(&changed.native_signature).unwrap();
        native[8] = 34;
        changed.native_signature = BASE64.encode(&native);
        assert_eq!(
            derive_public(&original).unwrap(),
            derive_public(&changed).unwrap()
        );
        // secp256k1 curve order - S yields the equivalent high-S signature.
        let order = hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
            .unwrap();
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let difference = order[i] as i16 - native[41 + i] as i16 - borrow;
            native[41 + i] = difference.rem_euclid(256) as u8;
            borrow = i16::from(difference < 0);
        }
        changed.native_signature = BASE64.encode(native);
        assert_eq!(
            derive_public(&original).unwrap(),
            derive_public(&changed).unwrap()
        );
    }
    #[test]
    fn rejects_tampering_privacy_leaks_and_resource_exhaustion() {
        let context = context();
        let encrypted = encrypt(&context, b"metadata").unwrap();
        let mut modified = encrypted.datadescriptor.clone();
        let mut ciphertext = hex::decode(modified["objectdata"].as_str().unwrap()).unwrap();
        ciphertext[0] ^= 1;
        modified["objectdata"] = json!(hex::encode(ciphertext));
        assert!(decrypt(&context, &modified).is_err());
        for field in ["ivk", "ssk", "salt", "label"] {
            let mut modified = encrypted.datadescriptor.clone();
            modified[field] = json!("00");
            assert!(decrypt(&context, &modified).is_err());
        }
        let mut modified = encrypted.datadescriptor.clone();
        modified["epk"] = json!("00".repeat(32));
        assert!(decrypt(&context, &modified).is_err());
        assert!(encrypt(&context, &[0; MAX_METADATA_BYTES + 1]).is_err());
        assert!(encrypt(&context, &[]).is_err());
    }
    #[test]
    fn malformed_context_fails_without_exposing_input() {
        let mut context = context();
        context.native_signature = "confidential malformed input".into();
        let error = derive_public(&context).unwrap_err();
        assert!(!error.contains("confidential"));
        context = self::context();
        context.identity_id = "invalid".into();
        assert!(derive_public(&context).is_err());
    }

    #[test]
    fn decrypts_independent_vrsctest_signdata_vector() {
        // Generated by the user's local VRSCTEST daemon with address:"",
        // createmmr:true, encrypttoaddress:derive_public(context()).z_address.
        // This exercises the daemon's native salted MMR leaf descriptor, not a
        // round trip generated by the Rust implementation under test.
        let descriptor = json!({"version":1,"flags":5,
            "objectdata":"873e7aae15d669ef349df68a0348e537bf88577785ae0a5f68bd40e08abc68b152b3bbb2eee8cdf160a6acbbba693140bfdeacfebc1384a0bf8caf107c4715319e76cf9041d9498a8b6514a188e3154c1cfc519e3947fca4c939f1c00392ccd14c522b1018dcd9bfee14e1b1076bd1da3ce5675e163c8196c54b9be0f462d3deb0368ef26628",
            "epk":"b1f7c366648454fe32ebb87211888bdda83f77ec864784ca58f4741c246a011d"});
        assert_eq!(
            decrypt(&context(), &descriptor).unwrap(),
            br#"{"title":"Vatermark compatibility fixture"}"#
        );
    }

    // Deliberately synthetic, publicly reproducible capability. Used only by the
    // optional local-daemon interoperability test; no wallet keys are exported.
    #[test]
    #[ignore = "writes a synthetic interoperability fixture only when explicitly requested"]
    fn write_synthetic_daemon_fixture() {
        let context = context();
        let cap = capability(&context).unwrap();
        let encrypted =
            encrypt(&context, br#"{"title":"Vatermark compatibility fixture"}"#).unwrap();
        let path =
            std::env::var("VATERMARK_SYNTHETIC_FIXTURE").expect("fixture output path required");
        let data = json!({"ivk":hex::encode(cap.ivk.to_repr()),"zAddress":cap.public.z_address,
            "datadescriptor":encrypted.datadescriptor});
        std::fs::write(path, serde_json::to_vec(&data).unwrap()).unwrap();
    }
}
