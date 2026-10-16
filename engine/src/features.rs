//! Compression-tolerant feature reconciliation inspired by arXiv:1608.02291.
//!
//! Three public helper bits per component identify the quantization bin modulo
//! four and its lower/upper half. They are correction information, not a secret
//! or a cryptographic hash. Authentication must sign BOTH the recovered feature
//! vector and these helper bytes, together with the image dimensions and profile.
//!
//! Unlike the paper's inconsistent one-based bin equations, bins here are
//! explicitly zero-based. Recovery is guaranteed when every raw measurement
//! changes by at most `QUANTIZATION_STEP`, including embedding distortion. Larger
//! changes may be rejected or recover different features; only the signature
//! determines authenticity. Perceptually different images can share features.

use image::RgbImage;

pub const FEATURE_SIDE: usize = 32;
pub const FEATURE_COUNT: usize = FEATURE_SIDE * FEATURE_SIDE;
pub const HELPER_BYTES: usize = FEATURE_COUNT * 3 / 8;
pub const GRADIENT_FEATURES: usize = 976;
pub const COLOR_SIDE: usize = 4;
/// RGB cell means are divided by this amount before the shared quantizer.
pub const COLOR_SCALE: f64 = 8.0;
/// Fixed for this feature profile. Changing it requires a new signed profile.
pub const QUANTIZATION_STEP: f64 = 1.0;
/// Fixed, normalized nine-tap Gaussian approximation (variance 2 pixels²).
const BLUR_WEIGHTS: [f64; 9] = [1.0, 8.0, 28.0, 56.0, 70.0, 56.0, 28.0, 8.0, 1.0];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeatureSet {
    pub quantized: Vec<u16>,
    pub helper: [u8; HELPER_BYTES],
}

fn validate_dimensions(image: &RgbImage) -> Result<(usize, usize), String> {
    let (width, height) = image.dimensions();
    crate::geometry::authentication_layout(width, height)?;
    Ok((width as usize, height as usize))
}

/// The paper's 32×32 gradient-only baseline. It is insensitive to luminance
/// inversion and uniform channel shifts, so `measure_raw` adds color anchors.
pub fn measure_gradient_raw(image: &RgbImage) -> Result<Vec<f64>, String> {
    let (width, height) = validate_dimensions(image)?;
    let luminance: Vec<f64> = image
        .pixels()
        .map(|pixel| {
            0.299 * f64::from(pixel[0]) + 0.587 * f64::from(pixel[1]) + 0.114 * f64::from(pixel[2])
        })
        .collect();
    let mut horizontal = vec![0.0; luminance.len()];
    for y in 0..height {
        for x in 0..width {
            horizontal[y * width + x] = BLUR_WEIGHTS
                .iter()
                .enumerate()
                .map(|(tap, weight)| {
                    let xx = (x as isize + tap as isize - 4).clamp(0, width as isize - 1) as usize;
                    weight * luminance[y * width + xx]
                })
                .sum::<f64>()
                / 256.0;
        }
    }
    let mut smooth = vec![0.0; luminance.len()];
    for y in 0..height {
        for x in 0..width {
            smooth[y * width + x] = BLUR_WEIGHTS
                .iter()
                .enumerate()
                .map(|(tap, weight)| {
                    let yy = (y as isize + tap as isize - 4).clamp(0, height as isize - 1) as usize;
                    weight * horizontal[yy * width + x]
                })
                .sum::<f64>()
                / 256.0;
        }
    }
    let mut features = Vec::with_capacity(FEATURE_COUNT);
    for cell_y in 0..FEATURE_SIDE {
        let start_y = cell_y * height / FEATURE_SIDE;
        let end_y = (cell_y + 1) * height / FEATURE_SIDE;
        for cell_x in 0..FEATURE_SIDE {
            let start_x = cell_x * width / FEATURE_SIDE;
            let end_x = (cell_x + 1) * width / FEATURE_SIDE;
            let mut sum = 0.0;
            for y in start_y..end_y {
                for x in start_x..end_x {
                    let left = x.saturating_sub(1);
                    let right = (x + 1).min(width - 1);
                    let up = y.saturating_sub(1);
                    let down = (y + 1).min(height - 1);
                    let dx = (smooth[y * width + right] - smooth[y * width + left]) * 0.5;
                    let dy = (smooth[down * width + x] - smooth[up * width + x]) * 0.5;
                    sum += dx.hypot(dy);
                }
            }
            features.push(sum / ((end_x - start_x) * (end_y - start_y)) as f64);
        }
    }
    Ok(features)
}

