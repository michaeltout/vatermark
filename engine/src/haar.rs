//! CPU watermark transport based on §III of arXiv:1608.02291.
//!
//! Orthonormal three-level Haar LH3 and HL3 coefficients carry the rate-1/2
//! LDPC codeword through the paper's ±quarter-step QIM (equation 11). Native
//! rectangular images use the largest top-left interior with dimensions that
//! are multiples of 8. Trailing right/bottom pixels remain byte-identical.
//! Public deterministic shuffling and repeated carriers on larger images are
//! explicit extensions; this module needs no secret watermark key.

use crate::{geometry, ldpc};
use image::RgbImage;
use rand::{seq::SliceRandom, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;

pub use crate::ldpc::DecodeReport;
pub const BLOCK_BYTES: usize = ldpc::DATA_BYTES;
pub const DEFAULT_STEP: f64 = 32.0;

#[derive(Debug, Serialize)]
pub struct Report {
    pub width: u32,
    pub height: u32,
    pub payload_bytes: usize,
    pub encoded_bits: usize,
    pub carrier_count: usize,
    pub minimum_repetitions: usize,
    pub step: f64,
    pub psnr_db: f64,
}

fn validate(image: &RgbImage, step: f64) -> Result<geometry::Layout, String> {
    let (width, height) = image.dimensions();
    let layout = geometry::authentication_layout(width, height)?;
    if !step.is_finite() || !(1.0..=256.0).contains(&step) {
        return Err("Haar quantization step must be finite and in 1..=256".into());
    }
    Ok(layout)
}

fn luminance(image: &RgbImage, width: usize, height: usize) -> Vec<f64> {
    let mut values = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let p = image.get_pixel(x as u32, y as u32);
            values
                .push(0.299 * f64::from(p[0]) + 0.587 * f64::from(p[1]) + 0.114 * f64::from(p[2]));
        }
    }
    values
}

/// Three levels, rows then columns. Top-left LL is recursively transformed;
/// the right-hand quadrant is the horizontal difference band.
fn forward(values: &mut [f64], width: usize, height: usize) {
    let scale = std::f64::consts::FRAC_1_SQRT_2;
    let mut scratch = vec![0.0; width.max(height)];
    for level in 0..3 {
        let w = width >> level;
        let h = height >> level;
        for y in 0..h {
            for x in 0..w / 2 {
                let a = values[y * width + 2 * x];
                let b = values[y * width + 2 * x + 1];
                scratch[x] = (a + b) * scale;
                scratch[w / 2 + x] = (a - b) * scale;
            }
            values[y * width..y * width + w].copy_from_slice(&scratch[..w]);
        }
        for x in 0..w {
            for y in 0..h / 2 {
                let a = values[(2 * y) * width + x];
                let b = values[(2 * y + 1) * width + x];
                scratch[y] = (a + b) * scale;
                scratch[h / 2 + y] = (a - b) * scale;
            }
            for y in 0..h {
                values[y * width + x] = scratch[y];
            }
        }
    }
}

fn inverse(values: &mut [f64], width: usize, height: usize) {
    let scale = std::f64::consts::FRAC_1_SQRT_2;
    let mut scratch = vec![0.0; width.max(height)];
    for level in (0..3).rev() {
        let w = width >> level;
        let h = height >> level;
        for x in 0..w {
            for y in 0..h / 2 {
                let a = values[y * width + x];
                let b = values[(h / 2 + y) * width + x];
                scratch[2 * y] = (a + b) * scale;
                scratch[2 * y + 1] = (a - b) * scale;
            }
            for y in 0..h {
                values[y * width + x] = scratch[y];
            }
        }
        for y in 0..h {
            for x in 0..w / 2 {
                let a = values[y * width + x];
                let b = values[y * width + x + w / 2];
                scratch[2 * x] = (a + b) * scale;
                scratch[2 * x + 1] = (a - b) * scale;
            }
            values[y * width..y * width + w].copy_from_slice(&scratch[..w]);
        }
    }
}

fn carriers(width: usize, height: usize) -> Vec<usize> {
    let w = width / 8;
    let h = height / 8;
    let mut positions = Vec::with_capacity(2 * w * h);
    for y in 0..h {
        for x in 0..w {
            positions.push(y * width + w + x);
            positions.push((h + y) * width + x);
        }
    }
    let seed = *blake3::hash(b"vatermark-haar-carriers-v1\0").as_bytes();
    positions.shuffle(&mut ChaCha8Rng::from_seed(seed));
    positions
}

