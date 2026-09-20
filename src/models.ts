export type SalaryCurrency = "USD" | "EUR" | "GBP" | "RON" | "CHF" | "";

export interface JobInterface {
	_id?: unknown;
	id: string;
	title: string;
	img: string;
	url: string;
	companyUrl: string;
	date: string; // format: yyyy-mm-dd
	postedDate: Date | string;
	company: string;
	location: string;
	countryCode: string;
	countryText: string;
	descriptionHtml: string | undefined;
	descriptionText?: string;
	city: string;
	remoteOk?: boolean;
	salaryMin: number;
	salaryMax: number;
	salaryCurrency: SalaryCurrency;
	stackRequired: string[];

	// Optional fields retained for compatibility with historical artifacts.
	applicants?: string;
	seniorityLevel?: string;
	employmentType?: string;
	jobFunction?: string;
	industries?: string;
	salaryRange?: string; // Added from getJobDescription
	postedTime?: string; // Added from getJobDescription

	// Source-neutral acquisition metadata for job artifacts.
	source?: "indeed" | "linkedin";
	sourceJobId?: string;
	canonicalUrl?: string;
	directUrl?: string;
	acquiredAt?: string;
	isRemote?: boolean;
	isConfirmedRemote?: boolean;
	remoteEvalMetadata?: {
		jobTitle: string;
		rationale: string;
		confidence: number;
		timestamp: string;
		fallbackUsed: boolean;
		retryCount: number;
	};

	// JobCloth / JobJudge analysis metadata
	confidence?: number;
	rationale?: string;
	isWorthInvestigating?: boolean;
	isVeryHighlyAligned?: boolean;
	isHighlyAligned?: boolean;
}
