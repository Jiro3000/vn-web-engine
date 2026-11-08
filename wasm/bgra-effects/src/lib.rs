use core::arch::wasm32::*;

/// Convert a dirty rectangle to opaque RGBA and return the changed row bounds.
#[no_mangle]
pub unsafe extern "C" fn present_bgrx(
    source: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    stride: usize,
) -> u32 {
    let opaque = u32x4_splat(0xff000000);
    let mut first = 0;
    let mut last = 0;
    for y in 0..height {
        let src = source.add(y * stride);
        let dst = destination.add(y * stride);
        let mut vector_changes = u32x4_splat(0);
        let mut x = 0;
        while x + 4 <= width {
            let bgra = v128_load(src.add(x).cast());
            let rgba = v128_or(
                opaque,
                i8x16_shuffle::<2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15>(bgra, bgra),
            );
            let previous = v128_load(dst.add(x).cast());
            vector_changes = v128_or(vector_changes, v128_xor(rgba, previous));
            v128_store(dst.add(x).cast(), rgba);
            x += 4;
        }
        let mut scalar_changes = 0;
        while x < width {
            let bgra = *src.add(x);
            let rgba = 0xff000000 | ((bgra & 255) << 16) | (bgra & 0xff00) | ((bgra >> 16) & 255);
            scalar_changes |= rgba ^ *dst.add(x);
            *dst.add(x) = rgba;
            x += 1;
        }
        if scalar_changes != 0 || v128_any_true(vector_changes) {
            last = (y + 1) as u32;
            if first == 0 {
                first = last;
            }
        }
    }
    first | (last << 16)
}

#[inline]
fn mix_bytes(source: v128, destination: v128, weight: v128) -> v128 {
    let rest = u16x8_sub(u16x8_splat(256), weight);
    u16x8_shr(
        u16x8_add(u16x8_mul(source, weight), u16x8_mul(destination, rest)),
        8,
    )
}

#[no_mangle]
pub unsafe extern "C" fn normal_blend(
    source: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    stride: usize,
    opacity: u32,
    masked: u32,
) {
    if width == stride {
        normal_blend_span(source, destination, width * height, opacity, masked);
    } else {
        for row in 0..height {
            normal_blend_span(
                source.add(row * width),
                destination.add(row * stride),
                width,
                opacity,
                masked,
            );
        }
    }
}

unsafe fn normal_blend_span(
    source: *const u32,
    destination: *mut u32,
    pixels: usize,
    opacity: u32,
    masked: u32,
) {
    normal_blend_span_into(source, destination, destination, pixels, opacity, masked);
}

/// `normal_blend_span` that reads the destination pixels from `under` and writes `destination`.
#[inline]
unsafe fn normal_blend_span_into(
    source: *const u32,
    under: *const u32,
    destination: *mut u32,
    pixels: usize,
    opacity: u32,
    masked: u32,
) {
    let opacity16 = u16x8_splat(opacity as u16);
    let rgb = u32x4_splat(0x00ffffff);
    let mut i = 0;
    while i + 4 <= pixels {
        let s = v128_load(source.add(i).cast());
        let d = v128_load(under.add(i).cast());
        let (low, high) = if masked != 0 {
            let alpha =
                i8x16_shuffle::<3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15>(s, s);
            let one = u16x8_splat(1);
            let weight = |a| u16x8_add(u16x8_shr(u16x8_mul(a, opacity16), 8), one);
            (
                weight(u16x8_extend_low_u8x16(alpha)),
                weight(u16x8_extend_high_u8x16(alpha)),
            )
        } else {
            (opacity16, opacity16)
        };
        let out = u8x16_narrow_i16x8(
            mix_bytes(u16x8_extend_low_u8x16(s), u16x8_extend_low_u8x16(d), low),
            mix_bytes(u16x8_extend_high_u8x16(s), u16x8_extend_high_u8x16(d), high),
        );
        v128_store(
            destination.add(i).cast(),
            if masked != 0 {
                v128_bitselect(out, d, rgb)
            } else {
                out
            },
        );
        i += 4;
    }
    while i < pixels {
        let s = *source.add(i);
        let d = *under.add(i);
        let k = if masked != 0 {
            ((s >> 24) * opacity >> 8) + 1
        } else {
            opacity
        };
        let mut out = if masked != 0 { d & 0xff000000 } else { 0 };
        for shift in (0..if masked != 0 { 24 } else { 32 }).step_by(8) {
            let from = (s >> shift) & 255;
            let to = (d >> shift) & 255;
            out |= ((from * k + to * (256 - k)) >> 8) << shift;
        }
        *destination.add(i) = out;
        i += 1;
    }
}

