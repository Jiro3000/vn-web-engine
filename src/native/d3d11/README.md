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
no interface. `runtime/views.ts` provides typed single-texture shader-resource,
render-target and depth/stencil views. Views hold resources through binding references;
`getResource` and `getDevice` return owned references. Mip ranges and descriptors are
copied, and factories reject foreign-device resources and missing bind flags. Array
views and typeless reinterpretation are outside the declared view subset.

These implementation components do not yet register a rendering device.
GPU writes and readback must use the same resource storage when that device is wired.
The internal resource owner can synchronize deferred GPU writes before borrowed-byte
reads, preserving maps, partial updates and copies. Validation precedes synchronization.
Whole-resource copies synchronize their source; their destination is replaced in full.
WRITE_DISCARD skips synchronization because it replaces the relevant storage. Resource
revisions distinguish those CPU replacements from pending device writes.
An optional readiness query lets Map(DO_NOT_WAIT) return
DXGI_ERROR_WAS_STILL_DRAWING before synchronizing or allocating mapped storage.

`runtime/states.ts` owns blend, depth/stencil, rasterizer and sampler descriptions.
Creation copies nested records, converts native float fields to float32, and interns
identical descriptions with an additional caller reference. Each kind is limited to
4,096 live unique states; final release removes its cache entry. Getters return copies,
and binding references keep a state alive independently of its creating caller. Fields
ignored by disabled blend/depth/stencil/sampler features retain their supplied values.
Sampler descriptors cover ordinary and comparison filters; minimum/maximum reduction
filters require a newer feature subset.

