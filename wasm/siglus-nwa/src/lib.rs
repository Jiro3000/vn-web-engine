use core::ptr::read_unaligned;

struct Bits {
    next: *const u8,
    end: *const u8,
    cache: u32,
    available: u32,
}

impl Bits {
    #[inline]
    unsafe fn read(&mut self, count: u32) -> Option<u32> {
        // NWA codes read at most eight bits, so a single refill is sufficient.
        if self.available < count {
            if self.next == self.end {
                return None;
            }
            self.cache |= u32::from(*self.next) << self.available;
            self.next = self.next.add(1);
            self.available += 8;
        }
        let value = self.cache & ((1 << count) - 1);
        self.cache >>= count;
        self.available -= count;
        Some(value)
    }
}

#[inline]
unsafe fn decode_block<const CHANNELS: usize, const RUNS: bool>(
    input: *const u8,
    end: *const u8,
    output: *mut i16,
    count: usize,
    width: u32,
    shift: u32,
) -> Option<()> {
    if end.offset_from(input) < (CHANNELS * 2) as isize {
        return None;
    }
    let mut predictors = [0; CHANNELS];
    for (channel, sample) in predictors.iter_mut().enumerate() {
        *sample = i16::from_le(read_unaligned(input.add(channel * 2).cast()));
    }
    let mut bits = Bits {
        next: input.add(CHANNELS * 2),
        end,
        cache: 0,
        available: 0,
    };
    let mut repeat = 0;
    for sample in 0..count {
        let predictor = &mut predictors[sample & (CHANNELS - 1)];
        if repeat != 0 {
            repeat -= 1;
        } else {
            let code = bits.read(3)?;
            if code == 0 {
                if RUNS && bits.read(1)? != 0 {
                    repeat = bits.read(2)?;
                    if repeat == 3 {
                        repeat = bits.read(8)?;
                    }
                }
            } else if code == 7 && bits.read(1)? != 0 {
                *predictor = 0;
            } else {
                let wide = (width + 3).min(8);
                let (count, scale) = if code == 7 {
                    (wide, 17 - wide)
                } else {
                    (width, shift + code - 1)
                };
                let sign = 1 << (count - 1);
                let value = bits.read(count)?;
                let magnitude = ((value & (sign - 1)) << scale) as i32;
                let delta = if value & sign == 0 {
                    magnitude
                } else {
                    -magnitude
                };
                // Only the low 16 bits are audible or can affect future samples.
                *predictor = predictor.wrapping_add(delta as i16);
            }
        }
        *output.add(sample) = *predictor;
    }
    Some(())
}

unsafe fn decode<const CHANNELS: usize, const RUNS: bool>(
    input: *const u8,
    offsets: &[u32],
    output: *mut i16,
    samples: usize,
    block_samples: usize,
    width: u32,
) -> bool {
    let shift = (8 - width).max(2);
    let mut destination = 0;
    for block in offsets.windows(2) {
        let count = block_samples.min(samples - destination);
        if decode_block::<CHANNELS, RUNS>(
            input.add(block[0] as usize),
            input.add(block[1] as usize),
            output.add(destination),
            count,
            width,
            shift,
        )
        .is_none()
        {
            return false;
        }
        destination += count;
    }
    true
}

/// Decode complete, independently seeded NWA blocks. Return false for truncated
/// predictors or codes so the caller can report its usual decoding error.
///
/// # Safety
/// The block offset table must have `blocks + 1` monotonically ordered offsets
/// within the input. The output must hold `samples` i16 values and must be
/// disjoint from the input and table. Channels must be one or two and level 0–5.
#[no_mangle]
pub unsafe extern "C" fn siglus_nwa(
    input: *const u8,
    offsets: *const u32,
    blocks: usize,
    output: *mut i16,
    samples: usize,
    block_samples: usize,
    channels: u32,
    level: u32,
    runs: u32,
) -> bool {
    let offsets = core::slice::from_raw_parts(offsets, blocks + 1);
    let width = if level <= 2 { 5 - level } else { 3 + level };
    match (channels, runs != 0) {
        (1, false) => decode::<1, false>(input, offsets, output, samples, block_samples, width),
        (1, true) => decode::<1, true>(input, offsets, output, samples, block_samples, width),
        (2, false) => decode::<2, false>(input, offsets, output, samples, block_samples, width),
        (2, true) => decode::<2, true>(input, offsets, output, samples, block_samples, width),
        _ => false,
    }
}
