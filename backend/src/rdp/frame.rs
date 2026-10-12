//! 帧编码与回放桌面：引擎 ImagePatch（u32 0x00RRGGBB）→ 共享 44 字节
//! RGBA 补丁帧（与 vnc/frame 同线制），以及 webview 重挂用的合成桌面。

use super::limits::{MAX_DESKTOP_HEIGHT, MAX_DESKTOP_WIDTH};

/// The decoded engine pixel buffer is one u32 per pixel (0x00RRGGBB).
pub(crate) const BYTES_PER_PIXEL: usize = 4;

/// the former eight-patch worst case (>250 MiB).
pub(crate) const RDP_REPLAY_FRAMEBUFFER_MAX_BYTES: usize =
    MAX_DESKTOP_WIDTH as usize * MAX_DESKTOP_HEIGHT as usize * BYTES_PER_PIXEL;

/// Bounded composite desktop used only for webview reattachment. It keeps the
/// most recent pixel at every coordinate, rather than retaining arbitrary
/// incremental wire patches that cannot reconstruct a complete scene.
pub(crate) struct RdpReplayFramebuffer {
    width: u16,
    height: u16,
    rgba: Vec<u8>,
    /// A local patch cannot reconstruct unknown pixels. Only a full-screen
    /// patch makes this desktop safe to replay after webview reconstruction.
    complete: bool,
}

/// The only owner of RDP frame sequence allocation and the replayable desktop.
/// Both the realtime frame publisher and `rdp/replay` hold this state lock
/// through frame construction and emission, so a replay frame can never be
/// published between an already-allocated realtime sequence and its emit.
#[derive(Default)]
pub(crate) struct RdpFrameState {
    next_sequence: u64,
    framebuffer: Option<RdpReplayFramebuffer>,
}

impl RdpFrameState {
    pub(crate) fn clear(&mut self) {
        self.framebuffer = None;
    }

    /// Converts one engine `ImagePatch` (u32 0x00RRGGBB pixels) into the shared
    /// 44-byte RGBA patch frame (same wire format as `vnc/frame`; the golden
    /// vector lives in docs/PROTOCOL.zh-CN.md and the frontend decoder spec).
    /// The argument list mirrors the engine event's own field set (NyaTerm's
    /// helper has the same shape).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply_and_encode(
        &mut self,
        pixels: &[u32],
        desktop_width: u16,
        desktop_height: u16,
        patch_x: u16,
        patch_y: u16,
        patch_width: u16,
        patch_height: u16,
    ) -> Result<Vec<u8>, String> {
        let dimensions_changed = self.framebuffer.as_ref().is_some_and(|framebuffer| {
            (framebuffer.width, framebuffer.height) != (desktop_width, desktop_height)
        });
        if dimensions_changed || self.framebuffer.is_none() {
            self.framebuffer = Some(RdpReplayFramebuffer::new(desktop_width, desktop_height)?);
        }
        let framebuffer = self
            .framebuffer
            .as_mut()
            .ok_or_else(|| "RDP replay framebuffer is unavailable".to_string())?;
        framebuffer.apply_patch(
            pixels,
            desktop_width,
            desktop_height,
            patch_x,
            patch_y,
            patch_width,
            patch_height,
        )?;
        let sequence = self.next_sequence;
        let frame = image_patch_to_frame(
            pixels,
            desktop_width,
            desktop_height,
            patch_x,
            patch_y,
            patch_width,
            patch_height,
            sequence,
        )?;
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(frame)
    }

    pub(crate) fn replay(&mut self) -> Result<Vec<u8>, String> {
        let framebuffer = self
            .framebuffer
            .as_ref()
            .ok_or_else(|| "RDP replay framebuffer is unavailable".to_string())?;
        let sequence = self.next_sequence;
        let frame = framebuffer.full_frame(sequence)?;
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(frame)
    }
}

#[cfg(test)]
pub(crate) fn frame_sequence(frame: &[u8]) -> u64 {
    u64::from_le_bytes(frame[0..8].try_into().expect("frame sequence"))
}

