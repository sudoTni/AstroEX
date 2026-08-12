/**
 * Source-neutral job acquisition model.
 *
 * This boundary keeps acquisition concerns separate from AstroEX's legacy
 * LinkedIn-shaped job model. It is deliberately small so providers can be
 * replaced without changing filtering, JobDB, or LLM commands.
 */
export type AcquisitionSource = "linkedin" | "indeed";

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
	/** Bounded independently because LinkedIn's guest endpoint is rate-limited. */
	linkedinResultsWanted?: number;
	hoursOld?: number;
	isRemote?: boolean;
	jobType?: "fulltime" | "parttime" | "contract" | "internship";
	easyApply?: boolean;
	offset?: number;
	indeedCountry?: string;
	linkedinFetchDescription?: boolean;
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
