//! A fully specified systematic (8192, 4096) IRA-LDPC code.
//!
//! The paper specifies only a code size, not its parity-check matrix. This is
//! our engineering choice: H = [A | B], where A is the XOR of three seeded
//! permutations and B is the lower dual-diagonal accumulator matrix. Every
//! information variable has degree three; checks have degree five (four for
//! the first check). Encoding and decoding are linear in the block size per
//! iteration. It is not the authors' unpublished LDPC implementation.

use rand::{seq::SliceRandom, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;
use std::sync::OnceLock;

pub const DATA_BYTES: usize = 512;
pub const DATA_BITS: usize = DATA_BYTES * 8;
pub const CODE_BITS: usize = DATA_BITS * 2;
const MAX_ITERATIONS: usize = 100;

struct Code {
    data_checks: Vec<[usize; 3]>,
    checks: Vec<Vec<usize>>,
}

fn code() -> &'static Code {
    static CODE: OnceLock<Code> = OnceLock::new();
    CODE.get_or_init(|| {
        let seed = *blake3::hash(b"vatermark-haar-ira-ldpc-v1\0").as_bytes();
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut permutations: Vec<Vec<usize>> = Vec::new();
        for _ in 0..3 {
            loop {
                let mut candidate: Vec<_> = (0..DATA_BITS).collect();
                candidate.shuffle(&mut rng);
                if permutations
                    .iter()
                    .all(|p| p.iter().zip(&candidate).all(|(a, b)| a != b))
                {
                    permutations.push(candidate);
                    break;
                }
            }
        }
        let data_checks: Vec<_> = (0..DATA_BITS)
            .map(|i| [permutations[0][i], permutations[1][i], permutations[2][i]])
            .collect();
        let checks = data_checks
            .iter()
            .enumerate()
            .map(|(i, data)| {
                let mut check = data.to_vec();
                check.push(DATA_BITS + i);
                if i != 0 {
                    check.push(DATA_BITS + i - 1);
                }
                check
            })
            .collect();
        Code {
            data_checks,
            checks,
        }
    })
}

pub fn encode(data: &[u8; DATA_BYTES]) -> Vec<u8> {
    let mut bits = vec![0; CODE_BITS];
    for (i, bit) in bits[..DATA_BITS].iter_mut().enumerate() {
        *bit = (data[i / 8] >> (7 - i % 8)) & 1;
    }
    let mut accumulator = 0;
    for (i, check) in code().data_checks.iter().enumerate() {
        accumulator ^= bits[check[0]] ^ bits[check[1]] ^ bits[check[2]];
        bits[DATA_BITS + i] = accumulator;
    }
    bits
}

#[derive(Debug, Clone, Serialize)]
pub struct DecodeReport {
    pub iterations: usize,
    pub corrected_hard_bits: usize,
    pub initial_unsatisfied_checks: usize,
}

fn unsatisfied(bits: &[u8]) -> usize {
    code()
        .checks
        .iter()
        .filter(|check| check.iter().fold(0, |parity, &i| parity ^ bits[i]) != 0)
        .count()
}