impl RdpReplayFramebuffer {
    pub(crate) fn new(width: u16, height: u16) -> Result<Self, String> {
        if width == 0 || height == 0 || width > MAX_DESKTOP_WIDTH || height > MAX_DESKTOP_HEIGHT {
            return Err(format!(
                "RDP replay framebuffer {width}x{height} is outside the supported range"
            ));
        }
        let bytes = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or_else(|| "RDP replay framebuffer size overflows".to_string())?;
        if bytes > RDP_REPLAY_FRAMEBUFFER_MAX_BYTES {
            return Err("RDP replay framebuffer exceeds the byte budget".to_string());
        }
        Ok(Self {
            width,
            height,
            rgba: vec![0; bytes],
            complete: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn byte_len(&self) -> usize {
        self.rgba.len()
    }

    #[cfg(test)]
    pub(crate) fn clear(&mut self) {
        self.rgba.clear();
        self.rgba.shrink_to_fit();
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply_patch(
        &mut self,
        pixels: &[u32],
        desktop_width: u16,
        desktop_height: u16,
        patch_x: u16,
        patch_y: u16,
        patch_width: u16,
        patch_height: u16,
    ) -> Result<(), String> {
        if self.rgba.is_empty() {
            return Err("RDP replay framebuffer has been released".to_string());
        }
        if (self.width, self.height) != (desktop_width, desktop_height) {
            self.complete = false;
            return Err("RDP replay framebuffer dimensions changed".to_string());
        }
        let patch_pixels = usize::from(patch_width)
            .checked_mul(usize::from(patch_height))
            .ok_or_else(|| "RDP replay patch size overflows".to_string())?;
        if pixels.len() < patch_pixels {
            return Err("RDP replay patch buffer is smaller than the patch".to_string());
        }
        let right = u32::from(patch_x) + u32::from(patch_width);
        let bottom = u32::from(patch_y) + u32::from(patch_height);
        if patch_width == 0
            || patch_height == 0
            || right > u32::from(self.width)
            || bottom > u32::from(self.height)
        {
            return Err("RDP replay patch exceeds framebuffer bounds".to_string());
        }
        let is_fullscreen = patch_x == 0
            && patch_y == 0
            && patch_width == self.width
            && patch_height == self.height;
        let stride = usize::from(self.width) * BYTES_PER_PIXEL;
        for row in 0..usize::from(patch_height) {
            for column in 0..usize::from(patch_width) {
                let pixel = pixels[row * usize::from(patch_width) + column];
                let [_, red, green, blue] = pixel.to_be_bytes();
                let offset = (usize::from(patch_y) + row) * stride
                    + (usize::from(patch_x) + column) * BYTES_PER_PIXEL;
                self.rgba[offset..offset + BYTES_PER_PIXEL]
                    .copy_from_slice(&[red, green, blue, 255]);
            }
        }
        if is_fullscreen {
            self.complete = true;
        }
        Ok(())
    }

    pub(crate) fn full_frame(&self, sequence: u64) -> Result<Vec<u8>, String> {
        if self.rgba.is_empty() || !self.complete {
            return Err("RDP replay framebuffer has been released".to_string());
        }
        crate::vnc_session::encode_frame_patch(&crate::vnc_session::FramePatch {
            sequence,
            desktop_width: u32::from(self.width),
            desktop_height: u32::from(self.height),
            x: 0,
            y: 0,
            width: u32::from(self.width),
            height: u32::from(self.height),
            stride: u32::from(self.width) * BYTES_PER_PIXEL as u32,
            payload: &self.rgba,
        })
        .map_err(|error| error.replace("VNC", "RDP"))
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn image_patch_to_frame(
    pixels: &[u32],
    desktop_width: u16,
    desktop_height: u16,
    patch_x: u16,
    patch_y: u16,
    patch_width: u16,
    patch_height: u16,
    sequence: u64,
) -> Result<Vec<u8>, String> {
    let pixel_count = usize::from(patch_width)
        .checked_mul(usize::from(patch_height))
        .ok_or_else(|| "RDP frame pixel count overflows".to_string())?;
    if pixels.len() < pixel_count {
        return Err("RDP frame pixel buffer is smaller than the patch".to_string());
    }
    let payload_len = pixel_count
        .checked_mul(BYTES_PER_PIXEL)
        .ok_or_else(|| "RDP frame payload size overflows".to_string())?;
    let mut payload = vec![0_u8; payload_len];
    for (index, pixel) in pixels.iter().take(pixel_count).enumerate() {
        let [_, red, green, blue] = pixel.to_be_bytes();
        let offset = index * BYTES_PER_PIXEL;
        payload[offset] = red;
        payload[offset + 1] = green;
        payload[offset + 2] = blue;
        payload[offset + 3] = 255;
    }
    crate::vnc_session::encode_frame_patch(&crate::vnc_session::FramePatch {
        sequence,
        desktop_width: u32::from(desktop_width),
        desktop_height: u32::from(desktop_height),
        x: u32::from(patch_x),
        y: u32::from(patch_y),
        width: u32::from(patch_width),
        height: u32::from(patch_height),
        stride: u32::from(patch_width) * 4,
        payload: &payload,
    })
    .map_err(|error| error.replace("VNC", "RDP"))
}
