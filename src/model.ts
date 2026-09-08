import * as vscode from 'vscode';
import { createReadStream, existsSync, readFile } from 'fs';
import { createInterface } from 'readline';
import './stringExtension';
import './mapExtension';
import './utils/io';
import { isAbsolute } from 'path';
import { Readable } from 'stream';
import { readHead } from './utils/io';
import { MojoParser } from './utils/mojo';
import { demangle } from './utils/demangle';
import { hashPath } from './utils/pathKey';


export class AustinSample {
    public pid: number;
    public tid: string;
    public stack: FrameObject[];
    public metrics: number[];
    public idle: boolean = false;
    public gc: boolean = false;

    public constructor(pid: number, tid: string, stack: FrameObject[], metrics: number[], idle: boolean = false, gc: boolean = false) {
        this.pid = pid;
        this.tid = tid;
        this.stack = stack;
        this.metrics = metrics;
        this.idle = idle;
        this.gc = gc;
    }

    public static parse(sample: string): AustinSample {
        let [pidTidFrames, metrics] = sample.rsplit(' ', 1);

        let frames = pidTidFrames.split(';');
        let pid = frames.shift()!;
        let tid = frames.shift()!;
        return new AustinSample(Number(pid), tid, frames.map(parseFrame), [Number(metrics)]);
    }
}

export class TopStats {
    public scope: string | null = null;
    public module: string | null = null;
    public own: number = 0;
    public total: number = 0;
    public rawOwn: number = 0;
    public rawTotal: number = 0;
    public rawCallerContributions: Map<string, number> = new Map();
    public callees: Map<string, TopStats> = new Map();
    public callers: Map<string, TopStats> = new Map();
    public callerContributions: Map<string, number> = new Map();
    public minLine: number = 0;

    public constructor(scope: string | null = null, module: string | null = null) {
        this.scope = scope;
        this.module = module;
    }

    key() {
        return `${this.module}:${this.scope}`;
    }
}

export interface TaskSummary {
    id: string;
    name: string;
    own: number;
    total: number;
    file?: string;
    line?: number;
    // Matches the flamegraph node's own frameKey (see _computeFrameKeys) for
    // cross-navigation with the flame graph view; undefined if the task
    // hasn't been attached to a flamegraph node yet.
    frameKey?: number;
    children: TaskSummary[];
}

export interface TaskThreadGroup {
    pid: number;
    tid: string;
    tasks: TaskSummary[];
    frameKey?: number;
}

export interface TaskTraceNode {
    taskId: string;
    name: string;
    startFraction: number;
    endFraction: number;
    frameKey?: number;
    // The tasks this one awaits (see AustinTask.awaiting server-side),
    // nested here the same way getTaskForest's await tree nests them --
    // but positioned by real observed time instead of a value-weighted
    // width, so this renders as an actual trace, not a value flame graph.
    children: TaskTraceNode[];
}

export interface TaskTraceGroup {
    pid: number;
    tid: string;
    // One entry per root task (nothing awaits it) owned by this thread --
    // each is the top of its own independent flame chart, since two root
    // tasks aren't nested under anything common to stack them under.
    roots: TaskTraceNode[];
}

export interface GCEvent {
    pid: number;
    tid: string;
    gc: boolean;
    metric: number;
    frameKeys: string[];  // `${module}:${scope}` for each frame in the sample
}

export interface AustinStats {
    hierarchy: FlameNode;
    locationMap: Map<string, Map<string, [FrameObject, number, number]>>;
    callStack: TopStats;
    top: Map<string, TopStats>;
    overallTotal: number;
    source: string | null;
    metadata: Map<string, string>;
    gcEvents: GCEvent[];
}

// Total length of a set of [start, end] windows, treating overlapping ones
// as covering that stretch of time only once -- e.g. several concurrent
// instances of the same task shape, all suspended over the same second,
// contribute 1 second to the union, not N. See finalizeTaskNodes.
function unionLength(intervals: [number, number][]): number {
    if (intervals.length === 0) {
        return 0;
    }
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curStart, curEnd] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const [s, e] = sorted[i];
        if (s > curEnd) {
            total += curEnd - curStart;
            curStart = s;
            curEnd = e;
        } else if (e > curEnd) {
            curEnd = e;
        }
    }
    total += curEnd - curStart;
    return total;
}

// Plain sum of a set of [start, end] windows' own lengths, double-counting
// any overlap -- correct when contributions are already known to be
// time-disjoint (CPU time: only one task can be on-CPU on a given thread
// at once) or where double-counting overlap is actually the point (memory:
// concurrent footprints are meant to add up). See finalizeTaskNodes.
function sumLength(intervals: [number, number][]): number {
    let total = 0;
    for (const [start, end] of intervals) {
        total += end - start;
    }
    return total;
}

// Key of the synthetic flamegraph node that collects orphaned tasks -- ones
// with no resolvable waiter AND no owning thread (see resolveTaskParent /
// getTaskForest). Shared by every reader/writer of that node so a typo or a
// future rename can't silently desync them.
const TASKS_ROOT_KEY = "__tasks__";

// A task owner is recorded as `${pid}:${tid}` (see setTaskOwner) -- split
// back into its parts wherever a group needs to display or navigate to the
// owning process/thread (getTaskForest, getTaskTraces). `tid` itself can
// legitimately contain further colons (see the iid:tid composite key built
// in mojo.ts's currentStackKey), so this only ever splits on the FIRST one.
function parseOwnerKey(ownerKey: string): { pid: number; tid: string } {
    const sep = ownerKey.indexOf(":");
    return { pid: Number(ownerKey.slice(0, sep)), tid: ownerKey.slice(sep + 1) };
}

export class AustinStats implements AustinStats {

