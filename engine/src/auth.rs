//! Self-contained image authentication: reconciled features + Verus signature.
//!
//! Transport frame: VA | frame-version=1 | envelope-size | envelope | helper[384]
//! | zero padding | CRC32-BE. Exactly 512 bytes enter the Haar/LDPC channel.
//! The CRC checks accidental transport errors; only Verus verification authenticates.

use crate::{features, haar, verus};
use image::RgbImage;
use serde::Serialize;
use sha2::{Digest, Sha256};

const CHECKSUM_OFFSET: usize = haar::BLOCK_BYTES - 4;
const MESSAGE_DOMAIN: &[u8] = b"Vatermark/image-auth/v1\0";

pub struct Packet {
    pub envelope: verus::Envelope,
    pub helper: [u8; features::HELPER_BYTES],
}

#[derive(Debug, Serialize)]
pub struct VerificationReport {
    pub version_type: u8,
    pub signature_valid: bool,
    pub fingerprint_reconciled: bool,
    pub identity_id: String,
    pub system_id: String,
    pub testnet: bool,
    pub signing_height: u32,
    pub signer_address: String,
    pub fingerprint_sha256: String,
    pub envelope_bytes: usize,
    pub helper_bytes: usize,
    pub watermark: haar::DecodeReport,
}

