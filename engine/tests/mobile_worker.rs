//! Local fixtures only. These do not claim the generated identities exist on chain.
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    process::{Command, Stdio},
};
use vatermark::{auth, features, verus, web};

fn fixture(width: u32, height: u32) -> RgbImage {
    RgbImage::from_fn(width, height, |x, y| {
        let b = 128.0 + 38.0 * (f64::from(x) / 21.0).sin() + 25.0 * (f64::from(y) / 33.0).cos();
        Rgb([
            (b + f64::from((x * 7 + y * 13) % 19) - 9.0) as u8,
            b as u8,
            (b - 12.0) as u8,
        ])
    })
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "vatermark-worker-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn worker(value: &Value) -> Value {
    let mut process = Command::new(env!("CARGO_BIN_EXE_vatermark-worker"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(value.to_string().as_bytes())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.success(), result["ok"].as_bool().unwrap());
    result
}

#[test]
fn mobile_profile_matches_independent_byte_text_digest_vector() {
    // Vector produced using Python struct + hashlib independently of this crate.
    let vector: Value = serde_json::from_str(include_str!("fixtures/mobile-profile.json")).unwrap();
    let helper = std::array::from_fn(|i| i as u8);
    let quantized: Vec<u16> = (0..1024).collect();
    let system = verus::default_system_id(true);
    assert_eq!(auth::hex(&system), vector["systemHex"]);
    let record = auth::mobile_record(2, &system, 641, 481, &helper, &quantized).unwrap();
    assert_eq!(
        record.len(),
        vector["canonicalBytes"].as_u64().unwrap() as usize
    );
    assert_eq!(auth::hex(&Sha256::digest(record)), vector["commitment"]);
    let message = auth::mobile_signed_message(2, &system, 641, 481, &helper, &quantized).unwrap();
    assert_eq!(
        String::from_utf8(message.clone()).unwrap(),
        vector["message"]
    );
    assert_eq!(auth::hex(&Sha256::digest(&message)), vector["messageHash"]);
    let mut envelope = verus::Envelope::new([3; 20], None, true, 123456);
    envelope.version_type = verus::MOBILE_PROFILE;
    assert_eq!(
        verus::encode_identity_id(&envelope.identity_id),
        vector["identityId"]
    );
    assert_eq!(
        auth::hex(&verus::signature_digest(&envelope, &message).unwrap()),
        vector["nativeDigest"]
    );
    // User selection and signing height are deliberately absent from C and S.
    envelope.identity_id = [9; 20];
    envelope.block_height = 987654;
    assert_eq!(
        auth::signed_message(&envelope, 641, 481, &helper, &quantized).unwrap(),
        message
    );
}

#[test]
fn worker_prepare_finalize_inspect_verify_and_reject_changed_context() {
    let temp = Temp::new();
    let source = temp.path("input.png");
    let normalized = temp.path("normalized.png");
    let output = temp.path("signed.png");
    fixture(641, 481).save(&source).unwrap();
    let prepared = worker(&json!({"cmd":"prepare", "input":source,"normalized_output":normalized}));
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert_eq!(prepared["prepared"]["profile"], 65);
    let text = prepared["prepared"]["message"].as_str().unwrap().as_bytes();
    let mut envelope = verus::Envelope::new([3; 20], None, true, 123456);
    envelope.version_type = verus::MOBILE_PROFILE;
    let identity = verus::sign_fixture(&mut envelope, text, [9; 32]).unwrap();
    let native = verus::verify(&envelope, text, &identity)
        .unwrap()
        .native_signature;
    let command = json!({"cmd":"finalize","input":normalized,"output":output,"prepared":prepared["prepared"],"identityId":verus::encode_identity_id(&envelope.identity_id),"nativeSignature":native,"identity":identity});
    for field in ["message", "sourceSha256", "systemId"] {
        let mut changed = command.clone();
        changed["prepared"][field] = json!("wrong");
        let rejected = worker(&changed);
        assert_eq!(rejected["error"]["code"], "authentication_failed");
        assert!(!output.exists());
    }
    let mut wrong_identity = command.clone();
    wrong_identity["identity"]["height"] = json!(123455);
    assert_eq!(worker(&wrong_identity)["ok"], false);
    assert!(!output.exists());
    let finalized = worker(&command);
    assert_eq!(finalized["ok"], true, "{finalized}");
    assert_eq!(finalized["verification"]["version_type"], 65);
    assert_eq!(finalized["verification"]["signature_valid"], true);
    let inspected = worker(&json!({"cmd":"inspect","input":output}));
    assert_eq!(inspected["message"], prepared["prepared"]["message"]);
    let verified = worker(&json!({"cmd":"verify","input":output,"identity":identity}));
    assert_eq!(verified["verification"]["signature_valid"], true);
    assert_eq!(verified["nativeSignature"], native);
    assert_eq!(
        worker(&command)["error"]["code"],
        "io_error",
        "existing output must not be overwritten"
    );
    let mut changed_pixels = image::open(&normalized).unwrap().to_rgb8();
    changed_pixels.get_pixel_mut(640, 480)[0] ^= 1;
    changed_pixels.save(&normalized).unwrap();
    let mut changed = command;
    changed["output"] = json!(temp.path("new-output.png"));
    assert_eq!(worker(&changed)["error"]["code"], "authentication_failed");
    assert!(!temp.path("new-output.png").exists());
}

#[test]
fn new_profile_survives_png_and_two_generations_of_three_jpeg_samplings() {
    let source = fixture(641, 481);
    for explicit in [false, true] {
        let measured = features::measure(&source).unwrap();
        let mut envelope = verus::Envelope::new(
            [3; 20],
            explicit.then(|| verus::default_system_id(true)),
            true,
            123456,
        );
        envelope.version_type = verus::MOBILE_PROFILE;
        let text = auth::signed_message(&envelope, 641, 481, &measured.helper, &measured.quantized)
            .unwrap();
        let identity = verus::sign_fixture(&mut envelope, &text, [9; 32]).unwrap();
        let (marked, _) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
        let mut encoded = Cursor::new(Vec::new());
        marked.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let png = image::load_from_memory(encoded.get_ref())
            .unwrap()
            .to_rgb8();
        assert!(
            web::verify(&png, &identity).unwrap()["verification"]["signature_valid"]
                .as_bool()
                .unwrap()
        );
        for quality in [90, 80, 75, 60] {
            for sampling in 0..3 {
                let mut received = png.clone();
                for generation in 1..=2 {
                    let mut bytes = Vec::new();
                    if sampling == 0 {
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
                            .encode_image(&received)
                            .unwrap();
                    } else {
                        let mut encoder = jpeg_encoder::Encoder::new(&mut bytes, quality);
                        encoder.set_sampling_factor(if sampling == 1 {
                            jpeg_encoder::SamplingFactor::R_4_4_4
                        } else {
                            jpeg_encoder::SamplingFactor::R_4_2_0
                        });
                        encoder
                            .encode(received.as_raw(), 641, 481, jpeg_encoder::ColorType::Rgb)
                            .unwrap();
                    }
                    received = image::load_from_memory(&bytes).unwrap().to_rgb8();
                    auth::verify(&received,&identity).unwrap_or_else(|e|panic!("explicit={explicit} Q{quality} sampling{sampling} generation{generation}: {e}"));
                }
            }
        }
    }
}

#[test]
fn image_loading_normalizes_exif_and_rejects_actual_alpha_at_native_precision() {
    let temp = Temp::new();
    let path = temp.path("input.data");
    let source = fixture(641, 481);
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&source)
        .unwrap();
    let before = image::load_from_memory(&jpeg).unwrap().to_rgb8();
    // EXIF little-endian TIFF with one Orientation=6 (90 degrees clockwise) entry.
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = jpeg[..2].to_vec();
    oriented.extend([0xff, 0xe1]);
    oriented.extend(((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend(exif);
    oriented.extend(&jpeg[2..]);
    fs::write(&path, oriented).unwrap();
    let loaded = web::read_image(&path, web::MAX_UPLOAD_BYTES).unwrap();
    assert_eq!(loaded, image::imageops::rotate90(&before));
    assert_eq!(loaded.dimensions(), (481, 641));
    assert_eq!(web::read_image(&path, 1).unwrap_err().code, "invalid_image");
    for sixteen in [false, true] {
        for opaque in [false, true] {
            let mut encoded = Cursor::new(Vec::new());
            let dynamic = if sixteen {
                DynamicImage::ImageRgba16(image::ImageBuffer::from_fn(512, 512, |_, _| {
                    image::Rgba([30000u16, 20000, 10000, if opaque { 65535 } else { 65534 }])
                }))
            } else {
                DynamicImage::ImageRgba8(image::ImageBuffer::from_fn(512, 512, |_, _| {
                    image::Rgba([120u8, 80, 40, if opaque { 255 } else { 254 }])
                }))
            };
            dynamic.write_to(&mut encoded, ImageFormat::Png).unwrap();
            fs::write(&path, encoded.into_inner()).unwrap();
            assert_eq!(
                web::read_image(&path, web::MAX_UPLOAD_BYTES).is_ok(),
                opaque
            );
        }
    }
    fs::write(&path, b"GIF89a invalid").unwrap();
    assert_eq!(
        web::read_image(&path, web::MAX_UPLOAD_BYTES)
            .unwrap_err()
            .code,
        "invalid_image"
    );
}

#[test]
fn worker_rejects_malformed_commands_and_untrusted_networks() {
    assert_eq!(
        worker(&json!({"cmd":"unknown"}))["error"]["code"],
        "invalid_request"
    );
    assert_eq!(
        worker(&json!({"cmd":"inspect","input":"relative.png"}))["error"]["code"],
        "invalid_request"
    );
    assert_eq!(
        worker(&json!({"cmd":"inspect","input":"/tmp/absent-vatermark","unexpected":true}))
            ["error"]["code"],
        "invalid_request"
    );
    let source = fixture(512, 512);
    let measured = features::measure(&source).unwrap();
    for (testnet, system) in [(false, None), (true, Some([7; 20]))] {
        let mut envelope = verus::Envelope::new([3; 20], system, testnet, 123456);
        envelope.version_type = verus::MOBILE_PROFILE;
        let text = auth::signed_message(&envelope, 512, 512, &measured.helper, &measured.quantized)
            .unwrap();
        let identity = verus::sign_fixture(&mut envelope, &text, [9; 32]).unwrap();
        let (marked, _) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
        assert_eq!(
            web::inspect(&marked).unwrap_err().code,
            "unsupported_network"
        );
        assert_eq!(
            web::verify(&marked, &identity).unwrap_err().code,
            "unsupported_network"
        );
    }
}

#[test]
fn mobile_and_original_profile_verification_stay_separate() {
    let source = fixture(641, 481);
    let measured = features::measure(&source).unwrap();
    for profile in [verus::PROFILE, verus::MOBILE_PROFILE] {
        let mut envelope = verus::Envelope::new([3; 20], None, true, 123456);
        envelope.version_type = profile;
        let message =
            auth::signed_message(&envelope, 641, 481, &measured.helper, &measured.quantized)
                .unwrap();
        let identity = verus::sign_fixture(&mut envelope, &message, [9; 32]).unwrap();
        let (marked, _) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
        assert_eq!(web::inspect(&marked).unwrap()["profile"], profile);
        assert_eq!(
            web::verify(&marked, &identity).unwrap()["verification"]["version_type"],
            profile
        );
        let mut changed = envelope.clone();
        changed.version_type = if profile == verus::PROFILE {
            verus::MOBILE_PROFILE
        } else {
            verus::PROFILE
        };
        let changed_message =
            auth::signed_message(&changed, 641, 481, &measured.helper, &measured.quantized)
                .unwrap();
        assert!(verus::verify(&changed, &changed_message, &identity).is_err());
        let cropped = image::imageops::crop_imm(&marked, 0, 0, 640, 480).to_image();
        assert_eq!(web::inspect(&cropped).unwrap()["profile"], profile);
        assert_eq!(
            web::verify(&cropped, &identity).unwrap_err().code,
            "authentication_failed"
        );
    }
}
