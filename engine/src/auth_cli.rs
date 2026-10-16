use clap::{ArgGroup, Args};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder, ImageFormat, Rgb, RgbImage};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use vatermark::{auth, features, haar, verus};

use crate::{create_parent, print_json, protect_input, read_image};

#[derive(Args)]
pub struct DemoArgs {
    pub input: PathBuf,
    pub output: PathBuf,
    /// Save the public local test identity. Keep this as a trusted input to verification.
    #[arg(long)]
    pub identity_out: PathBuf,
    /// Include an explicit system i-address, exercising the 110-byte envelope.
    #[arg(long)]
    pub system_id: Option<String>,
}

#[derive(Args)]
pub struct NodeArgs {
    /// Path to the Verus CLI connected to an independently trusted node.
    #[arg(long)]
    pub verus_cli: PathBuf,
    /// Repeat for node selectors, e.g. --verus-arg=-testnet or --verus-arg=-chain=NAME.
    #[arg(long)]
    pub verus_arg: Vec<OsString>,
}

impl NodeArgs {
    fn client(self) -> verus::VerusCli {
        verus::VerusCli {
            executable: self.verus_cli,
            args: self.verus_arg,
        }
    }
}

#[derive(Args)]
pub struct SignArgs {
    pub input: PathBuf,
    pub output: PathBuf,
    #[arg(long)]
    pub identity: String,
    /// Embed the selected node's system ID (required for non-default chains).
    #[arg(long)]
    pub explicit_system: bool,
    #[command(flatten)]
    pub node: NodeArgs,
}

#[derive(Args)]
#[command(group(ArgGroup::new("trust").required(true).args(["trusted_identity", "verus_cli"])))]
pub struct VerifyArgs {
    pub input: PathBuf,
    /// Public identity JSON from a trusted source. This is not an on-chain proof.
    #[arg(long)]
    pub trusted_identity: Option<PathBuf>,
    /// Query historical identity state and require native verification on this node.
    #[arg(long)]
    pub verus_cli: Option<PathBuf>,
    #[arg(long, requires = "verus_cli")]
    pub verus_arg: Vec<OsString>,
}

#[derive(Args)]
pub struct TestArgs {
    pub input: PathBuf,
    #[arg(long)]
    pub trusted_identity: PathBuf,
    #[arg(long, value_delimiter = ',', default_value = "90,80,75,60",
        value_parser = clap::value_parser!(u8).range(1..=100))]
    pub qualities: Vec<u8>,
    /// Optionally save the tested JPEGs here, with their sampling and quality in the names.
    #[arg(long)]
    pub output_dir: Option<PathBuf>,
}

fn prepare_output(input: &Path, output: &Path) -> Result<(), String> {
    if !output
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("png"))
    {
        return Err("authentication output must have a .png extension".into());
    }
    protect_input(input, output)
}

fn read_identity(path: &Path) -> Result<verus::Identity, String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid trusted identity JSON: {e}"))
}

/// Check the actual serialized PNG before any output file is opened.
fn verified_png(image: &RgbImage, identity: &verus::Identity) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("PNG encoding failed: {e}"))?;
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .map_err(|e| format!("PNG decoding failed: {e}"))?
        .to_rgb8();
    auth::verify(&decoded, identity).map_err(|e| {
        format!("serialized PNG failed authentication; output was not written: {e}")
    })?;
    Ok(bytes)
}

fn save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    create_parent(path)?;
    fs::write(path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

fn distinct_outputs(left: &Path, right: &Path) -> Result<(), String> {
    for path in [left, right] {
        if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
            && !path.exists()
        {
            return Err(
                "dangling output symlinks are unsupported; choose explicit file paths".into(),
            );
        }
    }
    // Resolve parents after creating them, including aliases of not-yet-existing files.
    create_parent(left)?;
    create_parent(right)?;
    let resolved = |path: &Path| -> Result<PathBuf, String> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        Ok(parent.join(path.file_name().ok_or("output must name a file")?))
    };
    if resolved(left)? == resolved(right)? {
        return Err("image and identity outputs must be different files".into());
    }
    if left.exists() {
        protect_input(left, right)?;
    }
    if right.exists() {
        protect_input(right, left)?;
    }
    Ok(())
}

