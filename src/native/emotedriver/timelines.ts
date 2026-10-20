import type {EmoteTimeline} from '../../formats/emote/metadata.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {
  EmoteTimelineSet as SharedTimelineSet,
  EmoteTimelineState as SharedTimelineState,
  type EmoteTimelineHost,
} from './runtime/player/timelines.js';

export {normalizeTimelineLabel, type EmoteTimelineHost} from './runtime/player/timelines.js';
export const TIMELINE_PARALLEL = 1;
export const TIMELINE_DIFFERENCE = 2;

/** Compatibility names for the shared exact-build timeline state machine. */
export class EmoteTimelineState extends SharedTimelineState {
  constructor(definition: EmoteTimeline | null) {
    super(definition, EMOTEDRIVER_X64_SHA256);
  }
}
export class EmoteTimelineSet extends SharedTimelineSet {
  constructor(host: EmoteTimelineHost, instant: ReadonlySet<string>) {
    super(host, instant, EMOTEDRIVER_X64_SHA256);
  }
}