    public paused: boolean = false;
    private _beforeCbs: (() => void)[];
    private _afterCbs: ((stats: AustinStats) => void)[];
    private _errorCbs: (() => void)[];
    private taskNames: Map<string, string> = new Map();
    private taskWaiters: Map<string, Set<string>> = new Map();
    private taskNodesById: Map<string, FlameNode> = new Map();
    // Thread key -> its own top-level container node (`Thread <tid>`, a
    // child of `Process <pid>`). Only ever used as the starting point for
    // _dominantLeaf's walk (see below) -- never as an attachment point
    // itself, since it competes for width with genuine top-level content
    // like <module> the moment anything else attaches there directly.
    private threadContainers: Map<string, FlameNode> = new Map();
    private taskLeaves: Map<string, FlameNode> = new Map();
    // Thread key (`${pid}:${tid}`) that last captured this task's coroutine
    // chain. See setTaskOwner/resolveTaskParent.
    private taskOwner: Map<string, string> = new Map();
    // Shape-merge state for the main flamegraph (see finalizeTaskNodes) --
    // rebuilt fresh every call, never read across refreshes. attachedTaskRoots
    // records every node WE pushed directly into some non-task-managed
    // parent's children, so it can be detached before the next rebuild;
    // shapeManagedNodes marks every node we created this pass, so a fresh
    // push is only registered in attachedTaskRoots when its parent ISN'T
    // itself one of ours (an ancestor's removal already covers it then).
    // sharedTaskEntry/sharedTaskLeaf translate a raw task id to its shape's
    // entry/current-leaf node in the shared tree, for resolveTaskParent
    // (structural, still per-instance) and for the Tasks/trace views'
    // click-to-navigate frameKey lookups.
    private attachedTaskRoots: Map<FlameNode, FlameNode> = new Map();
    private shapeManagedNodes: Set<FlameNode> = new Set();
    // How much of a node's value came from genuine regular (non-task)
    // sampling -- see updateHierarchy's own increment site. Persists across
    // refreshes (unlike the rest of this group): finalizeTaskNodes can
    // overwrite node.value on a node it shares with the regular hierarchy
    // (see the sharedTaskIntervals loop), so this is the only durable record
    // of what a shared node's OWN regular contribution actually is -- needed
    // to add the task-derived portion back on top instead of clobbering it.
    private regularOwnValue: Map<FlameNode, number> = new Map();
    private sharedTaskEntry: Map<string, FlameNode> = new Map();
    private sharedTaskLeaf: Map<string, FlameNode> = new Map();
    // Every contributing instance's raw intervals (see taskNodeIntervals)
    // for a given shared node, collected across this whole rebuild pass so
    // finalizeTaskNodes can compute its final value from all of them at
    // once (union in wall-time mode, plain sum otherwise) once merging is
    // done, rather than accumulating a running (and, for concurrent
    // instances, double-counted) total as each one is visited.
    private sharedTaskIntervals: Map<FlameNode, [number, number][]> = new Map();
    // Thread key -> the "(awaiting N tasks)" frame appended at that
    // thread's own last frame (threadLeaves), when it's genuinely driving
    // several concurrent ROOT tasks at once (see finalizeTaskNodes) --
    // resolveTaskParent checks this before falling back to the thread's
    // bare leaf, so a thread with just one (or several, but never
    // concurrent) top-level task attaches its root task(s) directly there
    // instead.
    private threadTaskShim: Map<string, FlameNode> = new Map();
    // Position on the overallTotal timeline (see updateTaskStack) at which a
    // task was first observed, and most recently observed. There's no
    // explicit "task ended" event on the wire, so the last position we ever
    // assigned dwell time to is the best available estimate of when it did.
    private taskFirstSeen: Map<string, number> = new Map();
    private taskLastSeen: Map<string, number> = new Map();
    // Per-thread clock (`${pid}:${tid}` -> cumulative own metric), advanced
    // only by that thread's own regular samples -- see update(). Unlike
    // overallTotal (shared across every thread AND every task's own dwell
    // weight, in wire order), this gives each thread its own time arrow that
    // isn't skewed by unrelated threads' or tasks' activity, matching how
    // computeGCSpans already normalizes per thread.
    private threadTotal: Map<string, number> = new Map();
    // Owning thread's own clock (see threadTotal) at the moment setTaskOwner
    // FIRST ran for a task -- i.e. Austin's own first sighting of it, which
    // can be well before its first real (non-null-elapsed) dwell flush ever
    // reaches updateTaskStack. See the elapsed===null branch there.
    private taskDiscoveredAt: Map<string, number> = new Map();

    public constructor() {
        this.locationMap = new Map();
        this.overallTotal = 0;
        this.top = new Map();
        this.hierarchy = {
            kind: 'root',
            key: "",
            name: "",
            value: 0,
            children: [],
        };
        this.callStack = new TopStats();
        this._beforeCbs = [];
        this._afterCbs = [];
        this._errorCbs = [];
        this.source = null;
        this.metadata = new Map();
        this.gcEvents = [];
    }

    clear() {
        this._frameKeysCache = null;
        this.top.clear();
        this.locationMap.clear();
        this.overallTotal = 0;
        this.hierarchy = {
            kind: 'root',
            key: "",
            name: this.source!,
            value: 0,
            children: [],
        };
        this.callStack = new TopStats();
        this.metadata = new Map();
        this.gcEvents = [];
        this.taskNames.clear();
        this.taskWaiters.clear();
        this.taskNodesById.clear();
        this.threadContainers.clear();
        this.taskLeaves.clear();
        this.taskOwner.clear();
        this.taskNodeIntervals.clear();
        this.attachedTaskRoots.clear();
        this.shapeManagedNodes.clear();
        this.sharedTaskEntry.clear();
        this.sharedTaskLeaf.clear();
        this.sharedTaskIntervals.clear();
        this.threadTaskShim.clear();
        this.regularOwnValue.clear();
        this.taskFirstSeen.clear();
        this.taskLastSeen.clear();
        this.threadTotal.clear();
        this.taskDiscoveredAt.clear();
    }

    // This task's own PRIVATE accumulation -- never attached to the live
    // hierarchy directly (see finalizeTaskNodes, which merges its content,
    // by shape, into the shared tree instead). Backs the per-instance Tasks
    // view and trace panel, and is where taskLeaves' "current position"
    // tracking lives, unaffected by shape-merging.
    private getOrCreateTaskNode(taskId: string): FlameNode {
        let taskNode = this.taskNodesById.get(taskId);
        if (!taskNode) {
            taskNode = { kind: 'task', key: taskId, name: this.taskNames.get(taskId) ?? `Task ${taskId}`, value: 0, children: [] };
            this.taskNodesById.set(taskId, taskNode);
        }
        return taskNode;
    }

    private updateTaskFrames(
        taskId: string, taskNode: FlameNode, frames: FrameObject[], value: number, interval: [number, number]
    ) {
        taskNode.value += value;
        this.recordTaskInterval(taskNode, interval);
        let owner = taskNode;
        let leaf = taskNode;
        frames.forEach((fo) => {
            const key = `${fo.module}:${fo.scope}`;
            let child = owner.children.find(e => e.key === key);
            if (!child) {
                child = { kind: 'frame', key, name: fo.scope, value: 0, children: [], file: fo.module, line: fo.line, source: this.source };
                owner.children.push(child);
            }
            child.value += value;
            this.recordTaskInterval(child, interval);
            owner = child;
            leaf = child;
        });
        this.taskLeaves.set(taskId, leaf);
    }

    // Raw [start, end] windows (in the owning thread's clock units --
    // see threadTotal) this task instance contributed at this PRIVATE
    // node, one per updateTaskStack call -- NOT yet deduplicated; kept out
    // of FlameNode itself (which gets serialized to the webview on every
    // refresh) since this is purely finalize-time bookkeeping, consumed by
    // finalizeTaskNodes' shape-merge to compute a coverage union instead of
    // a plain sum in wall-time mode (see mergeTaskChildren).
    private taskNodeIntervals: Map<FlameNode, [number, number][]> = new Map();

    private recordTaskInterval(node: FlameNode, interval: [number, number]) {
        this.taskNodeIntervals.getDefault(node, () => []).push(interval);
    }