Interning and limits follow [CreateBlendState](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createblendstate)
and the [native return codes](https://learn.microsoft.com/en-us/windows/win32/direct3d11/d3d11-graphics-reference-returnvalues).

`runtime/context-state.ts` provides the immediate context's VS/PS constant buffers,
PS resource/sampler/shader slots, input assembler and output/rasterizer bindings.
Its implemented methods are checked against the native context contract. Updates
validate all incoming handles before replacing bindings, and getters return owned
interface references or copied scalar records. Shader-resource/render-target overlap
is resolved per mip range. Output views must have compatible dimensions and cannot
bind one subresource twice. Setting outputs preserves viewport/scissor state.

`clearState` resets all covered bindings and defaults. Final device lifetime teardown
uses the same cleanup without reacquiring a caller reference, attempts every release,
and retires state even if host disposal fails. Drawing, resource transfers and flushing
belong to the concrete rendering backend; this binding component does not register one.
It accepts SM4 shaders, whose class-instance arrays are empty.

Binding ownership and hazards follow [PSSetShaderResources](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-pssetshaderresources),
[OMSetRenderTargets](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-omsetrendertargets)
and [ClearState](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-clearstate).

`runtime/input-layout.ts` creates owned input-layout metadata from SM4 signatures.
It copies semantic records and resolves APPEND offsets independently for each stream.
The current float-input subset covers R32G32_FLOAT, R32G32B32_FLOAT and
B8G8R8A8_UNORM; unsupported types and element spans beyond2,048bytes return E_NOTIMPL.
Unused declared elements are retained, and missing/duplicate semantics are rejected.
Elements sharing an input slot must agree on instance class and step rate. The input
subset uses one semantic per register; packed IA signatures return E_NOTIMPL.
Validation-only calls create no interface. Shared `graphics/dxgi-vertex.ts` reads these
in-bounds element formats into caller-owned float4 storage, preserving packed color
normalization and the missing-component defaults0,0,0,1.

`runtime/input-assembly.ts` provides borrowed vertex/index readers for one synchronous
draw while context bindings retain the resources. Vertex reads combine streams in the
requested register order and preserve each element's float4 format expansion. Address
multiplication and addition wrap to32bits. Wrapped addresses below the bound buffer
offset and elements extending beyond storage return zero for present format components
and native defaults for missing components. Zero stride repeats an element; ordinary
Draw/DrawIndexed use instance0 for instance-class elements. Used streams must be bound
in this subset. Mapped, foreign and released buffers fail explicitly.

Index reads accept R16_UINT/R32_UINT, apply the same wrapping and lower bound, return
zero outside storage and retain strip-cut words. The draw operation consumes strip cuts
before adding BaseVertexLocation. Readers allocate no objects per vertex or index.
The shared DXGI helper still exposes strict in-bounds reads for other callers.

Addressing follows sections8.3/8.5/8.19 of the [Direct3D functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).

Layout ownership and signature matching follow [CreateInputLayout](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createinputlayout).
Missing-component defaults follow section19.1.3.3 of the [Direct3D functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).

`runtime/shaders.ts` creates owned vertex/pixel device children from DXBC bytes.
The shared SM4 compiler owns immutable interface and executable records, so releasing
or changing caller bytecode cannot change a created shader. Stage mismatches and
malformed interfaces fail before allocation; validation-only calls return S_FALSE.
The supported shader model uses float registers and no dynamic class linkage.
Shaders participate in the same binding/getter/device reference lifetime as other
children. Compiling linked GPU programs and managing their cache belongs to the
concrete backend; these shader objects do not register a rendering device.

Creation and bytecode lifetime follow [CreateVertexShader](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createvertexshader)
and [CreatePixelShader](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createpixelshader).

`webgl2/shaders.ts` compiles and links these native shader pairs on WebGL2. Its
device-owned cache retains the shader children and bounds programs with LRU eviction.
Eviction and disposal delete GPU programs and release both children. Pair lookup uses
weak identity maps; successful selection makes the corresponding program current.
Failed compilation or linkage releases every partially created GPU object.

Active uniform reflection bounds raw constant uploads to the array size retained by
the driver. Short and unbound buffers are zero-filled; unchanged buffer identities
and revisions avoid repeated uploads. Texture/sampler pairs receive independent units.
The synthetic shader probe exercises this cache, native buffer updates, unbinding,
eviction and disposal with raw float readback. A rendering device still needs to bind
textures, input assembly, targets and raster/output state through this implementation.

## GPU texture storage

`webgl2/textures.ts` owns single-sample Texture2D images, mip attachments and independent
shader-view mip ranges. Full-range views share the canonical image; other ranges use
copied GPU images so simultaneous views have independent base levels. A draw acquires
its context-owned views together, pinning their images until release. Unbound resources
sample an all-zero image, including alpha.

R8/RG8 upload directly. BGRA, A8 and BC1/2/3/7 use the shared integer GPU decoder in
`graphics/block-texture.ts`; their canonical images contain the corresponding RGBA8
texels. Depth uploads support D32_FLOAT and D24_UNORM_S8_UINT, with native depth/stencil
bit order converted to GL's packed order. Native row0 is GL row0 throughout upload,
rendering, shader-view copies and readback.

Render-target clears ignore scissor and component write masks. Device writes advance
the resource revision and defer CPU readback. The resource owner's synchronization
callback commits pending color writes in native byte order before a preserving CPU
operation. CPU changes re-upload the coherent mip chain; WRITE_DISCARD replaces obsolete
contents. Map(DO_NOT_WAIT) queries a lazily created fence with zero timeout, returning
still-drawing until ready. Fences are retired on another device write, CPU replacement,
completed synchronization or final release. Lost contexts report device-removed.

Texture allocations, aliases and packed-upload scratch share a512MiB limit. Aliases
and scratch each have a64MiB bound; idle view ranges use LRU eviction with eight cached
ranges per resource. Active draws can temporarily pin more ranges within the memory
bound. Readback uses chunks of at most1MiB. Resource final release deletes its images
and attachments; decoder programs, scratch and the zero image belong to the device.

Texture arrays and CPU depth/stencil readback are outside the GPU view subset. Staging
depth textures are already rejected by resource creation; native depth copies must
stay on the GPU. The concrete device/context still supplies drawing, transfer commands,
mip generation and raster/output state. These components do not register a device yet.

`tools/probe-d3d11-textures.mjs` checks generated texture bytes and numeric readback,
including every format/mip, independent ranges, cache pressure, pinned bindings,
unbound resources, clears, native CPU shadows, partial updates, dynamic discard,
staging-map readiness, depth/stencil upload, final ownership and context loss. It
captures no screenshots and loads no game assets. This is resource coverage, not
full draw-command or performance acceptance.

Map behavior follows [D3D11_MAP_FLAG](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_map_flag).
Storage conventions follow [DXGI formats](https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format)
and the [WebGL2 specification](https://registry.khronos.org/webgl/specs/2.0.0/).

Resource rules follow Microsoft's [Map values](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_map),
[UpdateSubresource](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-updatesubresource)
and [block compression](https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/block-compression)
documentation. No Windows graphics binaries execute in this implementation.
