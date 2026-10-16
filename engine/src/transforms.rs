//! CPU transforms used by the watermark codec.
//!
//! All arrays are row-major. FFTs are unshifted: the DC coefficient is at index
//! zero. The forward FFT is unnormalized; the inverse divides by width * height.
//! DCT coefficients use the same layout, with vertical frequency as the row and
//! horizontal frequency as the column.

use rustfft::{num_complex::Complex, FftPlanner};
use std::sync::OnceLock;

fn validate_dimensions(len: usize, width: usize, height: usize) {
    assert!(width > 0 && height > 0, "FFT dimensions must be positive");
    let expected = width.checked_mul(height).expect("FFT dimensions overflow");
    assert_eq!(len, expected, "FFT data length must equal width * height");
}

fn transform2(data: &mut [Complex<f64>], width: usize, height: usize, inverse: bool) {
    let mut planner = FftPlanner::<f64>::new();
    let row_fft = if inverse {
        planner.plan_fft_inverse(width)
    } else {
        planner.plan_fft_forward(width)
    };
    let column_fft = if inverse {
        planner.plan_fft_inverse(height)
    } else {
        planner.plan_fft_forward(height)
    };
    let scratch_len = row_fft
        .get_inplace_scratch_len()
        .max(column_fft.get_inplace_scratch_len());
    let mut scratch = vec![Complex::default(); scratch_len];
    for row in data.chunks_exact_mut(width) {
        row_fft.process_with_scratch(row, &mut scratch);
    }
    let mut column = vec![Complex::default(); height];
    for x in 0..width {
        for y in 0..height {
            column[y] = data[y * width + x];
        }
        column_fft.process_with_scratch(&mut column, &mut scratch);
        for y in 0..height {
            data[y * width + x] = column[y];
        }
    }
}

/// Compute the unnormalized 2-D forward FFT of a real, row-major image plane.
pub fn fft2(real: &[f64], width: usize, height: usize) -> Vec<Complex<f64>> {
    validate_dimensions(real.len(), width, height);
    let mut spectrum: Vec<_> = real.iter().map(|&value| Complex::new(value, 0.0)).collect();
    transform2(&mut spectrum, width, height, false);
    spectrum
}

/// Compute the normalized inverse 2-D FFT and return its real component.
///
/// The caller must preserve conjugate symmetry when modifying a spectrum if it
/// expects the imaginary component to vanish. This function performs no shift,
/// clamping, rounding, or implicit symmetry repair.
pub fn ifft2(spectrum: &[Complex<f64>], width: usize, height: usize) -> Vec<f64> {
    validate_dimensions(spectrum.len(), width, height);
    let mut spatial = spectrum.to_vec();
    transform2(&mut spatial, width, height, true);
    let normalization = spatial.len() as f64;
    spatial
        .into_iter()
        .map(|value| value.re / normalization)
        .collect()
}

fn cosine_basis() -> &'static [[f64; 8]; 8] {
    static BASIS: OnceLock<[[f64; 8]; 8]> = OnceLock::new();
    BASIS.get_or_init(|| {
        let mut basis = [[0.0; 8]; 8];
        for (frequency, row) in basis.iter_mut().enumerate() {
            let normalization = if frequency == 0 {
                (1.0_f64 / 8.0).sqrt()
            } else {
                0.5
            };
            for (position, value) in row.iter_mut().enumerate() {
                *value = normalization
                    * (std::f64::consts::PI * (position as f64 + 0.5) * frequency as f64 / 8.0)
                        .cos();
            }
        }
        basis
    })
}

/// Orthonormal 2-D DCT-II on an 8-by-8 block, without JPEG level shifting.
pub fn dct8(block: &[f64; 64]) -> [f64; 64] {
    let basis = cosine_basis();
    let mut horizontal = [0.0; 64];
    for y in 0..8 {
        for u in 0..8 {
            horizontal[y * 8 + u] = (0..8).map(|x| basis[u][x] * block[y * 8 + x]).sum();
        }
    }
    let mut coefficients = [0.0; 64];
    for v in 0..8 {
        for u in 0..8 {
            coefficients[v * 8 + u] = (0..8).map(|y| basis[v][y] * horizontal[y * 8 + u]).sum();
        }
    }
    coefficients
}

