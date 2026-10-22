# Direct3D 11 shader containers

`parseDxbcContainer` reads the DXBC envelope shared by compiled shader containers.
It validates version1.0, the complete input size, the part-offset table, every part
range and overlap, with a4,096-part allocation limit. Returned digest and part payloads borrow the caller's immutable
byte image; table order is retained even when file offsets are not sorted.
Unknown part FourCCs remain opaque. This reader does not validate the stored
checksum or interpret shader instructions.

The envelope follows Microsoft's [container declarations](https://github.com/microsoft/DirectXShaderCompiler/blob/main/include/dxc/DxilContainer/DxilContainer.h).
Native clients verify the identity of their embedded shader data separately.

`parseSm4Program` reads a complete SHDR payload for vertex/pixel Shader Model4.0.
It decodes the declared arithmetic/sample/declaration opcode subset, component masks
and swizzles, operand extensions, immediate bit patterns and indexed register operands.
Relative indices are bounded to16levels;64-bit indices stay as two raw DWORDs. Custom
data uses its own length word and remains opaque. Instructions cannot consume another
instruction's words. Inputs are limited to4MiB and65,536instructions; unknown opcodes,
versions and undefined operand encodings fail explicitly.

Token syntax follows Microsoft's [token-format definitions](https://github.com/microsoft/DirectX-Headers/blob/main/include/directx/D3D12TokenizedProgramFormat.hpp).
Decoding does not validate shader semantics, register declarations or executable
compatibility. A shader backend must validate those separately before accepting a
program for rendering.

`parseSm4Signature` reads the serialized24-byte parameter records in ISGN/OSGN
payloads. It retains semantic spelling/index, serialized system values, component
types, register masks and the input always-reads/output never-writes mask. Registers
must be ordered; parameter tables and NUL-terminated strings are checked within the
payload. Parameter count and individual name length are limited to4,096. Newer
signature record layouts are outside this reader's scope.

The layout and mask meanings follow Microsoft's [SM4 signature reader](https://github.com/microsoft/D3D12TranslationLayer/blob/master/DxbcParser/src/DXBCUtils.cpp).

## GLSL instruction lowering

`translateSm4ToGlsl` lowers the declared SM4 arithmetic and float Texture2D sampling
subset into a callable GLSL ES3 stage function. It validates declarations, register
bounds, instruction controls and supported operand forms. Disjoint component
declarations may share an input/output register. Unsupported effects fail explicitly.
The returned binding records describe raw constant-buffer DWORD arrays and distinct
texture/sampler pairs; the caller supplies stage linkage, positions, texture formats
and sampler state.

Registers contain raw unsigned words. Moves, masks, sign modifiers and conditional
moves preserve those bits; arithmetic flushes denormals at its boundaries. Helpers
cover NaN selection/saturation and division, logarithm, reciprocal-square-root and
exponential special values. Pixel discard is deferred until return so subsequent
instructions retain their derivative participation. GPU arithmetic retains the
precision limits of the target GLSL implementation.

`tools/probe-sm4-glsl.mjs` executes generated instruction fixtures in an isolated
headless WebGL2 browser and reads an integer framebuffer. Fixtures cover raw words,
arithmetic special values, masked aliasing, discard, short constant buffers and
independent samplers. It serves synthetic data and compiled modules only and captures
no screenshots. This instruction probe does not verify a complete D3D11 rendering
pipeline.

Instruction behavior follows Microsoft's [floating-point rules](https://learn.microsoft.com/en-us/windows/win32/direct3d11/floating-point-rules),
[conditional moves](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/movc--sm4---asm-)
and [discard](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/discard--sm4---asm-).
