/**
 * Selects OpenRouter provider slugs from the endpoint metadata API.
 *
 * The exported selector deliberately returns structured data. CLI adapters and
 * the pipeline can render its output without having to parse display text.
 */

const API_BASE = "https://openrouter.ai/api/v1";
const ONE_MILLION = 1_000_000;
const REQUIRED_QUANTIZATION = "fp8";
export const DEFAULT_TOP = 3;
const DEFAULT_MIN_UPTIME = 95;
const DEFAULT_MAX_PRICE_VS_MEDIAN = 1.1;
const REQUEST_TIMEOUT_MS = 30_000;

export const ASTRO_AUTO_PROVIDER = "astro_auto_provider";

type JsonRecord = Record<string, unknown>;

export interface ProviderRow {
	provider: string;
	providerSlug: string;
	quantization: string;
	inputPerM: number | null;
	outputPerM: number | null;
	cacheReadPerM: number | null;
	latencyS: number | null;
	throughputTps: number | null;
	uptimePct: number | null;
	combinedPerM: number | null;
	throughputPerDollar: number | null;
}

export interface AstroAutoProviderOptions {
	modelId: string;
	apiKey: string;
	top?: number;
	minUptime?: number;
	maxPriceVsMedian?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	quantizations?: string[];
}

export interface AstroAutoProviderResult {
	modelId: string;
	providers: ProviderRow[];
	providerSlugs: string[];
	medianPrice: number | null;
	maxPrice: number | null;
	excludedCount: number;
	allEndpointsCount: number;
	fp8EndpointsCount: number;
	noDetailsOutput: string;
}

interface SelectionResult {
	providers: ProviderRow[];
	medianPrice: number | null;
	maxPrice: number | null;
	excludedCount: number;
}

export interface AstroAutoProviderCliOptions {
	modelId: string;
	top: number;
	minUptime: number;
	maxPriceVsMedian: number;
	plain: boolean;
	noDetails: boolean;
}

