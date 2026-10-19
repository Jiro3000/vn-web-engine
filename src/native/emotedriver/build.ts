/** Exact driver images whose arithmetic is reproduced by this runtime. */
export const EMOTEDRIVER_X86_SHA256 =
  'a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86';
export const EMOTEDRIVER_X64_SHA256 =
  '80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051';
export type EmoteBuild = typeof EMOTEDRIVER_X86_SHA256 | typeof EMOTEDRIVER_X64_SHA256;

/** Normalize a known image identity; SDK strings and pointer width select no behavior. */
export function emoteBuild(sha256: string = EMOTEDRIVER_X86_SHA256): EmoteBuild {
  const build = sha256.toLowerCase();
  if (build !== EMOTEDRIVER_X86_SHA256 && build !== EMOTEDRIVER_X64_SHA256)
    throw Error(`emotedriver: unsupported DLL build ${sha256}`);
  return build;
}
