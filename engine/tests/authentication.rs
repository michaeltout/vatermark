//! End-to-end fixtures use actual secp256k1 signatures and explicitly trusted
//! local identities. They do not assert that the fixture identity exists on-chain.

use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat, Rgb, RgbImage};
use std::io::Cursor;
use vatermark::{auth, features, haar, verus};

fn image_fixture(width: u32, height: u32) -> RgbImage {
    RgbImage::from_fn(width, height, |x, y| {
        let base = 128.0 + 38.0 * (f64::from(x) / 21.0).sin() + 25.0 * (f64::from(y) / 33.0).cos();
        Rgb([
            (base + f64::from((x * 7 + y * 13) % 19) - 9.0) as u8,
            base as u8,
            (base - 12.0) as u8,
        ])
    })
}

fn sign_source(
    image: &RgbImage,
    explicit_system: bool,
) -> (verus::Envelope, features::FeatureSet, verus::Identity) {
    let measured = features::measure(image).unwrap();
    let mut envelope = verus::Envelope::new(
        [0x42; 20],
        explicit_system.then_some([0x61; 20]),
        true,
        12_345,
    );
    let message = auth::signed_message(
        &envelope,
        image.width(),
        image.height(),
        &measured.helper,
        &measured.quantized,
    )
    .unwrap();
    let identity = verus::sign_fixture(&mut envelope, &message, [9; 32]).unwrap();
    (envelope, measured, identity)
}

fn rewrite_crc(block: &mut [u8; haar::BLOCK_BYTES]) {
    let checksum = crc32fast::hash(&block[..508]).to_be_bytes();
    block[508..].copy_from_slice(&checksum);
}

#[test]
fn both_envelope_sizes_have_strict_canonical_frames() {
    let image = image_fixture(512, 512);
    for explicit in [false, true] {
        let (envelope, measured, _) = sign_source(&image, explicit);
        let block = auth::encode_packet(&envelope, &measured.helper).unwrap();
        let expected = if explicit { 110 } else { 90 };
        assert_eq!(&block[..4], &[b'V', b'A', 1, expected as u8]);
        assert_eq!(&block[4..4 + expected], envelope.encode().unwrap());
        let padding_start = 4 + expected + features::HELPER_BYTES;
        assert!(block[padding_start..508].iter().all(|&byte| byte == 0));
        let recovered = auth::decode_packet(&block).unwrap();
        assert_eq!(recovered.envelope, envelope);
        assert_eq!(recovered.helper, measured.helper);

        // Each malformed frame has a valid checksum so the corresponding
        // structural validation, rather than CRC alone, must reject it.
        for (offset, replacement) in [
            (0, b'X'),
            (2, 2),
            (3, 91),
            (4, 0x51),
            (5, 0x80),
            (padding_start, 1),
        ] {
            let mut malformed = block;
            malformed[offset] = replacement;
            rewrite_crc(&mut malformed);
            assert!(
                auth::decode_packet(&malformed).is_err(),
                "accepted invalid byte at {offset}"
            );
        }
        let mut wrong_flag = block;
        wrong_flag[5] ^= verus::HAS_SYSTEM_ID;
        rewrite_crc(&mut wrong_flag);
        assert!(auth::decode_packet(&wrong_flag).is_err());

        let mut damaged = block;
        damaged[4 + expected] ^= 1;
        assert!(auth::decode_packet(&damaged).is_err());
    }
}

