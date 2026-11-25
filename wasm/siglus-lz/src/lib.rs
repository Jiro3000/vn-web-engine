use core::ptr::{copy_nonoverlapping, read_unaligned, write_bytes, write_unaligned};

#[repr(u32)]
enum Status {
    Ok,
    TruncatedStream,
    TruncatedLiteral,
    TruncatedReference,
    InvalidReference,
}

unsafe fn unpack<const UNIT: usize>(
    input: *const u8,
    length: usize,
    output: *mut u8,
    size: usize,
) -> Status {
    let mut src = 0;
    let mut dst = 0;
    while dst < size {
        if src == length {
            return Status::TruncatedStream;
        }
        let mut flags = *input.add(src);
        src += 1;
        for _ in 0..8 {
            if dst == size {
                break;
            }
            if flags & 1 != 0 {
                if UNIT == 4 {
                    if length - src < 3 {
                        return Status::TruncatedLiteral;
                    }
                    let bgr = u32::from(read_unaligned(input.add(src).cast::<u16>()).to_le())
                        | (u32::from(*input.add(src + 2)) << 16);
                    write_unaligned(output.add(dst).cast::<u32>(), (bgr | 0xff000000).to_le());
                    src += 3;
                } else {
                    if src == length {
                        return Status::TruncatedLiteral;
                    }
                    *output.add(dst) = *input.add(src);
                    src += 1;
                }
                dst += UNIT;
            } else {
                if length - src < 2 {
                    return Status::TruncatedReference;
                }
                let word = usize::from(read_unaligned(input.add(src).cast::<u16>()).to_le());
                src += 2;
                let distance = (word >> 4) * UNIT;
                if distance == 0 || distance > dst {
                    return Status::InvalidReference;
                }
                let extra = if UNIT == 4 { 1 } else { 2 };
                let count = ((word & 15) + extra) * UNIT;
                let count = count.min(size - dst);
                let from = output.add(dst - distance);
                let to = output.add(dst);
                if distance >= count {
                    copy_nonoverlapping(from, to, count);
                } else if UNIT == 1 && distance == 1 {
                    write_bytes(to, *from, count);
                } else if UNIT == 4 {
                    // Wordwise copies retain the newly written pixels for overlapping runs.
                    for offset in (0..count).step_by(4) {
                        write_unaligned(
                            to.add(offset).cast::<u32>(),
                            read_unaligned(from.add(offset).cast::<u32>()),
                        );
                    }
                } else {
                    for offset in 0..count {
                        *to.add(offset) = *from.add(offset);
                    }
                }
                dst += count;
            }
            flags >>= 1;
        }
    }
    Status::Ok
}

/// Decode an LZSS payload after the caller validates its header.
///
/// # Safety
/// The payload and output must occupy disjoint ranges of the indicated lengths.
/// Pixel mode requires the output size to be divisible by four.
#[no_mangle]
pub unsafe extern "C" fn siglus_lz(
    input: *const u8,
    length: usize,
    output: *mut u8,
    size: usize,
    pixel_mode: u32,
) -> u32 {
    if pixel_mode == 0 {
        unpack::<1>(input, length, output, size) as u32
    } else {
        unpack::<4>(input, length, output, size) as u32
    }
}
