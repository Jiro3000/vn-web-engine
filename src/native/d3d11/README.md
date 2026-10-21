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
