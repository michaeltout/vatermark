//! Bounded, daemon-free image operations for the web API.
//!
//! The caller owns paths and supplies identity state obtained from its trusted
//! chain service. Prepared data is private job state, never browser input.
use crate::{auth, features, metadata_crypto, verus};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

pub const MAX_UPLOAD_BYTES: u64 = 96 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 24_000_000;
// A normalized PNG can be larger than the compressed upload.
const MAX_NORMALIZED_BYTES: u64 = 96 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepared {
    pub profile: u8,
    pub flags: u8,
    pub system_id: String,
    pub width: u32,
    pub height: u32,
    pub helper_hex: String,
    pub quantized: Vec<u16>,
    pub message: String,
    pub commitment: String,
    /// Binds private prepared state to exact normalized pixels before embedding.
    /// This digest is not signed or stored in the watermark.
    pub source_sha256: String,
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Prepare {
        input: PathBuf,
        normalized_output: PathBuf,
    },
    Inspect {
        input: PathBuf,
    },
    Verify {
        input: PathBuf,
        identity: verus::Identity,
    },
    Finalize {
        input: PathBuf,
        output: PathBuf,
        prepared: Box<Prepared>,
        #[serde(rename = "identityId")]
        identity_id: String,
        #[serde(rename = "nativeSignature")]
        native_signature: String,
        identity: verus::Identity,
    },
    MetadataDerive {
        context: metadata_crypto::MetadataContext,
    },
    MetadataEncrypt {
        context: metadata_crypto::MetadataContext,
        plaintext: String,
    },
    MetadataDecrypt {
        context: metadata_crypto::MetadataContext,
        descriptor: Value,
    },
}

#[derive(Debug, Serialize)]
pub struct WorkerError {
    pub code: &'static str,
    pub message: String,
}
impl WorkerError {
    fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}
type Result<T> = std::result::Result<T, WorkerError>;

/// Reads only PNG/JPEG, limits decoded allocation, applies EXIF orientation once,
/// and rejects alpha before reducing native precision.
pub fn read_image(path: &Path, max_bytes: u64) -> Result<RgbImage> {
    absolute(path)?;
    let file = fs::File::open(path).map_err(|e| WorkerError::new("io_error", e))?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| WorkerError::new("io_error", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(WorkerError::new(
            "invalid_image",
            "Image exceeds the configured file size limit",
        ));
    }
    decode_image(&bytes)
}

fn decode_image(bytes: &[u8]) -> Result<RgbImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| WorkerError::new("invalid_image", e))?;
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg)) {
        return Err(WorkerError::new(
            "invalid_image",
            "Only PNG and JPEG images are supported",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| WorkerError::new("invalid_image", e))?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(WorkerError::new(
            "invalid_image",
            "Image exceeds 24 million decoded pixels",
        ));
    }
    let orientation = decoder
        .orientation()
        .map_err(|e| WorkerError::new("invalid_image", e))?;
    let mut source =
        DynamicImage::from_decoder(decoder).map_err(|e| WorkerError::new("invalid_image", e))?;
    let opaque = match &source {
        DynamicImage::ImageLumaA8(i) => i.pixels().all(|p| p[1] == u8::MAX),
        DynamicImage::ImageRgba8(i) => i.pixels().all(|p| p[3] == u8::MAX),
        DynamicImage::ImageLumaA16(i) => i.pixels().all(|p| p[1] == u16::MAX),
        DynamicImage::ImageRgba16(i) => i.pixels().all(|p| p[3] == u16::MAX),
        DynamicImage::ImageRgba32F(i) => i.pixels().all(|p| p[3] == 1.0),
        _ => !source.color().has_alpha(),
    };
    if !opaque {
        return Err(WorkerError::new(
            "invalid_image",
            "Images with transparency are unsupported; every alpha value must be fully opaque",
        ));
    }
    source.apply_orientation(orientation);
    let image = source.to_rgb8();
    crate::geometry::authentication_layout(image.width(), image.height())
        .map_err(|e| WorkerError::new("invalid_image", e))?;
    Ok(image)
}