/// YU-RIS 0x402FE0/0x402D7C. The staged first image becomes the output.
#[no_mangle]
pub unsafe extern "C" fn transition_bgra(
    first: *mut u32,
    second: *const u32,
    width: usize,
    height: usize,
    weight: u32,
    sse: u32,
) {
    transition_bgra_into(first, second, first, width, height, weight, sse);
}

/// `transition_bgra` with the first image left in place and the result written to `output`.
#[no_mangle]
pub unsafe extern "C" fn transition_bgra_into(
    first: *const u32,
    second: *const u32,
    output: *mut u32,
    width: usize,
    height: usize,
    weight: u32,
    sse: u32,
) {
    if weight != 128 {
        normal_blend_span_into(second, first, output, width * height, weight, 0);
        return;
    }
    for row in 0..height {
        let a = first.add(row * width);
        let b = second.add(row * width);
        let o = output.add(row * width);
        let mut x = 0;
        while x + 4 <= width {
            let left = v128_load(a.add(x).cast());
            let right = v128_load(b.add(x).cast());
            let mixed = if sse != 0 {
                u8x16_avgr(left, right)
            } else {
                u8x16_add(u8x16_shr(left, 1), u8x16_shr(right, 1))
            };
            v128_store(o.add(x).cast(), mixed);
            x += 4;
        }
        while x < width {
            let left = *a.add(x);
            let right = *b.add(x);
            let tail = (width & 1) != 0 && x + 1 == width;
            let mut mixed = 0;
            for shift in (0..32).step_by(8) {
                let l = (left >> shift) & 255;
                let r = (right >> shift) & 255;
                let value = if tail {
                    (l + r) >> 1
                } else if sse != 0 {
                    (l + r + 1) >> 1
                } else {
                    (l >> 1) + (r >> 1)
                };
                mixed |= value << shift;
            }
            *o.add(x) = mixed;
            x += 1;
        }
    }
}

#[inline]
fn rule_weights(a: u16, b: u16) -> v128 {
    u16x8(a, a, a, a, b, b, b, b)
}

#[inline]
fn weighted_difference(from: v128, to: v128, weight: v128) -> v128 {
    let from = u16x8_extend_low_u8x16(from);
    let to = u16x8_extend_low_u8x16(to);
    let difference = i16x8_sub(from, to);
    let low = i32x4_mul(
        i32x4_extend_low_i16x8(difference),
        u32x4_extend_low_u16x8(weight),
    );
    let high = i32x4_mul(
        i32x4_extend_high_i16x8(difference),
        u32x4_extend_high_u16x8(weight),
    );
    i16x8_add(
        to,
        i16x8_narrow_i32x4(i32x4_shr(low, 16), i32x4_shr(high, 16)),
    )
}

#[no_mangle]
pub unsafe extern "C" fn rule_blend(
    source: *const u32,
    destination: *mut u32,
    rule: *const u32,
    weights: *const i32,
    width: usize,
    height: usize,
    stride: usize,
    opacity: u32,
    masked: u32,
) {
    if width == stride {
        rule_blend_span(
            source,
            destination,
            rule,
            weights,
            width * height,
            opacity,
            masked,
        );
    } else {
        for row in 0..height {
            rule_blend_span(
                source.add(row * width),
                destination.add(row * stride),
                rule.add(row * width),
                weights,
                width,
                opacity,
                masked,
            );
        }
    }
}