#[test]
fn vatermark_frames_reject_earlier_profiles_without_fallback() {
    let source = image_fixture(512, 512);
    assert_eq!(
        verus::Envelope::new([0x42; 20], None, true, 12_345).version_type,
        verus::PROFILE
    );
    let (envelope, measured, identity) = sign_source(&source, false);
    let (marked, _) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
    let verified = auth::verify(&marked, &identity).unwrap();
    assert!(verified.signature_valid);
    assert_eq!(verified.version_type, 0x31);
    for profile in [0x11, 0x21] {
        // A checksum-correct packet with an earlier profile must be rejected
        // rather than interpreted under the renamed domains and transport.
        let (mut swapped, _) = haar::extract(&marked, haar::DEFAULT_STEP).unwrap();
        swapped[4] = profile;
        rewrite_crc(&mut swapped);
        assert!(auth::decode_packet(&swapped).is_err());
        let (transplanted, _) = haar::embed(&source, &swapped, haar::DEFAULT_STEP).unwrap();
        assert_eq!(
            haar::extract(&transplanted, haar::DEFAULT_STEP).unwrap().0,
            swapped
        );
        assert!(
            auth::verify(&transplanted, &identity).is_err(),
            "accepted a signature transplanted from profile {profile:#04x}"
        );
    }
}

#[test]
fn signatures_bind_the_vatermark_message_domain() {
    let source = image_fixture(512, 512);
    let (envelope, measured, identity) = sign_source(&source, false);
    let message =
        auth::signed_message(&envelope, 512, 512, &measured.helper, &measured.quantized).unwrap();
    let domain = b"Vatermark/image-auth/v1\0";
    assert!(message.starts_with(domain));
    assert_eq!(message.len(), 2510);
    let mut different_domain = b"Other/image-auth/v1\0".to_vec();
    different_domain.extend_from_slice(&message[domain.len()..]);
    assert!(verus::verify(&envelope, &different_domain, &identity).is_err());
}

#[test]
fn both_signatures_survive_png_and_two_jpeg_encoders() {
    let source = image_fixture(512, 512);
    for explicit in [false, true] {
        let (envelope, measured, identity) = sign_source(&source, explicit);
        let (marked, report) =
            auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
        assert_eq!(report.envelope_bytes, if explicit { 110 } else { 90 });
        assert_eq!(
            report.authentication_bytes,
            if explicit { 494 } else { 474 }
        );
        assert!(report.watermark.psnr_db > 39.0);
        assert!(report.verification.signature_valid);

        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(marked.clone())
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let saved = image::load_from_memory(png.get_ref()).unwrap().to_rgb8();
        let saved_report = auth::verify(&saved, &identity).unwrap();
        assert_eq!(
            saved_report.fingerprint_sha256,
            report.verification.fingerprint_sha256
        );

        for quality in [90, 80, 75] {
            let mut jpeg444 = Vec::new();
            JpegEncoder::new_with_quality(&mut jpeg444, quality)
                .encode_image(&saved)
                .unwrap();
            let mut jpeg420 = Vec::new();
            let mut encoder = jpeg_encoder::Encoder::new(&mut jpeg420, quality);
            encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
            encoder
                .encode(saved.as_raw(), 512, 512, jpeg_encoder::ColorType::Rgb)
                .unwrap();
            for (subsampling, encoded) in [("4:4:4", jpeg444), ("4:2:0", jpeg420)] {
                let received = image::load_from_memory(&encoded).unwrap().to_rgb8();
                let verified = auth::verify(&received, &identity).unwrap_or_else(|error| {
                    panic!(
                        "envelope={} JPEG Q{quality} {subsampling}: {error}",
                        report.envelope_bytes
                    )
                });
                assert!(verified.signature_valid);
                assert_eq!(
                    verified.fingerprint_sha256,
                    report.verification.fingerprint_sha256
                );
            }
        }
    }
}

#[test]
fn prepared_features_and_helper_are_bound_to_the_signature() {
    let source = image_fixture(512, 512);
    let (envelope, measured, identity) = sign_source(&source, false);
    let mut modified_source = source.clone();
    for y in 80..176 {
        for x in 80..176 {
            modified_source.put_pixel(x, y, Rgb([240, 20, 40]));
        }
    }
    assert!(auth::embed_signed(&modified_source, &envelope, &measured, &identity).is_err());
    let wrong_measured = features::measure(&modified_source).unwrap();
    assert!(auth::embed_signed(&source, &envelope, &wrong_measured, &identity).is_err());

    let (marked, _) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
    let (mut packet, watermark) = auth::extract_packet(&marked).unwrap();
    // The half-bin helper bit can leave the recovered integer unchanged;
    // signing the helper bytes themselves must still detect this change.
    packet.helper[0] ^= 0x20;
    assert!(auth::verify_packet(&marked, &packet, watermark, &identity).is_err());
}