#[derive(Debug, Serialize)]
pub struct EmbedReport {
    pub envelope_bytes: usize,
    pub helper_bytes: usize,
    pub authentication_bytes: usize,
    pub transport_information_bytes: usize,
    pub watermark: haar::Report,
    pub verification: VerificationReport,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn feature_bytes(quantized: &[u16]) -> Result<Vec<u8>, String> {
    if quantized.len() != features::FEATURE_COUNT {
        return Err("wrong number of quantized image features".into());
    }
    Ok(quantized
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect())
}

/// Canonical bytes passed to Verus signdata(messagehex, SHA256, fixed prefix).
/// Height is already bound by the native Verus signature digest, so it is not
/// repeated here: a node may advance between preparing the message and signing.
pub fn signed_message(
    envelope: &verus::Envelope,
    width: u32,
    height: u32,
    helper: &[u8; features::HELPER_BYTES],
    quantized: &[u16],
) -> Result<Vec<u8>, String> {
    envelope.validate()?;
    if envelope.version_type == verus::MOBILE_PROFILE {
        return mobile_signed_message(
            envelope.flags,
            &envelope.system_id(),
            width,
            height,
            helper,
            quantized,
        );
    }
    let mut message = MESSAGE_DOMAIN.to_vec();
    message.extend(envelope.metadata_bytes());
    message.extend(width.to_le_bytes());
    message.extend(height.to_le_bytes());
    // The profile fixes these parameters. Signing them also guards
    // against accidental mismatch between independently built verifiers.
    message.extend(features::QUANTIZATION_STEP.to_le_bytes());
    message.extend(features::COLOR_SCALE.to_le_bytes());
    message.extend(haar::DEFAULT_STEP.to_le_bytes());
    message.extend(helper);
    message.extend(feature_bytes(quantized)?);
    Ok(message)
}

/// Canonical mobile record. No signer or height is needed until approval.
/// The native Verus digest binds those fields independently.
pub fn mobile_record(
    flags: u8,
    system_id: &[u8; 20],
    width: u32,
    height: u32,
    helper: &[u8; features::HELPER_BYTES],
    quantized: &[u16],
) -> Result<Vec<u8>, String> {
    if flags & !(verus::HAS_SYSTEM_ID | verus::TESTNET) != 0 || *system_id == [0; 20] {
        return Err("invalid mobile signing context".into());
    }
    if flags & verus::HAS_SYSTEM_ID == 0
        && *system_id != verus::default_system_id(flags & verus::TESTNET != 0)
    {
        return Err("implicit system ID does not match network".into());
    }
    crate::geometry::authentication_layout(width, height)?;
    let mut record = b"Vatermark/image-auth/v2\0".to_vec();
    record.extend([verus::MOBILE_PROFILE, flags]);
    record.extend(system_id);
    record.extend(width.to_le_bytes());
    record.extend(height.to_le_bytes());
    record.extend(features::QUANTIZATION_STEP.to_le_bytes());
    record.extend(features::COLOR_SCALE.to_le_bytes());
    record.extend(haar::DEFAULT_STEP.to_le_bytes());
    record.extend(helper);
    record.extend(feature_bytes(quantized)?);
    Ok(record)
}

pub fn mobile_signed_message(
    flags: u8,
    system_id: &[u8; 20],
    width: u32,
    height: u32,
    helper: &[u8; features::HELPER_BYTES],
    quantized: &[u16],
) -> Result<Vec<u8>, String> {
    let record = mobile_record(flags, system_id, width, height, helper, quantized)?;
    Ok(format!(
        "Vatermark image authentication v2\nsha256:{}",
        hex(&Sha256::digest(record))
    )
    .into_bytes())
}

pub fn encode_packet(
    envelope: &verus::Envelope,
    helper: &[u8; features::HELPER_BYTES],
) -> Result<[u8; haar::BLOCK_BYTES], String> {
    let encoded = envelope.encode()?;
    if encoded.len() != 90 && encoded.len() != 110 {
        return Err("authentication requires a 90- or 110-byte envelope".into());
    }
    let mut block = [0u8; haar::BLOCK_BYTES];
    block[..4].copy_from_slice(&[b'V', b'A', 1, encoded.len() as u8]);
    block[4..4 + encoded.len()].copy_from_slice(&encoded);
    block[4 + encoded.len()..4 + encoded.len() + helper.len()].copy_from_slice(helper);
    let crc = crc32fast::hash(&block[..CHECKSUM_OFFSET]).to_be_bytes();
    block[CHECKSUM_OFFSET..].copy_from_slice(&crc);
    Ok(block)
}

pub fn decode_packet(block: &[u8; haar::BLOCK_BYTES]) -> Result<Packet, String> {
    if block[..3] != [b'V', b'A', 1] {
        return Err("no supported image-authentication frame found".into());
    }
    let length = block[3] as usize;
    if length != 90 && length != 110 {
        return Err("invalid authentication envelope length".into());
    }
    if block[CHECKSUM_OFFSET..] != crc32fast::hash(&block[..CHECKSUM_OFFSET]).to_be_bytes() {
        return Err("authentication frame CRC mismatch".into());
    }
    let end = 4 + length + features::HELPER_BYTES;
    if block[end..CHECKSUM_OFFSET].iter().any(|&byte| byte != 0) {
        return Err("authentication frame has nonzero padding".into());
    }
    let envelope = verus::Envelope::decode(&block[4..4 + length])?;
    let helper = block[4 + length..end].try_into().unwrap();
    Ok(Packet { envelope, helper })
}

/// Recover the public envelope and correction data, without claiming authenticity.
pub fn extract_packet(image: &RgbImage) -> Result<(Packet, haar::DecodeReport), String> {
    let (block, report) = haar::extract(image, haar::DEFAULT_STEP)?;
    Ok((decode_packet(&block)?, report))
}

pub fn verify_packet(
    image: &RgbImage,
    packet: &Packet,
    watermark: haar::DecodeReport,
    identity: &verus::Identity,
) -> Result<VerificationReport, String> {
    let quantized = features::recover(image, &packet.helper)
        .map_err(|error| format!("feature reconstruction failed: {error}"))?;
    let message = signed_message(
        &packet.envelope,
        image.width(),
        image.height(),
        &packet.helper,
        &quantized,
    )?;
    let result = verus::verify(&packet.envelope, &message, identity)
        .map_err(|error| format!("image signature verification failed: {error}"))?;
    Ok(VerificationReport {
        version_type: packet.envelope.version_type,
        signature_valid: true,
        fingerprint_reconciled: true,
        identity_id: verus::encode_identity_id(&packet.envelope.identity_id),
        system_id: verus::encode_identity_id(&packet.envelope.system_id()),
        testnet: packet.envelope.flags & 2 != 0,
        signing_height: packet.envelope.block_height,
        signer_address: result.signer_address,
        fingerprint_sha256: hex(&Sha256::digest(feature_bytes(&quantized)?)),
        envelope_bytes: packet.envelope.encode()?.len(),
        helper_bytes: packet.helper.len(),
        watermark,
    })
}

/// Identity must come from a trusted source, not from the image being verified.
pub fn verify(image: &RgbImage, identity: &verus::Identity) -> Result<VerificationReport, String> {
    let (packet, watermark) = extract_packet(image)?;
    verify_packet(image, &packet, watermark, identity)
}

/// Verify the signed source features, embed, then verify the final quantized RGB.
pub fn embed_signed(
    image: &RgbImage,
    envelope: &verus::Envelope,
    measured: &features::FeatureSet,
    identity: &verus::Identity,
) -> Result<(RgbImage, EmbedReport), String> {
    if features::measure(image)? != *measured {
        return Err("prepared features do not match the input image".into());
    }
    let message = signed_message(
        envelope,
        image.width(),
        image.height(),
        &measured.helper,
        &measured.quantized,
    )?;
    verus::verify(envelope, &message, identity)?;
    let block = encode_packet(envelope, &measured.helper)?;
    let (marked, watermark) = haar::embed(image, &block, haar::DEFAULT_STEP)?;
    let verification = verify(&marked, identity)
        .map_err(|error| format!("marked image failed authentication before saving: {error}"))?;
    let envelope_bytes = envelope.encode()?.len();
    Ok((
        marked,
        EmbedReport {
            envelope_bytes,
            helper_bytes: measured.helper.len(),
            authentication_bytes: envelope_bytes + measured.helper.len(),
            transport_information_bytes: block.len(),
            watermark,
            verification,
        },
    ))
}
