# Direct3D 11 shader containers

`parseDxbcContainer` reads the DXBC envelope shared by compiled shader containers.
It validates version1.0, the complete input size, the part-offset table, every part
range and overlap, with a4,096-part allocation limit. Returned digest and part payloads borrow the caller's immutable
byte image; table order is retained even when file offsets are not sorted.
Unknown part FourCCs remain opaque. This reader does not validate the stored
checksum or interpret shader instructions.

The envelope follows Microsoft's [container declarations](https://github.com/microsoft/DirectXShaderCompiler/blob/main/include/dxc/DxilContainer/DxilContainer.h).
Native clients verify the identity of their embedded shader data separately.
