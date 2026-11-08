/** Envelope posted to a pool worker. */
export interface WorkerPoolRequest<Request> {
  readonly id: number;
  readonly request: Request;
}

/** Envelope a pool worker posts back; `failed` reports an exception thrown by its handler. */
export interface WorkerPoolResponse<Response> {
  readonly id: number;
  readonly response?: Response;
  readonly failed?: true;
}

interface PoolWorker<Response> {
  readonly worker: Worker;
  readonly pending: Map<number, (response: Response | undefined) => void>;
}

/**
 * Background jobs of one caller, for example the parts of one speculative decode, in any
 * pool. They wait in the page until a worker is idle and the pool runs fewer background jobs
 * than its background limit, so they never queue ahead of a job that is needed now.
 * `promote` starts the waiting jobs at once and makes later ones ordinary jobs. Jobs of an
 * `urgent` lane start before the waiting jobs of other lanes.
 */
export class WorkerPoolLane {
  private foreground = false;
  constructor(readonly urgent = false) {}
  private readonly waiting = new Set<() => void>();

  get background(): boolean {
    return !this.foreground;
  }

  promote(): void {
    if (this.foreground) return;
    this.foreground = true;
    const jobs = [...this.waiting];
    this.waiting.clear();
    for (const start of jobs) start();
  }

  /** @internal Registers a waiting job's start; returns its removal. */
  wait(start: () => void): () => void {
    this.waiting.add(start);
    return () => this.waiting.delete(start);
  }
}

interface QueuedJob {
  readonly start: () => void;
  readonly leave: () => void;
  readonly urgent: boolean;
}

/**
 * Request/response jobs over lazily created module workers. Each job goes to the worker with
 * the fewest pending jobs; a new worker starts only while every existing one is busy and the
 * pool is below its size. `run` resolves with undefined, never rejects, when workers are
 * unavailable, the handler threw, or a worker failed. A failed worker also disables the pool,
 * so callers keep an in-thread implementation for that result. Jobs of a background lane
 * start in order on idle workers, at most `backgroundLimit` at a time.
 *
 * `create` must construct the worker from a literal module URL relative to `import.meta.url` at its call
 * site so bundlers emit the worker chunk.
 */
export class WorkerPool<Request, Response> {
  private readonly workers: PoolWorker<Response>[] = [];
  private readonly queue: QueuedJob[] = [];
  private running = 0;
  private nextId = 1;
  private failed = typeof Worker === 'undefined';

  constructor(
    private readonly create: () => Worker,
    readonly size = defaultWorkerPoolSize(),
    readonly backgroundLimit = Math.min(size, defaultWorkerPoolSize()),
  ) {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new RangeError('Worker pool size must be a positive safe integer');
    if (!Number.isSafeInteger(backgroundLimit) || backgroundLimit < 1)
      throw new RangeError('Worker pool background limit must be a positive safe integer');
  }

  /** False once workers are known to be unavailable. */
  get available(): boolean {
    return !this.failed;
  }

  /** Runs a job. A job of a background lane waits in the page until `drain` starts it. */
  run(
    request: Request,
    transfer: Transferable[] = [],
    lane?: WorkerPoolLane,
  ): Promise<Response | undefined> {
    if (!lane?.background || this.failed) return this.post(request, transfer);
    return new Promise((resolve) => {
      let started = false;
      const start = (background: boolean) => {
        if (started) return;
        started = true;
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        leave();
        if (background) this.running++;
        void this.post(request, transfer).then((response) => {
          if (background) {
            this.running--;
            this.drain();
          }
          resolve(response);
        });
      };
      const leave = lane.wait(() => start(false));
      const job: QueuedJob = {start: () => start(true), leave, urgent: lane.urgent};
      // Urgent jobs keep their own order ahead of the other waiting jobs.
      const later = lane.urgent ? this.queue.findIndex((queued) => !queued.urgent) : -1;
      if (later < 0) this.queue.push(job);
      else this.queue.splice(later, 0, job);
      this.drain();
    });
  }

  /** True when a job would start at once: a worker has nothing pending or one can start. */
  private idle(): boolean {
    return (
      this.workers.length < this.size || this.workers.some((entry) => entry.pending.size === 0)
    );
  }

  /** Starts waiting background jobs while workers are idle and below the background limit. */
  private drain(): void {
    while (this.queue.length && !this.failed && this.running < this.backgroundLimit && this.idle())
      this.queue[0]!.start();
  }

  private post(request: Request, transfer: Transferable[]): Promise<Response | undefined> {
    const target = this.failed ? undefined : this.select();
    if (target === undefined) return Promise.resolve(undefined);
    const id = this.nextId++;
    return new Promise((resolve) => {
      target.pending.set(id, resolve);
      try {
        target.worker.postMessage({id, request} satisfies WorkerPoolRequest<Request>, transfer);
      } catch {
        target.pending.delete(id);
        resolve(undefined);
      }
    });
  }

  /** Stops every worker; pending jobs resolve with undefined. */
  terminate(): void {
    this.failed = true;
    for (const entry of this.workers.splice(0)) this.stop(entry);
    // Waiting background jobs start against the failed pool, which resolves them as unavailable.
    for (const job of this.queue.slice()) job.start();
  }

  private select(): PoolWorker<Response> | undefined {
    let best: PoolWorker<Response> | undefined;
    for (const entry of this.workers)
      if (best === undefined || entry.pending.size < best.pending.size) best = entry;
    if (best !== undefined && (best.pending.size === 0 || this.workers.length >= this.size))
      return best;
    let worker: Worker;
    try {
      worker = this.create();
    } catch {
      this.failed = true;
      return best;
    }
    const entry: PoolWorker<Response> = {worker, pending: new Map()};
    worker.onmessage = ({data}: MessageEvent<WorkerPoolResponse<Response>>) => {
      const resolve = entry.pending.get(data.id);
      entry.pending.delete(data.id);
      resolve?.(data.failed ? undefined : data.response);
      this.drain();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.terminate();
    };
    worker.onmessageerror = () => this.terminate();
    this.workers.push(entry);
    return entry;
  }

  private stop(entry: PoolWorker<Response>): void {
    entry.worker.terminate();
    const jobs = [...entry.pending.values()];
    entry.pending.clear();
    for (const resolve of jobs) resolve(undefined);
  }
}

/** Leaves one hardware thread to the page, with at most two workers. */
export function defaultWorkerPoolSize(): number {
  const threads = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1;
  return Math.max(1, Math.min(2, threads - 1));
}

/**
 * Worker-side counterpart of `WorkerPool`: answers each request with the handler's result and
 * its transfer list. A thrown exception or rejected promise is reported as a failed job.
 */
export function serveWorkerPool<Request, Response>(
  handler: (
    request: Request,
  ) =>
    | {response: Response; transfer?: Transferable[]}
    | Promise<{response: Response; transfer?: Transferable[]}>,
): void {
  const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<WorkerPoolRequest<Request>>) => void) | null;
    postMessage(message: WorkerPoolResponse<Response>, transfer?: Transferable[]): void;
  };
  scope.onmessage = async ({data: {id, request}}) => {
    let result: {response: Response; transfer?: Transferable[]};
    try {
      result = await handler(request);
    } catch {
      scope.postMessage({id, failed: true});
      return;
    }
    scope.postMessage({id, response: result.response}, result.transfer ?? []);
  };
}
