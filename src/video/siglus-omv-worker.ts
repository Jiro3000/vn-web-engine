import {openWorkerSource, type WorkerSource} from '../core/worker-source.js';
import {SiglusOmv} from '../formats/siglus/omv.js';

export type OmvRequest = {source: WorkerSource} | {index: number};
export type OmvReply =
  | {width: number; height: number; duration: number; frameTime: number}
  | {pixels: Uint8ClampedArray<ArrayBuffer>; index: number}
  | {error: string};

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<OmvRequest>) => void;
  postMessage: (reply: OmvReply, transfer?: Transferable[]) => void;
};
let movie: SiglusOmv;
scope.onmessage = async ({data}) => {
  try {
    if ('source' in data) {
      const source = openWorkerSource(data.source);
      movie = new SiglusOmv(await source.read(0, source.size));
      const {width, height, frameTime, frames} = movie;
      scope.postMessage({width, height, frameTime, duration: frames * frameTime});
    } else {
      const pixels = movie.frame(data.index);
      scope.postMessage({pixels, index: data.index}, [pixels.buffer]);
    }
  } catch (error) {
    scope.postMessage({error: error instanceof Error ? error.message : String(error)});
  }
};