/// Inverse of [`dct8`], using the transpose of its orthonormal cosine basis.
pub fn idct8(coefficients: &[f64; 64]) -> [f64; 64] {
    let basis = cosine_basis();
    let mut vertical = [0.0; 64];
    for y in 0..8 {
        for u in 0..8 {
            vertical[y * 8 + u] = (0..8).map(|v| basis[v][y] * coefficients[v * 8 + u]).sum();
        }
    }
    let mut block = [0.0; 64];
    for y in 0..8 {
        for x in 0..8 {
            block[y * 8 + x] = (0..8).map(|u| basis[u][x] * vertical[y * 8 + u]).sum();
        }
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "actual {actual}, expected {expected}, tolerance {tolerance}"
        );
    }

    #[test]
    fn rectangular_fft_round_trip_and_energy() {
        let (width, height) = (7, 5);
        let input: Vec<_> = (0..width * height)
            .map(|i| (i as f64 * 0.37).sin() + i as f64 / 11.0)
            .collect();
        let spectrum = fft2(&input, width, height);
        let output = ifft2(&spectrum, width, height);
        for (&actual, &expected) in output.iter().zip(&input) {
            assert_close(actual, expected, 1e-12);
        }
        let spatial_energy: f64 = input.iter().map(|x| x * x).sum();
        let spectral_energy: f64 = spectrum.iter().map(|x| x.norm_sqr()).sum();
        assert_close(spectral_energy / input.len() as f64, spatial_energy, 1e-10);
    }

    #[test]
    fn fft_impulse_has_expected_unshifted_phase() {
        let (width, height) = (5, 3);
        let (source_x, source_y) = (1, 2);
        let mut input = vec![0.0; width * height];
        input[source_y * width + source_x] = 1.0;
        let spectrum = fft2(&input, width, height);
        for v in 0..height {
            for u in 0..width {
                let angle = -std::f64::consts::TAU
                    * (u as f64 * source_x as f64 / width as f64
                        + v as f64 * source_y as f64 / height as f64);
                assert_close(spectrum[v * width + u].re, angle.cos(), 1e-12);
                assert_close(spectrum[v * width + u].im, angle.sin(), 1e-12);
            }
        }
    }

    #[test]
    fn single_pixel_fft_round_trip() {
        let spectrum = fft2(&[42.5], 1, 1);
        assert_eq!(spectrum, vec![Complex::new(42.5, 0.0)]);
        assert_eq!(ifft2(&spectrum, 1, 1), vec![42.5]);
    }

    #[test]
    fn dct_constant_has_only_expected_dc() {
        let coefficients = dct8(&[7.0; 64]);
        assert_close(coefficients[0], 56.0, 1e-12);
        for &coefficient in &coefficients[1..] {
            assert_close(coefficient, 0.0, 1e-12);
        }
    }

    #[test]
    fn dct_round_trip_preserves_energy() {
        let input = std::array::from_fn(|i| (i as f64 * 0.73).cos() * 17.0 + i as f64);
        let coefficients = dct8(&input);
        let output = idct8(&coefficients);
        for (actual, expected) in output.into_iter().zip(input) {
            assert_close(actual, expected, 1e-12);
        }
        let input_energy: f64 = input.iter().map(|x| x * x).sum();
        let output_energy: f64 = coefficients.iter().map(|x| x * x).sum();
        assert_close(output_energy, input_energy, 1e-9);
    }

    #[test]
    #[should_panic(expected = "FFT data length must equal width * height")]
    fn fft_rejects_inconsistent_shape() {
        fft2(&[1.0, 2.0], 2, 2);
    }
}