    // Records the coroutine stack of a suspended task (from MOJO_TASK_STACK),
    // weighted by the real dwell time Austin accumulated at that frame
    // (trailing MOJO_METRIC_TIME) when the capture carries one. Older
    // captures never emit that trailing metric, so fall back to approximating
    // one observation as one sampling interval -- keeping it on the same time
    // scale as the rest of the tree instead of an arbitrary unit of 1.
    public updateTaskStack(taskId: string, frames: FrameObject[], elapsed: number | null) {
        const weight = elapsed !== null ? elapsed : (Number(this.metadata.get("interval")) || 1);

        // Position is the owning thread's OWN clock (see threadTotal), not
        // overallTotal: overallTotal also advances from every task's own
        // dwell weight below, in wire order, which has nothing to do with
        // real chronology -- stamping positions from it made concurrent
        // tasks' spans drift apart and overlap arbitrarily. A task with no
        // resolved owner yet (e.g. the very first observation, before
        // setTaskOwner runs) has no thread clock to read; it lands in the
        // synthetic orphaned trace group anyway, so overallTotal is an
        // acceptable fallback there.
        const ownerKey = this.taskOwner.get(taskId);
        const clock = ownerKey !== undefined ? (this.threadTotal.get(ownerKey) ?? 0) : this.overallTotal;

        // `weight` is the dwell duration Austin measured at the frames this
        // call reports (see the comment above), ending "now" (this flush's
        // clock reading) -- so the block it describes actually STARTED
        // `weight` units earlier, not at `clock`. This matters a lot: Austin
        // only emits a new MOJO_TASK_STACK when a task's coroutine identity
        // changes (see _py_asyncio__emit_task's fingerprint check), so a task
        // blocked at the exact same await point for a long stretch (e.g. the
        // root task sitting in gather()) gets exactly ONE flush, often only
        // at eviction -- without this back-computed start, that single huge
        // dwell would collapse to a zero-width point at the very end instead
        // of the long span it actually was.
        // Unclamped for the interval recorded below: unionLength/sumLength
        // only care about relative overlaps and (end - start) lengths, so
        // a negative start is harmless there -- but clamping it away HERE
        // would silently shrink the interval's own length below `weight`
        // whenever clock < weight (e.g. a task's very first observation,
        // before its owning thread's clock has advanced much), quietly
        // losing weight from the shared merge's value computation.
        const rawBlockStart = clock - weight;
        const isFirstObservation = !this.taskFirstSeen.has(taskId);

        // elapsed === null means Austin never got to report a REAL measured
        // dwell for this task's first-ever data point at all -- typically
        // because its identity never changed again before sampling stopped
        // (e.g. a task parked forever at the same `await`, like an event
        // loop's own driving coroutine), so this is really just the
        // end-of-stream carry flush (see mojo.ts's flushTaskStackCarry) for
        // a task discovered long ago, and `weight` (hence rawBlockStart) is
        // a meaningless one-interval placeholder, not a measurement --
        // back-computing from it collapses the task's whole (possibly very
        // long) life into a sliver right at the end. taskDiscoveredAt,
        // stamped independently the moment setTaskOwner first ran for it,
        // is a real clock reading and a far better lower bound here --
        // applied to the interval itself (not just taskFirstSeen below), so
        // the shape-merge in finalizeTaskNodes doesn't ALSO collapse this
        // task's contribution to the main flamegraph into that same sliver.
        const discoveredAt = this.taskDiscoveredAt.get(taskId);
        const intervalStart = isFirstObservation && elapsed === null && discoveredAt !== undefined
            ? Math.min(rawBlockStart, discoveredAt) : rawBlockStart;

        // The same correction has to widen the actual dwell weight too, not
        // just the interval's start: `weight` is what lands in taskNode.value
        // (and, below, overallTotal/updateLineMap) -- the Tasks view and the
        // editor gutter read taskNode.value directly, so leaving it at the
        // meaningless placeholder while only the interval gets widened would
        // make those views show a near-zero contribution for a task whose
        // merged flamegraph node (built from the widened interval) shows a
        // large span.
        const correctedWeight = intervalStart < rawBlockStart ? clock - intervalStart : weight;

        this.updateTaskFrames(taskId, this.getOrCreateTaskNode(taskId), frames, correctedWeight, [intervalStart, clock]);
        if (isFirstObservation) {
            this.taskFirstSeen.set(taskId, Math.max(0, intervalStart));
        }
        this.taskLastSeen.set(taskId, clock);

        // A task's coroutine frames are real source lines just like any
        // regular sample's -- feed them into the same per-line own/total map
        // (and the same overallTotal denominator those fractions are taken
        // against) so the editor gutter (setLinesHeat, driven by
        // locationMap) reflects time spent suspended in a task exactly like
        // it does for a thread's own stack. There's normally no overlap with
        // a thread's own regular samples: while a task sits suspended, the
        // thread's own top-of-stack is the event loop (base_events.py,
        // selectors.py, ...), never the task's own coroutine code -- the two
        // views cover disjoint source lines in the common case.
        if (correctedWeight > 0) {
            this.overallTotal += correctedWeight;
        }
        this.updateLineMap(frames, correctedWeight);
    }

    public setTaskName(taskId: string, name: string) {
        this.taskNames.set(taskId, name);
    }

    // Records the thread whose MOJO_STACK...next-MOJO_STACK window most
    // recently captured this task's coroutine chain -- a task's owning
    // thread isn't tagged on the wire, so this is recovered from wire
    // position (see mojo.ts's flushTaskStack). Used as a fallback anchor by
    // resolveTaskParent for tasks with no resolvable waiter -- e.g. a
    // top-level task like the one asyncio.run() drives, which has nothing
    // awaiting it directly.
    public setTaskOwner(taskId: string, pid: number, tid: string) {
        const key = `${pid}:${tid}`;
        this.taskOwner.set(taskId, key);
        if (!this.taskDiscoveredAt.has(taskId)) {
            this.taskDiscoveredAt.set(taskId, this.threadTotal.get(key) ?? 0);
        }
    }

    public updateTaskWaiter(taskId: string, waiterId: string) {
        if (!this.taskWaiters.has(taskId)) {
            this.taskWaiters.set(taskId, new Set());
        }
        this.taskWaiters.get(taskId)!.add(waiterId);
    }

    // Read-only lookup, for callers that must NOT create the fallback bucket
    // just by asking whether it exists (e.g. a value-recompute pass, or a
    // frameKey lookup that should stay undefined when there's nothing to
    // navigate to).
    private findFallbackTasksRoot(): FlameNode | undefined {
        return this.hierarchy.children.find(e => e.key === TASKS_ROOT_KEY);
    }

    private getFallbackTasksRoot(): FlameNode {
        let tasksRoot = this.findFallbackTasksRoot();
        if (!tasksRoot) {
            tasksRoot = { kind: 'taskRoot', key: TASKS_ROOT_KEY, name: 'Tasks', value: 0, children: [] };
            this.hierarchy.children.push(tasksRoot);
        }
        return tasksRoot;
    }

    // A task can have multiple waiters (several coroutines all doing
    // `await same_task`); the "primary" one -- the one it's actually
    // resolved/nested under everywhere -- is picked by a stable,
    // arbitrary-but-deterministic tie-break (lexicographically smallest
    // waiter task id), consistently applied across cycle detection,
    // parent resolution, shape-merge blending, and the await-edge index.
    // Returns undefined for a task with no (or no recorded) waiter.
    private getPrimaryWaiter(taskId: string): string | undefined {
        const waiters = this.taskWaiters.get(taskId);
        return waiters && waiters.size > 0 ? [...waiters].sort()[0] : undefined;
    }

    // Whether waiterTaskId (about to become taskId's resolved parent) is
    // itself, transitively, awaiting taskId -- i.e. attaching taskId there
    // would create a cycle. Purely a walk over the raw per-instance waiter
    // graph (taskWaiters), deliberately independent of which FlameNode
    // anything maps to: once multiple task instances can share one shared
    // shape-node (see finalizeTaskNodes), a node no longer has a single
    // unambiguous "owning" task, so cycle detection can't be derived from
    // FlameNode identity any more -- but the waiter graph itself is exactly
    // as unambiguous as it always was.
    private wouldCycle(taskId: string, waiterTaskId: string): boolean {
        const visited = new Set<string>();
        let current: string | undefined = waiterTaskId;
        while (current !== undefined) {
            if (current === taskId) {
                return true;
            }
            if (visited.has(current)) {
                return false;
            }
            visited.add(current);
            current = this.getPrimaryWaiter(current);
        }
        return false;
    }

    // The thread's own dominant "settled" position: starting from its
    // container node, repeatedly follows the highest-value 'frame' child
    // until none remains. This is where an asyncio event loop thread
    // genuinely, structurally ends up (e.g. EpollSelector.select) --
    // deterministic and stable across refreshes, unlike literally using
    // whichever frame the MOST RECENT sample happened to catch (which can
    // land anywhere, e.g. brief interpreter-shutdown cleanup code at the
    // very end of a capture, wildly understating the real settling point).
    private _dominantLeaf(threadKey: string): FlameNode | undefined {
        let node = this.threadContainers.get(threadKey);
        if (!node) {
            return undefined;
        }
        // A thread that never produced any real regular sample content
        // (e.g. only ever seen via a bare MOJO_STACK declaration) has
        // nothing meaningful to descend into -- same as the degenerate-
        // sample guard this replaces, don't hand back the bare container.
        let descended = false;
        for (;;) {
            let biggest: FlameNode | undefined;
            for (const child of node.children) {
                if (child.kind === 'frame' && (!biggest || child.value > biggest.value)) {
                    biggest = child;
                }
            }
            if (!biggest) {
                return descended ? node : undefined;
            }
            node = biggest;
            descended = true;
        }
    }

