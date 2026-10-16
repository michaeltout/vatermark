//! Binary payload framing and Reed–Solomon correction for extracted watermark bits.
//!
//! Wire format: `VM | version=1 | length | payload[48] | CRC32[4] | parity[32]`.
//! The payload is zero padded and the CRC is big endian over the first 52 bytes.
//! The shortened RS(88, 56) code corrects up to 16 unknown erroneous bytes.
//! CRC32 detects accidental corruption; it is not cryptographic authentication.

use reed_solomon::{Decoder, Encoder};

pub const PAYLOAD_BYTES: usize = 48;
pub const CODEWORD_BYTES: usize = 88;
pub const CODEWORD_BITS: usize = CODEWORD_BYTES * 8;

const HEADER_BYTES: usize = 4;
const CRC_OFFSET: usize = HEADER_BYTES + PAYLOAD_BYTES;
const PACKET_BYTES: usize = CRC_OFFSET + 4;
const PARITY_BYTES: usize = CODEWORD_BYTES - PACKET_BYTES;

/// Frame up to 48 arbitrary bytes and append 32 Reed–Solomon parity bytes.
pub fn encode(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() > PAYLOAD_BYTES {
        return Err(format!("payload exceeds the {PAYLOAD_BYTES}-byte limit"));
    }
    let mut packet = [0u8; PACKET_BYTES];
    packet[..HEADER_BYTES].copy_from_slice(&[b'V', b'M', 1, data.len() as u8]);
    packet[HEADER_BYTES..HEADER_BYTES + data.len()].copy_from_slice(data);
    let checksum = crc32fast::hash(&packet[..CRC_OFFSET]);
    packet[CRC_OFFSET..].copy_from_slice(&checksum.to_be_bytes());
    let encoded = Encoder::new(PARITY_BYTES).encode(&packet);
    Ok(encoded
        .data()
        .iter()
        .chain(encoded.ecc())
        .copied()
        .collect())
}

/// Correct unknown byte errors, then validate the complete frame before returning data.
pub fn decode(codeword: &[u8]) -> Result<Vec<u8>, String> {
    if codeword.len() != CODEWORD_BYTES {
        return Err(format!("expected {CODEWORD_BYTES} encoded bytes"));
    }
    // None means the erroneous byte locations are unknown, not supplied erasures.
    let corrected = Decoder::new(PARITY_BYTES)
        .correct(codeword, None)
        .map_err(|_| "watermark packet could not be error corrected".to_string())?;
    let packet = corrected.data();
    if packet.len() != PACKET_BYTES || packet[..3] != [b'V', b'M', 1] {
        return Err("watermark packet has an invalid header or version".to_string());
    }
    let length = usize::from(packet[3]);
    if length > PAYLOAD_BYTES {
        return Err("watermark packet has an invalid payload length".to_string());
    }
    if packet[HEADER_BYTES + length..CRC_OFFSET]
        .iter()
        .any(|&byte| byte != 0)
    {
        return Err("watermark packet has nonzero payload padding".to_string());
    }
    let checksum = crc32fast::hash(&packet[..CRC_OFFSET]).to_be_bytes();
    if packet[CRC_OFFSET..] != checksum {
        return Err("watermark packet failed its CRC32 check".to_string());
    }
    Ok(packet[HEADER_BYTES..HEADER_BYTES + length].to_vec())
}

/// Expand bytes into individual bits, most significant bit first in each byte.
pub fn bytes_to_bits(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .flat_map(|&byte| (0..8).rev().map(move |shift| (byte >> shift) & 1))
        .collect()
}

