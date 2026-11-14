<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import {playerEntry} from '../registry.js';
</script>

<PlayerShell entry={playerEntry('siglus')} boot={() => import('../../runtimes/siglus.js')}>
  {#snippet surface()}<div
      id="siglus-surface"
      style="position:absolute;inset:0;overflow:hidden"
    ></div>{/snippet}
  {#snippet textHelp()}Drag to select dialogue. Click or press Enter to advance.{/snippet}
  {#snippet saveFiles()}{/snippet}
</PlayerShell>