    private resolveTaskParent(taskId: string): FlameNode {
        const primaryWaiter = this.getPrimaryWaiter(taskId);
        if (primaryWaiter !== undefined) {
            if (!this.wouldCycle(taskId, primaryWaiter)) {
                const waiterLeaf = this.sharedTaskLeaf.get(primaryWaiter);
                if (waiterLeaf) {
                    return waiterLeaf;
                }
            }
        }
        // No waiter (typical for a top-level task like the one
        // asyncio.run() drives, which has nothing awaiting it directly) --
        // fall back to the thread's own dominant leaf (_dominantLeaf): the
        // thread stack waiting on its tasks genuinely ends there (an
        // asyncio-internal frame like EpollSelector.select), so that's the
        // real parent of the task roots. threadTaskShim, if set (see
        // finalizeTaskNodes), takes priority: several genuinely concurrent
        // root tasks on the same thread get a real "(awaiting N tasks)"
        // frame appended there first, the same way a task awaiting several
        // children does one level down (mergeAndAttachTask's own local
        // shim).
        const threadKey = this.taskOwner.get(taskId);
        if (threadKey !== undefined) {
            const threadAnchor = this.threadTaskShim.get(threadKey) ?? this._dominantLeaf(threadKey);
            if (threadAnchor) {
                return threadAnchor;
            }
        }
        return this.getFallbackTasksRoot();
    }

    // Whether any two of these tasks' observed lifetimes (taskFirstSeen /
    // taskLastSeen) genuinely overlap in time -- i.e. were really
    // concurrent, not just several sequential occurrences of "one thing
    // awaited at a time" spread out over a shared waiter's whole lifetime.
    // See mergeAndAttachTask. Checking only ADJACENT pairs once sorted by
    // start is enough: if one task's window reached far enough to overlap
    // some LATER one, it would already have to overlap everything between
    // them too (their start is >= its and <= the later one's, which sits
    // inside its still-open window) -- same reasoning as flamegraph.js's
    // own childrenOverlap for the task-trace panel.
    private anyOverlap(taskIds: string[]): boolean {
        if (taskIds.length <= 1) {
            return false;
        }
        const windows = taskIds
            .map(id => {
                const start = this.taskFirstSeen.get(id) ?? 0;
                return { start, end: Math.max(this.taskLastSeen.get(id) ?? start, start) };
            })
            .sort((a, b) => a.start - b.start);
        for (let i = 0; i < windows.length - 1; i++) {
            if (windows[i].end > windows[i + 1].start) {
                return true;
            }
        }
        return false;
    }

    // Merges privateChildren (one level of some task's own PRIVATE frame
    // chain -- see updateTaskFrames) into parent's children, by (kind, key):
    // reuses a matching existing node (adding this contribution's value
    // and recursing into ITS children) instead of creating a new one
    // whenever some OTHER task instance already put an identical frame
    // there. This is exactly updateHierarchy's own merge rule, applied to
    // task frames instead of a thread's regular ones -- which is what lets
    // two different task instances (any name, any id) that happen to run
    // the same code collapse into one shared subtree, while two genuinely
    // different call paths that happen to share a common leaf frame (e.g.
    // both eventually calling asyncio.sleep) stay separate, since they
    // diverge at whichever frame differs ABOVE that leaf and so never end
    // up searching the same parent's children.
    //
    // markAsTaskEntry applies 'task' (not 'frame') only at this call's own
    // top level, so the anchor scan in media/flamegraph.js still finds
    // exactly one entry point per shape, with deeper frames rendered as
    // ordinary nested ones. privateToShared records every node visited,
    // so the caller can translate a specific PRIVATE node it already has a
    // reference to (e.g. this task's own current leaf) into its shared
    // counterpart, without needing to re-derive "which one is that" from
    // the merge walk itself.
    private mergeTaskChildren(
        parent: FlameNode, privateChildren: FlameNode[], markAsTaskEntry: boolean,
        privateToShared: Map<FlameNode, FlameNode>
    ): void {
        for (const privateChild of privateChildren) {
            const kind = markAsTaskEntry ? 'task' : 'frame';
            let shared = parent.children.find(c => c.kind === kind && c.key === privateChild.key);
            if (!shared) {
                shared = {
                    kind, key: privateChild.key, name: privateChild.name, value: 0, children: [],
                    file: privateChild.file, line: privateChild.line, source: privateChild.source,
                };
                parent.children.push(shared);
                // Only register for detach-before-rebuild if `parent` isn't
                // itself one of ours -- removing an ancestor we registered
                // earlier already discards everything nested under it.
                if (!this.shapeManagedNodes.has(parent)) {
                    this.attachedTaskRoots.set(shared, parent);
                }
            }
            this.shapeManagedNodes.add(shared);
            // Deferred: `shared`'s own value is set once, from the UNION
            // (or plain sum -- see finalizeTaskNodes) of every contributing
            // instance's intervals, after ALL tasks have been merged --
            // not accumulated here, since two concurrent instances' raw
            // weights would otherwise double-count the wall-clock time
            // they both happened to be suspended during at once.
            const contributed = this.taskNodeIntervals.get(privateChild) ?? [];
            this.sharedTaskIntervals.getDefault(shared, () => []).push(...contributed);
            privateToShared.set(privateChild, shared);
            this.mergeTaskChildren(shared, privateChild.children, false, privateToShared);
        }
    }

