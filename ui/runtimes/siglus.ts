import {BlobSource} from '../../src/core/source.js';
import type {CachedInstallation} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {isInstallationMetadata} from '../../src/platform/installation-path.js';
import {siglusDirectory} from '../../src/engines/siglus/installation-markers.js';
import {openSiglusGame, SiglusPlayer, type SiglusGame} from '../../src/engines/siglus/player.js';
import type {SiglusTag} from '../../src/engines/siglus/vm.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {rememberLastPlayed} from '../player/last-played.js';
import {setRuntimeState} from '../player/runtime-state.js';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const play = el<HTMLButtonElement>('play');
const surface = el('siglus-surface');
const textMode = el<HTMLSelectElement>('text-mode');
const fullscreen = el<HTMLButtonElement>('fullscreen');
let fullscreenControls: ReturnType<typeof mountFullscreenControls> | undefined;
const viewer = mountGameViewer('siglus');
const traceEnabled = new URLSearchParams(location.search).has('siglus-trace');
let cached: CachedInstallation | null = null;
let game: SiglusGame | null = null;
export let currentPlayer: SiglusPlayer | null = null;
let player: SiglusPlayer | undefined;
let busy = false;

function report(message: string): void {
  el('status').textContent = message;
}

function refresh(): void {
  setRuntimeState({busy, running: Boolean(player)});
  play.disabled = busy || !game || Boolean(player);
  controls.refresh();
}

async function load(selected: CachedInstallation): Promise<void> {
  const dir = siglusDirectory(selected.files);
  if (dir === undefined)
    throw new Error('Choose the folder containing the SiglusEngine installation.');
  const parent = dir.replace(/[^/]+\/$/, '');
  const files = new Map(
    selected.files.flatMap(({path, source}) => {
      const key = path.replaceAll('\\', '/').toLowerCase();
      return key.startsWith(dir) && !isInstallationMetadata(key)
        ? [[key.slice(dir.length), source] as const]
        : [];
    }),
  );
  if (!files.has('siglusengine.exe') && parent !== dir) {
    const exe = selected.files.find(
      ({path}) => path.replaceAll('\\', '/').toLowerCase() === parent + 'siglusengine.exe',
    );
    if (exe) files.set('siglusengine.exe', exe.source);
  }
  let appendDir = '';
  if (parent !== dir) {
    if (!files.has('select.ini')) {
      const ini = selected.files.find(
        ({path}) => path.replaceAll('\\', '/').toLowerCase() === parent + 'select.ini',
      );
      if (ini) files.set('select.ini', ini.source);
    }
    const sample = selected.files.find(({path}) => {
      const normalized = path.replaceAll('\\', '/').toLowerCase();
      return normalized.startsWith(dir) && !isInstallationMetadata(normalized);
    });
    const rel = sample ? sample.path.replaceAll('\\', '/').slice(parent.length) : '';
    appendDir = rel.split('/')[0] ?? dir.slice(parent.length).replace(/\/$/, '');
  }
  const next = await openSiglusGame(files, appendDir ? {appendDir} : undefined);
  cached = selected;
  game = next;
  el('game-title').textContent = next.title;
  el('prompt').textContent = 'Ready to play.';
}

function select(selection: InstallationSelection): Promise<void> {
  return load({
    files: selection.files.map(({path, file}) => ({
      path,
      source: new BlobSource(file),
      lastModifiedMs: file.lastModified,
    })),
    directories: selection.directories,
    metadata: {},
    attachments: {},
  });
}

const controls = mountInstallationControls({
  player: 'siglus',
  choose: el('choose'),
  input: el('files'),
  current: () => cached,
  busy: () => busy || Boolean(player),
  setBusy(value) {
    busy = value;
    refresh();
  },
  report,
  select,
  load,
  clear() {
    cached = null;
    game = null;
    el('game-title').textContent = 'SiglusEngine';
    el('prompt').textContent = 'Choose your game folder or open game files saved in this browser.';
  },
});

textMode.onchange = () => player?.setTextMode(textMode.value === 'dom' ? 'dom' : 'native');
fullscreen.disabled = true;

function emit(tag: SiglusTag): void {
  surface.dispatchEvent(new CustomEvent('siglus-tag', {detail: tag}));
}

play.onclick = () => {
  if (!game || player || busy) return;
  const active = new SiglusPlayer(
    surface,
    game,
    {
      root: el('display'),
      changed: () => fullscreenControls?.refresh(),
      report,
    },
    traceEnabled ? emit : undefined,
  );
  active.setTextMode(textMode.value === 'dom' ? 'dom' : 'native');
  fullscreenControls = mountFullscreenControls(active.windowDisplay);
  fullscreen.disabled = false;
  player = active;
  currentPlayer = active;
  el('welcome').hidden = true;
  el('fatal-error').hidden = true;
  viewer.collapseOptions(true);
  rememberLastPlayed('siglus', game.title);
  report('Playing ' + game.title);
  refresh();
  void (async () => {
    try {
      await active.start();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error(error);
        const fatal = el('fatal-error');
        fatal.textContent = error instanceof Error ? error.message : String(error);
        fatal.hidden = false;
        report(fatal.textContent);
      }
    } finally {
      await active.dispose();
      if (player === active) {
        player = undefined;
        currentPlayer = null;
        fullscreenControls?.destroy();
        fullscreenControls = undefined;
        fullscreen.disabled = true;
        el('welcome').hidden = false;
        refresh();
      }
    }
  })();
};
window.addEventListener('pagehide', () => void player?.dispose());
refresh();
