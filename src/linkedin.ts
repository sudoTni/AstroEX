import type { Browser, Page } from "puppeteer";
import { defer, EMPTY, from, type Observable, of, timer } from "rxjs"; // Use 'from' from 'rxjs' instead of 'rxjs/internal/observable/fromArray'
import { fromPromise } from "rxjs/internal-compatibility";
import {
	catchError,
	concatMap,
	expand,
	map,
	retryWhen,
	switchMap,
	tap,
} from "rxjs/operators"; // Removed delayWhen import
import { searchParamsList, stacks } from "./data";
import type { JobInterface, SalaryCurrency } from "./models";
import {
	getPageLocationOperator,
	retryStrategyByCondition,
} from "./scraper.utils";
import { log, pageAddLogs } from "./utils"; // Import pageAddLogs and log

export interface ScraperSearchParams {
	searchText: string;
	locationText: string;
	pageNumber: number;
}

export interface ScraperResult {
	jobs: JobInterface[];
	searchParams: ScraperSearchParams;
}

const urlQueryPage = (search: ScraperSearchParams) =>
	`https://linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${search.searchText}&start=${search.pageNumber * 25}${search.locationText ? `&location=${search.locationText}` : ""}&f_TPR=r86400&f_WT=2`;

function getJobsFromLinkedinPage(page: Page): Observable<JobInterface[]> {
	return defer(
		() =>
			fromPromise(
				page.evaluate(
					(pageEvalData) => {
						const collection: HTMLCollection = document.body.children;
						const results: JobInterface[] = [];
						for (let i = 0; i < collection.length; i++) {
							try {
								const item = collection.item(i);
								if (!item) continue;
								// Use more stable selectors if available from analysis, falling back to existing
								const titleElement =
									item.querySelector(".base-search-card__title") ||
									item.querySelector("h3.base-main-card__title");
								const title = titleElement?.textContent?.trim() || "";

								const imgElement = item.querySelector("img");
								const imgSrc =
									imgElement?.getAttribute("data-delayed-url") ||
									imgElement?.getAttribute("src") ||
									"";

								const remoteOk: boolean = !!title.match(
									/remote|No office location/gi,
								);

								const urlElement =
									item.querySelector(".base-card__full-link") ||
									item.querySelector(".base-search-card--link");
								const url = (
									(urlElement as HTMLLinkElement)?.href || ""
								).replace(
									/^(https?:\/\/(?:www\.)?linkedin\.com){1,2}(https?:\/\/)/i,
									"$2",
								);

								const companyNameAndLinkContainer =
									item.querySelector(".base-search-card__subtitle") ||
									item.querySelector("h4.base-main-card__subtitle");
								const companyLinkElement =
									companyNameAndLinkContainer?.querySelector("a");
								const companyUrl: string = companyLinkElement?.href || "";
								const companyName =
									companyNameAndLinkContainer?.textContent?.trim() || "";

								const locationElement =
									item.querySelector(".job-search-card__location") ||
									item.querySelector("span.main-job-card__location");
								const companyLocation =
									locationElement?.textContent?.trim() || "";

								const toDate = (dateString: string) => {
									const [year, month, day] = dateString.split("-");
									return new Date(
										parseFloat(year),
										parseFloat(month) - 1,
										parseFloat(day),
									);
								};

								const dateTimeElement =
									item.querySelector(".job-search-card__listdate") ||
									item.querySelector(".job-search-card__listdate--new") ||
									item.querySelector("time.main-job-card__listdate");
								const dateTime = dateTimeElement?.getAttribute("datetime");
								const postedDate = dateTime
									? toDate(dateTime).toISOString()
									: new Date().toISOString(); // Default to current date if not found

								/**
								 * Calculate minimum and maximum salary
								 *
								 * Salary HTML example to parse:
								 * <span class="job-search-card__salary-info">$65,000.00 - $90,000.00</span>
								 */
								let currency: SalaryCurrency = "";
								let salaryMin = -1;
								let salaryMax = -1;

								const salaryCurrencyMap: Record<string, string> = {
									"€": "EUR",
									$: "USD",
									"£": "GBP",
								};

								const salaryInfoElem =
									item.querySelector(".job-search-card__salary-info") ||
									item.querySelector("span.main-job-card__salary-info");
								if (salaryInfoElem) {
									const salaryInfo: string =
										salaryInfoElem?.textContent?.trim() || "";
									if (
										salaryInfo.startsWith("€") ||
										salaryInfo.startsWith("$") ||
										salaryInfo.startsWith("£")
									) {
										const coinSymbol = salaryInfo.charAt(0);
										const mapped = salaryCurrencyMap[coinSymbol] || coinSymbol;
										// Ensure mapped value matches SalaryCurrency union, otherwise default to empty
										if (
											mapped === "USD" ||
											mapped === "EUR" ||
											mapped === "GBP" ||
											mapped === "RON" ||
											mapped === "CHF" ||
											mapped === ""
										) {
											currency = mapped as SalaryCurrency;
										} else {
											currency = "";
										}
									}

									const matches = salaryInfo.match(/([0-9]|,|\.)+/g);
									if (matches?.[0]) {
										// values are in USA format, so we need to remove ALL the comas
										salaryMin = parseFloat(matches[0].replace(/,/g, ""));
									}
									if (matches?.[1]) {
										// values are in USA format, so we need to remove ALL the comas
										salaryMax = parseFloat(matches[1].replace(/,/g, ""));
									}
								}

								// Calculate tags
								let stackRequired: string[] = [];
								title
									.split(" ")
									.concat(url.split("-"))
									.forEach((word) => {
										if (word) {
											const wordLowerCase = word.toLowerCase();
											if (pageEvalData.stacks.includes(wordLowerCase)) {
												stackRequired.push(wordLowerCase);
											}
										}
									});
								// Define uniq function here. remember that page.evaluate executes inside the browser, so we cannot easily import outside functions form other contexts
								const uniq = (_array: unknown[]) =>
									_array.filter(
										(item, pos) => _array.indexOf(item) === pos,
									) as unknown[]; // Deduplicate
								stackRequired = uniq(stackRequired) as string[];

								const result: JobInterface = {
									id:
										item?.children[0]
											.getAttribute("data-entity-urn")
											?.split(":")
											.pop()
											?.match(/\d+/)?.[0] || "", // Extract numeric ID from data-entity-urn
									city: companyLocation, // Corrected: use companyLocation
									url: url,
									companyUrl: companyUrl || "",
									img: imgSrc,
									date: new Date().toISOString(),
									postedDate: postedDate,
									title: title,
									company: companyName,
									location: companyLocation,
									salaryCurrency: currency,
									salaryMax: salaryMax || -1,
									salaryMin: salaryMin || -1,
									countryCode: "", // This is not easily available on the search results page
									countryText: "", // This is not easily available on the search results page
									descriptionHtml: "", // Description is scraped on the detail page
									remoteOk: remoteOk,
									stackRequired: stackRequired,
								};
								console.log("result", result); // Keep original console.log for object structure
								results.push(result);
							} catch (e: unknown) {
								// Keep original console.error for stack trace when available
								const stack = (e as Error)?.stack;
								console.error(
									`Something when wrong retrieving linkedin page item: ${i} on url: ${window.location}`,
									stack,
								);
							}
						}
						return results;
					},
					{ stacks },
				),
			) as Observable<JobInterface[]>,
	); // Removed log function from here
}