/// Fixed profile 1: 976 distributed gradient samples followed by 48 color/DC
/// anchors. This is an explicit extension of the paper's grayscale descriptor.
///
/// The baseline is a 32×32 grid of mean Gaussian-smoothed gradient magnitudes.
/// Gradient sample i uses cell floor((2i+1)1024/(2×976)), in row-major order.
/// Anchors are row-major 4×4 cells, each contributing mean R, G, B divided by 8.
/// Cells partition the native image without resizing, even when sizes are not
/// divisible by 32. These anchors reduce easy color/inversion collisions; they
/// do not make the descriptor cryptographically collision-resistant.
pub fn measure_raw(image: &RgbImage) -> Result<Vec<f64>, String> {
    let gradient = measure_gradient_raw(image)?;
    let (width, height) = (image.width() as usize, image.height() as usize);
    let mut features = Vec::with_capacity(FEATURE_COUNT);
    for index in 0..GRADIENT_FEATURES {
        let cell = (2 * index + 1) * FEATURE_COUNT / (2 * GRADIENT_FEATURES);
        features.push(gradient[cell]);
    }
    for cell_y in 0..COLOR_SIDE {
        let start_y = cell_y * height / COLOR_SIDE;
        let end_y = (cell_y + 1) * height / COLOR_SIDE;
        for cell_x in 0..COLOR_SIDE {
            let start_x = cell_x * width / COLOR_SIDE;
            let end_x = (cell_x + 1) * width / COLOR_SIDE;
            let mut sum = [0_u64; 3];
            for y in start_y..end_y {
                for x in start_x..end_x {
                    let pixel = image.get_pixel(x as u32, y as u32);
                    for channel in 0..3 {
                        sum[channel] += u64::from(pixel[channel]);
                    }
                }
            }
            let denominator = ((end_x - start_x) * (end_y - start_y)) as f64 * COLOR_SCALE;
            features.extend(sum.map(|value| value as f64 / denominator));
        }
    }
    debug_assert_eq!(features.len(), FEATURE_COUNT);
    Ok(features)
}

/// Produce the signed feature vector and its 384-byte public correction data.
pub fn measure(image: &RgbImage) -> Result<FeatureSet, String> {
    quantize_raw(&measure_raw(image)?)
}

/// Recover the exact vector to verify, using helper bytes extracted from the
/// watermark. Success here is NOT authentication; a digital signature is needed.
pub fn recover(image: &RgbImage, helper: &[u8; HELPER_BYTES]) -> Result<Vec<u16>, String> {
    recover_raw(&measure_raw(image)?, helper)
}

fn validate_raw(raw: &[f64]) -> Result<(), String> {
    if raw.len() != FEATURE_COUNT {
        return Err(format!(
            "expected {FEATURE_COUNT} feature values, got {}",
            raw.len()
        ));
    }
    if raw.iter().any(|value| {
        !value.is_finite()
            || *value < 0.0
            || *value / QUANTIZATION_STEP >= f64::from(u16::MAX) + 1.0
    }) {
        return Err(
            "feature values must be finite, nonnegative, and representable as u16 bins".into(),
        );
    }
    Ok(())
}

fn write_helper(helper: &mut [u8; HELPER_BYTES], index: usize, value: u8) {
    for bit in 0..3 {
        let offset = 3 * index + bit;
        helper[offset / 8] |= ((value >> (2 - bit)) & 1) << (7 - offset % 8);
    }
}

fn read_helper(helper: &[u8; HELPER_BYTES], index: usize) -> u8 {
    (0..3).fold(0, |value, bit| {
        let offset = 3 * index + bit;
        (value << 1) | ((helper[offset / 8] >> (7 - offset % 8)) & 1)
    })
}

