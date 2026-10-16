//! Shared capacity and feature-grid checks for image authentication.

use crate::{features::FEATURE_SIDE, ldpc::CODE_BITS};

pub(crate) struct Layout {
    /// Top-left transform region; the trailing pixels stay in the image.
    pub width: usize,
    pub height: usize,
    pub carrier_count: usize,
}

pub(crate) fn authentication_layout(width: u32, height: u32) -> Result<Layout, String> {
    if width < FEATURE_SIDE as u32 || height < FEATURE_SIDE as u32 {
        return Err(format!(
            "authentication requires each dimension to be at least {FEATURE_SIDE} pixels for the feature grid; got {width}x{height}"
        ));
    }
    // Use wide arithmetic even on 32-bit targets; image area must not wrap.
    let carrier_count = 2 * u64::from(width / 8) * u64::from(height / 8);
    if carrier_count < CODE_BITS as u64 {
        return Err(format!(
            "image {width}x{height} has capacity for {carrier_count} watermark bits; authentication needs at least {CODE_BITS} (2 * floor(width/8) * floor(height/8)); use a larger image"
        ));
    }
    Ok(Layout {
        width: (width / 8 * 8) as usize,
        height: (height / 8 * 8) as usize,
        carrier_count: usize::try_from(carrier_count)
            .map_err(|_| "image capacity exceeds this platform's address space")?,
    })
}