pub fn prepare(image: &RgbImage) -> Result<Prepared> {
    if u64::from(image.width()) * u64::from(image.height()) > MAX_PIXELS {
        return Err(WorkerError::new(
            "invalid_image",
            "Image exceeds 24 million decoded pixels",
        ));
    }
    let measured = features::measure(image).map_err(|e| WorkerError::new("invalid_image", e))?;
    let system = verus::default_system_id(true);
    let record = auth::mobile_record(
        verus::TESTNET,
        &system,
        image.width(),
        image.height(),
        &measured.helper,
        &measured.quantized,
    )
    .map_err(|e| WorkerError::new("invalid_image", e))?;
    let commitment = auth::hex(&Sha256::digest(record));
    let message = format!("Vatermark image authentication v2\nsha256:{commitment}");
    let mut source_hash = Sha256::new();
    source_hash.update(image.width().to_le_bytes());
    source_hash.update(image.height().to_le_bytes());
    source_hash.update(image.as_raw());
    Ok(Prepared {
        profile: verus::MOBILE_PROFILE,
        flags: verus::TESTNET,
        system_id: verus::encode_identity_id(&system),
        width: image.width(),
        height: image.height(),
        helper_hex: auth::hex(&measured.helper),
        quantized: measured.quantized,
        message,
        commitment,
        source_sha256: auth::hex(&source_hash.finalize()),
    })
}

fn checked_packet(image: &RgbImage) -> Result<(auth::Packet, crate::haar::DecodeReport)> {
    let (packet, report) = auth::extract_packet(image).map_err(|e| {
        let code = if e.contains("unsupported image signature profile") {
            "unsupported_profile"
        } else {
            "no_watermark"
        };
        WorkerError::new(code, e)
    })?;
    if packet.envelope.flags & verus::TESTNET == 0
        || packet.envelope.system_id() != verus::default_system_id(true)
    {
        return Err(WorkerError::new(
            "unsupported_network",
            "Only VRSCTEST signatures are supported",
        ));
    }
    Ok((packet, report))
}

fn packet_message(image: &RgbImage, packet: &auth::Packet) -> Result<Vec<u8>> {
    let recovered = features::recover(image, &packet.helper)
        .map_err(|e| WorkerError::new("authentication_failed", e))?;
    auth::signed_message(
        &packet.envelope,
        image.width(),
        image.height(),
        &packet.helper,
        &recovered,
    )
    .map_err(|e| WorkerError::new("authentication_failed", e))
}

pub fn inspect(image: &RgbImage) -> Result<Value> {
    let (packet, _) = checked_packet(image)?;
    let message = packet_message(image, &packet)?;
    let envelope = &packet.envelope;
    Ok(json!({
        "profile": envelope.version_type, "flags": envelope.flags,
        "identityId": verus::encode_identity_id(&envelope.identity_id),
        "systemId": verus::encode_identity_id(&envelope.system_id()),
        "testnet": true, "signingHeight": envelope.block_height,
        "width": image.width(), "height": image.height(),
        "message": if envelope.version_type == verus::MOBILE_PROFILE { String::from_utf8(message.clone()).ok() } else { None },
        "messageHex": auth::hex(&message), "helperHex": auth::hex(&packet.helper),
        "signatureHex": auth::hex(&envelope.signature),
        "envelopeBytes": envelope.encode().map_err(|e| WorkerError::new("authentication_failed", e))?.len()
    }))
}

pub fn verify(image: &RgbImage, identity: &verus::Identity) -> Result<Value> {
    let (packet, watermark) = checked_packet(image)?;
    let message = packet_message(image, &packet)?;
    let native = verus::verify(&packet.envelope, &message, identity)
        .map_err(|e| WorkerError::new("authentication_failed", e))?;
    let report = auth::verify_packet(image, &packet, watermark, identity)
        .map_err(|e| WorkerError::new("authentication_failed", e))?;
    Ok(
        json!({ "verification": report, "nativeSignature": native.native_signature, "signerAddress": native.signer_address }),
    )
}