/// Quantize a measured vector. Helper triples are `(q mod 4, upper_half)`, packed
/// from the most significant bit; consecutive triples may cross byte boundaries.
pub fn quantize_raw(raw: &[f64]) -> Result<FeatureSet, String> {
    validate_raw(raw)?;
    let mut quantized = Vec::with_capacity(FEATURE_COUNT);
    let mut helper = [0_u8; HELPER_BYTES];
    for (index, value) in raw.iter().enumerate() {
        let scaled = value / QUANTIZATION_STEP;
        let q = scaled.floor() as u16;
        let upper_half = u8::from(scaled - f64::from(q) >= 0.5);
        write_helper(&mut helper, index, ((q % 4) as u8) << 1 | upper_half);
        quantized.push(q);
    }
    Ok(FeatureSet { quantized, helper })
}

/// Reconcile noisy measurements against public helper triples.
///
/// Compatible half-bin centers are separated by 4Δ. The original value is at
/// most Δ/4 from its center. If measurement noise is at most Δ, that center is
/// uniquely nearest and no farther than 5Δ/4. Checking that distance gives an
/// explicit bounded-noise guarantee and rejects measurements in the gaps.
pub fn recover_raw(raw: &[f64], helper: &[u8; HELPER_BYTES]) -> Result<Vec<u16>, String> {
    validate_raw(raw)?;
    raw.iter()
        .enumerate()
        .map(|(index, value)| {
            let bits = read_helper(helper, index);
            let residue = f64::from(bits >> 1);
            let phase = if bits & 1 == 0 { 0.25 } else { 0.75 };
            let scaled = value / QUANTIZATION_STEP;
            let q = 4.0 * ((scaled - residue - phase) / 4.0).round() + residue;
            // Floating-point noise at the inclusive bound must not reject a
            // mathematically permitted change. This tolerance is far below a
            // quantization interval and does not broaden the practical profile.
            let tolerance = 16.0 * f64::EPSILON * scaled.abs().max(1.0);
            if !(0.0..=f64::from(u16::MAX)).contains(&q)
                || (scaled - (q + phase)).abs() > 1.25 + tolerance
            {
                return Err(format!(
                    "feature {index} exceeds the reconciliation tolerance"
                ));
            }
            Ok(q as u16)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn helper_bit_packing_has_a_fixed_wire_representation() {
        let mut helper = [0; HELPER_BYTES];
        for index in 0..FEATURE_COUNT {
            write_helper(&mut helper, index, (index % 8) as u8);
        }
        assert_eq!(&helper[..3], &[0b0000_0101, 0b0011_1001, 0b0111_0111]);
        for index in 0..FEATURE_COUNT {
            assert_eq!(read_helper(&helper, index), (index % 8) as u8);
        }
    }

    #[test]
    fn exact_reconciliation_includes_bin_and_half_bin_boundaries() {
        let phases = [0.0, 1e-10, 0.25, 0.5 - 1e-10, 0.5, 0.75, 1.0 - 1e-10];
        for q in 0..12 {
            for phase in phases {
                let original = (f64::from(q) + phase) * QUANTIZATION_STEP;
                let source = vec![original; FEATURE_COUNT];
                let encoded = quantize_raw(&source).unwrap();
                for step in -100..=100 {
                    let received = original + f64::from(step) * QUANTIZATION_STEP / 100.0;
                    if received < 0.0 {
                        continue;
                    }
                    assert_eq!(
                        recover_raw(&vec![received; FEATURE_COUNT], &encoded.helper).unwrap(),
                        encoded.quantized,
                        "failed for original={original}, received={received}"
                    );
                }
            }
        }
    }

    #[test]
    fn excessive_changes_can_reject_or_recover_a_different_signed_vector() {
        let source = vec![5.25 * QUANTIZATION_STEP; FEATURE_COUNT];
        let encoded = quantize_raw(&source).unwrap();
        assert!(recover_raw(
            &vec![7.25 * QUANTIZATION_STEP; FEATURE_COUNT],
            &encoded.helper
        )
        .is_err());
        let shifted = recover_raw(
            &vec![9.25 * QUANTIZATION_STEP; FEATURE_COUNT],
            &encoded.helper,
        )
        .unwrap();
        assert_ne!(shifted, encoded.quantized);
        // A signature over the reconstructed vector, rather than recovery's
        // success flag, is essential to reject the latter case.
    }

    #[test]
    fn invalid_measurements_are_rejected() {
        assert!(quantize_raw(&[0.0]).is_err());
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 65536.0 * QUANTIZATION_STEP] {
            let mut input = vec![0.0; FEATURE_COUNT];
            input[17] = invalid;
            assert!(quantize_raw(&input).is_err());
            assert!(recover_raw(&input, &[0; HELPER_BYTES]).is_err());
        }
        assert!(measure(&RgbImage::new(512, 504)).is_err());
        assert!(measure(&RgbImage::new(31, 16384)).is_err());
    }

    #[test]
    fn constant_and_rectangular_images_have_zero_gradient() {
        let image = RgbImage::from_pixel(513, 521, Rgb([60, 100, 180]));
        let feature = measure(&image).unwrap();
        assert_eq!(
            &feature.quantized[..GRADIENT_FEATURES],
            vec![0; GRADIENT_FEATURES]
        );
        for anchor in feature.quantized[GRADIENT_FEATURES..].chunks_exact(3) {
            assert_eq!(anchor, &[7, 12, 22]);
        }
        assert_eq!(recover(&image, &feature.helper).unwrap(), feature.quantized);
    }

    #[test]
    fn gradient_only_profile_cannot_distinguish_inversion() {
        let original = RgbImage::from_fn(512, 512, |x, y| {
            let value = ((x * 13 + y * 7 + (x / 16) * 61) % 200 + 20) as u8;
            Rgb([value; 3])
        });
        let inverted = RgbImage::from_fn(512, 512, |x, y| {
            let value = 255 - original.get_pixel(x, y)[0];
            Rgb([value; 3])
        });
        let source = quantize_raw(&measure_gradient_raw(&original).unwrap()).unwrap();
        assert_eq!(
            recover_raw(&measure_gradient_raw(&inverted).unwrap(), &source.helper).unwrap(),
            source.quantized
        );
    }

    #[test]
    fn color_anchors_detect_large_inversion_and_uniform_color_shift() {
        let original = RgbImage::from_fn(512, 512, |x, y| {
            let value = ((x * 13 + y * 7 + (x / 16) * 61) % 100 + 20) as u8;
            Rgb([value, value + 10, value + 20])
        });
        let inverted = RgbImage::from_fn(512, 512, |x, y| {
            Rgb(original.get_pixel(x, y).0.map(|value| 255 - value))
        });
        let color_shift = RgbImage::from_fn(512, 512, |x, y| {
            let mut pixel = *original.get_pixel(x, y);
            pixel[0] += 40;
            pixel
        });
        let source = measure(&original).unwrap();
        for altered in [&inverted, &color_shift] {
            if let Ok(recovered) = recover(altered, &source.helper) {
                assert_ne!(recovered, source.quantized);
            }
        }
    }

    #[test]
    fn balanced_inversion_remains_a_known_descriptor_collision() {
        // Every color-anchor cell has the same mean after inversion, while all
        // gradient magnitudes are unchanged. This is a concrete limitation of
        // the feature family, even after adding the color/DC anchors. Keeping
        // this counterexample prevents treating the profile as a secure hash.
        let original = RgbImage::from_fn(512, 512, |x, y| {
            Rgb([if (x / 16 + y / 16) % 2 == 0 { 32 } else { 223 }; 3])
        });
        let inverted =
            RgbImage::from_fn(512, 512, |x, y| Rgb([255 - original.get_pixel(x, y)[0]; 3]));
        assert_ne!(original, inverted);
        let reference = measure(&original).unwrap();
        assert_eq!(
            recover(&inverted, &reference.helper).unwrap(),
            reference.quantized
        );
    }
}