    // Merges taskId's own private frame chain into the shared tree at its
    // resolved parent, then recurses into whatever tasks it's the primary
    // waiter for -- their own resolveTaskParent needs THIS task's shared
    // leaf, so it must be set first. Safe to call more than once per pass
    // (e.g. once from the root-seeded walk, again from the cycle-catching
    // sweep in finalizeTaskNodes): a task already processed this pass is
    // skipped immediately.
    //
    // concurrentGroupSize is set only for a task that was GENUINELY
    // concurrent with at least one other task sharing its own primary
    // waiter (see anyOverlap) -- not merely "one of several tasks that
    // waiter has awaited over its whole lifetime" (e.g. a loop awaiting a
    // fresh task, one at a time, many times over: every occurrence shares
    // the same waiter, but none overlap, so each individually IS the
    // single-child case below). Unset means there's no concurrency to
    // disambiguate: this task's own frames blend directly into the SAME
    // tower as plain nested frames (kind:'frame', not 'task'), like an
    // ordinary function call, instead of a separate floating one -- no
    // risk of over-inflating wall time doing that, since the parent was
    // only ever waiting on this one thing at any given moment. Set means
    // today's existing behavior (separate floating towers, since
    // genuinely overlapping windows can't be flattened into one stack
    // safely -- see mergeTaskChildren) but also inserts a "(awaiting N
    // tasks)" shim frame at the parent's own leaf first, so that plateau
    // doesn't read as the parent's own compute time: the spines for each
    // floating tower then drop from the shim instead of directly from the
    // parent's last real frame.
    private mergeAndAttachTask(
        taskId: string, childrenOf: Map<string, string[]>, concurrentGroupSize: Map<string, number>,
        visiting: Set<string>
    ) {
        if (this.sharedTaskLeaf.has(taskId) || visiting.has(taskId)) {
            return;
        }
        visiting.add(taskId);

        const privateNode = this.taskNodesById.get(taskId);
        const parent = this.resolveTaskParent(taskId);
        const privateToShared = new Map<FlameNode, FlameNode>();

        // Blending only makes sense when `parent` is actually another
        // task's own shared leaf -- not a thread/fallback anchor taskId
        // landed on because its waiter was never itself resolved (e.g. no
        // stack was ever captured for it). There's no real "parent tower"
        // to blend into in that case, so it must stay its own; matches
        // resolveTaskParent's own waiter-resolution check, re-derived here
        // since resolveTaskParent only returns the resulting node, not
        // which path produced it.
        const rawPrimaryWaiter = this.getPrimaryWaiter(taskId);
        const primaryWaiter = rawPrimaryWaiter !== undefined && !this.wouldCycle(taskId, rawPrimaryWaiter)
            ? rawPrimaryWaiter : undefined;
        const viaWaiter = primaryWaiter !== undefined && this.sharedTaskLeaf.get(primaryWaiter) === parent;
        // Blending (kind:'frame', folded into ordinary proportional layout)
        // only makes sense continuing INSIDE an already-floating tower --
        // i.e. `parent` is another task's own shared leaf, reached via a
        // real, resolved waiter edge (viaWaiter). Anything anchored directly
        // to a thread/global-fallback node (no waiter at all, or one that
        // never resolved) must stay its own floating tower (kind:'task'),
        // no matter how "alone" it looks structurally: the renderer
        // (media/flamegraph-utils.js) only ever treats a kind:'task' node as
        // an anchor positioned by true wall-clock time on top of its
        // parent -- anything else just shares width proportionally like an
        // ordinary call, which silently discards that positioning for a
        // task that's actually independently scheduled.
        const markAsTaskEntry = !viaWaiter || concurrentGroupSize.has(taskId);

        if (privateNode) {
            this.mergeTaskChildren(parent, privateNode.children, markAsTaskEntry, privateToShared);
            if (privateNode.children.length > 0) {
                this.sharedTaskEntry.set(taskId, privateToShared.get(privateNode.children[0])!);
            }
        }

        const privateLeaf = this.taskLeaves.get(taskId);
        let leaf = (privateLeaf && privateToShared.get(privateLeaf)) ?? parent;

        const awaited = childrenOf.get(taskId) ?? [];
        // Same "genuinely concurrent" test as above, now for taskId's OWN
        // children rather than taskId itself -- every member of an
        // overlapping group carries the same group size, so checking the
        // first is enough.
        if (awaited.length > 1 && concurrentGroupSize.has(awaited[0])) {
            const shimKey = `__awaiting__:${awaited.length}`;
            let shim = leaf.children.find(c => c.kind === 'frame' && c.key === shimKey);
            if (!shim) {
                shim = { kind: 'frame', key: shimKey, name: `(awaiting ${awaited.length} tasks)`, value: 0, children: [] };
                leaf.children.push(shim);
                if (!this.shapeManagedNodes.has(leaf)) {
                    this.attachedTaskRoots.set(shim, leaf);
                }
            }
            this.shapeManagedNodes.add(shim);
            // This shim's own value comes from the SAME union/sum machinery
            // as any other merged node (see the sharedTaskIntervals loop
            // below) -- keyed on taskId's OWN contributed interval, not
            // mirrored from `leaf`'s eventual total. Mirroring the full
            // parent value was wrong whenever the same shared `leaf` needs
            // more than one distinct-N shim over its lifetime (e.g. several
            // sibling instances of the same task shape each awaiting a
            // different number of children): every such shim would then
            // claim the ENTIRE parent's value for itself, so their combined
            // width could add up to several times the parent's own -- the
            // "children overrunning their parent" bug. Interval-based
            // attribution instead gives each shim only the union of the
            // specific instances that actually went through it.
            const contributed = privateNode ? this.taskNodeIntervals.get(privateNode) ?? [] : [];
            this.sharedTaskIntervals.getDefault(shim, () => []).push(...contributed);
            leaf = shim;
        }
        this.sharedTaskLeaf.set(taskId, leaf);

        for (const childId of awaited) {
            this.mergeAndAttachTask(childId, childrenOf, concurrentGroupSize, visiting);
        }

        visiting.delete(taskId);
    }

    // Rebuilds every task's presence in the main flamegraph, merged by
    // shape (see mergeTaskChildren) rather than kept as one floating tower
    // per task instance -- so N instances of the same recurring coroutine
    // (any names, any ids) collapse into one, while genuinely different
    // call shapes stay separate exactly like ordinary call frames do.
    // Rebuilt from scratch every call rather than incrementally patched,
    // since refresh() can run repeatedly (a live/streaming capture) and
    // re-deriving each shared node's value from every contributing
    // instance's own (already correct, incrementally maintained) private
    // intervals sidesteps ever having to track how much was already added
    // on some earlier pass.
    private finalizeTaskNodes() {
        for (const [child, parent] of this.attachedTaskRoots) {
            const idx = parent.children.indexOf(child);
            if (idx !== -1) {
                parent.children.splice(idx, 1);
            }
        }
        this.attachedTaskRoots.clear();
        this.shapeManagedNodes.clear();
        this.sharedTaskEntry.clear();
        this.sharedTaskLeaf.clear();
        this.sharedTaskIntervals.clear();
        this.threadTaskShim.clear();

        const { childrenOf, hasParent } = this._computeAwaitEdges();
        // How many tasks were GENUINELY concurrent with at least one other
        // task sharing the same primary waiter -- i.e. that waiter was
        // really awaiting several of them at once, not just one thing at
        // a time repeated over its lifetime (e.g. a loop that awaits a
        // fresh task, one at a time, many times over: every occurrence
        // shares the same waiter, but none of them overlap, so each is
        // still the single-child blend case). Set only for tasks in an
        // actually-concurrent group; see mergeAndAttachTask for how this
        // drives blending into the parent's own tower vs. staying
        // separate (with a "(awaiting N tasks)" shim).
        const concurrentGroupSize = new Map<string, number>();
        for (const ids of childrenOf.values()) {
            if (this.anyOverlap(ids)) {
                for (const id of ids) {
                    concurrentGroupSize.set(id, ids.length);
                }
            }
        }

        // Same idea, one level up: root tasks (no waiter at all -- not
        // merely unresolved, see mergeAndAttachTask's own viaWaiter check)
        // grouped by owning thread, mirroring childrenOf's role for
        // waiter-based grouping. A thread driving just one top-level task
        // (or several, but never at once -- e.g. one after another) attaches
        // it directly to its own dominant leaf (_dominantLeaf); several
        // GENUINELY concurrent ones get a real "(awaiting N tasks)" frame
        // appended there instead, inserted here (before any task is
        // processed) since resolveTaskParent needs to see it up front.
        const rootsByThread = new Map<string, string[]>();
        for (const taskId of this.taskNodesById.keys()) {
            if (hasParent.has(taskId)) {
                continue;
            }
            const threadKey = this.taskOwner.get(taskId);
            if (threadKey !== undefined) {
                rootsByThread.getDefault(threadKey, () => []).push(taskId);
            }
        }
        for (const [threadKey, ids] of rootsByThread) {
            if (!this.anyOverlap(ids)) {
                continue;
            }
            const threadLeaf = this._dominantLeaf(threadKey);
            if (!threadLeaf) {
                continue;
            }
            // kind:'frame', appended as a genuinely NEW child of threadLeaf
            // -- never moving/reparenting anything updateHierarchy already
            // owns there, so the two subsystems don't fight over
            // threadLeaf.children on the next regular sample. Mirrors
            // threadLeaf's own value (like the task-kind children's globalScale
            // independence doesn't apply to an ordinary 'frame' node): a
            // small task-derived value here would otherwise render as a
            // sliver next to threadLeaf's own (often much larger) value.
            const shimKey = `__awaiting__:${ids.length}`;
            let shim = threadLeaf.children.find(c => c.kind === 'frame' && c.key === shimKey);
            if (!shim) {
                shim = { kind: 'frame', key: shimKey, name: `(awaiting ${ids.length} tasks)`, value: 0, children: [] };
                threadLeaf.children.push(shim);
                if (!this.shapeManagedNodes.has(threadLeaf)) {
                    this.attachedTaskRoots.set(shim, threadLeaf);
                }
            }
            this.shapeManagedNodes.add(shim);
            shim.value = threadLeaf.value;
            this.threadTaskShim.set(threadKey, shim);
        }

        const visiting = new Set<string>();
        for (const taskId of this.taskNodesById.keys()) {
            if (!hasParent.has(taskId)) {
                this.mergeAndAttachTask(taskId, childrenOf, concurrentGroupSize, visiting);
            }
        }
        // Anything left (only possible via a genuine waiter cycle, or
        // otherwise-garbled remote data) still needs processing --
        // mergeAndAttachTask's own has()-guard makes this safe to call
        // unconditionally for whatever wasn't reached from a root above.
        for (const taskId of this.taskNodesById.keys()) {
            this.mergeAndAttachTask(taskId, childrenOf, concurrentGroupSize, visiting);
        }

        // Now that every task has contributed its intervals to whichever
        // shared node(s) it landed on, set each one's final value. In
        // wall-time mode, two concurrent instances of the same shape were
        // both genuinely suspended at once, so their windows can overlap --
        // summing them would count that overlapped stretch of real time
        // twice (or N times, for N concurrent instances), so the value is
        // the total length of their UNION instead. That reasoning doesn't
        // apply to CPU time (only one task can be on-CPU on a given thread
        // at once, so contributions are already time-disjoint by
        // construction) or memory (a snapshot of concurrent footprints is
        // supposed to add up, not deduplicate) -- both keep a plain sum.
        // mergeAndAttachTask's own "(awaiting N)" shim (for a task awaiting
        // several children at once) is included here too, via the same
        // sharedTaskIntervals contributions -- so a shim's value is the
        // union (or sum) of only the specific task instances that actually
        // went through it, not the full value of whatever real node it sits
        // under. Without that distinction, two sibling shims under the same
        // merged parent (e.g. several same-shaped tasks each observed
        // awaiting a different number of children) would each claim the
        // ENTIRE parent's value, so their combined width could add up to
        // several times the parent's own.
        // A shared node can ALSO be a genuine regular-hierarchy node -- its
        // regularOwnValue (0 for a node that only ever existed for task-
        // merging) must be preserved underneath the task-derived portion,
        // not replaced by it.
        const dedupe = this.metadata.get("mode") === "wall";
        for (const [node, intervals] of this.sharedTaskIntervals) {
            const ownValue = this.regularOwnValue.get(node) ?? 0;
            node.value = ownValue + (dedupe ? unionLength(intervals) : sumLength(intervals));
        }

        // Task nodes render as independent floating flamegraphs (see
        // media/flamegraph.js), not as width-sharing children, so the flat
        // fallback bucket's own value is just an informational sum of
        // whatever ended up there -- it never needs to affect layout.
        const fallbackRoot = this.findFallbackTasksRoot();
        if (fallbackRoot) {
            fallbackRoot.value = fallbackRoot.children.reduce((sum, c) => sum + c.value, 0);
        }
    }

