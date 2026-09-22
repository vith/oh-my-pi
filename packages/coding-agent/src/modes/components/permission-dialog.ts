/**
 * Permission approval dialog (spec §5): title, context lines (decision
 * context, per-piece status list), numbered options with optional YAML-preview
 * descriptions, j/k/enter/esc navigation. Returns the chosen option index or
 * undefined on cancel.
 *
 * The options list is mutable (`addOption`): the LLM-suggestion flow (Task 11,
 * spec §5.3) appends suggested rules behind a spinner after the dialog is
 * already shown. Suggestions that resolve after the user chose are dropped.
 */
import { Container, Loader, Markdown, matchesKey, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import type { PermissionDialogLine, PermissionDialogOption } from "../../extensibility/extensions";
import { resolveLazy } from "../../tools/permissions/prompt";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { DynamicBorder } from "@oh-my-pi/pi-tui/chrome/dynamic-border";

const DEFAULT_HELP_TEXT = "j/k navigate  enter select  esc cancel — no rule written";
const SUGGESTING_LABEL = "Suggesting rules…";

/**
 * Truncate the segments' plain text to `available` columns, cutting per
 * segment so each keeps its own style; the visible text ends with `…` when
 * anything was cut. Segments carry plain text (no ANSI), so lengths are safe.
 */
function truncateSegments(
	segments: ReadonlyArray<{ text: string; dim?: boolean }>,
	available: number,
): Array<{ text: string; dim?: boolean }> {
	const result: Array<{ text: string; dim?: boolean }> = [];
	let remaining = available;
	for (const segment of segments) {
		if (remaining <= 0) break;
		if (segment.text.length > remaining) {
			result.push({ text: `${segment.text.slice(0, Math.max(0, remaining - 1))}…`, dim: segment.dim });
			remaining = 0;
			break;
		}
		result.push(segment);
		remaining -= segment.text.length;
	}
	return result;
}

export class PermissionDialogComponent extends Container {
	#options: PermissionDialogOption[];
	/** The caller's option array, kept for checklist state write-back (Task 6 reads it). */
	#sourceOptions: readonly PermissionDialogOption[];
	#lines: PermissionDialogLine[];
	#lineContainer: Container;
	#previewText: Text | undefined;
	#previewFor: ((checked: boolean[]) => string) | undefined;
	#onEdit: ((index: number) => void) | undefined;
	#checklist: boolean;
	#checked: boolean[];
	/** -1 = no selection: no highlight, Enter no-op until j/k/arrows move first (spec §5.1). */
	#selectedIndex: number;
	#expanded = false;
	#onSelect: (index: number) => void;
	#onCancel: () => void;
	#maxVisible: number;
	#listContainer: Container;
	#lastRenderWidth: number | undefined;
	/** Set once the user chose or the dialog was dismissed; late suggestions are dropped. */
	#settled = false;
	/** Any key press marks the dialog as interacted; the late model preselection then stays off. */
	#userInteracted = false;
	#suggestionRow: Loader | Text | undefined;

	constructor(
		title: string,
		lines: readonly (string | PermissionDialogLine)[],
		options: readonly PermissionDialogOption[],
		onSelect: (index: number) => void,
		onCancel: () => void,
		opts?: {
			maxVisible?: number;
			helpText?: string;
			/** Row to preselect; -1/omitted = no selection (spec §5.1, Task 6's Pattern preselect). */
			initialIndex?: number;
			/**
			 * Resolves to the row to preselect once the model's recommendation
			 * lands. Applied only while the dialog is untouched (no key pressed,
			 * not settled); resolving `undefined` keeps the current selection.
			 * May be a starter function invoked on mount: queued dialogs begin
			 * their recommendation when presented (issue 13).
			 */
			preselect?: Promise<number | undefined> | (() => Promise<number | undefined>);
			/** Checklist mode: space toggles toggleable options. */
			checklist?: boolean;
			/** Edit mode: `e` on a row settles and reports the row (caller maps the sentinel). */
			allowEdit?: boolean;
			onEdit?: (index: number) => void;
			/** Checklist summary line computed from the current checked array; empty string hides it. */
			previewFor?: (checked: boolean[]) => string;
			suggestions?: Promise<PermissionDialogOption[]> | (() => Promise<PermissionDialogOption[]>);
			ui?: TUI;
		},
	) {
		super();
		this.#options = [...options];
		// Keep the caller's array so toggled state can be written back (Task 6 reads it).
		this.#sourceOptions = options;
		this.#lines = lines.map(line => (typeof line === "string" ? { segments: [{ text: line }] } : line));
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#selectedIndex = opts?.initialIndex ?? -1;
		this.#checklist = opts?.checklist === true;
		this.#onEdit = opts?.onEdit;
		this.#previewFor = opts?.previewFor;
		this.#checked = this.#options.map(option => option.checked ?? false);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) }));
		this.addChild(new Spacer(1));
		this.#lineContainer = new Container();
		this.addChild(this.#lineContainer);
		if (lines.length > 0) {
			this.addChild(new Spacer(1));
		}
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		if (opts?.suggestions !== undefined) {
			// Lazy starters begin the model request at mount — the dialog is
			// presented (dequeued) here, so queued dialogs keep their full
			// timeout budget and never overlap a sibling request (issue 13).
			this.#attachSuggestions(resolveLazy(opts.suggestions), opts.ui);
		}
		this.addChild(new Spacer(1));
		if (opts?.previewFor !== undefined) {
			// Empty text renders zero rows, so an empty preview hides itself.
			this.#previewText = new Text("", 1, 0);
			this.addChild(this.#previewText);
		}
		this.addChild(new Text(theme.fg("dim", opts?.helpText ?? DEFAULT_HELP_TEXT), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#renderList();
		this.#renderLines();
		this.#renderPreview();
		if (opts?.preselect !== undefined) {
			void resolveLazy(opts.preselect)
				.then(index => {
					// The model's recommendation lands while the user may
					// already have chosen or moved — never override an
					// interacted dialog.
					if (index === undefined || this.#settled || this.#userInteracted) return;
					this.#selectedIndex = index;
					this.#renderList();
				})
				.catch(() => {
					// A failed recommendation leaves the initial selection.
				})
				.finally(() => {
					// The TUI is event-driven with no heartbeat: the tree
					// mutation above stays unpainted without a repaint request.
					opts.ui?.requestRender();
				});
		}
	}

	/** Watch the suggestion promise: spinner row while pending, append on settle, drop after choice. */
	#attachSuggestions(suggestions: Promise<PermissionDialogOption[]>, ui: TUI | undefined): void {
		this.#suggestionRow =
			ui !== undefined
				? new Loader(
						ui,
						spinner => theme.fg("accent", spinner),
						text => theme.fg("muted", text),
						SUGGESTING_LABEL,
					)
				: new Text(theme.fg("muted", `  ${SUGGESTING_LABEL}`), 1, 0);
		this.addChild(this.#suggestionRow);
		void suggestions
			.then(appended => {
				this.#removeSuggestionRow();
				// Suggestions that resolve after the user chose are dropped.
				if (this.#settled) return;
				for (const option of appended) {
					this.addOption(option);
				}
			})
			.catch(() => {
				// Provider failure degrades silently to candidates-only.
				this.#removeSuggestionRow();
			})
			.finally(() => {
				// The TUI is event-driven with no heartbeat: the tree mutations
				// above (spinner removal, appended options) stay unpainted until
				// the next input/resize unless we schedule a repaint here.
				ui?.requestRender();
			});
	}

	#removeSuggestionRow(): void {
		if (this.#suggestionRow === undefined) return;
		const row = this.#suggestionRow;
		this.#suggestionRow = undefined;
		if (row instanceof Loader) {
			row.dispose();
		}
		this.removeChild(row);
	}

	/** Append an option and re-render (Task 11: LLM suggestions arrive late). */
	addOption(option: PermissionDialogOption): void {
		this.#options.push(option);
		this.#renderList();
	}

	handleInput(keyData: string): void {
		this.#userInteracted = true;
		if (matchesSelectCancel(keyData)) {
			this.#settled = true;
			this.#onCancel();
			return;
		}
		if (matchesSelectUp(keyData) || matchesKey(keyData, "k")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(keyData) || matchesKey(keyData, "j")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "l")) {
			this.#expanded = !this.#expanded;
			this.#renderLines();
			return;
		}
		if (this.#checklist && (matchesKey(keyData, "space") || keyData === " ")) {
			this.#toggleChecked(this.#selectedIndex);
			return;
		}
		if (matchesKey(keyData, "e") && this.#onEdit !== undefined && this.#checklist && this.#selectedIndex >= 0) {
			// `#selectedIndex >= 0` keeps the edit sentinel distinguishable from
			// plain cancel: an edit for row `index` settles -(index + 2) (Step 5).
			this.#settled = true;
			this.#onEdit(this.#selectedIndex);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			// No-selection mode: Enter stays a no-op until navigation (spec §5.1).
			if (this.#options.length > 0 && this.#selectedIndex >= 0) {
				const option = this.#options[this.#selectedIndex];
				// Checklist rows toggle on Enter like space; only the write
				// button (non-toggleable) commits — Enter on a row must never
				// settle the dialog.
				if (this.#checklist && option?.toggleable === true) {
					this.#toggleChecked(this.#selectedIndex);
					return;
				}
				this.#settled = true;
				this.#onSelect(Math.min(this.#selectedIndex, this.#options.length - 1));
			}
		}
	}

	/** Toggle a checklist row's checked state (space or Enter on the row). */
	#toggleChecked(index: number): void {
		const option = this.#options[index];
		if (option?.toggleable !== true) return;
		this.#checked[index] = !(this.#checked[index] ?? false);
		// Write back onto the source option object so the caller can read final state.
		const source = this.#sourceOptions[index];
		if (source !== undefined) source.checked = this.#checked[index];
		if (option.labelFor !== undefined) option.label = option.labelFor(this.#checked);
		this.#renderList();
		this.#renderPreview();
	}

	override dispose(): void {
		this.#settled = true;
		if (this.#suggestionRow instanceof Loader) {
			this.#suggestionRow.dispose();
		}
		this.#suggestionRow = undefined;
		super.dispose();
	}

	#moveSelection(delta: number): void {
		if (this.#options.length === 0) return;
		if (this.#selectedIndex < 0) {
			// No-selection start: j/down lands on the first row; k/up treats -1
			// as just-before-start and wraps to the last row.
			this.#selectedIndex = delta < 0 ? this.#options.length - 1 : 0;
		} else {
			this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex + delta, this.#options.length - 1));
		}
		this.#renderList();
	}

	#renderList(): void {
		this.#listContainer.clear();
		if (this.#options.length === 0) {
			this.#listContainer.addChild(new Text(theme.fg("dim", "  No options"), 1, 0));
			return;
		}
		const windowStart = Math.max(0, Math.min(this.#selectedIndex, this.#options.length - this.#maxVisible));
		const windowEnd = Math.min(this.#options.length, windowStart + this.#maxVisible);
		for (let i = windowStart; i < windowEnd; i++) {
			const option = this.#options[i];
			if (option === undefined) continue;
			const isSelected = i === this.#selectedIndex;
			// The label is stored without the checklist prefix; labelFor options
			// recompute their label from the live checked array each render.
			let label = option.label;
			if (option.labelFor !== undefined) label = option.labelFor(this.#checked);
			if (this.#checklist && option.toggleable === true) {
				label = `${this.#checked[i] === true ? "[x]" : "[ ]"} ${label}`;
			}
			const numberColor = isSelected ? "accent" : "dim";
			const labelColor = isSelected ? "accent" : "text";
			const rows = [`${theme.fg(numberColor, `${i + 1}. `)}${theme.fg(labelColor, label)}`];
			if (option.description !== undefined) {
				for (const line of option.description.replace(/\n+$/u, "").split("\n")) {
					rows.push(`    ${theme.fg("muted", line)}`);
				}
			}
			for (const row of rows) {
				const painted = isSelected ? theme.bg("selectedBg", row) : row;
				this.#listContainer.addChild(new Text(painted, 1, 0));
			}
		}
	}

	/** Render the context lines: styled segments, collapsed truncation, right-aligned status. */
	#renderLines(): void {
		this.#lineContainer.clear();
		const available = Math.max(20, (this.#lastRenderWidth ?? 80) - 4);
		for (const line of this.#lines) {
			const style = line.style ?? "muted";
			const styleColor =
				style === "accent" ? "accent" : style === "text" ? "text" : style === "allowed" ? "muted" : "dim";
			// Reserve the status (plus its mandatory one-space gap) inside
			// `available` so a truncated line plus status stays on ONE row,
			// right-aligned at the ellipsis.
			const statusLength = line.status?.text.length ?? 0;
			const budget = statusLength > 0 ? Math.max(0, available - statusLength - 1) : available;
			const segments = this.#expanded ? line.segments : truncateSegments(line.segments, budget);
			const plain = segments.map(segment => segment.text).join("");
			let text = "";
			for (const segment of segments) {
				text += segment.dim === true ? theme.fg("dim", segment.text) : theme.fg(styleColor, segment.text);
			}
			if (line.status !== undefined) {
				// Pad to `available` including the status text itself so the line
				// stays right-aligned within the render width (no wrap/cut).
				const pad = Math.max(1, available - plain.length - line.status.text.length);
				text += " ".repeat(pad) + theme.fg(line.status.style === "accent" ? "accent" : "muted", line.status.text);
			}
			this.#lineContainer.addChild(new Text(text, 1, 0));
		}
	}

	/** Update the checklist summary line from previewFor; an empty string hides it. */
	#renderPreview(): void {
		if (this.#previewText === undefined) return;
		this.#previewText.setText(this.#previewFor?.(this.#checked) ?? "");
	}

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		if (this.#lastRenderWidth !== renderWidth) {
			this.#lastRenderWidth = renderWidth;
			this.#renderList();
			this.#renderLines();
		}
		return super.render(renderWidth);
	}
}