export function getJobDescription(
	page: Page,
	job: Pick<JobInterface, "url">,
): Observable<{
	url: string;
	title: string;
	company: string;
	location: string;
	postedTime: string;
	applicants: string;
	salaryRange: string;
	seniorityLevel: string;
	employmentType: string;
	jobFunction: string;
	industries: string;
	descriptionText: string;
}> {
	return defer(() => {
		log("LinkedIn", `goto ${job.url}`, "log", { url: job.url });
		return defer(() =>
			fromPromise(
				page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" }),
			),
		).pipe(
			// https://pptr.dev/api/puppeteer.puppeteerlifecycleevent
			switchMap(() =>
				defer(() =>
					fromPromise(
						page.goto(job.url, { waitUntil: "networkidle2", timeout: 60000 }),
					),
				),
			), // Increased timeout to 60 seconds
		);
	}).pipe(
		tap((response) => {
			const status = (
				response as unknown as { status?: () => number }
			)?.status?.();
			log("LinkedIn", `RESPONSE STATUS: ${status}`, "log", {
				status: status,
				url: job.url,
			});
			if (status === STATUS_TOO_MANY_REQUESTS) {
				throw Error("Status 429 (Too many requests)");
			}
		}),
		switchMap(() =>
			getPageLocationOperator(page).pipe(
				tap((locationHref) => {
					log("LinkedIn", `LocationHref: ${locationHref}`, "log", {
						locationHref: locationHref,
						url: job.url,
					});
					if (locationHref.includes(AUTHWALL_PATH)) {
						log("LinkedIn", "Authwall error", "error", {
							locationHref: locationHref,
							url: job.url,
						});
						throw {
							message: `Linkedin authwall! locationHref: ${locationHref}`,
							retry: true,
						};
					}
				}),
			),
		),
		// Use element scraping approach (removed JSON-LD extraction)
		switchMap(() =>
			defer(async () => {
				// --- Element scraping logic (removed JSON-LD extraction) ---
				const seeMoreButtonSelector = ".show-more-less-html__button";
				try {
					// Wait for the button to appear, with an increased timeout
					await page.waitForSelector(seeMoreButtonSelector, { timeout: 10000 }); // Increased timeout to 10 seconds
					log("LinkedIn", 'Clicking "See more" button...', "info", {
						url: job.url,
					});
					await page.click(seeMoreButtonSelector);
					// Wait longer for content to expand
					await new Promise((resolve) => setTimeout(resolve, 2000)); // Increased delay to 2 seconds
				} catch (_error) {
					log(
						"LinkedIn",
						'"See more" button not found or clickable, proceeding without clicking.',
						"info",
						{ url: job.url },
					);
					// Continue if the button is not found (e.g., description is already fully visible)
				}
				// Extract the job title and description text using potentially more stable selectors
				const title = await page
					.$eval(
						"h1.top-card-layout__title, h1.topcard__title",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => "");
				const company = await page
					.$eval(
						"a.topcard__org-name-link",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => "");
				// Use XPath for location as suggested in analysis for potentially better stability
				const location = await page
					.evaluate(() => {
						const element = document.evaluate(
							"//div[contains(@class,'topcard__flavor-row')]/span[contains(@class, 'topcard__flavor--bullet')]/text()",
							document,
							null,
							XPathResult.FIRST_ORDERED_NODE_TYPE,
							null,
						).singleNodeValue;
						return element?.textContent?.trim() || "";
					})
					.catch(() => "");

				const postedTime = await page
					.$eval(
						"span.posted-time-ago__text",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => "");
				const applicants = await page
					.$eval(
						"span.num-applicants__caption",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => "");
				const salaryRange = await page
					.$eval(
						"div.compensation__salary, span.main-job-card__salary-info",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => ""); // Use multiple selectors
				// Use XPath for job criteria as suggested in analysis
				const seniorityLevel = await page
					.evaluate(() => {
						const element = document.evaluate(
							"//h3[contains(text(), 'Seniority level')]/following-sibling::span/text()",
							document,
							null,
							XPathResult.FIRST_ORDERED_NODE_TYPE,
							null,
						).singleNodeValue;
						return element?.textContent?.trim() || "";
					})
					.catch(() => "");
				const employmentType = await page
					.evaluate(() => {
						const element = document.evaluate(
							"//h3[contains(text(), 'Employment type')]/following-sibling::span/text()",
							document,
							null,
							XPathResult.FIRST_ORDERED_NODE_TYPE,
							null,
						).singleNodeValue;
						return element?.textContent?.trim() || "";
					})
					.catch(() => "");
				const jobFunction = await page
					.evaluate(() => {
						const element = document.evaluate(
							"//h3[contains(text(), 'Job function')]/following-sibling::span/text()",
							document,
							null,
							XPathResult.FIRST_ORDERED_NODE_TYPE,
							null,
						).singleNodeValue;
						return element?.textContent?.trim() || "";
					})
					.catch(() => "");
				const industries = await page
					.evaluate(() => {
						const element = document.evaluate(
							"//h3[contains(text(), 'Industries')]/following-sibling::span/text()",
							document,
							null,
							XPathResult.FIRST_ORDERED_NODE_TYPE,
							null,
						).singleNodeValue;
						return element?.textContent?.trim() || "";
					})
					.catch(() => "");

				const descriptionText = await page
					.$eval(
						"div.description__text--rich div.show-more-less-html__markup",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => "");

				// Extract remoteBox value from the specified HTML structure
				const remoteBox = await page
					.$eval(
						"span.tvm__text.tvm__text--low-emphasis strong",
						(element: Element) => element.textContent?.trim() || "",
					)
					.catch(() => "");

				return {
					url: job.url,
					title,
					company,
					location,
					postedTime,
					applicants,
					salaryRange,
					seniorityLevel,
					employmentType,
					jobFunction,
					industries,
					descriptionText,
					remoteBox,
				};
			}),
		),
		map(
			({
				url,
				title,
				company,
				location,
				postedTime,
				applicants,
				salaryRange,
				seniorityLevel,
				employmentType,
				jobFunction,
				industries,
				descriptionText,
			}) => {
				// Return the URL and extracted details
				return {
					url,
					title,
					company,
					location,
					postedTime,
					applicants,
					salaryRange,
					seniorityLevel,
					employmentType,
					jobFunction,
					industries,
					descriptionText,
				};
			},
		),
		catchError((error) => {
			log("LinkedIn", `getJobDescription Error: ${error}`, "error", {
				url: job.url,
				error: error,
			});
			// Return URL and empty details on error
			return of({
				url: job.url,
				title: "",
				company: "",
				location: "",
				postedTime: "",
				applicants: "",
				salaryRange: "",
				seniorityLevel: "",
				employmentType: "",
				jobFunction: "",
				industries: "",
				descriptionText: "",
			});
		}),
	);
}