unsafe fn rule_blend_span(
    source: *const u32,
    destination: *mut u32,
    rule: *const u32,
    weights: *const i32,
    pixels: usize,
    opacity: u32,
    masked: u32,
) {
    let weight = |i: usize| {
        let value = *weights.add((*rule.add(i) & 255) as usize);
        if value > 1 {
            value as u16
        } else {
            0
        }
    };
    let rgb = u32x4_splat(0x00ffffff);
    let mut i = 0;
    while i + 4 <= pixels {
        let a = weight(i);
        let b = weight(i + 1);
        let c = weight(i + 2);
        let e = weight(i + 3);
        if a | b | c | e != 0 {
            let s = v128_load(source.add(i).cast());
            let d = v128_load(destination.add(i).cast());
            let out = if masked != 0 {
                let alpha =
                    i8x16_shuffle::<3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15>(s, s);
                let lo = u16x8_mul(rule_weights(a, b), u16x8_extend_low_u8x16(alpha));
                let hi = u16x8_mul(rule_weights(c, e), u16x8_extend_high_u8x16(alpha));
                let src_high = i64x2_shuffle::<1, 1>(s, s);
                let dst_high = i64x2_shuffle::<1, 1>(d, d);
                u8x16_narrow_i16x8(
                    weighted_difference(s, d, lo),
                    weighted_difference(src_high, dst_high, hi),
                )
            } else {
                // At full opacity the native worker subtracts a rounded-down
                // destination-minus-source product, which rounds this sum up.
                let mix = |s: v128, d: v128, w: v128| {
                    let rest = u16x8_sub(u16x8_splat(256), w);
                    let sum = u16x8_add(u16x8_mul(s, w), u16x8_mul(d, rest));
                    u16x8_shr(
                        u16x8_add(sum, u16x8_splat(if opacity >= 256 { 255 } else { 0 })),
                        8,
                    )
                };
                u8x16_narrow_i16x8(
                    mix(
                        u16x8_extend_low_u8x16(s),
                        u16x8_extend_low_u8x16(d),
                        rule_weights(a, b),
                    ),
                    mix(
                        u16x8_extend_high_u8x16(s),
                        u16x8_extend_high_u8x16(d),
                        rule_weights(c, e),
                    ),
                )
            };
            v128_store(destination.add(i).cast(), v128_bitselect(out, d, rgb));
        }
        i += 4;
    }
    while i < pixels {
        let k = i32::from(weight(i));
        if k != 0 {
            let s = *source.add(i);
            let d = *destination.add(i);
            let mut out = d & 0xff000000;
            for shift in [0, 8, 16] {
                let from = ((s >> shift) & 255) as i32;
                let to = ((d >> shift) & 255) as i32;
                let delta = from - to;
                let value = if masked != 0 {
                    to + ((delta * ((s >> 24) as i32) * k) >> 16)
                } else if opacity >= 256 {
                    to - ((-delta * k) >> 8)
                } else {
                    to + ((delta * k) >> 8)
                };
                out |= (value as u32) << shift;
            }
            *destination.add(i) = out;
        }
        i += 1;
    }
}

#[inline]
unsafe fn pixel(source: *const u32, count: usize, index: i32) -> u32 {
    if (index as usize) < count {
        *source.add(index as usize)
    } else {
        0
    }
}

