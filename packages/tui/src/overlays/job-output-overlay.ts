import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { OverlayPanel, PanelRows } from "../chrome/overlay-box";
import { ScrollView } from "../components/scroll-view";
import { matchesKey } from "../keys";
import { replaceTabs } from "../render/render-utils";
import { theme } from "../theme/theme";
import type { TUI } from "../tui";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";
import { DEFAULT_MAX_BYTES, truncateTailBytes } from "../tools/streaming-output";

export interface JobOutputSnapshot {
	id: string;
	label: string;
	status: string;
	startTime: number;
	endTime?: number;
	output?: string;
	lastOutputAt?: number;
}

export type JobOutputObservation =
	| { state: "available"; job?: JobOutputSnapshot }
	| { state: "session-changed" | "unavailable" };

export interface JobOutputOverlayOptions {
	tui: TUI;
	job: JobOutputSnapshot;
	observe: () => JobOutputObservation;
	onClose: () => void;
}

/** Read-only tail of one session-owned bash job; closing never interrupts it. */
export class JobOutputOverlay extends OverlayPanel {
	readonly #options: JobOutputOverlayOptions;
	readonly #header = new PanelRows();
	readonly #footer = new PanelRows();
	readonly #scroll = new ScrollView([], { height: 1, followTail: true });
	#job: JobOutputSnapshot;
	#notice = "";
	#following = true;
	#rawOutput: string | undefined;
	#cleanOutput = "";
	#width = -1;
	#linesDirty = true;
	#disposed = false;
	#timer: NodeJS.Timeout | undefined;

	constructor(options: JobOutputOverlayOptions) {
		super(`Job ${sanitizeText(options.job.id)}`);
		this.#options = options;
		this.#job = options.job;
		this.addChild(this.#header);
		this.addChild(this.#scroll);
		this.addChild(this.#footer);
		this.#updateOutput();
		this.#timer = setInterval(() => this.#refresh(), 500);
		this.#timer.unref();
	}

	#refresh(): void {
		if (this.#disposed) return;
		if (!this.#options.tui.overlayStack.some(entry => entry.component === this)) {
			this.dispose();
			return;
		}
		const observation = this.#options.observe();
		if (observation.state !== "available") {
			this.#notice =
				observation.state === "session-changed"
					? "Viewed session changed — retained output, no longer following."
					: "Jobs unavailable — retained output, completion unknown.";
			this.#stopTimer();
		} else if (observation.job) {
			if (this.#job.status !== observation.job.status && !this.#cleanOutput) this.#linesDirty = true;
			this.#job = observation.job;
			this.#updateOutput();
		} else {
			this.#notice =
				this.#job.status === "running"
					? "Job no longer available — retained output, completion unknown."
					: "Job result consumed — retained final output.";
			this.#stopTimer();
		}
		this.#options.tui.requestRender();
	}

	#updateOutput(): void {
		if (this.#rawOutput === this.#job.output) return;
		this.#rawOutput = this.#job.output;
		// Bound both retained text and wrapping work, independently of the source's cap.
		this.#cleanOutput = replaceTabs(sanitizeText(truncateTailBytes(this.#rawOutput ?? "", DEFAULT_MAX_BYTES).text));
		this.#linesDirty = true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.dispose();
			this.#options.onClose();
			return;
		}
		if (matchesKey(data, "end")) {
			this.#following = true;
			this.#scroll.setFollowTail(true);
			this.#scroll.setScrollOffset(this.#scroll.getMaxScrollOffset());
		} else if (this.#scroll.handleScrollKey(data)) {
			this.#following = false;
			this.#scroll.setFollowTail(false);
		} else {
			return;
		}
		this.#options.tui.requestRender();
	}

	override render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const now = Date.now();
		const elapsed = formatDuration(Math.max(0, (this.#job.endTime ?? now) - this.#job.startTime));
		const quiet =
			this.#job.lastOutputAt === undefined
				? "no output yet"
				: `last output ${formatDuration(Math.max(0, now - this.#job.lastOutputAt))} ago`;
		this.#header.setLines([
			truncateToWidth(`${sanitizeText(this.#job.status)} · elapsed ${elapsed} · ${quiet}`, innerWidth),
			truncateToWidth(replaceTabs(sanitizeText(this.#job.label)).replace(/\n/g, " "), innerWidth),
		]);
		this.#footer.setLines([
			truncateToWidth(
				theme.fg(
					"muted",
					this.#notice ||
						`${this.#following ? "Following newest" : "Follow paused"} · ↑/↓ PgUp/PgDn scroll · End follow · Esc close (job keeps running)`,
				),
				innerWidth,
			),
		]);
		this.#scroll.setHeight(Math.max(1, this.#options.tui.terminal.rows - 5));
		if (this.#linesDirty || this.#width !== innerWidth) {
			this.#width = innerWidth;
			this.#linesDirty = false;
			const empty = this.#job.status === "running" ? "Waiting for output…" : "No output captured.";
			this.#scroll.setLines(wrapTextWithAnsi(this.#cleanOutput || empty, Math.max(1, innerWidth - 1)));
		}
		if (this.#following) this.#scroll.setScrollOffset(this.#scroll.getMaxScrollOffset());
		return super.render(width);
	}

	#stopTimer(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopTimer();
		super.dispose();
	}
}