    // Builds the task-await tree for the Tasks view: unlike finalizeTaskNodes
    // (which attaches each task under the exact spine frame that awaits it,
    // for the flamegraph), this attaches a task directly under the task that
    // awaits it -- a task-only tree, independent of frames, mirroring
    // AustinTask.awaiting on the server side. Own is this task's own
    // coroutine time (taskNodesById's value, which never includes an awaited
    // task's time -- those are separate nodes); total adds in every
    // (transitively) awaited task's total, so a task blocked on slow
    // children reads as slow itself, the usual self-vs-cumulative split.
    // Every node's own path-hash, computed the exact same way the flamegraph
    // webview computes it client-side (media/flamegraph.js's addPathKeys) --
    // same hashPath function, same root seed of 0, same node.key input --
    // so a task's frameKey here identifies the SAME node the flamegraph would
    // assign, letting the Tasks view and the flame graph cross-navigate via
    // a plain numeric message the way Call Stacks and the flame graph already
    // do. Computed once per refresh rather than per task, since ancestor
    // hashes are shared across every task attached under the same frame --
    // cached here (invalidated in refresh(), see _frameKeysCache) because
    // getTaskForest and getTaskTraces both call this on every refresh tick
    // for the SAME hierarchy, and a full-tree walk repeated twice per tick
    // would otherwise scale with total node count on every live refresh.
    private _frameKeysCache: Map<FlameNode, number> | null = null;

    private _computeFrameKeys(): Map<FlameNode, number> {
        if (this._frameKeysCache) {
            return this._frameKeysCache;
        }
        const keys = new Map<FlameNode, number>();
        const walk = (node: FlameNode, parentHash: number) => {
            const frameKey = hashPath(node.key, parentHash);
            keys.set(node, frameKey);
            for (const child of node.children) {
                walk(child, frameKey);
            }
        };
        for (const child of this.hierarchy.children) {
            walk(child, 0);
        }
        this._frameKeysCache = keys;
        return keys;
    }

    // Shared await-edge index used by both getTaskForest (own/total tree,
    // for navigation) and getTaskTraces (time-positioned trace) so a task's
    // parent is resolved identically in both views.
    private _computeAwaitEdges(): { childrenOf: Map<string, string[]>; hasParent: Set<string> } {
        const childrenOf = new Map<string, string[]>();
        const hasParent = new Set<string>();
        for (const taskId of this.taskWaiters.keys()) {
            const primaryWaiter = this.getPrimaryWaiter(taskId);
            if (primaryWaiter === undefined) {
                continue;
            }
            childrenOf.getDefault(primaryWaiter, () => []).push(taskId);
            hasParent.add(taskId);
        }
        return { childrenOf, hasParent };
    }

    private buildTaskSummary(
        taskId: string, childrenOf: Map<string, string[]>, visiting: Set<string>, frameKeys: Map<FlameNode, number>
    ): TaskSummary {
        const leaf = this.taskLeaves.get(taskId);
        const taskNode = this.taskNodesById.get(taskId);
        // frameKey navigates into the main flamegraph, where this task's
        // frames now live merged into a shared shape-node (see
        // finalizeTaskNodes) -- taskNode itself is never attached there.
        const entryNode = this.sharedTaskEntry.get(taskId);
        const node: TaskSummary = {
            id: taskId,
            name: this.taskNames.get(taskId) ?? `Task ${taskId}`,
            own: taskNode?.value ?? 0,
            total: taskNode?.value ?? 0,
            file: leaf?.file,
            line: leaf?.line,
            frameKey: entryNode ? frameKeys.get(entryNode) : undefined,
            children: [],
        };

        // A cycle (tasks awaiting each other in a loop) can't happen for a
        // well-formed program, but remote memory read during a concurrent
        // mutation can garble the waiter graph -- bail out of the recursion
        // rather than the whole tree.
        if (visiting.has(taskId)) {
            return node;
        }
        visiting.add(taskId);
        for (const childId of childrenOf.get(taskId) ?? []) {
            const childNode = this.buildTaskSummary(childId, childrenOf, visiting, frameKeys);
            node.children.push(childNode);
            node.total += childNode.total;
        }
        visiting.delete(taskId);

        return node;
    }

    // Root tasks (nothing awaits them -- typically the one asyncio.run()
    // drives directly) grouped by the thread whose event loop owns them, for
    // easy navigation; a task whose own stack was never captured (e.g. it
    // died before this scan, see the "Orphaned task tree" case on the C
    // side) has no recorded owner and lands in a synthetic "orphaned" group.
    public getTaskForest(): TaskThreadGroup[] {
        const frameKeys = this._computeFrameKeys();
        const { childrenOf, hasParent } = this._computeAwaitEdges();

        // A group's own frameKey is the corresponding Process/Thread node's
        // (or, for the orphaned group, the flamegraph's own "__tasks__"
        // fallback root -- see getFallbackTasksRoot) so clicking a group
        // header navigates too, exactly like a task row does.
        const groups = new Map<string, TaskThreadGroup>();
        for (const taskId of this.taskNodesById.keys()) {
            if (hasParent.has(taskId)) {
                continue;
            }
            const ownerKey = this.taskOwner.get(taskId);
            const group = groups.getDefault(ownerKey ?? "orphaned", () => {
                if (ownerKey === undefined) {
                    const fallbackNode = this.findFallbackTasksRoot();
                    return { pid: -1, tid: "orphaned", tasks: [], frameKey: fallbackNode && frameKeys.get(fallbackNode) };
                }
                const { pid, tid } = parseOwnerKey(ownerKey);
                const processNode = this.hierarchy.children.find(c => c.key === `Process ${pid}`);
                const threadNode = processNode?.children.find(c => c.key === `Thread ${tid}`);
                return { pid, tid, tasks: [], frameKey: threadNode && frameKeys.get(threadNode) };
            });
            group.tasks.push(this.buildTaskSummary(taskId, childrenOf, new Set(), frameKeys));
        }

        return [...groups.values()];
    }

