# Lua 5.1 embedding

`runtime.ts` embeds upstream Lua 5.1.5 in an isolated WebAssembly module per VM.
Strings remain `Uint8Array`; decode known UTF-8 text with `luaText`. Maps copy
values at the host boundary. `LuaReference` retains live tables/functions in the
Lua registry; owners release retained handles. Callback arguments from
`bindReferences` are temporary and must be retained to outlive the callback.

Base/coroutine, table, string and math libraries are available. Filesystem and
process services, package loading, debug and Pluto are not exposed. Include and
other platform effects use explicit host bindings. The execute/compile entry APIs
reject precompiled bytecode; this embedding does not reproduce the Windows x64
native bytecode ABI. It is not a full native Lua library replacement.

Host calls preserve coroutine state and reentrant execution. Protected Lua/host
errors restore the VM stack. A per-call instruction budget is shared across nested
calls; exhaustion throws across the wasm import, preventing Lua pcall from
swallowing it, and invalidates that VM. Host table conversion is bounded to
100,000 visited values per conversion and nesting depth 64. Memory growth is bounded to 64 MiB. These
limits do not bound every C library operation or claim a security sandbox.

## Rebuilding

`wasm/lua51/vendor` contains unmodified C/header sources and COPYRIGHT from
[Lua 5.1.5](https://www.lua.org/ftp/lua-5.1.5.tar.gz), under its MIT license.
Upstream archive SHA-256:
`2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333`.
The standalone lua/luac executables and print.c are omitted. The build also excludes
io, os, package, debug and the upstream library initialization implementation.
Custom embedding code is in `wasm/lua51/bridge.c`.

With Emscripten on PATH:

```sh
npm run build:lua51
npm run build:runtime
node --test tests/lua51-runtime.test.mjs
```

`EMCC` can select a compiler and `EM_CONFIG` its configuration. The checked-in
`wasm-binary.ts` was built with Emscripten 6.0.11 and wasm exception handling for
Lua longjmp. Normal runtime/web builds use the checked-in module and do not require
Emscripten. The standalone wasm host exposes no file descriptors or process exit
service. Missing host capabilities fail explicitly.