const _cookies = [
	{
		name: "lang",
		value: "v=2&lang=en-us",
	},
];

const AUTHWALL_PATH = "linkedin.com/authwall";
const STATUS_TOO_MANY_REQUESTS = 429;
const JOB_SEARCH_SELECTOR = ".job-search-card";

/**
 * Navigate to the LinkedIn search page, using the provided search parameters.
 */
function navigateToLinkedinJobsPage(
	page: Page,
	searchParams: ScraperSearchParams,
) {
	return defer(() =>
		fromPromise(
			page.goto(urlQueryPage(searchParams), { waitUntil: "networkidle0" }),
		),
	);
}

/**
 * Check the HTTP response status and throw an error if too many requests have been made.
 */
function checkResponseStatus(response: unknown) {
	const status = (response as { status?: () => number })?.status?.() as
		| number
		| undefined;
	if (status === STATUS_TOO_MANY_REQUESTS) {
		throw {
			message: "Status 429 (Too many requests)",
			retry: true,
			status: STATUS_TOO_MANY_REQUESTS,
		};
	}
}

/**
 * Check if the current page is an authwall and throw an error if it is.
 */
function throwErrorIfAuthwall(page: Page) {
	return getPageLocationOperator(page).pipe(
		tap((locationHref) => {
			if (locationHref.includes(AUTHWALL_PATH)) {
				log("LinkedIn", "Authwall error", "error", {
					locationHref: locationHref,
				});
				throw {
					message: `Linkedin authwall! locationHref: ${locationHref}`,
					retry: true,
				};
			}
		}),
	);
}

