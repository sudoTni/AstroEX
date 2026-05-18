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
	remoteOk: boolean;
	salaryMin: number;
	salaryMax: number;
	salaryCurrency: SalaryCurrency;
	stackRequired: string[];

	// New fields from enhanced LinkedIn scraping
	applicants?: string;
	seniorityLevel?: string;
	employmentType?: string;
	jobFunction?: string;
	industries?: string;
	salaryRange?: string; // Added from getJobDescription
	postedTime?: string; // Added from getJobDescription
}