#[test]
fn valid_watermark_transplants_fail_image_authentication() {
    let source = image_fixture(512, 512);
    let (envelope, measured, identity) = sign_source(&source, false);
    let block = auth::encode_packet(&envelope, &measured.helper).unwrap();

    let mut local_edit = source.clone();
    for y in 80..176 {
        for x in 80..176 {
            local_edit.put_pixel(x, y, Rgb([240, 20, 40]));
        }
    }
    let mut inverted = source.clone();
    for pixel in inverted.pixels_mut() {
        for channel in &mut pixel.0 {
            *channel = 255 - *channel;
        }
    }
    let mut color_shift = source.clone();
    for pixel in color_shift.pixels_mut() {
        pixel[0] = pixel[0].saturating_add(40);
    }
    for (name, altered) in [
        ("local edit", local_edit),
        ("inversion", inverted),
        ("color shift", color_shift),
    ] {
        let (transplanted, _) = haar::embed(&altered, &block, haar::DEFAULT_STEP).unwrap();
        assert_eq!(
            haar::extract(&transplanted, haar::DEFAULT_STEP).unwrap().0,
            block
        );
        assert!(
            auth::verify(&transplanted, &identity).is_err(),
            "accepted transplant after {name}"
        );
    }
}

#[test]
fn signature_binds_native_dimensions() {
    let original = image_fixture(512, 512);
    let (envelope, measured, identity) = sign_source(&original, true);
    let original_message =
        auth::signed_message(&envelope, 512, 512, &measured.helper, &measured.quantized).unwrap();
    assert!(verus::verify(&envelope, &original_message, &identity).is_ok());
    for (width, height) in [(520, 512), (512, 520), (1024, 1024)] {
        let changed = auth::signed_message(
            &envelope,
            width,
            height,
            &measured.helper,
            &measured.quantized,
        )
        .unwrap();
        assert!(verus::verify(&envelope, &changed, &identity).is_err());
    }
}

