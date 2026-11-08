<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import {playerEntry} from '../registry.js';
  import SaveFiles from './SaveFiles.svelte';
  import TextHook from '../../player/TextHook.svelte';
</script>

<PlayerShell entry={playerEntry('yuris')} boot={() => import('../../runtimes/yuris.js')}>
  {#snippet surface()}<div
      id="yuris-surface"
      style="position:absolute;inset:0;overflow:hidden"
    ></div>{/snippet}
  {#snippet textHelp()}DOM text makes supported game text selectable. Click outside the text or
    press Enter to continue.{/snippet}
  {#snippet saveFiles()}<SaveFiles runtime />{/snippet}
  {#snippet options()}<TextHook />{/snippet}
</PlayerShell>
