<script lang="ts">
  let {heading = true}: {runtime?: boolean; heading?: boolean} = $props();
</script>

<section>
  {#if heading}<h2>Save files</h2>{/if}
  <p>Siglus save files are unavailable in this player.</p>
</section>
