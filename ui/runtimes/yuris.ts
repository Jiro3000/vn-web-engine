import {BlobSource, type ByteSource} from '../../src/core/source.js';
import {YpfArchive, YpfFileSystem} from '../../src/formats/yuris/ypf.js';
import {loadYurisProject, type YurisProject} from '../../src/formats/yuris/ybn.js';
import {YurisBrowserPlayer} from '../../src/engines/yuris/browser/player.js';
import {LegacyFolder} from '../../src/platform/legacy-folder.js';
import {IndexedDbStore, type RecordStore} from '../../src/platform/store.js';
import {decodeCp932, encodeCp932} from '../../src/text/cp932.js';
import type {CachedInstallation} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState} from '../player/runtime-state.js';
import {rememberLastPlayed} from '../player/last-played.js';
import {setYurisSaveStore} from './yuris-saves.js';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = el('status'),
  play = el<HTMLButtonElement>('play'),
  surface = el('yuris-surface');
const {collapseOptions} = mountGameViewer('yuris');
let busy = false,
  started = false,
  cached: CachedInstallation | null = null;
let installation: {
  project: YurisProject;
  files: YpfFileSystem;
  folder: LegacyFolder;
  store: RecordStore;
} | null = null;
export let currentPlayer: YurisBrowserPlayer | null = null;
function report(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function refresh(): void {
  setRuntimeState({running: started, busy});
  play.disabled = busy || started || !installation;
  controls.refresh();
}
async function load(selected: CachedInstallation): Promise<void> {
  await currentPlayer?.dispose();
  currentPlayer = null;
  installation?.store.close();
  installation = null;
  const sources = new Map<string, ByteSource>();
  for (const file of selected.files)
    sources.set(file.path.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase(), file.source);
  const archives = [];
  for (const [path, source] of [...sources]
    .filter(([p]) => /^pac\/[^/]+\.ypf$/.test(p))
    .sort(([a], [b]) => a.localeCompare(b))) {
    if (await YpfArchive.isArchive(source))
      archives.push({name: path, archive: await YpfArchive.open(source)});
  }
  for (const [path, source] of [...sources]
    .filter(([p]) => /^update[1-9]\.ypf$/.test(p))
    .sort(([a], [b]) => a.localeCompare(b))) {
    if (await YpfArchive.isArchive(source))
      archives.push({name: path, archive: await YpfArchive.open(source)});
  }
  if (!archives.length) throw new Error('Choose a YU-RIS game folder, including pac/.');
  const files = new YpfFileSystem(archives),
    project = await loadYurisProject((p) => files.read(p));
  // Archive-index identity namespaces browser saves without selecting game behavior.
  const index = archives
    .map(
      (a) => a.name + ':' + a.archive.entries.map((e) => e.nameHash + ':' + e.dataHash).join(','),
    )
    .join(';');
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(index)),
  );
  const key = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  const store = await IndexedDbStore.open(['yuris', key]);
  const folder = new LegacyFolder(
    sources,
    store,
    (s) => decodeCp932(Uint8Array.from(s, (c) => c.charCodeAt(0))),
    (s) => String.fromCharCode(...encodeCp932(s)),
  );
  await folder.initialize();
  installation = {project, files, folder, store};
  cached = selected;
  setYurisSaveStore(store);
  play.hidden = false;
  report(`${files.size} resources ready.`);
  el('prompt').textContent = 'Ready to play.';
  rememberLastPlayed('yuris', 'YU-RIS');
  collapseOptions(true);
}
async function select(selection: InstallationSelection): Promise<void> {
  await load({
    directories: selection.directories,
    files: selection.files.map(({path, file}) => ({
      path,
      source: new BlobSource(file),
      lastModifiedMs: file.lastModified,
    })),
    metadata: {},
    attachments: {},
  });
}
const controls = mountInstallationControls({
  player: 'yuris',
  choose: el('choose'),
  input: el('files'),
  current: () => cached,
  busy: () => busy || started,
  setBusy: (v) => {
    busy = v;
    refresh();
  },
  report,
  select,
  load,
  clear: () => {
    cached = null;
    installation = null;
    setYurisSaveStore(null);
  },
});
function stopped(error?: unknown): void {
  started = false;
  report(error ?? 'The game closed.');
  if (error) console.error(error);
  refresh();
}
play.onclick = () => {
  if (!installation || busy || started) return;
  started = true;
  el('welcome').hidden = true;
  currentPlayer = new YurisBrowserPlayer(surface, installation.files, installation.folder, stopped);
  refresh();
  void currentPlayer.start(installation.project).catch(stopped);
};
window.addEventListener('pagehide', () => {
  void currentPlayer?.dispose();
  installation?.store.close();
});
refresh();
