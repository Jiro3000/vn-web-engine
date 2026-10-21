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
compatibility, and does not translate or run shaders. A shader backend must validate
those separately before accepting a program for rendering.
