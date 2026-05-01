export interface TourKeyframe {
  nodeId: string;
  zoom: number;
  narration: string;
  highlightedNodeIds: string[];
  duration: number; // ms to display this step before auto-advancing (0 = manual)
}

export interface TourCallbacks {
  onStep: (index: number, keyframe: TourKeyframe) => void;
  onPlay: () => void;
  onPause: () => void;
  onEnd: () => void;
}

export class TourEngine {
  private keyframes: TourKeyframe[];
  private cy: any; // cytoscape instance
  private currentIndex: number = -1;
  private playing: boolean = false;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: TourCallbacks;

  constructor(cy: any, keyframes: TourKeyframe[], callbacks: TourCallbacks) {
    this.cy = cy;
    this.keyframes = keyframes;
    this.callbacks = callbacks;
  }

  get length(): number {
    return this.keyframes.length;
  }

  get current(): number {
    return this.currentIndex;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  play(): void {
    if (this.currentIndex < 0) {
      this.goTo(0);
    } else if (this.currentIndex >= this.keyframes.length - 1) {
      // Already at end — restart
      this.goTo(0);
    } else {
      this.playing = true;
      this.callbacks.onPlay();
      this.scheduleNext();
    }
  }

  pause(): void {
    this.playing = false;
    this.clearTimer();
    this.callbacks.onPause();
  }

  next(): void {
    this.clearTimer();
    if (this.currentIndex < this.keyframes.length - 1) {
      this.goTo(this.currentIndex + 1);
    }
  }

  prev(): void {
    this.clearTimer();
    if (this.currentIndex > 0) {
      this.goTo(this.currentIndex - 1);
    }
  }

  reset(): void {
    this.pause();
    this.currentIndex = -1;
    this.cy.elements().removeClass('tour-dimmed tour-target tour-highlight');
    this.callbacks.onEnd();
  }

  private goTo(index: number): void {
    this.currentIndex = index;
    const kf = this.keyframes[index];

    // Camera animation
    const targetNode = this.cy.getElementById(kf.nodeId);
    if (targetNode && targetNode.length > 0) {
      this.cy.animate(
        { center: { eles: targetNode }, zoom: kf.zoom },
        { duration: 700, easing: 'ease-in-out-cubic' }
      );
    }

    // Apply dim / highlight classes
    this.cy.elements().removeClass('tour-dimmed tour-target tour-highlight');
    this.cy.elements().addClass('tour-dimmed');

    const allHighlighted = [kf.nodeId, ...kf.highlightedNodeIds];
    allHighlighted.forEach((id) => {
      const node = this.cy.getElementById(id);
      if (node && node.length > 0) {
        node.removeClass('tour-dimmed');
        node.addClass(id === kf.nodeId ? 'tour-target' : 'tour-highlight');
        // Also un-dim connected edges between highlighted nodes
        node.connectedEdges().forEach((edge: any) => {
          const src = edge.data('source');
          const tgt = edge.data('target');
          if (allHighlighted.includes(src) && allHighlighted.includes(tgt)) {
            edge.removeClass('tour-dimmed');
          }
        });
      }
    });

    this.callbacks.onStep(index, kf);

    if (this.playing) {
      if (index >= this.keyframes.length - 1) {
        // Reached last keyframe
        this.playing = false;
        this.callbacks.onPause();
        this.callbacks.onEnd();
      } else if (kf.duration > 0) {
        this.scheduleNext(kf.duration);
      }
    }
  }

  private scheduleNext(delay?: number): void {
    const kf = this.keyframes[this.currentIndex];
    const ms = delay ?? (kf?.duration ?? 0);
    if (ms > 0) {
      this.stepTimer = setTimeout(() => {
        if (this.playing) this.next();
      }, ms);
    }
  }

  private clearTimer(): void {
    if (this.stepTimer !== null) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
  }
}