/// Pack most-significant-first bits, rejecting partial bytes and nonbinary values.
pub fn bits_to_bytes(bits: &[u8]) -> Result<Vec<u8>, String> {
    if !bits.len().is_multiple_of(8) {
        return Err("bit count must be divisible by eight".to_string());
    }
    if bits.iter().any(|&bit| bit > 1) {
        return Err("bits must contain only 0 or 1".to_string());
    }
    Ok(bits
        .chunks_exact(8)
        .map(|chunk| chunk.iter().fold(0, |byte, &bit| (byte << 1) | bit))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protect_packet(packet: &[u8]) -> Vec<u8> {
        let encoded = Encoder::new(PARITY_BYTES).encode(packet);
        encoded
            .data()
            .iter()
            .chain(encoded.ecc())
            .copied()
            .collect()
    }

    fn update_crc(packet: &mut [u8]) {
        let checksum = crc32fast::hash(&packet[..CRC_OFFSET]).to_be_bytes();
        packet[CRC_OFFSET..].copy_from_slice(&checksum);
    }

    #[test]
    fn roundtrips_empty_binary_and_full_payloads() {
        let full: Vec<u8> = (0..PAYLOAD_BYTES).map(|i| (i * 37) as u8).collect();
        for data in [&[][..], &[0, 255, 128, 0, 254][..], full.as_slice()] {
            let encoded = encode(data).unwrap();
            assert_eq!(encoded.len(), CODEWORD_BYTES);
            assert_eq!(&encoded[..4], &[b'V', b'M', 1, data.len() as u8]);
            assert_eq!(decode(&encoded).unwrap(), data);
            let bits = bytes_to_bits(&encoded);
            assert_eq!(bits.len(), CODEWORD_BITS);
            assert_eq!(bits_to_bytes(&bits).unwrap(), encoded);
        }
        assert!(encode(&[0; PAYLOAD_BYTES + 1]).is_err());
    }

    #[test]
    fn corrects_up_to_sixteen_unknown_byte_errors() {
        let payload: Vec<u8> = (0..PAYLOAD_BYTES).map(|i| (i * 19 + 3) as u8).collect();
        let encoded = encode(&payload).unwrap();
        for start in [0, 29, 63] {
            for errors in 0..=16 {
                let mut damaged = encoded.clone();
                for i in 0..errors {
                    // Relatively-prime stride visits distinct header, data, CRC,
                    // and parity positions; all magnitudes are nonzero.
                    let position = (start + i * 5) % CODEWORD_BYTES;
                    damaged[position] ^= ((i * 29 + errors) % 255 + 1) as u8;
                }
                assert_eq!(
                    decode(&damaged).unwrap(),
                    payload,
                    "errors={errors}, start={start}"
                );
            }
        }
    }

    #[test]
    fn rejects_a_fixture_beyond_the_correction_capacity() {
        let mut damaged = encode(b"too many erroneous byte symbols").unwrap();
        for (i, byte) in damaged.iter_mut().take(17).enumerate() {
            *byte ^= (i + 1) as u8;
        }
        // Beyond 16 errors there is no general recovery guarantee. This fixed
        // over-capacity example must fail, rather than return corrupted payload.
        assert!(decode(&damaged).is_err());
        assert!(decode(&[0; CODEWORD_BYTES]).is_err());
        assert!(decode(&[255; CODEWORD_BYTES]).is_err());
    }

    #[test]
    fn rejects_unrelated_extracted_byte_sequences() {
        // Deterministic random-looking fixtures model decoding an unmarked
        // image or extracting with the wrong spreading key.
        let mut state = 0x1357_9bdf_u32;
        for _ in 0..64 {
            let mut unrelated = [0u8; CODEWORD_BYTES];
            for byte in &mut unrelated {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = (state >> 24) as u8;
            }
            assert!(decode(&unrelated).is_err());
        }
    }

    #[test]
    fn rejects_bad_crc_even_when_reed_solomon_parity_is_valid() {
        let encoded = encode(b"checksum").unwrap();
        let mut packet = encoded[..PACKET_BYTES].to_vec();
        packet[CRC_OFFSET] ^= 1;
        let forged = protect_packet(&packet);
        assert!(decode(&forged).unwrap_err().contains("CRC32"));
    }

    #[test]
    fn rejects_bad_header_length_and_padding_even_with_valid_crc_and_parity() {
        let encoded = encode(b"abc").unwrap();
        for (position, replacement, expected) in [
            (0, b'X', "header"),
            (2, 2, "version"),
            (3, 49, "length"),
            (HEADER_BYTES + 3, 1, "padding"),
        ] {
            let mut packet = encoded[..PACKET_BYTES].to_vec();
            packet[position] = replacement;
            update_crc(&mut packet);
            let forged = protect_packet(&packet);
            assert!(decode(&forged).unwrap_err().contains(expected));
        }
        assert!(decode(&encoded[..CODEWORD_BYTES - 1]).is_err());
        let mut oversized = encoded;
        oversized.push(0);
        assert!(decode(&oversized).is_err());
    }

    #[test]
    fn bits_are_big_endian_and_must_be_complete_binary_bytes() {
        assert_eq!(bytes_to_bits(&[0x81]), [1, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(bits_to_bytes(&[1, 0, 1, 0, 0, 1, 0, 1]).unwrap(), [0xa5]);
        assert_eq!(bits_to_bytes(&[]).unwrap(), Vec::<u8>::new());
        assert!(bits_to_bytes(&[1, 0, 1]).is_err());
        assert!(bits_to_bytes(&[0, 0, 0, 0, 0, 0, 0, 2]).is_err());
    }
}
