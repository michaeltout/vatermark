use clap::{ArgGroup, Args, Parser, Subcommand};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ExtendedColorType, ImageEncoder, ImageFormat, RgbImage,
};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

mod auth_cli;

#[derive(Parser)]
#[command(
    name = "vatermark",
    version,
    about = "CPU image watermarking with binary payloads"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Sign and watermark with a fresh local test identity (no wallet or chain).
    AuthDemo(auth_cli::DemoArgs),
    /// Sign through an explicitly selected Verus wallet and watermark the image.
    AuthSign(auth_cli::SignArgs),
    /// Recover and verify image features and the identity signature.
    AuthVerify(auth_cli::VerifyArgs),
    /// Check full authentication after JPEG recompression and selected edits.
    AuthTest(auth_cli::TestArgs),
    /// Embed text or arbitrary bytes, save a PNG, and verify the saved payload.
    Embed(EmbedArgs),
    /// Recover the payload without the original image.
    Extract {
        input: PathBuf,
        #[arg(long)]
        key: String,
        /// Save the exact payload bytes; otherwise print hexadecimal and UTF-8 JSON.
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Recompress a watermarked image at each quality and check exact recovery.
    TestJpeg {
        input: PathBuf,
        #[arg(long)]
        key: String,
        #[arg(long, value_delimiter = ',', default_value = "90,80,75,60",
              value_parser = clap::value_parser!(u8).range(1..=100))]
        qualities: Vec<u8>,
        /// Optionally save the JPEGs as quality-N.jpg in this directory.
        #[arg(long)]
        output_dir: Option<PathBuf>,
    },
}

#[derive(Args)]
#[command(group(ArgGroup::new("payload").required(true).args(["text", "payload_file"])))]
struct EmbedArgs {
    input: PathBuf,
    output: PathBuf,
    /// UTF-8 bytes to embed (the limit is bytes, not characters).
    #[arg(long)]
    text: Option<String>,
    /// Read arbitrary binary payload bytes from this file.
    #[arg(long)]
    payload_file: Option<PathBuf>,
    #[arg(long)]
    key: String,
    #[arg(long, default_value_t = vatermark::DEFAULT_STRENGTH)]
    strength: f64,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::AuthDemo(args) => auth_cli::demo(args),
        Command::AuthSign(args) => auth_cli::sign(args),
        Command::AuthVerify(args) => auth_cli::verify(args),
        Command::AuthTest(args) => auth_cli::test(args),
        Command::Embed(args) => embed_file(args),
        Command::Extract { input, key, output } => {
            let started = Instant::now();
            let image = read_image(&input)?;
            let payload = vatermark::extract(&image, &key)?;
            if let Some(output) = output {
                protect_input(&input, &output)?;
                create_parent(&output)?;
                fs::write(&output, &payload)
                    .map_err(|error| format!("cannot write {}: {error}", output.display()))?;
                print_json(json!({
                    "output": output.to_string_lossy(),
                    "bytes": payload.len(),
                    "elapsed_seconds": started.elapsed().as_secs_f64(),
                }))
            } else {
                let payload_hex: String =
                    payload.iter().map(|byte| format!("{byte:02x}")).collect();
                print_json(json!({
                    "payload_hex": payload_hex,
                    "payload_utf8": std::str::from_utf8(&payload).ok(),
                    "bytes": payload.len(),
                    "elapsed_seconds": started.elapsed().as_secs_f64(),
                }))
            }
        }
        Command::TestJpeg {
            input,
            key,
            qualities,
            output_dir,
        } => test_jpeg(&input, &key, &qualities, output_dir.as_deref()),
    }
}

fn embed_file(args: EmbedArgs) -> Result<(), String> {
    let started = Instant::now();
    if !args
        .output
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
    {
        return Err("embedding output must have a .png extension".into());
    }
    if !args.strength.is_finite() || args.strength <= 0.0 {
        return Err("--strength must be finite and positive".into());
    }
    protect_input(&args.input, &args.output)?;
    if let Some(path) = &args.payload_file {
        protect_input(path, &args.output)?;
    }
    let payload = match (args.text, args.payload_file) {
        (Some(text), None) => text.into_bytes(),
        (None, Some(path)) => fs::read(&path)
            .map_err(|error| format!("cannot read payload {}: {error}", path.display()))?,
        _ => return Err("specify exactly one of --text and --payload-file".into()),
    };
    let original = read_image(&args.input)?;
    let (watermarked, report) = vatermark::embed(&original, &payload, &args.key, args.strength)?;
    // Verify the serialized PNG bytes before opening the output file. An
    // embedding failure therefore neither leaves a bad file nor replaces one.
    let mut png_bytes = Vec::new();
    PngEncoder::new(&mut png_bytes)
        .write_image(
            watermarked.as_raw(),
            watermarked.width(),
            watermarked.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| format!("PNG encoding failed: {error}"))?;
    let stored = image::load_from_memory_with_format(&png_bytes, ImageFormat::Png)
        .map_err(|error| format!("encoded PNG could not be decoded: {error}"))?
        .to_rgb8();
    let recovered = vatermark::extract(&stored, &args.key).map_err(|error| {
        format!("encoded PNG failed verification; output was not written: {error}")
    })?;
    if recovered != payload {
        return Err(
            "encoded PNG failed verification; output was not written: recovered bytes differ from the payload".into(),
        );
    }
    create_parent(&args.output)?;
    fs::write(&args.output, &png_bytes)
        .map_err(|error| format!("cannot save {}: {error}", args.output.display()))?;
    print_json(json!({
        "output": args.output.to_string_lossy(),
        "payload_bytes": payload.len(),
        "verified": true,
        "psnr_db": vatermark::psnr(&original, &stored),
        "embedding": report,
        "elapsed_seconds": started.elapsed().as_secs_f64(),
    }))
}