pub fn demo(args: DemoArgs) -> Result<(), String> {
    let started = Instant::now();
    prepare_output(&args.input, &args.output)?;
    protect_input(&args.input, &args.identity_out)?;
    distinct_outputs(&args.output, &args.identity_out)?;
    let image = read_image(&args.input)?;
    let measured = features::measure(&image)?;
    let system = args
        .system_id
        .as_deref()
        .map(verus::decode_identity_id)
        .transpose()?;
    let mut secret = [0; 32];
    let mut id = [0; 20];
    OsRng
        .try_fill_bytes(&mut secret)
        .map_err(|e| format!("OS randomness unavailable: {e}"))?;
    OsRng
        .try_fill_bytes(&mut id)
        .map_err(|e| format!("OS randomness unavailable: {e}"))?;
    // Arbitrary local ID and height; neither purports to exist on VRSCTEST.
    let mut envelope = verus::Envelope::new(id, system, true, 1);
    let message = auth::signed_message(
        &envelope,
        image.width(),
        image.height(),
        &measured.helper,
        &measured.quantized,
    )?;
    let identity = verus::sign_fixture(&mut envelope, &message, secret)?;
    let (marked, report) = auth::embed_signed(&image, &envelope, &measured, &identity)?;
    let png = verified_png(&marked, &identity)?;
    let mut identity_json = serde_json::to_vec_pretty(&identity).map_err(|e| e.to_string())?;
    identity_json.push(b'\n');
    save(&args.identity_out, &identity_json)?;
    save(&args.output, &png)?;
    print_json(json!({
        "trust_source": "local_test_identity", "on_chain_identity_verified": false,
        "private_key_persisted": false,
        "output": args.output, "identity_file": args.identity_out,
        "authentication": report, "elapsed_seconds": started.elapsed().as_secs_f64(),
    }))
}

pub fn sign(args: SignArgs) -> Result<(), String> {
    let started = Instant::now();
    prepare_output(&args.input, &args.output)?;
    let image = read_image(&args.input)?;
    let measured = features::measure(&image)?;
    let client = args.node.client();
    let mut envelope = client.prepare(&args.identity, args.explicit_system)?;
    let message = auth::signed_message(
        &envelope,
        image.width(),
        image.height(),
        &measured.helper,
        &measured.quantized,
    )?;
    let identity = client.sign(&mut envelope, &message)?;
    let (marked, report) = auth::embed_signed(&image, &envelope, &measured, &identity)?;
    let png = verified_png(&marked, &identity)?;
    save(&args.output, &png)?;
    print_json(json!({
        "trust_source": "selected_verus_node", "on_chain_identity_verified": true,
        "output": args.output, "authentication": report,
        "elapsed_seconds": started.elapsed().as_secs_f64(),
    }))
}

pub fn verify(args: VerifyArgs) -> Result<(), String> {
    let started = Instant::now();
    let image = read_image(&args.input)?;
    let (packet, transport) = auth::extract_packet(&image)?;
    let (identity, client) = if let Some(path) = args.trusted_identity {
        (read_identity(&path)?, None)
    } else {
        let client = verus::VerusCli {
            executable: args
                .verus_cli
                .ok_or("select a trusted identity file or Verus node")?,
            args: args.verus_arg,
        };
        (client.lookup_identity(&packet.envelope)?, Some(client))
    };
    let report = auth::verify_packet(&image, &packet, transport, &identity)?;
    if let Some(client) = &client {
        let quantized = features::recover(&image, &packet.helper)?;
        let message = auth::signed_message(
            &packet.envelope,
            image.width(),
            image.height(),
            &packet.helper,
            &quantized,
        )?;
        client.verify_on_chain(&packet.envelope, &message)?;
    }
    print_json(json!({
        "input": args.input,
        "trust_source": if client.is_some() { "selected_verus_node" } else { "trusted_identity_file" },
        "on_chain_identity_verified": client.is_some(),
        "verification": report, "elapsed_seconds": started.elapsed().as_secs_f64(),
    }))
}

fn jpeg(
    image: &RgbImage,
    quality: u8,
    subsampled: bool,
    image_encoder: bool,
) -> Result<(Vec<u8>, RgbImage), String> {
    let mut bytes = Vec::new();
    if image_encoder {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(image)
            .map_err(|e| format!("JPEG encoding failed: {e}"))?;
    } else {
        let width =
            u16::try_from(image.width()).map_err(|_| "image exceeds JPEG encoder dimensions")?;
        let height =
            u16::try_from(image.height()).map_err(|_| "image exceeds JPEG encoder dimensions")?;
        let mut encoder = jpeg_encoder::Encoder::new(&mut bytes, quality);
        encoder.set_sampling_factor(if subsampled {
            jpeg_encoder::SamplingFactor::F_2_2
        } else {
            jpeg_encoder::SamplingFactor::F_1_1
        });
        encoder
            .encode(image.as_raw(), width, height, jpeg_encoder::ColorType::Rgb)
            .map_err(|e| format!("JPEG encoding failed: {e}"))?;
    }
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG decoding failed: {e}"))?
        .to_rgb8();
    Ok((bytes, decoded))
}