// Each row holds its unrounded horizontal 2-tap sums, in channel order.
unsafe fn horizontal(
    source: *const u32,
    count: usize,
    columns: *const i32,
    weights: *const u8,
    row: i32,
    output: *mut v128,
    pairs: usize,
) {
    for pair in 0..pairs {
        let x = pair * 2;
        let i = row + *columns.add(x);
        let j = row + *columns.add(x + 1);
        let left = u32x4(pixel(source, count, i), pixel(source, count, j), 0, 0);
        let right = u32x4(
            pixel(source, count, i + 1),
            pixel(source, count, j + 1),
            0,
            0,
        );
        let a = *weights.add(x) as u16;
        let b = *weights.add(x + 1) as u16;
        let w = u16x8(a, a, a, a, b, b, b, b);
        let iw = u16x8_sub(u16x8_splat(256), w);
        v128_store(
            output.add(pair),
            u16x8_add(
                u16x8_mul(u16x8_extend_low_u8x16(left), iw),
                u16x8_mul(u16x8_extend_low_u8x16(right), w),
            ),
        );
    }
}

#[inline]
fn vertical_sse(a: v128, b: v128, wa: v128, wb: v128) -> v128 {
    let low = u32x4_add(
        u32x4_shr(u32x4_extmul_low_u16x8(a, wa), 16),
        u32x4_shr(u32x4_extmul_low_u16x8(b, wb), 16),
    );
    let high = u32x4_add(
        u32x4_shr(u32x4_extmul_high_u16x8(a, wa), 16),
        u32x4_shr(u32x4_extmul_high_u16x8(b, wb), 16),
    );
    u16x8_narrow_i32x4(low, high)
}

#[inline]
fn vertical_mmx(a: v128, b: v128, wa: v128, wb: v128) -> v128 {
    u16x8_shr(
        u16x8_add(
            u16x8_mul(u16x8_shr(a, 8), wa),
            u16x8_mul(u16x8_shr(b, 8), wb),
        ),
        8,
    )
}

// The host supplies the engine's fixed-point coordinates and sharpened fractions.
// Columns are padded to a pair, and the final store omits the padding pixel.
#[no_mangle]
pub unsafe extern "C" fn bilinear(
    source: *const u32,
    count: usize,
    stride: i32,
    destination: *mut u32,
    width: usize,
    height: usize,
    columns: *const i32,
    x_weights: *const u8,
    rows: *const i32,
    y_weights: *const u8,
    scratch: *mut v128,
    cached_rows: *mut u8,
    sse: u32,
) {
    let pairs = width.div_ceil(2);
    let mut first = scratch;
    let mut second = scratch.add(pairs);
    let mut first_y = i32::MIN;
    let mut second_y = i32::MIN;
    let zero = u32x4_splat(0);
    for y in 0..height {
        let row = *rows.add(y);
        let fraction = *y_weights.add(y) as u16;
        if cached_rows.is_null() {
            if row == second_y {
                core::mem::swap(&mut first, &mut second);
                core::mem::swap(&mut first_y, &mut second_y);
            }
            if row != first_y {
                horizontal(
                    source,
                    count,
                    columns,
                    x_weights,
                    row * stride,
                    first,
                    pairs,
                );
                first_y = row;
            }
            if fraction != 0 && row + 1 != second_y {
                horizontal(
                    source,
                    count,
                    columns,
                    x_weights,
                    (row + 1) * stride,
                    second,
                    pairs,
                );
                second_y = row + 1;
            }
        } else {
            let cached = |at: i32| {
                let found = cached_rows.add(at as usize);
                let output = scratch.add(at as usize * pairs);
                if *found == 0 {
                    horizontal(
                        source,
                        count,
                        columns,
                        x_weights,
                        at * stride,
                        output,
                        pairs,
                    );
                    *found = 1;
                }
                output
            };
            first = cached(row);
            if fraction != 0 {
                second = cached(row + 1);
            }
        }
        let wa = u16x8_splat(256 - fraction);
        let wb = u16x8_splat(fraction);
        let output = destination.add(y * width);
        for pair in 0..pairs {
            let a = v128_load(first.add(pair));
            let channels = if fraction == 0 {
                u16x8_shr(a, 8)
            } else {
                let b = v128_load(second.add(pair));
                if sse != 0 {
                    vertical_sse(a, b, wa, wb)
                } else {
                    vertical_mmx(a, b, wa, wb)
                }
            };
            let pixels = u8x16_narrow_i16x8(channels, zero);
            if pair * 2 + 1 < width {
                v128_store64_lane::<0>(pixels, output.add(pair * 2).cast());
            } else {
                *output.add(pair * 2) = u32x4_extract_lane::<0>(pixels);
            }
        }
    }
}