pub fn embed(
    image: &RgbImage,
    block: &[u8; BLOCK_BYTES],
    step: f64,
) -> Result<(RgbImage, Report), String> {
    let layout = validate(image, step)?;
    let (width, height) = image.dimensions();
    let width_usize = layout.width;
    let height_usize = layout.height;
    let original_y = luminance(image, width_usize, height_usize);
    let mut values = original_y.clone();
    forward(&mut values, width_usize, height_usize);
    let bits = ldpc::encode(block);
    let positions = carriers(width_usize, height_usize);
    debug_assert_eq!(positions.len(), layout.carrier_count);
    for (i, &position) in positions.iter().enumerate() {
        values[position] = step
            * ((values[position] / step).round()
                + if bits[i % ldpc::CODE_BITS] == 1 {
                    0.25
                } else {
                    -0.25
                });
    }
    inverse(&mut values, width_usize, height_usize);
    let mut marked = image.clone();
    for y in 0..height_usize {
        for x in 0..width_usize {
            let offset = y * width_usize + x;
            let after = values[offset];
            let before = original_y[offset];
            let pixel = marked.get_pixel_mut(x as u32, y as u32);
            for channel in &mut pixel.0 {
                *channel = (f64::from(*channel) + after - before)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }
    let report = Report {
        width,
        height,
        payload_bytes: BLOCK_BYTES,
        encoded_bits: ldpc::CODE_BITS,
        carrier_count: positions.len(),
        minimum_repetitions: positions.len() / ldpc::CODE_BITS,
        step,
        psnr_db: crate::psnr(image, &marked),
    };
    Ok((marked, report))
}

fn soft_bit(value: f64, step: f64) -> f64 {
    // Squared distances to the two periodic quantization lattices produce a
    // triangular confidence: uncertainty at either decision boundary, maximal
    // confidence at ±step/4. Positive LLR favors bit zero.
    let distance = |offset: f64| {
        let translated = value / step - offset;
        (translated - translated.round()).abs()
    };
    let zero = distance(-0.25);
    let one = distance(0.25);
    32.0 * (one * one - zero * zero)
}

pub fn extract(image: &RgbImage, step: f64) -> Result<([u8; BLOCK_BYTES], DecodeReport), String> {
    let layout = validate(image, step)?;
    let mut values = luminance(image, layout.width, layout.height);
    forward(&mut values, layout.width, layout.height);
    let mut llrs = vec![0.0; ldpc::CODE_BITS];
    for (i, position) in carriers(layout.width, layout.height)
        .into_iter()
        .enumerate()
    {
        llrs[i % ldpc::CODE_BITS] += soft_bit(values[position], step);
    }
    ldpc::decode(&llrs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::jpeg::JpegEncoder, Rgb};

    #[test]
    fn rectangular_transform_preserves_energy_and_samples() {
        let (width, height) = (24, 40);
        let original: Vec<_> = (0..width * height)
            .map(|i| ((i * 97 % 251) as f64) - 128.0)
            .collect();
        let mut transformed = original.clone();
        forward(&mut transformed, width, height);
        let energy: f64 = original.iter().map(|v| v * v).sum();
        let transformed_energy: f64 = transformed.iter().map(|v| v * v).sum();
        assert!((energy - transformed_energy).abs() < 1e-7);
        inverse(&mut transformed, width, height);
        assert!(original
            .iter()
            .zip(&transformed)
            .all(|(a, b)| (a - b).abs() < 1e-10));
    }

    #[test]
    fn qim_handles_negative_coefficients_and_boundaries() {
        for bin in -4..=4 {
            let base = f64::from(bin) * DEFAULT_STEP;
            assert!(soft_bit(base - DEFAULT_STEP / 4.0, DEFAULT_STEP) > 7.9);
            assert!(soft_bit(base + DEFAULT_STEP / 4.0, DEFAULT_STEP) < -7.9);
            assert!(soft_bit(base, DEFAULT_STEP).abs() < 1e-10);
            assert!(soft_bit(base + DEFAULT_STEP / 2.0, DEFAULT_STEP).abs() < 1e-10);
        }
    }

    fn fixture() -> RgbImage {
        fixture_with_size(512, 512)
    }

    fn fixture_with_size(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| {
            let base =
                128.0 + 38.0 * (f64::from(x) / 21.0).sin() + 25.0 * (f64::from(y) / 33.0).cos();
            Rgb([
                (base + f64::from((x * 7 + y * 13) % 19) - 9.0) as u8,
                base as u8,
                (base - 12.0) as u8,
            ])
        })
    }

    #[test]
    fn full_binary_payload_survives_pixels_and_jpeg75() {
        let original = fixture();
        let payload = std::array::from_fn(|i| (i as u8).wrapping_mul(31).wrapping_add(7));
        let (marked, report) = embed(&original, &payload, DEFAULT_STEP).unwrap();
        // Freeze Vatermark's carrier ordering, LDPC graph, and pixel arithmetic.
        assert_eq!(
            blake3::hash(marked.as_raw()).to_hex().as_str(),
            "0df28c0727c2e40e0507119955a5218269ef097fd536151cc30d2da4b3689849"
        );
        assert!(report.psnr_db > 39.0);
        assert_eq!(extract(&marked, DEFAULT_STEP).unwrap().0, payload);
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 75)
            .encode_image(&marked)
            .unwrap();
        let recompressed = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(extract(&recompressed, DEFAULT_STEP).unwrap().0, payload);

        let mut jpeg420 = Vec::new();
        let mut encoder = jpeg_encoder::Encoder::new(&mut jpeg420, 75);
        encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
        encoder
            .encode(marked.as_raw(), 512, 512, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        let recompressed420 = image::load_from_memory(&jpeg420).unwrap().to_rgb8();
        assert_eq!(extract(&recompressed420, DEFAULT_STEP).unwrap().0, payload);
    }

    #[test]
    fn unsupported_dimensions_and_steps_fail() {
        let payload = [0; BLOCK_BYTES];
        assert!(embed(&RgbImage::new(511, 512), &payload, DEFAULT_STEP).is_err());
        assert!(embed(&RgbImage::new(512, 511), &payload, DEFAULT_STEP).is_err());
        // Large total area alone is insufficient: only complete 8x8 cells
        // provide carriers (2 * 33 * 124 = 8184, below the required 8192).
        assert!(embed(&RgbImage::new(264, 999), &payload, DEFAULT_STEP).is_err());
        assert!(embed(&RgbImage::new(512, 520), &payload, f64::NAN).is_err());
    }

    #[test]
    fn rectangular_and_odd_dimensions_roundtrip_with_unchanged_borders() {
        let payload = std::array::from_fn(|i| (i as u8).wrapping_mul(53).wrapping_add(17));
        for (width, height) in [(1024, 256), (256, 1024), (519, 519), (1047, 263)] {
            let original = fixture_with_size(width, height);
            let interior_width = width / 8 * 8;
            let interior_height = height / 8 * 8;
            let (marked, report) = embed(&original, &payload, DEFAULT_STEP).unwrap();
            assert_eq!(marked.dimensions(), original.dimensions());
            assert_eq!((report.width, report.height), original.dimensions());
            assert_eq!(
                report.carrier_count,
                (2 * (width / 8) * (height / 8)) as usize
            );
            assert_eq!(extract(&marked, DEFAULT_STEP).unwrap().0, payload);
            for (x, y, pixel) in marked.enumerate_pixels() {
                if x >= interior_width || y >= interior_height {
                    assert_eq!(pixel, original.get_pixel(x, y));
                }
            }
            // Native row stride must not leak into the packed transform.
            let interior =
                image::imageops::crop_imm(&original, 0, 0, interior_width, interior_height)
                    .to_image();
            let (marked_interior, _) = embed(&interior, &payload, DEFAULT_STEP).unwrap();
            assert_eq!(
                image::imageops::crop_imm(&marked, 0, 0, interior_width, interior_height)
                    .to_image(),
                marked_interior
            );
        }
    }

    /// Optional local benchmark; the user's photo is never a test dependency.
    #[test]
    #[ignore = "local photo benchmark: cargo test --release haar::tests::photo_probe -- --ignored --nocapture"]
    fn photo_probe() {
        let source = image::open("photo.jpg").unwrap().to_rgb8();
        let payload = std::array::from_fn(|i| (i as u8).wrapping_mul(71).wrapping_add(13));
        for size in [512, 800] {
            let source =
                image::imageops::resize(&source, size, size, image::imageops::FilterType::Lanczos3);
            for step in [24.0, 32.0, 40.0, 48.0] {
                let started = std::time::Instant::now();
                let (marked, report) = embed(&source, &payload, step).unwrap();
                println!(
                    "{size} step {step}: {:.2} dB, {:.3}s embed",
                    report.psnr_db,
                    started.elapsed().as_secs_f64()
                );
                assert_eq!(extract(&marked, step).unwrap().0, payload);
                for quality in [90, 80, 75, 60] {
                    let mut jpeg = Vec::new();
                    JpegEncoder::new_with_quality(&mut jpeg, quality)
                        .encode_image(&marked)
                        .unwrap();
                    let recompressed = image::load_from_memory(&jpeg).unwrap().to_rgb8();
                    match extract(&recompressed, step) {
                        Ok((recovered, decode)) => println!(
                            "  JPEG{quality}: recovered={} {decode:?}",
                            recovered == payload
                        ),
                        Err(error) => println!("  JPEG{quality}: {error}"),
                    }
                }
            }
        }
    }
}