#[test]
fn rectangular_native_dimensions_survive_png_and_jpeg75() {
    // Both dimensions are divisible by eight, but neither by the 32-cell
    // feature grid. This exercises uneven feature cells and partial repetition.
    let source = image_fixture(520, 536);
    let (envelope, measured, identity) = sign_source(&source, true);
    let (marked, report) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
    assert_eq!(marked.dimensions(), (520, 536));
    assert_eq!(report.watermark.carrier_count, 2 * 65 * 67);
    let expected = report.verification.fingerprint_sha256;

    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(marked)
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let saved = image::load_from_memory(png.get_ref()).unwrap().to_rgb8();
    assert_eq!(
        auth::verify(&saved, &identity).unwrap().fingerprint_sha256,
        expected
    );

    for sampling in [
        jpeg_encoder::SamplingFactor::R_4_4_4,
        jpeg_encoder::SamplingFactor::R_4_2_0,
    ] {
        let mut jpeg = Vec::new();
        let mut encoder = jpeg_encoder::Encoder::new(&mut jpeg, 75);
        encoder.set_sampling_factor(sampling);
        encoder
            .encode(saved.as_raw(), 520, 536, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        let received = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(received.dimensions(), (520, 536));
        assert_eq!(
            auth::verify(&received, &identity)
                .unwrap()
                .fingerprint_sha256,
            expected
        );
    }
}

#[test]
fn arbitrary_aspect_ratios_and_edge_strips_survive_png_and_jpeg75() {
    for (width, height) in [
        (1024, 256),
        (256, 1024),
        (641, 481),
        (481, 641),
        (647, 487),
        (1025, 257),
        (32, 8192),
    ] {
        let source = image_fixture(width, height);
        let (envelope, measured, identity) = sign_source(&source, true);
        let (marked, report) = auth::embed_signed(&source, &envelope, &measured, &identity)
            .unwrap_or_else(|error| panic!("embedding {width}×{height}: {error}"));
        assert_eq!(marked.dimensions(), (width, height));
        assert_eq!(
            report.watermark.carrier_count,
            (2 * (width / 8) * (height / 8)) as usize
        );
        let interior_width = width / 8 * 8;
        let interior_height = height / 8 * 8;
        // Only complete 8×8 blocks carry watermark bits. The remaining source
        // pixels are preserved exactly, while the full image is authenticated.
        for (x, y, original) in source.enumerate_pixels() {
            if x >= interior_width || y >= interior_height {
                assert_eq!(marked.get_pixel(x, y), original, "border pixel ({x}, {y})");
            }
        }
        let expected = report.verification.fingerprint_sha256;
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(marked)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let saved = image::load_from_memory(png.get_ref()).unwrap().to_rgb8();
        assert_eq!(saved.dimensions(), (width, height));
        let verified = auth::verify(&saved, &identity).unwrap();
        assert!(verified.signature_valid);
        assert_eq!(verified.fingerprint_sha256, expected);

        let mut jpeg444 = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg444, 75)
            .encode_image(&saved)
            .unwrap();
        let mut jpeg420 = Vec::new();
        let mut encoder = jpeg_encoder::Encoder::new(&mut jpeg420, 75);
        encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
        encoder
            .encode(
                saved.as_raw(),
                width as u16,
                height as u16,
                jpeg_encoder::ColorType::Rgb,
            )
            .unwrap();
        for (subsampling, encoded) in [("4:4:4", jpeg444), ("4:2:0", jpeg420)] {
            let received = image::load_from_memory(&encoded).unwrap().to_rgb8();
            assert_eq!(received.dimensions(), (width, height));
            let verified = auth::verify(&received, &identity)
                .unwrap_or_else(|error| panic!("{width}×{height} JPEG Q75 {subsampling}: {error}"));
            assert!(verified.signature_valid);
            assert_eq!(verified.fingerprint_sha256, expected);
        }
    }
}

#[test]
fn insufficient_capacity_and_empty_feature_cells_are_rejected() {
    for (width, height) in [(511, 513), (640, 400), (31, 16384), (16384, 31)] {
        let source = image_fixture(width, height);
        assert!(
            features::measure(&source).is_err(),
            "accepted feature dimensions {width}×{height}"
        );
        assert!(
            haar::embed(&source, &[0; haar::BLOCK_BYTES], haar::DEFAULT_STEP).is_err(),
            "accepted embedding dimensions {width}×{height}"
        );
        assert!(
            haar::extract(&source, haar::DEFAULT_STEP).is_err(),
            "accepted extraction dimensions {width}×{height}"
        );
    }
}

#[test]
fn cropping_untouched_edge_strips_keeps_the_packet_but_invalidates_authentication() {
    let source = image_fixture(641, 481);
    let (envelope, measured, identity) = sign_source(&source, false);
    let block = auth::encode_packet(&envelope, &measured.helper).unwrap();
    let (marked, _) = auth::embed_signed(&source, &envelope, &measured, &identity).unwrap();
    for (width, height) in [(640, 481), (641, 480), (640, 480)] {
        let cropped = image::imageops::crop_imm(&marked, 0, 0, width, height).to_image();
        // Native dimensions remain signed even when the removed pixels carried
        // no watermark data and the complete original packet is recoverable.
        assert_eq!(
            haar::extract(&cropped, haar::DEFAULT_STEP).unwrap().0,
            block
        );
        assert!(
            auth::verify(&cropped, &identity).is_err(),
            "accepted {width}×{height} crop of the signed 641×481 image"
        );
    }
}
