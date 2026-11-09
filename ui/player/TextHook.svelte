<script lang="ts">
  import {onMount} from 'svelte';
  import {
    getTextHookMode,
    normalizeTextHookMode,
    setTextHookMode,
    type TextHookMode,
  } from '../../src/text/text-hook.js';

  const storageKey = 'vn-web-engine.text-hook';
  let mode: TextHookMode = getTextHookMode();

  function update(value: string): void {
    setTextHookMode(normalizeTextHookMode(value));
    mode = getTextHookMode();
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      /* Keep the live mode even when it cannot be remembered. */
    }
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) setTextHookMode(normalizeTextHookMode(saved));
    } catch {
      /* The hook stays off when browser storage is unavailable. */
    }
    mode = getTextHookMode();
  });
</script>

<section>
  <h2>Text hook</h2>
  <label for="text-hook-mode">Copy dialogue to the clipboard</label>
  <select
    id="text-hook-mode"
    value={mode}
    aria-describedby="text-hook-help"
    onchange={(event) => update(event.currentTarget.value)}
  >
    <option value="off">Off</option>
    <option value="all">Every line</option>
    <option value="unvoiced">Lines without voice</option>
  </select>
  <p id="text-hook-help">
    Each new line is copied while this page has focus, for text-to-speech readers, dictionaries and
    translators that watch the clipboard. “Lines without voice” copies narration and the lines of an
    unvoiced protagonist. A voiced line sends an invisible stop signal to Japanese Reader.
  </p>
</section>
