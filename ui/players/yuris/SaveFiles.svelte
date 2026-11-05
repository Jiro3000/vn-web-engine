<script lang="ts">
  import SaveFiles from '../../player/SaveFiles.svelte';
  import {yurisSaveAdapter} from '../../runtimes/yuris-saves.js';
  let {runtime = false, heading = true}: {runtime?: boolean; heading?: boolean} = $props();
</script>

<SaveFiles adapter={$yurisSaveAdapter} {runtime} {heading} />
