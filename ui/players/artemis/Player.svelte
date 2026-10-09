<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import {playerEntry} from '../registry.js';
  import SaveFiles from './SaveFiles.svelte';
</script>

<PlayerShell entry={playerEntry('artemis')} boot={() => import('../../runtimes/artemis.js')}>
  {#snippet surface()}<div id="artemis-surface"></div>{/snippet}
  {#snippet textHelp()}
    The game draws its own text; DOM text is not available in this player.
  {/snippet}
  {#snippet saveFiles()}<SaveFiles runtime />{/snippet}
</PlayerShell>
