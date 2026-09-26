//! Offline GIF exporter for the AstroOM animated logo.
//!
//! Generates a looping animated GIF (`AstroOM-logo.gif`) at exactly 30 logical FPS
//! using the compile-time embedded TrueType Collection font asset `DinaRemasterII.ttc`.
//!
//! Visual elements, animation cycles, and thermal shockwave colors are shared directly
//! with the terminal banner renderer (`src/utils/mod.rs`).

use ab_glyph::{point, Font, FontRef, Glyph};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::utils::{strike_frame_cells, BannerRgb, CANVAS_WIDTH};

/// The compile-time embedded TrueType Collection font asset.
///
/// Source: `/usr/local/share/fonts/d/DinaRemasterII.ttc` (46,544 bytes).
/// SHA-256: `ebca3d277e9c552774ea24c4630b14e2f82fc15c2c9032731b363d85753996df`.
///
/// Collection Index 0 corresponds specifically to the `DinaRemasterII` (Medium) face.
pub static DINA_REMASTER_II_TTC: &[u8] = include_bytes!("../../assets/fonts/DinaRemasterII.ttc");

/// TTC Collection index for the mandatory `DinaRemasterII` face.
pub const DINA_REMASTER_II_COLLECTION_INDEX: usize = 0;

/// Logical frames per second for the AstroOM animated banner.
pub const ANIMATION_FPS: usize = 30;

/// Number of frames comprising exactly one complete shockwave ripple cycle.
///
/// The strike wave ripple frequency is omega = 3.0 rad/s (wave period T = 2*pi / 3.0 ~= 2.0944s).
/// Over 63 frames at 30 FPS (duration = 2.100s, 210 centiseconds total), the wave advances
/// through an exact 2*pi phase, enabling a mathematically seamless, closed loop.
pub const CYCLE_FRAME_COUNT: usize = 63;

/// Canvas width in pixels: 8px left margin + 62 cols * 8px cell width + 8px right margin.
pub const GIF_WIDTH: u16 = 512;

/// Canvas height in pixels: 8px top margin + 9 rows * 16px cell height + 8px bottom margin.
pub const GIF_HEIGHT: u16 = 160;

/// Monospace cell width in pixels (1:2 aspect ratio).
pub const CELL_WIDTH: usize = 8;

/// Monospace cell height in pixels.
pub const CELL_HEIGHT: usize = 16;

/// Horizontal padding before the first character cell.
pub const PADDING_X: usize = 8;

/// Vertical padding before the first character row.
pub const PADDING_Y: usize = 8;

/// Canonical dark slate background color for the forge theme (`#0d1117`).
pub const BACKGROUND_RGB: BannerRgb = BannerRgb(13, 17, 23);

/// Standard target output filename.
pub const LOGO_GIF_FILENAME: &str = "AstroOM-logo.gif";

/// Computes the exact centisecond delay for frame `frame` at `fps` using rational accumulation.
///
/// GIF delays are expressed in integer units of 1/100 second (10 ms). Because 1/30 s (33.333... ms)
/// cannot be expressed as a single integer, rational Bresenham-style rounding produces the sequence:
/// `3, 3, 4, 3, 3, 4, 3, 3, 4, ...` centiseconds.
/// Every 3 frames sum to exactly 10 centiseconds (100 ms), with zero cumulative drift.
#[inline]
pub fn gif_delay_for_frame(frame: usize, fps: usize) -> u16 {
    let end = ((frame + 1) * 100) / fps;
    let start = (frame * 100) / fps;
    (end - start) as u16
}