/// Remeasure server-owned source; verify its approved message and signature;
/// embed, encode PNG, decode that PNG, then verify again before returning bytes.
pub fn finalize(
    image: &RgbImage,
    prepared: &Prepared,
    identity_id: &str,
    native_signature: &str,
    identity: &verus::Identity,
) -> Result<(Vec<u8>, Value)> {
    if *prepared != prepare(image)? {
        return Err(WorkerError::new(
            "authentication_failed",
            "Prepared source or signing context has changed",
        ));
    }
    let id = verus::decode_identity_id(identity_id)
        .map_err(|e| WorkerError::new("invalid_request", e))?;
    let mut envelope = verus::Envelope::new(id, None, true, 1);
    envelope.version_type = verus::MOBILE_PROFILE;
    envelope
        .import_native_signature(native_signature)
        .map_err(|e| WorkerError::new("authentication_failed", e))?;
    let measured = features::measure(image).map_err(|e| WorkerError::new("invalid_image", e))?;
    let message = auth::signed_message(
        &envelope,
        image.width(),
        image.height(),
        &measured.helper,
        &measured.quantized,
    )
    .map_err(|e| WorkerError::new("authentication_failed", e))?;
    if message != prepared.message.as_bytes() {
        return Err(WorkerError::new(
            "authentication_failed",
            "Approved signing text does not match the image",
        ));
    }
    let (marked, report) = auth::embed_signed(image, &envelope, &measured, identity)
        .map_err(|e| WorkerError::new("authentication_failed", e))?;
    let bytes = encode_png(&marked)?;
    let saved = decode_image(&bytes)?;
    let verification = verify(&saved, identity)?;
    Ok((
        bytes,
        json!({ "verification": verification["verification"], "nativeSignature": verification["nativeSignature"],
        "width": image.width(), "height": image.height(), "report": report }),
    ))
}

fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(WorkerError::new(
            "invalid_request",
            "Worker paths must be absolute and server-controlled",
        ));
    }
    Ok(())
}
fn encode_png(image: &RgbImage) -> Result<Vec<u8>> {
    let mut encoded = Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|e| WorkerError::new("io_error", e))?;
    Ok(encoded.into_inner())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    absolute(path)?;
    // Server allocates a fresh private filename; refuse accidental overwrites.
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| WorkerError::new("io_error", e))?;
    file.write_all(bytes)
        .map_err(|e| WorkerError::new("io_error", e))?;
    file.sync_all()
        .map_err(|e| WorkerError::new("io_error", e))?;
    Ok(())
}

pub fn run(command: Command) -> Result<Value> {
    let mut result = match command {
        Command::Prepare {
            input,
            normalized_output,
        } => {
            absolute(&normalized_output)?;
            let image = read_image(&input, MAX_UPLOAD_BYTES)?;
            let prepared = prepare(&image)?;
            write_new(&normalized_output, &encode_png(&image)?)?;
            json!({ "width": image.width(), "height": image.height(), "previewPath": normalized_output, "prepared": prepared })
        }
        Command::Inspect { input } => inspect(&read_image(&input, MAX_UPLOAD_BYTES)?)?,
        Command::Verify { input, identity } => {
            verify(&read_image(&input, MAX_UPLOAD_BYTES)?, &identity)?
        }
        Command::Finalize {
            input,
            output,
            prepared,
            identity_id,
            native_signature,
            identity,
        } => {
            absolute(&output)?;
            let image = read_image(&input, MAX_NORMALIZED_BYTES)?;
            let (bytes, report) = finalize(
                &image,
                &prepared,
                &identity_id,
                &native_signature,
                &identity,
            )?;
            write_new(&output, &bytes)?;
            report
        }
        Command::MetadataDerive { context } => serde_json::to_value(
            metadata_crypto::derive_public(&context)
                .map_err(|_| WorkerError::new("metadata_error", "Cannot derive image metadata capability"))?
        ).map_err(|_| WorkerError::new("metadata_error", "Cannot encode metadata capability"))?,
        Command::MetadataEncrypt { context, plaintext } => serde_json::to_value(
            metadata_crypto::encrypt(&context, plaintext.as_bytes())
                .map_err(|_| WorkerError::new("metadata_error", "Cannot encrypt image metadata"))?
        ).map_err(|_| WorkerError::new("metadata_error", "Cannot encode encrypted metadata"))?,
        Command::MetadataDecrypt { context, descriptor } => {
            let bytes = metadata_crypto::decrypt(&context, &descriptor)
                .map_err(|_| WorkerError::new("metadata_error", "Image metadata cannot be decrypted"))?;
            json!({ "plaintextHex": auth::hex(&bytes) })
        }
    };
    result["ok"] = json!(true);
    Ok(result)
}