    private buildTaskTraceNode(
        taskId: string, childrenOf: Map<string, string[]>, visiting: Set<string>, frameKeys: Map<FlameNode, number>,
        denom: number, bounds: { start: number; end: number } | null
    ): TaskTraceNode {
        // frameKey navigates into the main flamegraph, where this task's
        // frames now live merged into a shared shape-node (see
        // finalizeTaskNodes) -- taskNodesById's own node is never attached
        // there.
        const entryNode = this.sharedTaskEntry.get(taskId);
        let start = this.taskFirstSeen.get(taskId) ?? 0;
        let end = Math.max(this.taskLastSeen.get(taskId) ?? start, start);

        // A task can never be observed to be active outside the window of
        // whatever awaits it -- clip into the parent's own [start, end]. Two
        // sparsely-flushed tasks (see the blockStart comment in
        // updateTaskStack) can otherwise reconstruct to overlapping-but-
        // inconsistent ranges, e.g. a child's own back-computed start
        // clamped all the way to 0 while its parent's is a bit later --
        // which would render as the child's bar sticking out to the left of
        // its parent's, breaking the flame chart's basic nesting invariant
        // (a child's bar is always inside its parent's).
        if (bounds) {
            start = Math.min(Math.max(start, bounds.start), bounds.end);
            end = Math.min(Math.max(end, bounds.start), bounds.end);
        }

        const node: TaskTraceNode = {
            taskId,
            name: this.taskNames.get(taskId) ?? `Task ${taskId}`,
            startFraction: start / denom,
            endFraction: end / denom,
            frameKey: entryNode ? frameKeys.get(entryNode) : undefined,
            children: [],
        };

        // See buildTaskSummary -- same cycle guard against a garbled remote
        // waiter graph.
        if (visiting.has(taskId)) {
            return node;
        }
        visiting.add(taskId);
        for (const childId of childrenOf.get(taskId) ?? []) {
            node.children.push(this.buildTaskTraceNode(childId, childrenOf, visiting, frameKeys, denom, { start, end }));
        }
        visiting.delete(taskId);

        return node;
    }

    // A trace view of every task's observed lifetime, as a flame chart per
    // root task -- unlike getTaskForest's own/total tree, spans are
    // positioned by real observed time rather than sized by value, so a
    // child task nests directly under the span of whatever awaits it.
    // Grouped by owning thread, with positions normalized against that
    // thread's OWN clock (threadTotal) -- not the shared overallTotal,
    // which also advances from every task's own dwell weight in wire order
    // and has nothing to do with real chronology, and would make concurrent
    // tasks' spans drift apart and overlap arbitrarily. This matches
    // computeGCSpans' per-thread normalization; two different threads'
    // clusters are no longer positioned on one directly-comparable timeline.
    public getTaskTraces(): TaskTraceGroup[] {
        const frameKeys = this._computeFrameKeys();
        const { childrenOf, hasParent } = this._computeAwaitEdges();
        const groups = new Map<string, TaskTraceGroup>();

        for (const taskId of this.taskNodesById.keys()) {
            if (hasParent.has(taskId)) {
                continue;
            }
            const ownerKey = this.taskOwner.get(taskId);
            const denom = ownerKey !== undefined ? (this.threadTotal.get(ownerKey) ?? 0) : this.overallTotal;
            if (denom === 0) {
                continue;
            }
            const group = groups.getDefault(ownerKey ?? "orphaned", () => {
                if (ownerKey === undefined) {
                    return { pid: -1, tid: "orphaned", roots: [] };
                }
                return { ...parseOwnerKey(ownerKey), roots: [] };
            });

            group.roots.push(this.buildTaskTraceNode(taskId, childrenOf, new Set(), frameKeys, denom, null));
        }

        return [...groups.values()];
    }

    private updateTop(frameList: FrameObject[], metric: number) {
        if (frameList.length === 0) {
            return;
        }

        let fo: FrameObject | undefined = undefined;
        let seenFrames = new Set<string>(); // Prevent inflating times (e.g. recursive functions)
        let stats = this.top;
        let caller: TopStats | null = null;
        frameList.forEach((fo) => {
            let key = `${fo.module}:${fo.scope}`;
            if (seenFrames.has(key)) {
                return;
            }
            seenFrames.add(key);
            if (!(stats.has(key))) {
                stats.set(key, new TopStats(fo.scope, fo.module));
            }
            let topStats = stats.get(key)!;
            topStats.rawTotal += metric;
            if (fo.line > 0 && (topStats.minLine === 0 || fo.line < topStats.minLine)) { topStats.minLine = fo.line; }
            if (caller) {
                const callerKey = caller.key();
                if (!topStats.callers.has(callerKey)) {
                    topStats.callers.set(callerKey, caller);
                }
                topStats.rawCallerContributions.set(callerKey, (topStats.rawCallerContributions.get(callerKey) ?? 0) + metric);
            }
            caller = topStats;
        });

        // Set own time to the top of the stack
        fo = frameList[frameList.length - 1];
        let key = `${fo.module}:${fo.scope}`;
        stats.get(key)!.rawOwn += metric;
    }

    private updateLineMap(frames: FrameObject[], metric: number) {
        let fo: FrameObject | undefined = undefined;
        let seenFrames = new Set<string>(); // Prevent inflating times (e.g. recursive functions)
        let stats = this.locationMap;

        let key = (fo: FrameObject) => `${fo.module}:${fo.scope}:${fo.line}:${fo.lineEnd}:${fo.column}:${fo.columnEnd}`;

        frames.forEach((fo) => {
            let frameKey = key(fo);
            if (seenFrames.has(frameKey)) {
                return;
            }
            seenFrames.add(frameKey);
            if (!(stats.has(fo.module))) {
                stats.set(fo.module, new Map<string, [FrameObject, number, number]>());
            }
            let module = stats.get(fo.module);
            if (!(module?.has(frameKey))) {
                module?.set(frameKey, [fo, 0, 0]);
            }
            let own: number, total: number;
            [fo, own, total] = module?.get(frameKey)!;
            total += metric;
            module?.set(frameKey, [fo, own, total]);
        });

        // Set own time to the top of the stack
        if (frames.length > 0) {
            fo = frames[frames.length - 1];
            let frameKey = key(fo);
            let module = stats.get(fo.module);
            let own: number, total: number;
            [fo, own, total] = module?.get(frameKey)!;
            own += metric;
            module?.set(frameKey, [fo, own, total]);
        }
    }

