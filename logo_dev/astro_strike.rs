//! Astro Logo - Blacksmith's Forge Edition (Rust Port)
//! ====================================================
//! High-performance native Rust implementation featuring `--theme strike --animate`.
//!
//! Visual elements:
//! - Incandescent Whites (impact point & flying sparks)
//! - Polished Silvers (cold steel blade & anvil face)
//! - Hearth Cherry Reds (iron heat & molten slag drips)
//! - Quench Blues (water-quenched temper oxidation)
//!
//! Features:
//! - 24-bit Truecolor ANSI rendering (pure standard library, 0 external crates).
//! - Radial thermal shockwave expansion centered over the 'T'.
//! - 360° surrounding sparks with 2 balanced flank columns and dynamic twinkling.
//! - Smooth tear-free terminal animation with clean SIGINT / Ctrl+C handling.

use std::env;
use std::f64::consts::PI;
use std::io::{self, Write};
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Signal Handling for Clean Exit (Restore Cursor on Ctrl+C)
// ---------------------------------------------------------------------------

static RUNNING: AtomicBool = AtomicBool::new(true);

extern "C" {
    fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
}

extern "C" fn handle_sigint(_: i32) {
    RUNNING.store(false, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Constants & ASCII Art Geometry
// ---------------------------------------------------------------------------

pub const CANVAS_WIDTH: usize = 62;

pub const ASTRO_LOGO_RAW: [&str; 9] = [
    "        ▄▄▄       ██████ ▄▄▄█████▓ ██▀███   ▒█████",
    "       ▒████▄   ▒██    ▒ ▓  ██▒ ▓▒▓██ ▒ ██▒▒██▒  ██▒",
    "       ▒██  ▀█▄ ░ ▓██▄   ▒ ▓██░ ▒░▓██ ░▄█ ▒▒██░  ██▒",
    "       ░██▄▄▄▄██  ▒   ██▒░ ▓██▓ ░ ▒██▀▀█▄  ▒██   ██░",
    "        ▓█   ▓██▒██████▒▒  ▒██▒ ░ ░██▓ ▒██▒░ ████▓▒░",
    "        ▒▒   ▓▒█░ ▒▓▒ ▒ ░  ▒ ░░   ░ ▒▓ ░▒▓░░ ▒░▒░▒░",
    "         ▒   ▒▒ ░ ░▒  ░ ░    ░      ░▒ ░ ▒░  ░ ▒ ▒░",
    "         ░   ▒    ░  ░    ░        ░░   ░ ░ ░ ░ ▒",
    "             ░  ░       ░           ░         ░ ░",
];

pub const ANVIL_BASE: [&str; 3] = [
    "  ══════════════════════════════════════════════════════════  ",
    "   ▲         [ FORGED IN FIRE • TEMPERED IN ICE ]         ▲   ",
    "  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ",
];

// ---------------------------------------------------------------------------
// Color Math & Themes
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct RGB(pub u8, pub u8, pub u8);

impl RGB {
    #[inline]
    pub fn lerp(self, other: RGB, t: f64) -> RGB {
        let t = t.clamp(0.0, 1.0);
        RGB(
            (self.0 as f64 + (other.0 as f64 - self.0 as f64) * t).round() as u8,
            (self.1 as f64 + (other.1 as f64 - self.1 as f64) * t).round() as u8,
            (self.2 as f64 + (other.2 as f64 - self.2 as f64) * t).round() as u8,
        )
    }

    #[inline]
    pub fn scale(self, factor: f64) -> RGB {
        RGB(
            (self.0 as f64 * factor).clamp(0.0, 255.0) as u8,
            (self.1 as f64 * factor).clamp(0.0, 255.0) as u8,
            (self.2 as f64 * factor).clamp(0.0, 255.0) as u8,
        )
    }
}

pub fn color_ramp(stops: &[(f64, RGB)], t: f64) -> RGB {
    let t = t.clamp(0.0, 1.0);
    if t <= stops[0].0 {
        return stops[0].1;
    }
    if t >= stops[stops.len() - 1].0 {
        return stops[stops.len() - 1].1;
    }
    for i in 0..stops.len() - 1 {
        let (p1, c1) = stops[i];
        let (p2, c2) = stops[i + 1];
        if t >= p1 && t <= p2 {
            let span = p2 - p1;
            let local_t = if span > 0.0 { (t - p1) / span } else { 0.0 };
            return c1.lerp(c2, local_t);
        }
    }
    stops[stops.len() - 1].1
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ThemeMode {
    Strike,
    Forge,
    Quench,
    Damascus,
}

pub const STRIKE_STOPS: &[(f64, RGB)] = &[
    (0.00, RGB(255, 255, 255)), // White-hot strike flash
    (0.15, RGB(255, 251, 235)), // Radiant white-yellow heat
    (0.30, RGB(255, 69, 0)),    // Fiery vermilion
    (0.48, RGB(220, 38, 38)),   // Cherry red body
    (0.65, RGB(56, 189, 248)),  // Temper blue oxide wave
    (0.82, RGB(30, 58, 138)),   // Quench cobalt
    (1.00, RGB(203, 213, 225)), // Cold silver steel edge
];

pub const FORGE_STOPS: &[(f64, RGB)] = &[
    (0.00, RGB(136, 19, 55)),   // Deep forge crimson
    (0.12, RGB(220, 38, 38)),   // Blazing cherry red
    (0.24, RGB(255, 87, 34)),   // Hearth vermilion
    (0.36, RGB(255, 247, 237)), // Radiant incandescence
    (0.48, RGB(255, 255, 255)), // White-hot hammer strike
    (0.56, RGB(241, 245, 249)), // Brilliant polished silver
    (0.66, RGB(203, 213, 225)), // Cold forged steel
    (0.76, RGB(56, 189, 248)),  // Electric temper oxide blue
    (0.88, RGB(29, 78, 216)),   // Quench cobalt blue
    (1.00, RGB(148, 163, 184)), // Tempered silver slate
];

pub const QUENCH_STOPS: &[(f64, RGB)] = &[
    (0.00, RGB(255, 255, 255)), // Glinting white edge
    (0.15, RGB(226, 232, 240)), // Cold silver steel crest
    (0.30, RGB(255, 255, 255)), // White-hot forge core
    (0.45, RGB(255, 59, 48)),   // Blazing cherry heat
    (0.60, RGB(220, 38, 38)),   // Deep forge crimson
    (0.72, RGB(56, 189, 248)),  // Electric temper blue sizzle
    (0.85, RGB(29, 78, 216)),   // Boiling quench cobalt
    (1.00, RGB(100, 116, 139)), // Cooling vapor / slate ash
];

pub const DAMASCUS_STOPS: &[(f64, RGB)] = &[
    (0.00, RGB(203, 213, 225)), // Forged silver
    (0.20, RGB(248, 250, 252)), // White-silver glint
    (0.35, RGB(56, 189, 248)),  // Peacock temper blue
    (0.50, RGB(255, 255, 255)), // Mirror edge white
    (0.65, RGB(220, 38, 38)),   // Cherry heat vein
    (0.80, RGB(30, 64, 175)),   // Deep spring blue
    (1.00, RGB(148, 163, 184)), // Slate steel
];

#[inline]
pub fn density_multiplier(ch: char) -> f64 {
    match ch {
        '█' => 1.15,
        '▀' | '▄' => 1.05,
        '▓' => 0.90,
        '▒' => 0.75,
        '░' => 0.58,
        _ => 1.00,
    }
}

pub fn calculate_char_color(
    ch: char,
    row: usize,
    col: usize,
    max_rows: usize,
    theme: ThemeMode,
    time_sec: f64,
) -> RGB {
    let col_start = 8.0;
    let col_end = 54.0;
    let norm_x = ((col as f64 - col_start) / (col_end - col_start)).clamp(0.0, 1.0);
    let norm_y = (row as f64 / (max_rows - 1) as f64).clamp(0.0, 1.0);

    let (stops, t) = match theme {
        ThemeMode::Strike => {
            // Anvil strike center atop the 'T' stem (col 30.0, row 1.5)
            let impact_x = 30.0;
            let impact_y = 1.5;
            let dx = (col as f64 - impact_x) * 0.70;
            let dy = (row as f64 - impact_y) * 1.50;
            let dist = (dx * dx + dy * dy).sqrt();

            // Expanding shockwave ripple and breathing forge pulse
            let pulse = 0.08 * (time_sec * 2.5).sin();
            let ripple = 0.05 * (dist * 0.35 - time_sec * 3.0).sin();
            let t = (dist / 28.0 - pulse + ripple).clamp(0.0, 1.0);
            (STRIKE_STOPS, t)
        }
        ThemeMode::Forge => {
            let pulse = 0.08 * (time_sec * 2.5).sin();
            let mut t = norm_x + pulse;
            if row >= 5 {
                let drip_cool = (row - 4) as f64 * 0.04;
                t += if norm_x > 0.5 { 0.05 } else { -0.05 } * drip_cool;
            }
            (FORGE_STOPS, t.clamp(0.0, 1.0))
        }
        ThemeMode::Quench => {
            let pulse = 0.06 * (time_sec * 2.5).sin();
            let t = (norm_y + pulse).clamp(0.0, 1.0);
            (QUENCH_STOPS, t)
        }
        ThemeMode::Damascus => {
            let wave = 0.5 + 0.5 * (norm_x * 9.0 + norm_y * 4.0 + time_sec * 2.0).sin();
            (DAMASCUS_STOPS, wave.clamp(0.0, 1.0))
        }
    };

    let base_rgb = color_ramp(stops, t);
    let dm = density_multiplier(ch);
    let intensity_boost = 0.95 + 0.15 * (time_sec * 3.2).sin();

    if row == 0 || ch == '▄' || ch == '▀' {
        base_rgb.scale(1.12 * intensity_boost)
    } else if row >= 5 {
        let cool_step = (row - 4) as f64 * 0.12;
        RGB(
            (base_rgb.0 as f64 * (1.0 - cool_step * 0.35) * dm * intensity_boost).clamp(0.0, 255.0) as u8,
            (base_rgb.1 as f64 * (1.0 - cool_step * 0.35) * dm * intensity_boost).clamp(0.0, 255.0) as u8,
            (base_rgb.2 as f64 * (1.0 - cool_step * 0.15) * dm * intensity_boost).clamp(0.0, 255.0) as u8,
        )
    } else {
        base_rgb.scale(dm * intensity_boost)
    }
}

// ---------------------------------------------------------------------------
// Surrounding Sparks & Embers Definitions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum SparkKind {
    White,
    Silver,
    Red,
    Blue,
}

pub struct Spark {
    pub col: usize,
    pub row: usize,
    pub symbol: char,
    pub kind: SparkKind,
}

// 1. Top Canopy Sparks (arc over the logo)
pub const CANOPY_SPARKS: &[(usize, char, SparkKind)] = &[
    (5, '·', SparkKind::Red),
    (10, '✦', SparkKind::White),
    (16, '°', SparkKind::Red),
    (23, '✦', SparkKind::White),
    (30, '*', SparkKind::Silver),
    (36, '✦', SparkKind::White),
    (43, '·', SparkKind::Blue),
    (49, '✦', SparkKind::Blue),
    (55, '°', SparkKind::Silver),
];

// 2. Left Side Sparks (2 columns: cols 2-3 & 5-6)
pub const LEFT_SPARKS: &[(usize, usize, char, SparkKind)] = &[
    (2, 0, '·', SparkKind::Red),
    (5, 0, '°', SparkKind::Red),
    (3, 1, '✦', SparkKind::White),
    (6, 1, '·', SparkKind::Red),
    (2, 2, '·', SparkKind::Red),
    (5, 2, '°', SparkKind::Silver),
    (1, 3, '°', SparkKind::Red),
    (4, 3, '✦', SparkKind::White),
    (3, 4, '·', SparkKind::Red),
    (6, 4, '·', SparkKind::Silver),
    (2, 5, '✦', SparkKind::Red),
    (5, 5, '°', SparkKind::Red),
    (1, 6, '·', SparkKind::Red),
    (4, 6, '·', SparkKind::Red),
    (3, 7, '°', SparkKind::Red),
    (6, 7, '✦', SparkKind::White),
    (2, 8, '·', SparkKind::Red),
    (5, 8, '·', SparkKind::Silver),
];

// 3. Right Side Sparks (EXACTLY 2 balanced columns: cols 55-56 & 58-59)
pub const RIGHT_SPARKS: &[(usize, usize, char, SparkKind)] = &[
    (55, 0, '·', SparkKind::Blue),
    (58, 0, '✦', SparkKind::White),
    (56, 1, '°', SparkKind::Silver),
    (59, 1, '·', SparkKind::Blue),
    (55, 2, '✦', SparkKind::Blue),
    (58, 2, '°', SparkKind::White),
    (56, 3, '·', SparkKind::Blue),
    (59, 3, '*', SparkKind::Silver),
    (55, 4, '°', SparkKind::Blue),
    (58, 4, '·', SparkKind::Silver),
    (56, 5, '✦', SparkKind::White),
    (59, 5, '°', SparkKind::Blue),
    (55, 6, '·', SparkKind::Silver),
    (58, 6, '✦', SparkKind::Blue),
    (56, 7, '·', SparkKind::Blue),
    (59, 7, '·', SparkKind::White),
    (55, 8, '°', SparkKind::Blue),
    (58, 8, '·', SparkKind::Silver),
];

// 4. Internal Negative Space Sparks
pub const INTERNAL_SPARKS: &[(usize, usize, char, SparkKind)] = &[
    (18, 2, '·', SparkKind::Red),
    (19, 3, '°', SparkKind::Silver),
    (26, 1, '✦', SparkKind::White),
    (36, 1, '·', SparkKind::White),
    (44, 2, '·', SparkKind::Blue),
];

// 5. Bottom Basin Sparks
pub const BASIN_SPARKS: &[(usize, char, SparkKind)] = &[
    (6, '·', SparkKind::Red),
    (12, '✦', SparkKind::White),
    (19, '·', SparkKind::Red),
    (26, '·', SparkKind::Silver),
    (33, '✦', SparkKind::White),
    (40, '·', SparkKind::Silver),
    (46, '✦', SparkKind::Blue),
    (52, '·', SparkKind::Blue),
];

#[inline]
pub fn spark_animated_color(kind: SparkKind, col: usize, row: usize, time_sec: f64) -> RGB {
    let flicker = 0.80 + 0.30 * (time_sec * 6.5 + col as f64 * 1.7 + row as f64 * 2.3).sin();
    match kind {
        SparkKind::White => RGB(255, 255, 255).scale(flicker),
        SparkKind::Silver => RGB(203, 213, 225).scale(flicker),
        SparkKind::Red => RGB(
            (255.0 * flicker).clamp(180.0, 255.0) as u8,
            (87.0 * flicker).clamp(30.0, 150.0) as u8,
            (34.0 * flicker).clamp(10.0, 60.0) as u8,
        ),
        SparkKind::Blue => RGB(
            (56.0 * flicker).clamp(20.0, 90.0) as u8,
            (189.0 * flicker).clamp(100.0, 230.0) as u8,
            (248.0 * flicker).clamp(160.0, 255.0) as u8,
        ),
    }
}

// ---------------------------------------------------------------------------
// Frame Renderer
// ---------------------------------------------------------------------------

pub fn render_frame(
    theme: ThemeMode,
    sparks: bool,
    anvil: bool,
    no_color: bool,
    time_sec: f64,
) -> String {
    let mut out = String::with_capacity(8192);

    // 1. Top Canopy Line
    if sparks {
        let mut canopy_line: Vec<Option<(char, RGB)>> = vec![None; CANVAS_WIDTH];
        for &(sc, ch, kind) in CANOPY_SPARKS {
            if sc < CANVAS_WIDTH {
                let color = spark_animated_color(kind, sc, 0, time_sec);
                canopy_line[sc] = Some((ch, color));
            }
        }
        for opt in canopy_line {
            match opt {
                Some((ch, rgb)) => {
                    if no_color {
                        out.push(ch);
                    } else {
                        out.push_str(&format!("\x1b[38;2;{};{};{}m{}\x1b[0m", rgb.0, rgb.1, rgb.2, ch));
                    }
                }
                None => out.push(' '),
            }
        }
        out.push('\n');
    }

    // Prepare in-grid sparks lookup: (row, col) -> (char, RGB)
    let mut grid_map: Vec<Vec<Option<(char, RGB)>>> = vec![vec![None; CANVAS_WIDTH]; 9];
    if sparks {
        for &(c, r, ch, kind) in LEFT_SPARKS.iter().chain(RIGHT_SPARKS).chain(INTERNAL_SPARKS) {
            if r < 9 && c < CANVAS_WIDTH {
                let rgb = spark_animated_color(kind, c, r, time_sec);
                grid_map[r][c] = Some((ch, rgb));
            }
        }
    }

    // 2. Main Logo Glyphs (shifted by 2 spaces to center over pedestal)
    for (r, raw_line) in ASTRO_LOGO_RAW.iter().enumerate() {
        let shifted = format!("  {}", raw_line);
        let chars: Vec<char> = shifted.chars().collect();

        for c in 0..CANVAS_WIDTH {
            let ch = if c < chars.len() { chars[c] } else { ' ' };
            if ch == ' ' {
                if let Some((sch, srgb)) = grid_map[r][c] {
                    if no_color {
                        out.push(sch);
                    } else {
                        out.push_str(&format!("\x1b[38;2;{};{};{}m{}\x1b[0m", srgb.0, srgb.1, srgb.2, sch));
                    }
                } else {
                    out.push(' ');
                }
            } else {
                if no_color {
                    out.push(ch);
                } else {
                    let rgb = calculate_char_color(ch, r, c, 9, theme, time_sec);
                    out.push_str(&format!("\x1b[38;2;{};{};{}m{}\x1b[0m", rgb.0, rgb.1, rgb.2, ch));
                }
            }
        }
        out.push('\n');
    }

    // 3. Bottom Basin Sparks Line
    if sparks {
        let mut basin_line: Vec<Option<(char, RGB)>> = vec![None; CANVAS_WIDTH];
        for &(sc, ch, kind) in BASIN_SPARKS {
            if sc < CANVAS_WIDTH {
                let color = spark_animated_color(kind, sc, 10, time_sec);
                basin_line[sc] = Some((ch, color));
            }
        }
        for opt in basin_line {
            match opt {
                Some((ch, rgb)) => {
                    if no_color {
                        out.push(ch);
                    } else {
                        out.push_str(&format!("\x1b[38;2;{};{};{}m{}\x1b[0m", rgb.0, rgb.1, rgb.2, ch));
                    }
                }
                None => out.push(' '),
            }
        }
        out.push('\n');
    }

    // 4. Anvil Pedestal Base
    if anvil {
        out.push('\n');
        for aline in &ANVIL_BASE {
            let chars: Vec<char> = aline.chars().collect();
            for (c_idx, &ach) in chars.iter().enumerate() {
                if ach == ' ' {
                    out.push(' ');
                } else if ach == '═' || ach == '▀' || ach == '▲' {
                    if no_color {
                        out.push(ach);
                    } else {
                        let t = c_idx as f64 / chars.len() as f64;
                        let wave = 0.25 + 0.25 * (t * PI).sin();
                        let rgb = RGB(148, 163, 184).lerp(RGB(56, 189, 248), wave);
                        out.push_str(&format!("\x1b[38;2;{};{};{}m{}\x1b[0m", rgb.0, rgb.1, rgb.2, ach));
                    }
                } else if ach == '[' || ach == ']' {
                    if no_color {
                        out.push(ach);
                    } else {
                        out.push_str(&format!("\x1b[38;2;255;255;255m{}\x1b[0m", ach));
                    }
                } else {
                    if no_color {
                        out.push(ach);
                    } else {
                        out.push_str(&format!("\x1b[38;2;241;245;249m{}\x1b[0m", ach));
                    }
                }
            }
            out.push('\n');
        }
    }

    out
}

// ---------------------------------------------------------------------------
// Animation Loop & Entry Point
// ---------------------------------------------------------------------------

fn print_help() {
    println!(
        r#"Astro Logo - Blacksmith's Forge Edition (Rust Port)

USAGE:
    astro_strike [OPTIONS]

OPTIONS:
    -t, --theme <THEME>   Theme preset: strike (default), forge, quench, damascus
    -a, --animate         Run continuous animated thermal breathing & spark shimmer (default)
    -s, --static          Render a single static frame and exit
    --fps <N>             Target frames per second for animation (default: 30)
    --clean               Clean mode: hide sparks and anvil pedestal
    --no-sparks           Disable spark particles
    --no-anvil            Disable anvil pedestal
    --no-color            Monochrome plain text output
    -h, --help            Show this help text

EXAMPLES:
    ./astro_strike --theme strike --animate    # Run the animated anvil strike shockwave
    ./astro_strike                            # Default: runs --theme strike --animate
    ./astro_strike --static                   # Print single static frame
    ./astro_strike --theme forge --animate    # Animated forge hearth flow
"#
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut theme = ThemeMode::Strike;
    let mut animate = true;
    let mut sparks = true;
    let mut anvil = true;
    let mut no_color = false;
    let mut fps = 30u64;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-t" | "--theme" => {
                if i + 1 < args.len() {
                    i += 1;
                    match args[i].to_lowercase().as_str() {
                        "strike" => theme = ThemeMode::Strike,
                        "forge" => theme = ThemeMode::Forge,
                        "quench" => theme = ThemeMode::Quench,
                        "damascus" => theme = ThemeMode::Damascus,
                        other => {
                            eprintln!("Unknown theme '{}'. Options: strike, forge, quench, damascus", other);
                            process::exit(1);
                        }
                    }
                }
            }
            "-a" | "--animate" => {
                animate = true;
            }
            "-s" | "--static" | "--once" => {
                animate = false;
            }
            "--fps" => {
                if i + 1 < args.len() {
                    i += 1;
                    if let Ok(val) = args[i].parse::<u64>() {
                        fps = val.clamp(1, 120);
                    }
                }
            }
            "--clean" => {
                sparks = false;
                anvil = false;
            }
            "--no-sparks" => {
                sparks = false;
            }
            "--no-anvil" => {
                anvil = false;
            }
            "--no-color" => {
                no_color = true;
            }
            "-h" | "--help" => {
                print_help();
                return;
            }
            _ => {}
        }
        i += 1;
    }

    if !animate {
        let frame = render_frame(theme, sparks, anvil, no_color, 0.0);
        print!("{}", frame);
        return;
    }

    // Register SIGINT / Ctrl+C handler for graceful terminal cleanup
    unsafe {
        signal(2, handle_sigint);
    }

    // Hide cursor during animation
    print!("\x1b[?25l");
    let _ = io::stdout().flush();

    let start_time = Instant::now();
    let frame_dur = Duration::from_millis(1000 / fps);
    let mut first_frame = true;
    let mut line_count = 0;

    while RUNNING.load(Ordering::SeqCst) {
        let elapsed = start_time.elapsed().as_secs_f64();
        let frame = render_frame(theme, sparks, anvil, no_color, elapsed);

        if first_frame {
            line_count = frame.lines().count();
            print!("{}", frame);
            first_frame = false;
        } else {
            // Move cursor up to overwrite previous frame
            print!("\x1b[{}A\r{}", line_count, frame);
        }
        let _ = io::stdout().flush();

        thread::sleep(frame_dur);
    }

    // Restore cursor
    print!("\x1b[?25h\n\x1b[1;36m[Forge fire subsided. Anvil cooled.]\x1b[0m\n");
    let _ = io::stdout().flush();
}
