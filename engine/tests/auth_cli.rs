//! Exercise the real executable and saved files, without a wallet or daemon.

use image::{Rgb, RgbImage};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "vatermark-auth-cli-{}-{:016x}",
                std::process::id(),
                rand::random::<u64>()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create test directory: {error}"),
            }
        }
    }

    fn run(&self, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_vatermark"))
            .current_dir(&self.0)
            .args(arguments)
            .output()
            .unwrap()
    }

    fn fixture(&self) {
        self.fixture_at(512, 512);
    }

    fn fixture_at(&self, width: u32, height: u32) {
        let image = RgbImage::from_fn(width, height, |x, y| {
            let base =
                128.0 + 38.0 * (f64::from(x) / 21.0).sin() + 25.0 * (f64::from(y) / 33.0).cos();
            Rgb([
                (base + f64::from((x * 7 + y * 13) % 19) - 9.0) as u8,
                base as u8,
                (base - 12.0) as u8,
            ])
        });
        image.save(self.0.join("source.png")).unwrap();
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn successful_json(output: Output) -> Value {
    assert!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("successful command must produce JSON")
}

#[test]
fn local_demo_preserves_odd_rectangle_and_verifies_with_explicit_trust() {
    let directory = TemporaryDirectory::new();
    directory.fixture_at(641, 481);
    let original = fs::read(directory.0.join("source.png")).unwrap();
    let result = successful_json(directory.run(&[
        "auth-demo",
        "source.png",
        "nested/marked image.png",
        "--identity-out",
        "trusted identity.json",
    ]));
    assert_eq!(result["trust_source"], "local_test_identity");
    assert_eq!(result["on_chain_identity_verified"], false);
    assert_eq!(result["private_key_persisted"], false);
    assert_eq!(result["authentication"]["envelope_bytes"], 90);
    assert_eq!(
        result["authentication"]["verification"]["signature_valid"],
        true
    );
    assert_eq!(fs::read(directory.0.join("source.png")).unwrap(), original);
    assert_eq!(
        image::open(directory.0.join("nested/marked image.png"))
            .unwrap()
            .to_rgb8()
            .dimensions(),
        (641, 481)
    );

    let public_bytes = fs::read(directory.0.join("trusted identity.json")).unwrap();
    let identity: vatermark::verus::Identity = serde_json::from_slice(&public_bytes).unwrap();
    let public: Value = serde_json::from_slice(&public_bytes).unwrap();
    let expected_keys = [
        "id",
        "system_id",
        "testnet",
        "height",
        "min_sigs",
        "revoked",
        "primary_addresses",
    ];
    assert_eq!(public.as_object().unwrap().len(), expected_keys.len());
    assert!(public
        .as_object()
        .unwrap()
        .keys()
        .all(|key| expected_keys.contains(&key.as_str())));
    assert!(identity.testnet);

    let verification = successful_json(directory.run(&[
        "auth-verify",
        "nested/marked image.png",
        "--trusted-identity",
        "trusted identity.json",
    ]));
    assert_eq!(verification["trust_source"], "trusted_identity_file");
    assert_eq!(verification["on_chain_identity_verified"], false);
    assert_eq!(verification["verification"]["signature_valid"], true);

    let absent = directory.run(&["auth-verify", "nested/marked image.png"]);
    assert_eq!(
        absent.status.code(),
        Some(2),
        "Clap must require an explicit trust source"
    );
    let conflicting = directory.run(&[
        "auth-verify",
        "nested/marked image.png",
        "--trusted-identity",
        "trusted identity.json",
        "--verus-cli",
        "must-not-be-executed",
    ]);
    assert_eq!(
        conflicting.status.code(),
        Some(2),
        "Clap must reject ambiguous trust sources"
    );

    let mut wrong = identity;
    wrong.id[0] ^= 1;
    fs::write(
        directory.0.join("wrong.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .unwrap();
    assert!(!directory
        .run(&[
            "auth-verify",
            "nested/marked image.png",
            "--trusted-identity",
            "wrong.json"
        ])
        .status
        .success());
    fs::write(
        directory.0.join("malformed.json"),
        b"{\"id\":\"not an identity\"}",
    )
    .unwrap();
    let malformed = directory.run(&[
        "auth-verify",
        "nested/marked image.png",
        "--trusted-identity",
        "malformed.json",
    ]);
    assert!(!malformed.status.success());
    assert!(String::from_utf8_lossy(&malformed.stderr).contains("invalid trusted identity JSON"));

    // An unrelated image cannot borrow the trusted identity merely by referring
    // to its public file. The unmarked source itself must also be rejected.
    assert!(!directory
        .run(&[
            "auth-verify",
            "source.png",
            "--trusted-identity",
            "trusted identity.json"
        ])
        .status
        .success());
}

#[test]
fn fully_opaque_alpha_is_discarded_for_signing_and_verification() {
    let directory = TemporaryDirectory::new();
    directory.fixture();
    let source = image::open(directory.0.join("source.png")).unwrap();
    let variants = [
        image::DynamicImage::ImageRgba8(source.to_rgba8()),
        image::DynamicImage::ImageLumaA8(source.to_luma_alpha8()),
        image::DynamicImage::ImageRgba16(source.to_rgba16()),
        image::DynamicImage::ImageLumaA16(source.to_luma_alpha16()),
    ];
    for variant in variants {
        variant.save(directory.0.join("opaque.png")).unwrap();
        let result = successful_json(directory.run(&[
            "auth-demo",
            "opaque.png",
            "marked.png",
            "--identity-out",
            "identity.json",
        ]));
        assert_eq!(
            result["authentication"]["verification"]["signature_valid"],
            true
        );
        let marked = image::open(directory.0.join("marked.png")).unwrap();
        assert_eq!(marked.color(), image::ColorType::Rgb8);
        // Adding a fully opaque alpha channel does not change the signed RGB.
        marked
            .to_rgba8()
            .save(directory.0.join("marked-opaque.png"))
            .unwrap();
        let verified = successful_json(directory.run(&[
            "auth-verify",
            "marked-opaque.png",
            "--trusted-identity",
            "identity.json",
        ]));
        assert_eq!(verified["verification"]["signature_valid"], true);
    }
}

#[test]
fn even_one_nonopaque_alpha_sample_is_rejected_before_writing() {
    let directory = TemporaryDirectory::new();
    directory.fixture();
    let source = image::open(directory.0.join("source.png")).unwrap();
    let mut variants = Vec::new();
    for alpha in [0, 254] {
        let mut rgba = source.to_rgba8();
        rgba.get_pixel_mut(511, 511)[3] = alpha;
        variants.push(image::DynamicImage::ImageRgba8(rgba));
        let mut gray = source.to_luma_alpha8();
        gray.get_pixel_mut(511, 511)[1] = alpha;
        variants.push(image::DynamicImage::ImageLumaA8(gray));
    }
    // 65534 may become 255 when reduced to 8 bits; it is still not opaque.
    let mut rgba16 = source.to_rgba16();
    rgba16.get_pixel_mut(511, 511)[3] = u16::MAX - 1;
    variants.push(image::DynamicImage::ImageRgba16(rgba16));
    let mut gray16 = source.to_luma_alpha16();
    gray16.get_pixel_mut(511, 511)[1] = u16::MAX - 1;
    variants.push(image::DynamicImage::ImageLumaA16(gray16));
    for variant in variants {
        variant.save(directory.0.join("transparent.png")).unwrap();
        let result = directory.run(&[
            "auth-demo",
            "transparent.png",
            "marked.png",
            "--identity-out",
            "identity.json",
        ]);
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr)
            .contains("every alpha value must be fully opaque"));
        assert!(!directory.0.join("marked.png").exists());
        assert!(!directory.0.join("identity.json").exists());
    }
}

#[test]
fn rejects_overlapping_paths_before_writing_either_output() {
    let directory = TemporaryDirectory::new();
    directory.fixture();
    let original = fs::read(directory.0.join("source.png")).unwrap();
    for (image_output, identity_output) in [
        ("source.png", "identity.json"),
        ("output.png", "source.png"),
        ("not-created.png", "not-created.png"),
        ("nested/same.png", "nested/../nested/same.png"),
    ] {
        let result = directory.run(&[
            "auth-demo",
            "source.png",
            image_output,
            "--identity-out",
            identity_output,
        ]);
        assert!(
            !result.status.success(),
            "accepted overlapping paths {image_output} / {identity_output}"
        );
        assert_eq!(fs::read(directory.0.join("source.png")).unwrap(), original);
    }
    for name in [
        "identity.json",
        "output.png",
        "not-created.png",
        "nested/same.png",
    ] {
        assert!(
            !directory.0.join(name).exists(),
            "created {name} before rejecting the paths"
        );
    }
}

#[cfg(unix)]
#[test]
fn rejects_symlink_and_hardlink_aliases_including_absent_output_files() {
    use std::os::unix::fs::symlink;
    let directory = TemporaryDirectory::new();
    directory.fixture();
    let original = fs::read(directory.0.join("source.png")).unwrap();
    symlink(
        directory.0.join("source.png"),
        directory.0.join("source-link.png"),
    )
    .unwrap();
    fs::hard_link(
        directory.0.join("source.png"),
        directory.0.join("source-hardlink.png"),
    )
    .unwrap();
    fs::create_dir(directory.0.join("real")).unwrap();
    symlink(directory.0.join("real"), directory.0.join("alias")).unwrap();
    symlink(
        directory.0.join("missing-identity.json"),
        directory.0.join("dangling-image.png"),
    )
    .unwrap();
    symlink(
        directory.0.join("missing-image.png"),
        directory.0.join("dangling-identity.json"),
    )
    .unwrap();
    for (image_output, identity_output) in [
        ("source-link.png", "identity.json"),
        ("source-hardlink.png", "identity.json"),
        ("output.png", "source-link.png"),
        ("real/new.png", "alias/new.png"),
        ("dangling-image.png", "missing-identity.json"),
        ("missing-image.png", "dangling-identity.json"),
    ] {
        assert!(!directory
            .run(&[
                "auth-demo",
                "source.png",
                image_output,
                "--identity-out",
                identity_output
            ])
            .status
            .success());
        assert_eq!(fs::read(directory.0.join("source.png")).unwrap(), original);
    }
    assert!(!directory.0.join("real/new.png").exists());
    assert!(!directory.0.join("output.png").exists());
    assert!(!directory.0.join("identity.json").exists());
    assert!(!directory.0.join("missing-identity.json").exists());
    assert!(!directory.0.join("missing-image.png").exists());
}
