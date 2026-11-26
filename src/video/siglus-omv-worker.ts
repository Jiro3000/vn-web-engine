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
let queue: Promise<void> = Promise.resolve();
scope.onmessage = ({data}) => {
  queue = queue.then(async () => {
    try {
      if ('source' in data) {
        const source = openWorkerSource(data.source);
        movie = await SiglusOmv.open(source);
        const {width, height, frameTime, frames} = movie;
        scope.postMessage({width, height, frameTime, duration: frames * frameTime});
      } else {
        const pixels = await movie.readFrame(data.index);
        scope.postMessage({pixels, index: data.index}, [pixels.buffer]);
      }
    } catch (error) {
      scope.postMessage({error: error instanceof Error ? error.message : String(error)});
    }
  });
};