    private updateHierarchy(pid: number, tid: string, frameList: FrameObject[], metric: number) {
        let stats = this.hierarchy;
        stats.value += metric;

        const findOrCreateNode = (owner: FlameNode, key: string, create: () => FlameNode): FlameNode => {
            for (const e of owner.children) {
                if (e.key === key) {
                    e.value += metric;
                    this.regularOwnValue.set(e, (this.regularOwnValue.get(e) ?? 0) + metric);
                    return e;
                }
            }
            const node = create();
            owner.children.push(node);
            this.regularOwnValue.set(node, node.value);
            return node;
        };

        const updateContainer = (owner: FlameNode, frame: FrameObject) => {
            const key = `${frame.module}:${frame.scope}`;
            return findOrCreateNode(owner, key, () => ({
                kind: 'frame',
                key,
                name: frame.scope,
                value: metric,
                children: [],
                file: frame.module,
                line: frame.line,
                source: this.source,
            }));
        };

        const getGroupContainer = (kind: 'process' | 'thread', name: string, owner: FlameNode) => {
            return findOrCreateNode(owner, name, () => ({ kind, key: name, name, value: metric, children: [] }));
        };

        const threadNode = getGroupContainer('thread', `Thread ${tid}`, getGroupContainer('process', `Process ${pid}`, stats));
        this.threadContainers.set(`${pid}:${tid}`, threadNode);

        let leaf = threadNode;
        frameList.forEach((fo) => {
            leaf = updateContainer(leaf, fo);
        });
    }

    private updateCallStack(pid: number, tid: string, frameList: FrameObject[], metric: number) {
        const processNode = this.callStack.callees.getDefault(pid.toString(), () => new TopStats(`Process ${pid}`, ""));
        processNode.rawTotal += metric;
        let current = processNode.callees.getDefault(tid, () => new TopStats(`Thread ${tid}`, ""));
        current.rawTotal += metric;

        frameList.forEach((fo, idx) => {
            const key = `${fo.module}:${fo.scope}`;
            const callee = current.callees.getDefault(key, () => new TopStats(fo.scope, fo.module));
            if (fo.line > 0 && (callee.minLine === 0 || fo.line < callee.minLine)) { callee.minLine = fo.line; }
            callee.rawTotal += metric;
            if (idx === frameList.length - 1) {
                callee.rawOwn += metric;
            }
            current = callee;
        });
    }

    private normalizeAll() {
        if (this.overallTotal === 0) { return; }
        const total = this.overallTotal;
        for (const s of this.top.values()) {
            s.own = s.rawOwn / total;
            s.total = s.rawTotal / total;
            for (const [k, v] of s.rawCallerContributions) {
                s.callerContributions.set(k, v / total);
            }
        }
        const queue: TopStats[] = [...this.callStack.callees.values()];
        while (queue.length > 0) {
            const node = queue.pop()!;
            node.own = node.rawOwn / total;
            node.total = node.rawTotal / total;
            for (const child of node.callees.values()) {
                queue.push(child);
            }
        }
    }

    public setMetadata(key: string, value: string) {
        this.metadata.set(key, value);
    }

    public update(pid: number, tid: string, frames: FrameObject[], metric: number, gc: boolean = false) {
        if (metric > 0) {
            this.overallTotal += metric;
            const threadKey = `${pid}:${tid}`;
            this.threadTotal.set(threadKey, (this.threadTotal.get(threadKey) ?? 0) + metric);
        }

        this.gcEvents.push({
            pid,
            tid,
            gc,
            metric,
            frameKeys: frames.map(f => `${f.module}:${f.scope}`),
        });

        this.updateLineMap(frames, metric);
        this.updateTop(frames, metric);
        this.updateHierarchy(pid, tid, frames, metric);
        this.updateCallStack(pid, tid, frames, metric);
    }

    public registerBeforeCallback(cb: () => void) {
        this._beforeCbs.push(cb);
    }


    public registerAfterCallback(cb: (stats: AustinStats) => void) {
        this._afterCbs.push(cb);
    }

    public registerOnceAfterCallback(cb: (stats: AustinStats) => void) {
        const wrapper = (stats: AustinStats) => {
            cb(stats);
            this._afterCbs = this._afterCbs.filter(c => c !== wrapper);
        };
        this._afterCbs.push(wrapper);
    }

    public registerErrorCallback(cb: () => void) {
        this._errorCbs.push(cb);
    }

    public notifyError() {
        this._errorCbs.forEach(cb => cb());
    }

    public begin(fileName: string) {
        this.source = fileName;
        this.clear();
        this._beforeCbs.forEach(cb => cb());
    }

    public refresh() {
        this._frameKeysCache = null;
        this.normalizeAll();
        this.finalizeTaskNodes();
        this._afterCbs.forEach(cb => cb(this));
    }

    private finalize() {
        this.refresh();
    }

    public readFromBuffer(buffer: Buffer, fileName: string) {
        if (buffer.length >= 3 && buffer.slice(0, 3).toString() === "MOJ") {
            this.readFromMojoStream(buffer.values(), fileName);
        } else {
            let stream = new Readable();

            stream.push(buffer.toString());
            stream.push(null);

            this.readFromStream(stream, fileName);
        }
    }

    public readFromStream(stream: Readable, fileName: string) {
        this.source = fileName;
        this.clear();

        const readInterface = createInterface({
            input: stream
        });

        this._beforeCbs.forEach(cb => cb());

        readInterface.on("line", (line) => {
            if (line.length === 0) {
                return;
            }

            if (line.startsWith("#")) {
                let [key, value] = line.substring(2).split(": ", 2);
                this.setMetadata(key, value);
                return;
            }

            let [pidTidFrames, metric] = line.rsplit(" ", 1);
            let frames = pidTidFrames.split(";");
            let pid = frames.shift()!.substring(1);
            let tid = frames.shift()!.substring(1);
            const parsedFrames = frames.map(parseFrame);
            const gc = parsedFrames.some(f => f.module === "" && f.scope === "GC");
            this.update(Number(pid), tid, parsedFrames.filter(f => !(f.module === "" && f.scope === "GC")), Number(metric), gc);
        });

        readInterface.on("close", this.finalize.bind(this));
    }

    readFromMojoStream(bytes: IterableIterator<number>, fileName: string) {
        this.source = fileName;
        this.clear();

        this._beforeCbs.forEach(cb => cb());

        try {
            new MojoParser(bytes).parseInto(this);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to parse MOJO profile: ${err instanceof Error ? err.message : err}`);
            console.error(err);
            return;
        }

        this.finalize();
    }

    public readFromMojo(fileName: string) {
        readFile(fileName, (err, data) => {
            if (err) {
                vscode.window.showErrorMessage(`Error reading file: ${err}`);
                console.error(err);
                return;
            }

            this.readFromMojoStream(data.values(), fileName);
        });
    }

    public readFromFile(file: string) {
        readHead(file, 3).then((head) => {
            if (head === "MOJ") {
                this.readFromMojo(file);
            } else {
                this.readFromStream(createReadStream(file), file);
            }
        });
    }
}


export function absolutePath(path: string) {
    if (!isAbsolute(path)) {
        if (vscode.workspace.workspaceFolders) {
            for (let folder of vscode.workspace.workspaceFolders) {
                let absolutePath = vscode.Uri.joinPath(folder.uri, path).fsPath;
                if (existsSync(absolutePath)) {
                    return absolutePath;
                }
            }
        }
    }
    return path;
}


export interface FrameObject {
    module: string;
    scope: string;
    line: number;
    lineEnd?: number;
    column?: number;
    columnEnd?: number;
};


function parseFrame(frame: string): FrameObject {
    let module: string, scope: string, line: string;
    [module, scope, line] = frame.rsplit(":", 2);

    return {
        scope: demangle(scope),
        line: Number(line),
        module: absolutePath(module),
    };
}


export type FlameNodeKind = 'root' | 'process' | 'thread' | 'frame' | 'taskRoot' | 'task';

export interface FlameNode {
    kind: FlameNodeKind;
    key: string;
    name: string;
    value: number;
    children: FlameNode[];
    // Frame-specific fields (only present when kind === 'frame'):
    file?: string;
    line?: number;
    source?: string | null;
    // Added by the webview frontend during rendering:
    pathKey?: string;
    // NOTE: deliberately no parent back-pointer here -- this object is sent
    // verbatim to the webview via postMessage, which requires
    // JSON-serializable data, and a parent pointer would make the tree
    // circular (parent -> children -> ... -> parent).
}