fn assess(image: &RgbImage, identity: &verus::Identity) -> (bool, Value) {
    let started = Instant::now();
    let mut payload_recovered = false;
    let verification = auth::extract_packet(image).and_then(|(packet, transport)| {
        payload_recovered = true;
        auth::verify_packet(image, &packet, transport, identity)
    });
    let (valid, result, error) = match verification {
        Ok(report) => (true, Some(report), None),
        Err(error) => (false, None, Some(error)),
    };
    (
        valid,
        json!({"payload_recovered": payload_recovered, "signature_valid": valid,
        "verification": result, "error": error, "elapsed_seconds": started.elapsed().as_secs_f64()}),
    )
}

pub fn test(args: TestArgs) -> Result<(), String> {
    let started = Instant::now();
    let original = read_image(&args.input)?;
    let identity = read_identity(&args.trusted_identity)?;
    let baseline = auth::verify(&original, &identity)
        .map_err(|e| format!("input failed authentication before testing: {e}"))?;
    let mut results = Vec::new();
    let mut all_jpeg_verified = true;
    for (encoder_name, subsampled) in [
        ("image", false),
        ("jpeg-encoder", false),
        ("jpeg-encoder", true),
    ] {
        let sampling = if subsampled { "420" } else { "444" };
        for &quality in &args.qualities {
            // Two generations also exercise accumulated recompression drift.
            let mut source = original.clone();
            for generation in 1..=2 {
                let (bytes, decoded) = jpeg(&source, quality, subsampled, encoder_name == "image")?;
                let (valid, assessment) = assess(&decoded, &identity);
                all_jpeg_verified &= valid;
                let output = args.output_dir.as_ref().map(|dir| {
                    dir.join(format!(
                        "auth-{encoder_name}-{sampling}-q{quality}-pass{generation}.jpg"
                    ))
                });
                if let Some(output) = &output {
                    protect_input(&args.input, output)?;
                    protect_input(&args.trusted_identity, output)?;
                    save(output, &bytes)?;
                }
                results.push(
                    json!({"encoder": encoder_name, "chroma_subsampling": if subsampled { "4:2:0" } else { "4:4:4" },
                    "quality": quality, "generation": generation, "jpeg_bytes": bytes.len(),
                    "output": output, "assessment": assessment}),
                );
                source = decoded;
            }
        }
    }
    let (packet, _) = auth::extract_packet(&original)?;
    let block = auth::encode_packet(&packet.envelope, &packet.helper)?;
    let mut edits = Vec::new();
    let mut all_selected_edits_rejected = true;
    for kind in [
        "central_patch",
        "brightness_plus_32",
        "rgb_inversion",
        "unrelated_flat_image",
    ] {
        let mut changed = original.clone();
        let (width, height) = changed.dimensions();
        for (x, y, pixel) in changed.enumerate_pixels_mut() {
            match kind {
                "central_patch"
                    if x >= width * 3 / 8
                        && x < width * 5 / 8
                        && y >= height * 3 / 8
                        && y < height * 5 / 8 =>
                {
                    *pixel = Rgb([20, 220, 40])
                }
                "brightness_plus_32" => pixel.0 = pixel.0.map(|v| v.saturating_add(32)),
                "rgb_inversion" => pixel.0 = pixel.0.map(|v| 255 - v),
                "unrelated_flat_image" => *pixel = Rgb([128, 128, 128]),
                _ => (),
            }
        }
        for transplant in [false, true] {
            let candidate = if transplant {
                haar::embed(&changed, &block, haar::DEFAULT_STEP)?.0
            } else {
                changed.clone()
            };
            let (valid, assessment) = assess(&candidate, &identity);
            all_selected_edits_rejected &= !valid;
            edits.push(
                json!({"edit": kind, "original_watermark_reembedded": transplant,
                "rejected": !valid, "assessment": assessment}),
            );
        }
    }
    print_json(json!({
        "input": args.input, "trust_source": "trusted_identity_file", "on_chain_identity_verified": false,
        "baseline": baseline, "encoder_versions": "recorded in Cargo.lock",
        "all_jpeg_verified": all_jpeg_verified, "jpeg": results,
        "all_selected_edits_rejected": all_selected_edits_rejected, "edits": edits,
        "scope": "same dimensions; selected examples only; known feature collisions remain",
        "elapsed_seconds": started.elapsed().as_secs_f64(),
    }))?;
    if !all_jpeg_verified || !all_selected_edits_rejected {
        return Err("one or more authentication checks failed; see the JSON results".into());
    }
    Ok(())
}