/// One pass of YU-RIS SIZE5 (0x434A14) over taps that stay inside the line. Output `i` of a
/// line sums the BGRA bytes at `samples[starts[i]..starts[i + 1]]` (in units of `tap_in`
/// bytes) times their weights, each sum wrapping to 32 bits after every tap, then divides by
/// `totals[i]` (1 plus the weights) toward zero; an alpha above 0xFC becomes 0xFF and every
/// byte is clamped. `outputs_outer` walks outputs before lines, for passes along columns.
#[no_mangle]
pub unsafe extern "C" fn lanczos_pass(
    source: *const u8,
    destination: *mut u8,
    lines: usize,
    count: usize,
    line_in: usize,
    tap_in: usize,
    line_out: usize,
    step_out: usize,
    starts: *const u32,
    samples: *const u32,
    weights: *const i32,
    totals: *const i32,
    outputs_outer: u32,
) {
    let run = |line: usize, i: usize| {
        let from = source.add(line * line_in);
        let mut sum = i32x4_splat(0);
        for t in *starts.add(i) as usize..*starts.add(i + 1) as usize {
            let pixel = v128_load32_zero(from.add(*samples.add(t) as usize * tap_in).cast());
            let channels = u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(pixel));
            sum = i32x4_add(sum, i32x4_mul(channels, i32x4_splat(*weights.add(t))));
        }
        let total = *totals.add(i);
        let quotient = |value: i32| {
            if total == 0 {
                0
            } else {
                value.wrapping_div(total)
            }
        };
        let output = destination.add(line * line_out + i * step_out);
        let mut alpha = quotient(i32x4_extract_lane::<3>(sum));
        if alpha > 0xfc {
            alpha = 0xff;
        }
        *output = quotient(i32x4_extract_lane::<0>(sum)).clamp(0, 255) as u8;
        *output.add(1) = quotient(i32x4_extract_lane::<1>(sum)).clamp(0, 255) as u8;
        *output.add(2) = quotient(i32x4_extract_lane::<2>(sum)).clamp(0, 255) as u8;
        *output.add(3) = alpha.clamp(0, 255) as u8;
    };
    if outputs_outer != 0 {
        for i in 0..count {
            for line in 0..lines {
                run(line, i);
            }
        }
    } else {
        for line in 0..lines {
            for i in 0..count {
                run(line, i);
            }
        }
    }
}

/// The CPU compositor's MODE blitters without a rule (0x789A00 and 0x789AA0 tables). `table`
/// holds F(source, destination) at `source * 256 + destination` (0x4626FC). Masked layers
/// keep the destination alpha; unmasked ones blend all four bytes.
#[no_mangle]
pub unsafe extern "C" fn table_blend(
    source: *const u8,
    destination: *mut u8,
    table: *const u8,
    width: usize,
    height: usize,
    stride: usize,
    opacity: u32,
    masked: u32,
    mode: u32,
) {
    if width == stride {
        table_blend_span(source, destination, table, width * height, opacity, masked, mode);
    } else {
        for row in 0..height {
            table_blend_span(
                source.add(row * width * 4),
                destination.add(row * stride * 4),
                table,
                width,
                opacity,
                masked,
                mode,
            );
        }
    }
}

/// Exact trunc(x / 255) for 0 <= x <= 65025 in u16 lanes.
#[inline]
fn div255(x: v128) -> v128 {
    u16x8_shr(u16x8_add(u16x8_add(x, u16x8_splat(1)), u16x8_shr(x, 8)), 8)
}

