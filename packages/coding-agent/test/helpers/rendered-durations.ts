export function renderedDurationsMs(text: string): number[] {
	return [...text.matchAll(/\b(\d+(?:\.\d+)?)(ms|s)\b/g)].map(
		([, value, unit]) => Number(value) * (unit === "s" ? 1000 : 1),
	);
}