/// Positive log-likelihood ratios favor zero. A successful parity check alone
/// does not authenticate data: callers must check their frame/signature too.
pub fn decode(llrs: &[f64]) -> Result<([u8; DATA_BYTES], DecodeReport), String> {
    if llrs.len() != CODE_BITS || llrs.iter().any(|v| !v.is_finite()) {
        return Err(format!("LDPC needs {CODE_BITS} finite soft measurements"));
    }
    let code = code();
    let mut beliefs: Vec<f64> = llrs.iter().map(|x| x.clamp(-40.0, 40.0)).collect();
    let original: Vec<u8> = beliefs.iter().map(|&v| u8::from(v < 0.0)).collect();
    let initial_unsatisfied_checks = unsatisfied(&original);
    let mut bits = original.clone();
    let mut messages = vec![[0.0_f64; 5]; DATA_BITS];
    let mut remaining = initial_unsatisfied_checks;
    for iteration in 0..=MAX_ITERATIONS {
        if remaining == 0 {
            let mut bytes = [0; DATA_BYTES];
            for (i, &bit) in bits[..DATA_BITS].iter().enumerate() {
                bytes[i / 8] |= bit << (7 - i % 8);
            }
            return Ok((
                bytes,
                DecodeReport {
                    iterations: iteration,
                    corrected_hard_bits: bits.iter().zip(&original).filter(|(a, b)| a != b).count(),
                    initial_unsatisfied_checks,
                },
            ));
        }
        if iteration == MAX_ITERATIONS {
            break;
        }
        // Layered normalized min-sum: remove this check's previous message,
        // derive its new extrinsic message, and update beliefs immediately.
        for (check, old) in code.checks.iter().zip(&mut messages) {
            let mut extrinsic = [0.0; 5];
            let mut smallest = f64::INFINITY;
            let mut second = f64::INFINITY;
            let mut smallest_index = 0;
            let mut negative = false;
            for (j, &variable) in check.iter().enumerate() {
                let value = (beliefs[variable] - old[j]).clamp(-40.0, 40.0);
                extrinsic[j] = value;
                negative ^= value < 0.0;
                let magnitude = value.abs();
                if magnitude < smallest {
                    second = smallest;
                    smallest = magnitude;
                    smallest_index = j;
                } else if magnitude < second {
                    second = magnitude;
                }
            }
            for (j, &variable) in check.iter().enumerate() {
                let magnitude = 0.8
                    * if j == smallest_index {
                        second
                    } else {
                        smallest
                    };
                let outgoing = if negative ^ (extrinsic[j] < 0.0) {
                    -magnitude
                } else {
                    magnitude
                };
                old[j] = outgoing;
                beliefs[variable] = extrinsic[j] + outgoing;
            }
        }
        for (bit, &belief) in bits.iter_mut().zip(&beliefs) {
            *bit = u8::from(belief < 0.0);
        }
        remaining = unsatisfied(&bits);
    }
    Err(format!(
        "LDPC failed after {MAX_ITERATIONS} iterations ({remaining} unsatisfied checks; image may be unmarked, distorted, or use another profile)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::Rng;

    fn fixture() -> [u8; DATA_BYTES] {
        std::array::from_fn(|i| (i as u8).wrapping_mul(37).wrapping_add(19))
    }

    #[test]
    fn systematic_encoding_and_clean_decoding() {
        let bytes = fixture();
        let bits = encode(&bytes);
        // Protect the wire format from changes to graph generation or RNGs.
        assert_eq!(
            blake3::hash(&bits).to_hex().as_str(),
            "f747e0a43b3288c5ed56e340b9d3abff7b5eac2f7e17a39bb09c996c3fe5883c"
        );
        assert_eq!(bits, encode(&bytes));
        assert_eq!(unsatisfied(&bits), 0);
        let llrs: Vec<_> = bits
            .iter()
            .map(|&b| if b == 0 { 5.0 } else { -5.0 })
            .collect();
        let (recovered, report) = decode(&llrs).unwrap();
        assert_eq!(bytes, recovered);
        assert_eq!(report.iterations, 0);
    }

    #[test]
    fn corrects_seeded_awgn_noise() {
        let bytes = fixture();
        let bits = encode(&bytes);
        let mut rng = ChaCha8Rng::from_seed([27; 32]);
        let llrs: Vec<_> = bits
            .iter()
            .map(|&bit| {
                let u: f64 = rng.gen_range(0.000001..1.0);
                let v: f64 = rng.gen_range(0.0..1.0);
                let noise = (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos();
                4.0 * (if bit == 0 { 1.0 } else { -1.0 }) + noise * 2.5
            })
            .collect();
        let errors = llrs
            .iter()
            .zip(&bits)
            .filter(|(v, b)| u8::from(**v < 0.0) != **b)
            .count();
        assert!(errors > 300, "fixture must actually exercise correction");
        let (recovered, report) = decode(&llrs).unwrap();
        assert_eq!(bytes, recovered);
        assert_eq!(report.corrected_hard_bits, errors);
        assert!(report.iterations > 0);
    }

    #[test]
    fn rejects_invalid_soft_measurements() {
        assert!(decode(&[]).is_err());
        assert!(decode(&vec![f64::NAN; CODE_BITS]).is_err());
    }
}