/// Renders a single animation frame into a 24-bit RGB pixel buffer (512x160).
pub fn render_frame_pixels(frame_index: usize, font: &impl Font) -> Vec<BannerRgb> {
    let mut pixels = vec![BACKGROUND_RGB; (GIF_WIDTH as usize) * (GIF_HEIGHT as usize)];

    // Exact closed-loop phase advancement: advances by 2*pi over CYCLE_FRAME_COUNT frames
    let wave_period = 2.0 * std::f64::consts::PI / 3.0;
    let time_sec = (frame_index as f64) * wave_period / (CYCLE_FRAME_COUNT as f64);
    // Over the loop cycle (wave_period = 2*pi / 3.0), harmonizing the breathing pulse
    // and intensity boost with the fundamental wave frequency (omega = 3.0 rad/s)
    // guarantees that all dynamic parameters complete an exact 2*pi cycle, eliminating
    // any boundary jump between the final frame (62) and first frame (0).
    let pulse = 0.08 * (time_sec * 3.0).sin();
    let intensity_boost = 0.92 + 0.08 * (time_sec * 3.0).sin();
    let cool_factor = 0.22;

    let cell_rows = strike_frame_cells(time_sec, pulse, intensity_boost, cool_factor);

    for (r, row) in cell_rows.iter().enumerate() {
        let cell_y = PADDING_Y + r * CELL_HEIGHT;
        for (c, &(ch, fg_rgb)) in row.iter().enumerate() {
            if c >= CANVAS_WIDTH || ch == ' ' {
                continue;
            }
            let cell_x = PADDING_X + c * CELL_WIDTH;

            match ch {
                // Unicode Block Elements & Shading:
                // Terminal emulators render these using geometric cell primitives to avoid
                // font outline rounding seams. We rasterize them with pixel-perfect boundaries.
                '█' => {
                    // Full block: fills the entire 8x16 cell
                    fill_rect(&mut pixels, cell_x, cell_y, CELL_WIDTH, CELL_HEIGHT, fg_rgb);
                }
                '▀' => {
                    // Upper half block: fills top 8px (0..8) of the 16px cell
                    fill_rect(
                        &mut pixels,
                        cell_x,
                        cell_y,
                        CELL_WIDTH,
                        CELL_HEIGHT / 2,
                        fg_rgb,
                    );
                }
                '▄' => {
                    // Lower half block: fills bottom 8px (8..16) of the 16px cell
                    fill_rect(
                        &mut pixels,
                        cell_x,
                        cell_y + CELL_HEIGHT / 2,
                        CELL_WIDTH,
                        CELL_HEIGHT / 2,
                        fg_rgb,
                    );
                }
                '░' => {
                    // 25% light shade: ordered 2x2 stipple (1 in 4 pixels)
                    for dy in 0..CELL_HEIGHT {
                        for dx in 0..CELL_WIDTH {
                            let px = cell_x + dx;
                            let py = cell_y + dy;
                            if dx % 2 == 0 && dy % 2 == 0 {
                                set_pixel(&mut pixels, px, py, fg_rgb);
                            }
                        }
                    }
                }
                '▒' => {
                    // 50% medium shade: ordered checkerboard stipple (2 in 4 pixels)
                    for dy in 0..CELL_HEIGHT {
                        for dx in 0..CELL_WIDTH {
                            let px = cell_x + dx;
                            let py = cell_y + dy;
                            if (dx + dy) % 2 == 0 {
                                set_pixel(&mut pixels, px, py, fg_rgb);
                            }
                        }
                    }
                }
                '▓' => {
                    // 75% dark shade: inverted 2x2 stipple (3 in 4 pixels)
                    for dy in 0..CELL_HEIGHT {
                        for dx in 0..CELL_WIDTH {
                            let px = cell_x + dx;
                            let py = cell_y + dy;
                            if !(dx % 2 == 0 && dy % 2 == 0) {
                                set_pixel(&mut pixels, px, py, fg_rgb);
                            }
                        }
                    }
                }
                _ => {
                    // Standard alphanumeric glyph: rasterize using DinaRemasterII font outline
                    rasterize_glyph(&mut pixels, font, ch, cell_x, cell_y, fg_rgb);
                }
            }
        }
    }

    pixels
}

#[inline]
fn fill_rect(
    pixels: &mut [BannerRgb],
    start_x: usize,
    start_y: usize,
    width: usize,
    height: usize,
    color: BannerRgb,
) {
    let canvas_w = GIF_WIDTH as usize;
    let canvas_h = GIF_HEIGHT as usize;
    for y in start_y..(start_y + height).min(canvas_h) {
        let row_offset = y * canvas_w;
        for x in start_x..(start_x + width).min(canvas_w) {
            pixels[row_offset + x] = color;
        }
    }
}

#[inline]
fn set_pixel(pixels: &mut [BannerRgb], x: usize, y: usize, color: BannerRgb) {
    let canvas_w = GIF_WIDTH as usize;
    let canvas_h = GIF_HEIGHT as usize;
    if x < canvas_w && y < canvas_h {
        pixels[y * canvas_w + x] = color;
    }
}

fn rasterize_glyph(
    pixels: &mut [BannerRgb],
    font: &impl Font,
    ch: char,
    cell_x: usize,
    cell_y: usize,
    fg_rgb: BannerRgb,
) {
    let glyph: Glyph = font
        .glyph_id(ch)
        .with_scale_and_position(16.0f32, point(cell_x as f32, (cell_y + 12) as f32));

    if let Some(outlined) = font.outline_glyph(glyph) {
        let canvas_w = GIF_WIDTH as usize;
        let canvas_h = GIF_HEIGHT as usize;
        outlined.draw(|gx, gy, coverage| {
            let px = gx as usize;
            let py = gy as usize;
            if px < canvas_w && py < canvas_h {
                let idx = py * canvas_w + px;
                let bg = pixels[idx];
                let alpha = (coverage as f64).clamp(0.0, 1.0);
                if alpha > 0.0 {
                    let blended = bg.lerp(fg_rgb, alpha);
                    pixels[idx] = blended;
                }
            }
        });
    }
}

