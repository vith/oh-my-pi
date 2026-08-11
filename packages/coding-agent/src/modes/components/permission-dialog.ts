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
import type { PermissionDialogOption } from "../../extensibility/extensions";
import { getMarkdownTheme, theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

const DEFAULT_HELP_TEXT = "j/k navigate  enter select  esc cancel";
const SUGGESTING_LABEL = "Suggesting rules…";

export class PermissionDialogComponent extends Container {
	#options: PermissionDialogOption[];
	#selectedIndex = 0;
	#onSelect: (index: number) => void;
	#onCancel: () => void;
	#maxVisible: number;
	#listContainer: Container;
	#lastRenderWidth: number | undefined;
	/** Set once the user chose or the dialog was dismissed; late suggestions are dropped. */
	#settled = false;
	#suggestionRow: Loader | Text | undefined;

	constructor(
		title: string,
		lines: readonly string[],
		options: readonly PermissionDialogOption[],
		onSelect: (index: number) => void,
		onCancel: () => void,
		opts?: { maxVisible?: number; helpText?: string; suggestions?: Promise<PermissionDialogOption[]>; ui?: TUI },
	) {
		super();
		this.#options = [...options];
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) }));
		this.addChild(new Spacer(1));
		for (const line of lines) {
			this.addChild(new Text(theme.fg("muted", line), 1, 0));
		}
		if (lines.length > 0) {
			this.addChild(new Spacer(1));
		}
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		if (opts?.suggestions !== undefined) {
			this.#attachSuggestions(opts.suggestions, opts.ui);
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", opts?.helpText ?? DEFAULT_HELP_TEXT), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#renderList();
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
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			if (this.#options.length > 0) {
				this.#settled = true;
				this.#onSelect(Math.min(this.#selectedIndex, this.#options.length - 1));
			}
		}
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
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex + delta, this.#options.length - 1));
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
			const numberColor = isSelected ? "accent" : "dim";
			const labelColor = isSelected ? "accent" : "text";
			const rows = [`${theme.fg(numberColor, `${i + 1}. `)}${theme.fg(labelColor, option.label)}`];
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

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		if (this.#lastRenderWidth !== renderWidth) {
			this.#lastRenderWidth = renderWidth;
			this.#renderList();
		}
		return super.render(renderWidth);
	}
}
