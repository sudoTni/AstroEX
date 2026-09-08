/**
 * Source-neutral job acquisition model.
 *
 * This boundary keeps Indeed acquisition separate from AstroEX's processing,
 * filtering, and LLM commands. It is deliberately small so the provider can
 * be replaced without changing those downstream stages.
 */
export type AcquisitionSource = "indeed";

export type DescriptionRepresentation =
	| "html"
	| "markdown"
	| "plain"
	| "unknown";

export interface CanonicalCompensation {
	interval?: "yearly" | "monthly" | "weekly" | "daily" | "hourly";
	minAmount?: number;
	maxAmount?: number;
	currency?: string;
	source?: "direct_data" | "description";
}

export interface CanonicalAcquiredJob {
	id: string;
	source: AcquisitionSource;
	sourceJobId?: string;
	canonicalUrl: string;
	directUrl?: string;
	title: string;
	company: string;
	companyUrl?: string;
	location?: string;
	postedAt?: string;
	description?: string;
	descriptionRepresentation: DescriptionRepresentation;
	isRemote?: boolean;
	jobType?: string;
	jobLevel?: string;
	jobFunction?: string;
	companyIndustry?: string;
	companyLogo?: string;
	compensation?: CanonicalCompensation;
	acquiredAt: string;
}

export interface AcquisitionQuery {
	sources: AcquisitionSource[];
	searchTerm: string;
	location?: string;
	distance?: number;
	resultsWanted: number;
	hoursOld?: number;
	isRemote?: boolean;
	remoteOnly?: boolean;
	jobType?: "fulltime" | "parttime" | "contract" | "internship";
	easyApply?: boolean;
	offset?: number;
	indeedCountry?: string;
	/** Optional Indeed client-key override; prefer ASTROEX_INDEED_API_KEY. */
	indeedApiKey?: string;
	includeDescriptions?: boolean;
	descriptionFormat?: "markdown" | "html" | "plain";
	proxies?: string[];
	userAgent?: string;
}

export interface AcquisitionFailure {
	source: AcquisitionSource;
	message: string;
	retryable: boolean;
}

export interface AcquisitionResult {
	jobs: CanonicalAcquiredJob[];
	failures: AcquisitionFailure[];
}

export interface AcquisitionProvider {
	acquire(query: AcquisitionQuery): Promise<AcquisitionResult>;
}