/// Converts a 24-bit RGB pixel buffer into an indexed pixel buffer and a local palette of up to 256 colors.
///
/// Because each banner animation frame uses at most ~175 unique colors (including background),
/// local palette encoding is completely lossless with zero color quantization or dithering artifacts.
pub fn create_indexed_frame(pixels: &[BannerRgb]) -> (Vec<u8>, Vec<u8>) {
    let mut color_to_index: HashMap<BannerRgb, u8> = HashMap::with_capacity(256);
    let mut palette: Vec<u8> = Vec::with_capacity(256 * 3);

    // Ensure background color is always palette index 0
    color_to_index.insert(BACKGROUND_RGB, 0);
    palette.push(BACKGROUND_RGB.0);
    palette.push(BACKGROUND_RGB.1);
    palette.push(BACKGROUND_RGB.2);

    let mut indexed_pixels = Vec::with_capacity(pixels.len());

    for &color in pixels {
        let idx = if let Some(&existing_idx) = color_to_index.get(&color) {
            existing_idx
        } else {
            let next_idx = color_to_index.len();
            if next_idx < 256 {
                let u8_idx = next_idx as u8;
                color_to_index.insert(color, u8_idx);
                palette.push(color.0);
                palette.push(color.1);
                palette.push(color.2);
                u8_idx
            } else {
                // Fallback to nearest palette entry if an unexpected frame exceeds 256 colors
                find_nearest_palette_index(&palette, color)
            }
        };
        indexed_pixels.push(idx);
    }

    // Pad palette to a standard 256 entries (768 bytes)
    while palette.len() < 256 * 3 {
        palette.push(BACKGROUND_RGB.0);
        palette.push(BACKGROUND_RGB.1);
        palette.push(BACKGROUND_RGB.2);
    }

    (indexed_pixels, palette)
}

fn find_nearest_palette_index(palette: &[u8], target: BannerRgb) -> u8 {
    let mut best_idx = 0u8;
    let mut min_dist = u32::MAX;
    for (i, chunk) in palette.chunks_exact(3).enumerate() {
        let dr = (chunk[0] as i32 - target.0 as i32).unsigned_abs();
        let dg = (chunk[1] as i32 - target.1 as i32).unsigned_abs();
        let db = (chunk[2] as i32 - target.2 as i32).unsigned_abs();
        let dist = dr * dr + dg * dg + db * db;
        if dist < min_dist {
            min_dist = dist;
            best_idx = i as u8;
        }
    }
    best_idx
}

/// Generates the animated GIF of the AstroOM logo and writes it to `destination_path`.
pub fn export_logo_gif(destination_path: &Path) -> Result<()> {
    let font = FontRef::try_from_slice_and_index(
        DINA_REMASTER_II_TTC,
        DINA_REMASTER_II_COLLECTION_INDEX as u32,
    )
    .map_err(|e| {
        AppError::message(format!(
            "Failed to load embedded DinaRemasterII.ttc at index {DINA_REMASTER_II_COLLECTION_INDEX}: {e:?}"
        ))
    })?;

    let file = File::create(destination_path).map_err(|e| {
        AppError::message(format!(
            "Failed to create output GIF at '{}': {e}",
            destination_path.display()
        ))
    })?;
    let mut writer = BufWriter::new(file);

    let mut encoder = gif::Encoder::new(&mut writer, GIF_WIDTH, GIF_HEIGHT, &[])
        .map_err(|e| AppError::message(format!("Failed to initialize GIF encoder: {e}")))?;

    encoder
        .set_repeat(gif::Repeat::Infinite)
        .map_err(|e| AppError::message(format!("Failed to configure GIF infinite looping: {e}")))?;

    for frame_idx in 0..CYCLE_FRAME_COUNT {
        let pixels = render_frame_pixels(frame_idx, &font);
        let (indexed_data, palette) = create_indexed_frame(&pixels);

        let mut gif_frame =
            gif::Frame::from_palette_pixels(GIF_WIDTH, GIF_HEIGHT, indexed_data, palette, None);
        gif_frame.delay = gif_delay_for_frame(frame_idx, ANIMATION_FPS);
        gif_frame.dispose = gif::DisposalMethod::Background;

        encoder.write_frame(&gif_frame).map_err(|e| {
            AppError::message(format!("Failed to write GIF frame {frame_idx}: {e}"))
        })?;
    }

    Ok(())
}

/// CLI entry point for `--record-logo-gif`.
///
/// Resolves the destination path strictly within the process's current working directory
/// as `./AstroOM-logo.gif`, generates the animated GIF offline, and returns the canonical path.
pub fn record_logo_gif() -> Result<PathBuf> {
    let cwd = std::env::current_dir().map_err(|e| {
        AppError::message(format!(
            "Failed to determine current working directory: {e}"
        ))
    })?;
    let destination = cwd.join(LOGO_GIF_FILENAME);
    export_logo_gif(&destination)?;
    Ok(destination)
}