export interface AstroAutoProviderCliIo {
	apiKey?: string;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function fmtNumber(value: number | null, places: number): string {
	if (value === null || !Number.isFinite(value)) return "--";
	return value
		.toFixed(places)
		.replace(/\.0+$/, "")
		.replace(/(\.\d*?)0+$/, "$1");
}

function formatLocalDateTime(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pricePerMillion(pricing: JsonRecord, key: string): number | null {
	const price = asNumber(pricing[key]);
	return price === null ? null : price * ONE_MILLION;
}

function metricP50(value: unknown): number | null {
	if (isRecord(value)) return asNumber(value.p50);
	return asNumber(value);
}

function getBasePricing(endpoint: JsonRecord): JsonRecord {
	const pricing = endpoint.pricing;
	if (Array.isArray(pricing)) return isRecord(pricing[0]) ? pricing[0] : {};
	return isRecord(pricing) ? pricing : {};
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function assertModelId(modelId: string): { author: string; slug: string } {
	if (typeof modelId !== "string") {
		throw new Error('MODEL_ID must look like "author/model".');
	}
	const [author, ...rest] = modelId.split("/");
	const slug = rest.join("/");
	if (!author || !slug)
		throw new Error('MODEL_ID must look like "author/model".');
	return { author, slug };
}

async function fetchEndpoints(
	modelId: string,
	apiKey: string,
	fetchImpl: typeof fetch,
	externalSignal?: AbortSignal,
): Promise<JsonRecord[]> {
	const { author, slug } = assertModelId(modelId);
	const timeoutController = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, REQUEST_TIMEOUT_MS);
	const abortFromPipeline = () =>
		timeoutController.abort(externalSignal?.reason);
	externalSignal?.addEventListener("abort", abortFromPipeline, { once: true });

	try {
		const response = await fetchImpl(
			`${API_BASE}/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: timeoutController.signal,
			},
		);
		if (!response.ok) {
			const body = (await response.text()).slice(0, 1000);
			throw new Error(`OpenRouter returned HTTP ${response.status}\n${body}`);
		}
		const payload: unknown = await response.json();
		if (
			!isRecord(payload) ||
			!isRecord(payload.data) ||
			!Array.isArray(payload.data.endpoints)
		) {
			throw new Error("Unexpected OpenRouter response shape.");
		}
		return payload.data.endpoints.filter(isRecord);
	} catch (error) {
		if (timedOut) throw new Error("OpenRouter request timed out after 30s.");
		if (externalSignal?.aborted) {
			throw externalSignal.reason instanceof Error
				? externalSignal.reason
				: error;
		}
		throw error;
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", abortFromPipeline);
	}
}

function isEndpointQuantizationEligible(
	endpoint: JsonRecord,
	allowedQuantizations: Set<string>,
): boolean {
	return (
		typeof endpoint.quantization === "string" &&
		allowedQuantizations.has(endpoint.quantization.toLowerCase())
	);
}

function isFp8(endpoint: JsonRecord): boolean {
	return (
		typeof endpoint.quantization === "string" &&
		endpoint.quantization.toLowerCase() === REQUIRED_QUANTIZATION
	);
}

function normalizeEndpoint(endpoint: JsonRecord): ProviderRow {
	const pricing = getBasePricing(endpoint);
	const inputPerM = pricePerMillion(pricing, "prompt");
	const outputPerM = pricePerMillion(pricing, "completion");
	const cacheReadPerM = pricePerMillion(pricing, "input_cache_read");
	const latencyS = metricP50(endpoint.latency_last_30m);
	const throughputTps = metricP50(endpoint.throughput_last_30m);
	const uptimePct = asNumber(endpoint.uptime_last_1d);
	let combinedPerM: number | null = null;
	let throughputPerDollar: number | null = null;
	if (inputPerM !== null && outputPerM !== null && cacheReadPerM !== null) {
		combinedPerM = inputPerM + outputPerM + cacheReadPerM;
		if (throughputTps !== null && combinedPerM > 0) {
			throughputPerDollar = throughputTps / combinedPerM;
		}
	}
	return {
		provider:
			typeof endpoint.provider_name === "string" && endpoint.provider_name
				? endpoint.provider_name
				: typeof endpoint.name === "string" && endpoint.name
					? endpoint.name
					: "Unknown",
		providerSlug: typeof endpoint.tag === "string" ? endpoint.tag : "",
		quantization:
			typeof endpoint.quantization === "string"
				? endpoint.quantization.toLowerCase()
				: "",
		inputPerM,
		outputPerM,
		cacheReadPerM,
		latencyS,
		throughputTps,
		uptimePct,
		combinedPerM,
		throughputPerDollar,
	};
}

function getBaseEligibleRows(
	rows: ProviderRow[],
	minUptime: number,
	allowedQuantizations?: Set<string>,
): ProviderRow[] {
	return rows.filter(
		(row) =>
			(allowedQuantizations
				? allowedQuantizations.has(row.quantization.toLowerCase())
				: row.quantization === REQUIRED_QUANTIZATION) &&
			row.combinedPerM !== null &&
			row.combinedPerM > 0 &&
			row.throughputPerDollar !== null &&
			row.throughputTps !== null &&
			row.uptimePct !== null &&
			row.uptimePct >= minUptime &&
			row.providerSlug.length > 0,
	);
}

function compareProviders(a: ProviderRow, b: ProviderRow): number {
	const efficiency =
		(b.throughputPerDollar ?? 0) - (a.throughputPerDollar ?? 0);
	if (efficiency !== 0) return efficiency;
	const throughput = (b.throughputTps ?? 0) - (a.throughputTps ?? 0);
	if (throughput !== 0) return throughput;
	const price =
		(a.combinedPerM ?? Number.POSITIVE_INFINITY) -
		(b.combinedPerM ?? Number.POSITIVE_INFINITY);
	if (price !== 0) return price;
	const uptime = (b.uptimePct ?? 0) - (a.uptimePct ?? 0);
	if (uptime !== 0) return uptime;
	return (
		(a.latencyS ?? Number.POSITIVE_INFINITY) -
		(b.latencyS ?? Number.POSITIVE_INFINITY)
	);
}

function topProviders(
	rows: ProviderRow[],
	topN: number,
	minUptime: number,
	maxPriceVsMedian: number,
	allowedQuantizations?: Set<string>,
): SelectionResult {
	const eligible = getBaseEligibleRows(rows, minUptime, allowedQuantizations);
	if (eligible.length === 0) {
		return {
			providers: [],
			medianPrice: null,
			maxPrice: null,
			excludedCount: 0,
		};
	}
	const medianPrice = median(
		eligible
			.map((row) => row.combinedPerM)
			.filter((price): price is number => price !== null && price > 0),
	);
	const maxPrice = medianPrice === null ? null : medianPrice * maxPriceVsMedian;
	const accepted = eligible.filter(
		(row) =>
			maxPrice === null ||
			(row.combinedPerM !== null && row.combinedPerM <= maxPrice),
	);
	accepted.sort(compareProviders);
	const providers: ProviderRow[] = [];
	const seenSlugs = new Set<string>();
	for (const row of accepted) {
		if (seenSlugs.has(row.providerSlug)) continue;
		seenSlugs.add(row.providerSlug);
		providers.push(row);
		if (providers.length >= topN) break;
	}
	return {
		providers,
		medianPrice,
		maxPrice,
		excludedCount: eligible.length - accepted.length,
	};
}

function formatTop(rows: ProviderRow[], quantLabel = "FP8"): string {
	if (rows.length === 0)
		return `No eligible ${quantLabel} providers remained after filtering.`;
	const headers = [
		"#",
		"Provider",
		"Slug",
		"Quant",
		"Combined /M",
		"TPS",
		"TPS/$",
		"Uptime",
		"Latency",
	];
	const body = rows.map((row, index) => [
		String(index + 1),
		row.provider,
		row.providerSlug,
		row.quantization,
		`$${fmtNumber(row.combinedPerM, 6)}`,
		fmtNumber(row.throughputTps, 2),
		fmtNumber(row.throughputPerDollar, 2),
		`${fmtNumber(row.uptimePct, 2)}%`,
		row.latencyS === null ? "--" : `${fmtNumber(row.latencyS, 3)}s`,
	]);
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...body.map((row) => row[column].length)),
	);
	const line = (values: string[]): string =>
		values.map((value, index) => value.padEnd(widths[index])).join("  ");
	return [
		line(headers),
		line(widths.map((width) => "-".repeat(width))),
		...body.map(line),
		"",
		"Provider slugs:",
		rows.map((row) => row.providerSlug).join(","),
	].join("\n");
}

function formatDetailedOutput(
	result: AstroAutoProviderResult,
	options: Pick<AstroAutoProviderCliOptions, "minUptime" | "maxPriceVsMedian">,
	quantLabel = "FP8",
): string {
	const lines = [
		`Model: ${result.modelId}`,
		result.noDetailsOutput.split("\n")[1],
		`Quantization: ${quantLabel} only`,
		`All endpoints: ${result.allEndpointsCount}`,
		`${quantLabel} endpoints: ${result.fp8EndpointsCount}`,
		"",
		"Selection:",
		`  1. Restrict to ${quantLabel} providers`,
		"  2. Apply minimum uptime",
		"  3. Calculate median combined price",
		"  4. Exclude high-price outliers",
		"  5. Rank remaining providers by TPS/$",
		"",
		`Minimum 1-day uptime: ${options.minUptime}%`,
		`Maximum price vs median: ${options.maxPriceVsMedian.toFixed(2)}x`,
	];
	if (result.medianPrice !== null) {
		lines.push(
			`Median combined price: $${fmtNumber(result.medianPrice, 6)} /M`,
		);
	}
	if (result.maxPrice !== null) {
		lines.push(
			`High-price outlier ceiling: $${fmtNumber(result.maxPrice, 6)} /M`,
		);
	}
	lines.push(
		`High-price providers excluded: ${result.excludedCount}`,
		"",
		"Ranking:",
		"  1. Highest throughput per dollar (TPS/$)",
		"  2. Highest p50 throughput",
		"  3. Lowest combined input + output + cache-read price",
		"  4. Highest uptime",
		"  5. Lowest latency",
		"",
		formatTop(result.providers, quantLabel),
	);
	return lines.join("\n");
}

export async function astro_auto_provider(
	options: AstroAutoProviderOptions,
): Promise<AstroAutoProviderResult> {
	const apiKey = options.apiKey?.trim();
	if (!apiKey) throw new Error("AEX_OR_API_KEY is not set.");
	const top = options.top ?? DEFAULT_TOP;
	const minUptime = options.minUptime ?? DEFAULT_MIN_UPTIME;
	const maxPriceVsMedian =
		options.maxPriceVsMedian ?? DEFAULT_MAX_PRICE_VS_MEDIAN;
	if (!Number.isInteger(top) || top < 1)
		throw new Error("--top must be an integer of at least 1.");
	if (minUptime < 0 || minUptime > 100)
		throw new Error("--min-uptime must be between 0 and 100.");
	if (maxPriceVsMedian <= 0)
		throw new Error("--max-price-vs-median must be greater than 0.");

	const rawQuants = options.quantizations
		?.map((q) => q.trim().toLowerCase())
		.filter(Boolean);
	const allowedQuantSet =
		rawQuants && rawQuants.length > 0
			? new Set(rawQuants)
			: new Set([REQUIRED_QUANTIZATION]);

	const quantLabel =
		allowedQuantSet.size === 1 && allowedQuantSet.has(REQUIRED_QUANTIZATION)
			? "FP8"
			: Array.from(allowedQuantSet)
					.map((q) => q.toUpperCase())
					.join("/");

	const allEndpoints = await fetchEndpoints(
		options.modelId,
		apiKey,
		options.fetchImpl ?? fetch,
		options.signal,
	);
	const eligibleEndpoints = allEndpoints.filter((ep) =>
		isEndpointQuantizationEligible(ep, allowedQuantSet),
	);
	const selection = topProviders(
		eligibleEndpoints.map(normalizeEndpoint),
		top,
		minUptime,
		maxPriceVsMedian,
		allowedQuantSet,
	);
	const dateTime = formatLocalDateTime((options.now ?? (() => new Date()))());
	return {
		modelId: options.modelId,
		providers: selection.providers,
		providerSlugs: selection.providers.map((row) => row.providerSlug),
		medianPrice: selection.medianPrice,
		maxPrice: selection.maxPrice,
		excludedCount: selection.excludedCount,
		allEndpointsCount: allEndpoints.length,
		fp8EndpointsCount: eligibleEndpoints.length,
		noDetailsOutput: [
			`Model: ${options.modelId}`,
			`Date & time: ${dateTime}`,
			formatTop(selection.providers, quantLabel),
		].join("\n"),
	};
}

export function astroAutoProviderUsage(): string {
	return `Usage:
  openrouter_providers.ts MODEL_ID [options]

Options:
  --top N                         Maximum unique providers to return (default: ${DEFAULT_TOP})
  --min-uptime PERCENT            Minimum 1-day uptime percentage (default: ${DEFAULT_MIN_UPTIME})
  --max-price-vs-median MULTIPLIER
                                  Exclude providers priced above median × multiplier
                                  (default: ${DEFAULT_MAX_PRICE_VS_MEDIAN.toFixed(2)})
  --plain                         Print only final comma-separated provider slugs
  --no-details                    Print model, results table, and provider slugs
  -h, --help                      Show this help

Environment:
  AEX_OR_API_KEY                  OpenRouter API key

Examples:
  npx tsx openrouter_providers.ts deepseek/deepseek-v3.2
  npx tsx openrouter_providers.ts z-ai/glm-4.5-air --top 4
  npx tsx openrouter_providers.ts z-ai/glm-4.5-air --plain
  npx tsx openrouter_providers.ts z-ai/glm-4.5-air --no-details
`;
}

function parseFiniteNumber(option: string, raw: string | undefined): number {
	if (raw === undefined) throw new Error(`${option} requires a value.`);
	const value = Number(raw);
	if (!Number.isFinite(value))
		throw new Error(`${option} must be a finite number.`);
	return value;
}

export function parseAstroAutoProviderCli(
	argv: string[],
): AstroAutoProviderCliOptions | null {
	let modelId: string | null = null;
	let top = DEFAULT_TOP;
	let minUptime = DEFAULT_MIN_UPTIME;
	let maxPriceVsMedian = DEFAULT_MAX_PRICE_VS_MEDIAN;
	let plain = false;
	let noDetails = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") return null;
		if (arg === "--plain") {
			plain = true;
			continue;
		}
		if (arg === "--no-details") {
			noDetails = true;
			continue;
		}
		if (arg === "--top") {
			top = parseFiniteNumber(arg, argv[++i]);
			continue;
		}
		if (arg === "--min-uptime") {
			minUptime = parseFiniteNumber(arg, argv[++i]);
			continue;
		}
		if (arg === "--max-price-vs-median") {
			maxPriceVsMedian = parseFiniteNumber(arg, argv[++i]);
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
		if (modelId !== null)
			throw new Error(`Unexpected positional argument: ${arg}`);
		modelId = arg;
	}
	if (modelId === null) throw new Error("MODEL_ID is required.");
	if (!Number.isInteger(top) || top < 1)
		throw new Error("--top must be an integer of at least 1.");
	if (minUptime < 0 || minUptime > 100)
		throw new Error("--min-uptime must be between 0 and 100.");
	if (maxPriceVsMedian <= 0)
		throw new Error("--max-price-vs-median must be greater than 0.");
	return { modelId, top, minUptime, maxPriceVsMedian, plain, noDetails };
}

/** Compatibility adapter for the standalone selector CLI. */
export async function runAstroAutoProviderCli(
	argv: string[],
	io: AstroAutoProviderCliIo = {},
): Promise<number> {
	const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
	const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
	let options: AstroAutoProviderCliOptions | null;
	try {
		options = parseAstroAutoProviderCli(argv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr(`Error: ${message}\n\n${astroAutoProviderUsage()}`);
		return 2;
	}
	if (options === null) {
		stdout(astroAutoProviderUsage());
		return 0;
	}
	if (!io.apiKey) {
		stderr("Error: AEX_OR_API_KEY is not set.\n");
		return 2;
	}
	try {
		const result = await astro_auto_provider({ ...options, apiKey: io.apiKey });
		if (options.plain) stdout(`${result.providerSlugs.join(",")}\n`);
		else if (options.noDetails) stdout(`${result.noDetailsOutput}\n`);
		else stdout(`${formatDetailedOutput(result, options)}\n`);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr(`Error: ${message}\n`);
		return 1;
	}
}