/**
 * Wait for the job search card to be visible on the page, and handle timeouts or authwalls.
 */
// Removed this function as its logic is now integrated into goToLinkedinJobsPageAndExtractJobs
/*
function waitForJobSearchCard(page: Page) {
    return defer(() => fromPromise(page.waitForSelector(JOB_SEARCH_SELECTOR, {visible: true, timeout: 5000}))).pipe(
        catchError(error => {
            if (error.name === 'TimeoutError') {
                log('LinkedIn', `Timeout waiting for selector "${JOB_SEARCH_SELECTOR}". Assuming no jobs on this page.`, 'warn');
                return of([]); // Return an empty array to signal no jobs found on this page
            }
            // If not a TimeoutError, check for authwall or re-throw
            return throwErrorIfAuthwall(page).pipe(
                tap(() => { throw error; }) // Re-throw the original non-timeout error after authwall check
            );
        })
    );
}
*/

function goToLinkedinJobsPageAndExtractJobs(
	page: Page,
	searchParams: ScraperSearchParams,
): Observable<JobInterface[]> {
	return defer(() =>
		fromPromise(
			page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" }),
		),
	).pipe(
		switchMap(() => navigateToLinkedinJobsPage(page, searchParams)), // Navigates and waits for networkidle0
		tap((response) => checkResponseStatus(response)), // Checks for 429
		switchMap(() => throwErrorIfAuthwall(page)), // Checks for authwall
		// Check for the job selector immediately after navigation and initial checks
		switchMap(() =>
			defer(() => fromPromise(page.$(JOB_SEARCH_SELECTOR))).pipe(
				switchMap((jobCardElement) => {
					if (jobCardElement) {
						// If element found, proceed to scrape jobs from the page
						log(
							"LinkedIn",
							`Selector "${JOB_SEARCH_SELECTOR}" found. Proceeding to scrape.`,
							"info",
							{ selector: JOB_SEARCH_SELECTOR, searchParams: searchParams },
						);
						return getJobsFromLinkedinPage(page);
					} else {
						// If element not found, return empty array immediately
						log(
							"LinkedIn",
							`Selector "${JOB_SEARCH_SELECTOR}" not found. No jobs on this page.`,
							"info",
							{ selector: JOB_SEARCH_SELECTOR, searchParams: searchParams },
						);
						return of([]);
					}
				}),
			),
		),
		// The retryWhen and map(jobs => Array.isArray(jobs) ? jobs : []) should still apply to the overall process
		retryWhen(
			retryStrategyByCondition({
				maxRetryAttempts: 4,
				retryConditionFn: (error: unknown) =>
					(error as { retry?: boolean }).retry === true,
			}),
		),
		map((jobs) => (Array.isArray(jobs) ? jobs : [])),
		// Removed take(1) here as it would stop after the first page of a query
	);
}

