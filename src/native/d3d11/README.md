# d3d11.dll contract

`contract.ts` defines the native device, immediate context, resource, view, shader
and state interfaces used by D3D11 clients. It names COM slots, including the three
`IUnknown` slots. The definitions follow the [Microsoft SDK header](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/d3d11.h).
The interface subset grows with client coverage; view descriptors currently describe
Texture2D views. Forward declarations for adapter and shader linkage objects expose
only their inherited operations needed at this boundary.

Calls are synchronous. Descriptors and output parameters use plain records; buffer
and shader data use `Uint8Array`. Parallel native count/pointer arrays use one array
where the array length supplies the count. Optional creation output pointers are
represented by `validateOnly`; a validation call can return `S_FALSE` without a
resource. These declarations do not select or register an implementation.

Resource creation returns an owned reference. Bindings retain their interfaces;
getters returning interfaces add references, including `getDevice`, `getResource`
and `getImmediateContext`. Callers release returned objects. Mapped bytes are borrowed
until `unmap`, which commits writes across the implementation boundary. A backend
copies descriptors and shader inputs according to the native object's lifetime.

Clients import only this contract. The UI runtime wiring registers the chosen
implementation with the existing native-library loader. Rendering hosts, browser
surfaces, shader translators and implementation classes stay outside the contract.

## Resource storage

`runtime/com.ts` separates caller references from internal bindings. The device and
immediate context can be reacquired while any child interface remains owned. Final
caller release clears bindings before retiring device/context storage.

`runtime/resources.ts` owns ordinary vertex/index/constant buffers and single-sample
typed Texture2D bytes. Creation copies input rows and descriptors; subresources follow
native mip/array order. Map returns borrowed bytes, and unmap snapshots writes. Read
maps preserve storage. Discard replaces the dynamic texture mip chain; no-overwrite
is limited to dynamic vertex/index buffers. Updates and copies validate complete
regions before writing, including compressed edge blocks and byte-based buffer boxes.

The format subset is RGBA8, BGRA8, R8, A8, R8G8, BC1/2/3/7, D32 and D24S8. Compressed
base dimensions are multiples of four; lower mip storage rounds up to whole blocks.
Typeless formats, multisampling, cube/shared resources and structured/raw buffers are
rejected. Storage is bounded to256 MiB per resource. Validation-only creation allocates
no interface. These implementation components do not yet register a rendering device.
GPU writes and readback must use the same resource storage when that device is wired.

Resource rules follow Microsoft's [Map values](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_map),
[UpdateSubresource](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-updatesubresource)
and [block compression](https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/block-compression)
documentation. No Windows graphics binaries execute in this implementation.