/// Per-lane weights of four masked pixels as two u16x8 halves.
#[inline]
fn masked_weights(s: v128, opacity: u32, mode: u32) -> (v128, v128) {
    let alpha = i8x16_shuffle::<3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15>(s, s);
    let a = u16x8_splat(opacity as u16);
    let weight = |sa: v128| {
        if opacity >= 256 {
            u16x8_add(sa, u16x8_splat(1))
        } else if mode == 1 {
            u16x8_shr(u16x8_mul(sa, a), 8)
        } else {
            u16x8_shr(u16x8_add(u16x8_mul(sa, a), a), 8)
        }
    };
    (
        weight(u16x8_extend_low_u8x16(alpha)),
        weight(u16x8_extend_high_u8x16(alpha)),
    )
}

unsafe fn table_blend_span(
    s: *const u8,
    d: *mut u8,
    f: *const u8,
    pixels: usize,
    opacity: u32,
    masked: u32,
    mode: u32,
) {
    let a = opacity as i32;
    if masked == 0 {
        let n = pixels * 4;
        for i in 0..n {
            let from = *s.add(i) as i32;
            let to = *d.add(i) as i32;
            *d.add(i) = if a >= 256 {
                *f.add(((from as usize) << 8) | to as usize)
            } else if mode == 1 {
                // 0x401124.
                (to + ((from * a) >> 8)).min(255) as u8
            } else {
                let diff = *f.add(((from as usize) << 8) | to as usize) as i32 - to;
                // 0x413EE0 truncates toward zero; the others shift.
                if mode == 8 {
                    (to + (a * diff) / 256) as u8
                } else {
                    (to + ((diff * a) >> 8)) as u8
                }
            };
        }
        return;
    }
    let rgb = u32x4_splat(0x00ffffff);
    let mut i = 0;
    if mode == 5 || (mode == 1 && a < 256) {
        while i + 4 <= pixels {
            let sv = v128_load(s.add(i * 4).cast());
            let dv = v128_load(d.add(i * 4).cast());
            let (wl, wh) = masked_weights(sv, opacity, mode);
            let lane = |s16: v128, d16: v128, k: v128| {
                if mode == 1 {
                    // 0x4011E4: d + (s * k >> 8), saturated.
                    u16x8_shr(u16x8_mul(s16, k), 8)
                } else {
                    // Screen: F - d = s - trunc(s * d / 255) >= 0.
                    let step = u16x8_sub(s16, div255(u16x8_mul(s16, d16)));
                    u16x8_shr(u16x8_mul(step, k), 8)
                }
            };
            let add = u8x16_narrow_i16x8(
                lane(u16x8_extend_low_u8x16(sv), u16x8_extend_low_u8x16(dv), wl),
                lane(u16x8_extend_high_u8x16(sv), u16x8_extend_high_u8x16(dv), wh),
            );
            let out = u8x16_add_sat(dv, add);
            v128_store(d.add(i * 4).cast(), v128_bitselect(out, dv, rgb));
            i += 4;
        }
    }
    while i < pixels {
        let p = i * 4;
        let sa = *s.add(p + 3) as i32;
        if mode == 1 && a < 256 {
            let k = (sa * a) >> 8;
            for c in 0..3 {
                let to = *d.add(p + c) as i32;
                *d.add(p + c) = (to + ((*s.add(p + c) as i32 * k) >> 8)).min(255) as u8;
            }
        } else {
            let k = if a >= 256 {
                sa + 1
            } else if mode == 0 {
                ((sa * a) >> 8) + 1
            } else {
                (sa * a + a) >> 8
            };
            for c in 0..3 {
                let to = *d.add(p + c) as i32;
                let from = *s.add(p + c) as usize;
                let diff = *f.add((from << 8) | to as usize) as i32 - to;
                *d.add(p + c) = (to + ((diff * k) >> 8)) as u8;
            }
        }
        i += 1;
    }
}