function getJobsFromAllPages(
	page: Page,
	initSearchParams: ScraperSearchParams,
	sleepSeconds: number,
): Observable<ScraperResult> {
	// Added sleepSeconds parameter
	const getJobs$ = (searchParams: ScraperSearchParams) =>
		goToLinkedinJobsPageAndExtractJobs(page, searchParams).pipe(
			map((jobs): ScraperResult => ({ jobs, searchParams }) as ScraperResult),
			catchError((error) => {
				log("LinkedIn", `Error in getJobsFromAllPages: ${error}`, "error", {
					error: error,
					searchParams: searchParams,
				});
				return of({ jobs: [], searchParams: searchParams });
			}),
		);

	return getJobs$(initSearchParams).pipe(
		expand(({ jobs, searchParams }) => {
			log(
				"LinkedIn",
				`Query: ${searchParams.searchText}, Location: ${searchParams.locationText}, Page: ${searchParams.pageNumber}, nJobs: ${jobs.length}, url: ${urlQueryPage(searchParams)}`,
				"log",
				{
					searchParams: searchParams,
					jobCount: jobs.length,
					url: urlQueryPage(searchParams),
				},
			);
			if (jobs.length === 0) {
				return EMPTY; // This stops the expand operator for the current query
			} else {
				const nextSearchParams = {
					...searchParams,
					pageNumber: searchParams.pageNumber + 1,
				};
				// Apply delay before fetching the next page for the current query
				log(
					"LinkedIn",
					`Introducing ${sleepSeconds}s delay before starting new query: ${searchParams.searchText}, page: ${nextSearchParams.pageNumber}`,
					"log",
					{ sleepSeconds: sleepSeconds, nextSearchParams: nextSearchParams },
				);
				return timer(sleepSeconds * 1000).pipe(
					tap(() =>
						log(
							"LinkedIn",
							`Delay finished. Starting new query: ${nextSearchParams.searchText}, location: ${nextSearchParams.locationText}`,
							"log",
							{ nextSearchParams: nextSearchParams },
						),
					), // Corrected logging and variable access
					concatMap(() => getJobs$(nextSearchParams)), // Fetch the next page after the delay
				);
			}
		}),
	);
}

/**
 * Creates a new page and scrapes LinkedIn job data for each pair of searchText and locationText, recursively retrieving data until there are no more pages.
 * @param browser A Puppeteer instance
 * @param sleepSeconds The delay in seconds between processing each search query.
 * @returns An Observable that emits scraped job data as ScraperResult
 */
export function getJobsFromLinkedin(
	browser: Browser,
	sleepSeconds: number,
): Observable<ScraperResult> {
	// Create the page once
	return defer(() => fromPromise(browser.newPage())).pipe(
		tap((page) => pageAddLogs(page, `LinkedInScraperPage-Sequential`)), // Log the single page
		// Use switchMap to switch to the observable that processes search parameters
		switchMap((page) =>
			from(searchParamsList).pipe(
				// Use concatMap to process each search parameter set sequentially
				concatMap((searchParams) =>
					// Scrape all pages for this search parameter set using the same page
					getJobsFromAllPages(
						page,
						{ ...searchParams, pageNumber: 0 },
						sleepSeconds,
					).pipe(
						// Add a delay *after* processing all pages for this search parameter set
						concatMap((result) =>
							timer(sleepSeconds * 1000).pipe(map(() => result)),
						),
					),
				),
			),
		),
	);
}
