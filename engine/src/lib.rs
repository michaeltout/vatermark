//! CPU image watermarking and experimental compression-tolerant authentication.
//!
//! `auth` combines reconciled image features, Verus signatures, and Haar/LDPC
//! transport inspired by arXiv:1608.02291. The original DFT–DCT byte watermark
//! based on arXiv:1911.00753 remains available through the top-level functions.
//! See AUTHENTICATION.md for the format, trust requirements, and known collisions.

pub mod auth;
pub mod features;
pub mod metadata_crypto;
mod geometry;
pub mod haar;
mod ldpc;
pub mod payload;
mod transforms;
pub mod verus;
pub mod web;

use image::RgbImage;
use rand::{seq::SliceRandom, Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rustfft::num_complex::Complex;
use serde::Serialize;
use transforms::{dct8, fft2, idct8, ifft2};

pub const DEFAULT_STRENGTH: f64 = 3000.0;
const SIDE: usize = 27;
const FRAME_BITS: usize = SIDE * SIDE;
const ARNOLD_ROUNDS: usize = 24;

#[derive(Debug, Serialize)]
pub struct EmbedReport {
    pub width: u32,
    pub height: u32,
    pub payload_bytes: usize,
    pub codeword_bytes: usize,
    pub carrier_blocks: usize,
    pub minimum_repetitions: usize,
    pub strength: f64,
    pub psnr_db: f64,
}

/// Keep dimension validation and carrier layout identical for embedding/extraction.
fn blocks(width: usize, height: usize) -> Result<Vec<(usize, usize)>, String> {
    if width < 8 || height < 18 {
        return Err("image is too small for an 8×8 Fourier-magnitude block".into());
    }
    // Positive y frequencies, excluding DC and Nyquist. Their conjugate partners
    // lie in the other half-plane. Reflect samples, not block indices.
    let rows = (height / 2 - 1) / 8;
    let columns = width / 8;
    let result: Vec<_> = (0..rows)
        .flat_map(|row| (0..columns).map(move |column| (column * 8, 1 + row * 8)))
        .collect();
    if result.len() < 2 * FRAME_BITS {
        return Err(format!(
            "image has {} carrier blocks; at least {} are required for two copies of the protected payload (use 512×512 or larger)",
            result.len(), 2 * FRAME_BITS
        ));
    }
    Ok(result)
}

fn rng(key: &str, domain: &str) -> ChaCha8Rng {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"vatermark-rust-v1\0");
    hasher.update(domain.as_bytes());
    hasher.update(key.as_bytes());
    ChaCha8Rng::from_seed(*hasher.finalize().as_bytes())
}

fn carriers(width: usize, height: usize, key: &str) -> Result<Vec<(usize, usize)>, String> {
    if key.is_empty() {
        return Err("key must not be empty".into());
    }
    let mut result = blocks(width, height)?;
    result.shuffle(&mut rng(key, "blocks"));
    Ok(result)
}

/// Explicit middle band (the paper does not enumerate its coordinates).
fn band() -> Vec<usize> {
    (0..64)
        .filter(|i| (3..=6).contains(&(i / 8 + i % 8)))
        .collect()
}

fn sequences(key: &str, length: usize) -> [Vec<f64>; 2] {
    let mut random = rng(key, "sequences");
    let mut first: Vec<_> = (0..length)
        .map(|i| if i < length / 2 { 1.0 } else { -1.0 })
        .collect();
    first.shuffle(&mut random);
    let mut second = first.clone();
    loop {
        second.shuffle(&mut random);
        let dot: f64 = first.iter().zip(&second).map(|(a, b)| a * b).sum();
        if dot.abs() <= 2.0 {
            return [first, second];
        }
    }
}

fn arnold(input: &[u8], inverse: bool) -> Vec<u8> {
    debug_assert_eq!(input.len(), FRAME_BITS);
    let mut current = input.to_vec();
    for _ in 0..ARNOLD_ROUNDS {
        let mut next = vec![0; FRAME_BITS];
        for y in 0..SIDE {
            for x in 0..SIDE {
                let (nx, ny) = if inverse {
                    ((2 * x + SIDE - y) % SIDE, (SIDE - x + y) % SIDE)
                } else {
                    ((x + y) % SIDE, (x + 2 * y) % SIDE)
                };
                next[ny * SIDE + nx] = current[y * SIDE + x];
            }
        }
        current = next;
    }
    current
}

fn luminance(image: &RgbImage) -> Vec<f64> {
    image
        .pixels()
        .map(|p| 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64)
        .collect()
}

fn magnitude_block(spectrum: &[Complex<f64>], width: usize, x: usize, y: usize) -> [f64; 64] {
    std::array::from_fn(|i| spectrum[(y + i / 8) * width + x + i % 8].norm())
}

