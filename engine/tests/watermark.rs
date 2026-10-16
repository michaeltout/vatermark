use image::{codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, ImageEncoder, Rgb, RgbImage};
use vatermark::{embed, extract, payload::PAYLOAD_BYTES};

const KEY: &str = "integration-test-key";
const STRENGTH: f64 = vatermark::DEFAULT_STRENGTH;

fn binary_payload() -> [u8; PAYLOAD_BYTES] {
    let mut payload = std::array::from_fn(|i| (i * 53 + 17) as u8);
    payload[0] = 0;
    payload[1] = 255;
    payload[2] = 128;
    payload[PAYLOAD_BYTES - 1] = 0;
    payload
}

/// A deterministic bounded texture with gradients, several spatial frequencies,
/// color variation, and fine noise. No external image or random seed is needed.
fn textured_fixture(width: u32, height: u32) -> RgbImage {
    let mut state = 0x7f4a_7c15_u32;
    RgbImage::from_fn(width, height, |x, y| {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let noise = f64::from(state >> 24) / 255.0 * 18.0 - 9.0;
        let (x, y) = (f64::from(x), f64::from(y));
        let base = 124.0
            + 28.0 * (x * 0.039).sin()
            + 22.0 * (y * 0.055).cos()
            + 14.0 * ((x + y) * 0.089).sin()
            + noise;
        Rgb([
            (base + 15.0 * (y * 0.017).sin()).round() as u8,
            (base + 8.0 * (x * 0.021).cos()).round() as u8,
            (base - 20.0 * (x * 0.013 + y * 0.011).sin()).round() as u8,
        ])
    })
}

fn stored_roundtrip(image: &RgbImage, jpeg_quality: Option<u8>) -> RgbImage {
    let mut encoded = Vec::new();
    if let Some(quality) = jpeg_quality {
        JpegEncoder::new_with_quality(&mut encoded, quality)
            .encode(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        assert_eq!(&encoded[..2], &[0xff, 0xd8]);
    } else {
        PngEncoder::new(&mut encoded)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        assert_eq!(&encoded[..8], b"\x89PNG\r\n\x1a\n");
    }
    let restored = image::load_from_memory(&encoded).unwrap().to_rgb8();
    assert_eq!(restored.dimensions(), image.dimensions());
    if jpeg_quality.is_none() {
        assert_eq!(restored, *image);
    } else {
        assert_ne!(
            restored, *image,
            "JPEG test must exercise a lossy roundtrip"
        );
    }
    restored
}

fn verify_texture(width: u32, height: u32, jpeg_quality: Option<u8>) {
    let original = textured_fixture(width, height);
    let payload = binary_payload();
    let (marked, report) = embed(&original, &payload, KEY, STRENGTH).unwrap();
    assert_eq!(marked.dimensions(), original.dimensions());
    assert_eq!(report.payload_bytes, PAYLOAD_BYTES);
    assert_eq!(report.codeword_bytes, 88);
    assert!(report.minimum_repetitions >= 2);
    assert!(report.psnr_db.is_finite());
    assert_ne!(marked, original);
    let stored = stored_roundtrip(&marked, jpeg_quality);
    let recovered = extract(&stored, KEY);
    println!(
        "texture {width}x{height}, JPEG={jpeg_quality:?}, PSNR={:.3} dB, decoded={}",
        report.psnr_db,
        recovered.is_ok()
    );
    assert_eq!(
        recovered
            .unwrap_or_else(|error| panic!("{width}x{height}, JPEG={jpeg_quality:?}: {error}")),
        payload
    );
}

#[test]
fn square_png_retains_full_binary_payload() {
    verify_texture(512, 512, None);
}

#[test]
fn rectangular_png_retains_full_binary_payload() {
    verify_texture(640, 512, None);
}

#[test]
fn odd_rectangular_png_retains_full_binary_payload() {
    verify_texture(513, 517, None);
}

#[test]
fn square_jpeg_quality_90_retains_full_binary_payload() {
    verify_texture(512, 512, Some(90));
}

#[test]
fn square_jpeg_quality_80_retains_full_binary_payload() {
    verify_texture(512, 512, Some(80));
}

#[test]
fn square_jpeg_quality_75_retains_full_binary_payload() {
    verify_texture(512, 512, Some(75));
}

#[test]
fn rectangular_jpeg_quality_90_retains_full_binary_payload() {
    verify_texture(640, 512, Some(90));
}

#[test]
fn rectangular_jpeg_quality_80_retains_full_binary_payload() {
    verify_texture(640, 512, Some(80));
}

#[test]
fn rectangular_jpeg_quality_75_retains_full_binary_payload() {
    verify_texture(640, 512, Some(75));
}

#[test]
fn flat_and_smooth_images_retain_full_payload_after_png_storage() {
    let gradient = RgbImage::from_fn(512, 512, |x, y| {
        let level = 16 + ((x + y) * 223 / 1022) as u8;
        Rgb([level; 3])
    });
    let fixtures = [
        ("flat gray", RgbImage::from_pixel(512, 512, Rgb([128; 3]))),
        ("near white", RgbImage::from_pixel(512, 512, Rgb([250; 3]))),
        ("near black", RgbImage::from_pixel(512, 512, Rgb([5; 3]))),
        ("smooth gradient", gradient),
    ];
    let payload = binary_payload();
    let mut failures = Vec::new();
    for (name, original) in fixtures {
        let (marked, report) = embed(&original, &payload, KEY, STRENGTH).unwrap();
        let stored = stored_roundtrip(&marked, None);
        let recovered = extract(&stored, KEY);
        println!(
            "{name}, PNG, PSNR={:.3} dB, decoded={}, error={:?}",
            report.psnr_db,
            recovered.is_ok(),
            recovered.as_ref().err()
        );
        if recovered.as_deref() != Ok(payload.as_slice()) {
            failures.push(name);
        }
    }
    assert!(failures.is_empty(), "PNG recovery failed for: {failures:?}");
}

#[test]
fn wrong_key_and_unmarked_images_are_rejected() {
    for (width, height) in [(512, 512), (640, 512)] {
        let original = textured_fixture(width, height);
        assert!(extract(&original, KEY).is_err());
        let (marked, _) = embed(&original, &binary_payload(), KEY, STRENGTH).unwrap();
        let stored = stored_roundtrip(&marked, None);
        assert!(extract(&stored, "a different integration-test key").is_err());
    }
    let unmarked_gray = RgbImage::from_pixel(512, 512, Rgb([128; 3]));
    assert!(extract(&unmarked_gray, KEY).is_err());
}

#[test]
fn validates_capacity_strength_key_and_payload_size() {
    for (width, height) in [(0, 0), (8, 8), (256, 256)] {
        let small = RgbImage::new(width, height);
        assert!(embed(&small, b"small image", KEY, STRENGTH).is_err());
        assert!(extract(&small, KEY).is_err());
    }
    let image = textured_fixture(512, 512);
    for strength in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(embed(&image, b"invalid strength", KEY, strength).is_err());
    }
    assert!(embed(&image, &[0; PAYLOAD_BYTES + 1], KEY, STRENGTH).is_err());
    assert!(embed(&image, b"empty key", "", STRENGTH).is_err());
    assert!(extract(&image, "").is_err());
}