fn test_jpeg(
    input: &Path,
    key: &str,
    qualities: &[u8],
    output_dir: Option<&Path>,
) -> Result<(), String> {
    let started = Instant::now();
    let image = read_image(input)?;
    let baseline = vatermark::extract(&image, key).map_err(|error| {
        format!("input watermark could not be extracted before compression: {error}")
    })?;
    let mut results = Vec::with_capacity(qualities.len());
    let mut all_recovered = true;
    for &quality in qualities {
        let iteration_started = Instant::now();
        let mut compressed = Vec::new();
        JpegEncoder::new_with_quality(&mut compressed, quality)
            .encode_image(&image)
            .map_err(|error| format!("JPEG encoding failed at quality {quality}: {error}"))?;
        let output = output_dir.map(|directory| directory.join(format!("quality-{quality}.jpg")));
        if let Some(path) = &output {
            protect_input(input, path)?;
            create_parent(path)?;
            fs::write(path, &compressed)
                .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        }
        let decoded_image = image::load_from_memory_with_format(&compressed, ImageFormat::Jpeg)
            .map_err(|error| format!("JPEG decoding failed at quality {quality}: {error}"))?
            .to_rgb8();
        let (recovered, error) = match vatermark::extract(&decoded_image, key) {
            Ok(payload) if payload == baseline => (true, None),
            Ok(_) => (
                false,
                Some("recovered payload differs from the baseline".to_string()),
            ),
            Err(error) => (false, Some(error)),
        };
        all_recovered &= recovered;
        results.push(json!({
            "quality": quality,
            "recovered": recovered,
            "error": error,
            "jpeg_bytes": compressed.len(),
            "output": output.as_ref().map(|path| path.to_string_lossy()),
            "elapsed_seconds": iteration_started.elapsed().as_secs_f64(),
        }));
    }
    print_json(json!({
        "input": input.to_string_lossy(),
        "payload_bytes": baseline.len(),
        "all_recovered": all_recovered,
        "jpeg": {
            "encoder": "image::codecs::jpeg::JpegEncoder",
            "dependency_version": "recorded in Cargo.lock",
            // Verified in image 0.25.10: new_with_quality sets all three
            // components to h=1,v=1, and build_frame_header writes those values.
            // Its documentation's 4:2:2 claim does not match that implementation.
            "chroma_subsampling": "4:4:4",
            "component_sampling_factors": [[1, 1], [1, 1], [1, 1]],
            "recompression": "one independent pass per quality from the input RGB pixels",
        },
        "results": results,
        "elapsed_seconds": started.elapsed().as_secs_f64(),
    }))?;
    if all_recovered {
        Ok(())
    } else {
        Err("JPEG recovery failed at one or more qualities; see the JSON results".into())
    }
}

fn read_image(path: &Path) -> Result<RgbImage, String> {
    let source = image::ImageReader::open(path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?
        .with_guessed_format()
        .map_err(|error| format!("cannot identify {}: {error}", path.display()))?
        .decode()
        .map_err(|error| format!("cannot decode {}: {error}", path.display()))?;
    // Inspect alpha at its native precision: conversion to 8-bit first could
    // round a partially transparent 16-bit value up to fully opaque.
    let opaque = match &source {
        image::DynamicImage::ImageLumaA8(image) => image.pixels().all(|pixel| pixel[1] == u8::MAX),
        image::DynamicImage::ImageRgba8(image) => image.pixels().all(|pixel| pixel[3] == u8::MAX),
        image::DynamicImage::ImageLumaA16(image) => {
            image.pixels().all(|pixel| pixel[1] == u16::MAX)
        }
        image::DynamicImage::ImageRgba16(image) => image.pixels().all(|pixel| pixel[3] == u16::MAX),
        image::DynamicImage::ImageRgba32F(image) => image.pixels().all(|pixel| pixel[3] == 1.0),
        _ => !source.color().has_alpha(),
    };
    if !opaque {
        return Err(
            "images with transparency are unsupported; every alpha value must be fully opaque"
                .into(),
        );
    }
    Ok(source.to_rgb8())
}

fn protect_input(input: &Path, output: &Path) -> Result<(), String> {
    let original = fs::canonicalize(input)
        .map_err(|error| format!("cannot access {}: {error}", input.display()))?;
    if let Ok(destination) = fs::canonicalize(output) {
        if original == destination {
            return Err("input and output must be different files".into());
        }
        // Canonical paths do not detect two names for the same hard-linked file.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let left = fs::metadata(&original).map_err(|error| error.to_string())?;
            let right = fs::metadata(&destination).map_err(|error| error.to_string())?;
            if left.dev() == right.dev() && left.ino() == right.ino() {
                return Err("input and output must be different files".into());
            }
        }
    }
    Ok(())
}

fn create_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    Ok(())
}

fn print_json(value: Value) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, &value).map_err(|error| error.to_string())?;
    writeln!(stdout).map_err(|error| error.to_string())
}