/// Embed at native resolution, retaining RGB color through luminance-only changes.
pub fn embed(
    image: &RgbImage,
    data: &[u8],
    key: &str,
    strength: f64,
) -> Result<(RgbImage, EmbedReport), String> {
    if !strength.is_finite() || strength <= 0.0 {
        return Err("strength must be finite and greater than zero".into());
    }
    let codeword = payload::encode(data)?;
    let mut bits = payload::bytes_to_bits(&codeword);
    bits.resize(FRAME_BITS, 0);
    let bits = arnold(&bits, false);
    let (width, height) = (image.width() as usize, image.height() as usize);
    let positions = carriers(width, height, key)?;
    let middle = band();
    let pn = sequences(key, middle.len());
    let original = luminance(image);
    let mut spectrum = fft2(&original, width, height);
    // A native-size adaptation: preserve per-pixel strength as the carrier grid
    // grows. The given strength is defined for a 512×512 image in 0..255 units.
    let gain = strength * ((width * height) as f64).sqrt() / 512.0;
    let mut phases = rng(key, "empty-bin-phases");
    for (slot, &(x, y)) in positions.iter().enumerate() {
        let mut coefficients = dct8(&magnitude_block(&spectrum, width, x, y));
        let sequence = &pn[bits[slot % FRAME_BITS] as usize];
        for (&index, &sign) in middle.iter().zip(sequence) {
            coefficients[index] += gain * sign;
        }
        let mut magnitudes = idct8(&coefficients);
        // Negative Fourier magnitudes are invalid. A uniform offset modifies
        // only DCT DC, leaving the embedded middle-band coefficients intact.
        let minimum = magnitudes.iter().copied().fold(f64::INFINITY, f64::min);
        let offset = (-minimum).max(0.0);
        for (i, magnitude) in magnitudes.iter_mut().enumerate() {
            *magnitude += offset;
            let (fx, fy) = (x + i % 8, y + i / 8);
            let index = fy * width + fx;
            let phase = if spectrum[index].norm() > 1e-8 {
                spectrum[index] / spectrum[index].norm()
            } else {
                // Empty bins have no meaningful original phase. Identical
                // phases would concentrate energy into spikes on flat images.
                Complex::from_polar(1.0, phases.gen::<f64>() * std::f64::consts::TAU)
            };
            spectrum[index] = phase * *magnitude;
            let partner = ((height - fy) % height) * width + (width - fx) % width;
            spectrum[partner] = spectrum[index].conj();
        }
    }
    let modified = ifft2(&spectrum, width, height);
    let mut output = image.clone();
    for (i, pixel) in output.pixels_mut().enumerate() {
        let delta = modified[i] - original[i];
        for channel in &mut pixel.0 {
            *channel = (*channel as f64 + delta).round().clamp(0.0, 255.0) as u8;
        }
    }
    let report = EmbedReport {
        width: image.width(),
        height: image.height(),
        payload_bytes: data.len(),
        codeword_bytes: codeword.len(),
        carrier_blocks: positions.len(),
        minimum_repetitions: positions.len() / FRAME_BITS,
        strength,
        psnr_db: psnr(image, &output),
    };
    let recovered = extract(&output, key)
        .map_err(|error| format!("embedding failed verification after RGB clipping: {error}; try a different strength or image"))?;
    if recovered != data {
        return Err("embedding failed verification: recovered payload differs".into());
    }
    Ok((output, report))
}

/// Blind extraction. Invalid/absent watermarks fail RS decoding or the frame CRC.
pub fn extract(image: &RgbImage, key: &str) -> Result<Vec<u8>, String> {
    let (width, height) = (image.width() as usize, image.height() as usize);
    let positions = carriers(width, height, key)?;
    let middle = band();
    let pn = sequences(key, middle.len());
    let spectrum = fft2(&luminance(image), width, height);
    let mut scores = vec![0.0; FRAME_BITS];
    for (slot, &(x, y)) in positions.iter().enumerate() {
        let coefficients = dct8(&magnitude_block(&spectrum, width, x, y));
        let mean = middle.iter().map(|&i| coefficients[i]).sum::<f64>() / middle.len() as f64;
        let norm = middle
            .iter()
            .map(|&i| (coefficients[i] - mean).powi(2))
            .sum::<f64>()
            .sqrt();
        let difference = middle
            .iter()
            .enumerate()
            .map(|(j, &i)| coefficients[i] * (pn[1][j] - pn[0][j]))
            .sum::<f64>();
        // Difference of Pearson correlations, summed over distributed copies.
        scores[slot % FRAME_BITS] += difference / (norm * (middle.len() as f64).sqrt()).max(1e-12);
    }
    let bits: Vec<_> = scores.iter().map(|&score| u8::from(score >= 0.0)).collect();
    let bits = arnold(&bits, true);
    let codeword = payload::bits_to_bytes(&bits[..payload::CODEWORD_BITS])?;
    payload::decode(&codeword)
}

pub fn psnr(original: &RgbImage, modified: &RgbImage) -> f64 {
    assert_eq!(original.dimensions(), modified.dimensions());
    let mse = original
        .as_raw()
        .iter()
        .zip(modified.as_raw())
        .map(|(&a, &b)| (a as f64 - b as f64).powi(2))
        .sum::<f64>()
        / original.as_raw().len() as f64;
    if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0_f64.powi(2) / mse).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arnold_roundtrip_and_nonidentity() {
        let data: Vec<_> = (0..FRAME_BITS).map(|i| (i % 7 == 0) as u8).collect();
        let scrambled = arnold(&data, false);
        assert_ne!(scrambled, data);
        assert_eq!(arnold(&scrambled, true), data);
    }

    #[test]
    fn carrier_pairs_do_not_overlap_even_or_odd_dimensions() {
        for (width, height) in [(512, 512), (513, 517), (800, 600)] {
            let mut occupied = vec![false; width * height];
            for (x, y) in blocks(width, height).unwrap() {
                for dy in 0..8 {
                    for dx in 0..8 {
                        let (fx, fy) = (x + dx, y + dy);
                        for index in [
                            fy * width + fx,
                            ((height - fy) % height) * width + (width - fx) % width,
                        ] {
                            assert!(!occupied[index]);
                            occupied[index] = true;
                        }
                    }
                }
            }
        }
    }
}
