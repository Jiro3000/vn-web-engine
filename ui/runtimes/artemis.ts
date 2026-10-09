import {BlobSource, type ByteSource} from '../../src/core/source.js';
import {IndexedDbStore} from '../../src/platform/store.js';
import type {CachedInstallation, InstallationFile} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {BrowserPageFullscreenHost} from '../../src/platform/browser-page-fullscreen.js';
import {pfsPathKey} from '../../src/formats/artemis/pfs.js';
import {ArtemisFiles} from '../../src/engines/artemis/files.js';
import {artemisRevision} from '../../src/engines/artemis/revision.js';
import {ArtemisBrowserPlayer} from '../../src/engines/artemis/browser/player.js';
import type {ArtemisRuntimeStorage} from '../../src/engines/artemis/runtime.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState, subscribeSaveBusy} from '../player/runtime-state.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {activeArtemisGame, artemisSaveNamespace} from '../player/artemis-library.js';

/** The Windows version this page reports to games (Windows 10, 10.0). Games that check the
 * version see a supported system instead of the unknown one a browser would report. */
const REPORTED_WINDOWS_VERSION = {major: 10, minor: 0};

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const status = element('status'),
  sidebar = element('sidebar'),
  surface = element('artemis-surface'),
  play = element<HTMLButtonElement>('play');
const {collapseOptions: collapse} = mountGameViewer('artemis');
let fullscreenControls: ReturnType<typeof mountFullscreenControls> | undefined;
const displayHost = new BrowserPageFullscreenHost(
  element('display'),
  () => fullscreenControls?.refresh(),
  report,
);
fullscreenControls = mountFullscreenControls(displayHost);

interface Installation {
  executableSha256: string;
  files: ArtemisFiles;
  paths: ReadonlySet<string>;
  saves: IndexedDbStore;
}
let installation: Installation | null = null,
  player: ArtemisBrowserPlayer | null = null,
  selectedInstallation: CachedInstallation | null = null,
  busy = false,
  started = false,
  saveBusy = false;

function report(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function updateControls(): void {
  setRuntimeState({running: started, busy});
  play.disabled = busy || started || saveBusy || !installation;
  installationControls.refresh();
}
function closeInstallation(): void {
  player?.dispose();
  player = null;
  installation?.saves.close();
  installation = null;
  activeArtemisGame.set(null);
}

async function sha256(source: ByteSource): Promise<string> {
  const bytes = await source.read(0, source.size);
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Identifies the engine revision by the hash of a root executable. */
async function identify(files: ReadonlyMap<string, ByteSource>): Promise<string> {
  const hashes: string[] = [];
  for (const [path, source] of files) {
    if (path.includes('/') || !/\.exe$/i.test(path)) continue;
    const hash = await sha256(source);
    try {
      artemisRevision(hash);
      return hash;
    } catch {
      hashes.push(hash);
    }
  }
  if (hashes.length) throw new Error('This Artemis executable revision is not supported yet.');
  throw new Error('Choose the game folder, including the game executable (.exe).');
}

function storage(store: IndexedDbStore): ArtemisRuntimeStorage {
  return {
    read: async (name) => (await store.snapshot()).get(name) ?? null,
    write: (name, bytes) => store.update((records) => void records.set(name, bytes.slice())),
  };
}

async function loadInstallation(cached: CachedInstallation): Promise<void> {
  closeInstallation();
  selectedInstallation = null;
  const byPath = new Map<string, ByteSource>();
  for (const entry of cached.files) byPath.set(pfsPathKey(entry.path), entry.source);
  const bases = [...byPath.keys()].filter((path) => !path.includes('/') && /\.pfs$/.test(path));
  if (bases.length !== 1)
    throw new Error('Choose the game folder, including its base .pfs archive.');
  const executableSha256 = await identify(byPath);
  const files = await ArtemisFiles.mount(bases[0]!, (segments) => byPath.get(segments.join('/')));
  const paths = new Set(byPath.keys());
  for (const {archive} of files.archives)
    for (const entry of archive.entries) paths.add(pfsPathKey(entry.name));
  const namespace = artemisSaveNamespace(executableSha256, bases[0]!);
  const saves = await IndexedDbStore.open(namespace);
  installation = {executableSha256, files, paths, saves};
  const title = 'Artemis';
  activeArtemisGame.set({title, namespace});
  element('prompt').textContent = 'The game is ready.';
  status.textContent = `${byPath.size} files found. Ready to play.`;
  play.hidden = false;
  selectedInstallation = cached;
  collapse(true);
}

async function selectInstallation(selection: InstallationSelection): Promise<void> {
  const files: InstallationFile[] = selection.files.map(({path, file}) => ({
    path,
    source: new BlobSource(file),
    lastModifiedMs: file.lastModified,
  }));
  await loadInstallation({
    directories: selection.directories,
    files,
    metadata: {},
    attachments: {},
  });
}

const installationControls = mountInstallationControls({
  player: 'artemis',
  choose: element<HTMLButtonElement>('choose'),
  input: element<HTMLInputElement>('files'),
  current: () => selectedInstallation,
  canonicalPath: pfsPathKey,
  busy: () => busy || started || saveBusy,
  setBusy: (value) => {
    busy = value;
    updateControls();
  },
  report,
  select: selectInstallation,
  load: loadInstallation,
  clear: () => {
    closeInstallation();
    selectedInstallation = null;
  },
});

function stopped(error: unknown): void {
  started = false;
  player?.dispose();
  player = null;
  surface.replaceChildren();
  element('welcome').hidden = false;
  const message = `The game stopped: ${error instanceof Error ? error.message : error}`;
  element('prompt').textContent = message;
  report(message);
  console.error(error);
  updateControls();
}

play.onclick = () => {
  if (!installation || busy || saveBusy || started) return;
  const {executableSha256, files, paths, saves} = installation;
  started = true;
  player = new ArtemisBrowserPlayer({
    document,
    executableSha256,
    files,
    paths,
    storage: storage(saves),
    windowsVersion: REPORTED_WINDOWS_VERSION,
    display: displayHost,
    diagnostic: (message) => console.warn(`[Artemis] ${message}`),
    exit: stopped,
  });
  element('welcome').hidden = true;
  surface.replaceChildren(player.panel);
  sidebar.hidden = false;
  collapse(true);
  status.textContent = 'The game is running.';
  updateControls();
  player.start();
};
subscribeSaveBusy((value) => {
  saveBusy = value;
  updateControls();
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    closeInstallation();
    displayHost.dispose();
    fullscreenControls?.destroy();
  }
});
