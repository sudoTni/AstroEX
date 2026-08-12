/**
 * Vendored and adapted from ts-jobspy-main/src/util.ts (MIT).
 * Only the HTTP, proxy, retry, and text-conversion primitives required by the
 * supported LinkedIn and Indeed providers are retained here.
 */
import axios, {
	type AxiosInstance,
	type InternalAxiosRequestConfig,
} from "axios";
import axiosRetry from "axios-retry";
import * as cheerio from "cheerio";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import TurndownService = require("turndown");

interface ProxyConfig {
	url: string;
}

function normalizeProxy(proxy: string): ProxyConfig {
	if (/^(https?|socks[45]):\/\//i.test(proxy)) return { url: proxy };
	return { url: `http://${proxy}` };
}

class RotatingProxySession {
	private readonly proxies: ProxyConfig[];
	private index = 0;

	constructor(proxies?: string[]) {
		this.proxies = (proxies ?? []).filter(Boolean).map(normalizeProxy);
	}

	next(): ProxyConfig | undefined {
		if (!this.proxies.length) return undefined;
		const proxy = this.proxies[this.index];
		this.index = (this.index + 1) % this.proxies.length;
		return proxy;
	}
}

export function createJobSpySession(
	options: {
		proxies?: string[];
		userAgent?: string;
		hasRetry?: boolean;
		retryDelaySeconds?: number;
	} = {},
): AxiosInstance {
	const proxySession = new RotatingProxySession(options.proxies);
	const session = axios.create({
		timeout: 30_000,
		validateStatus: (status) => status >= 200 && status < 400,
		headers: {
			"User-Agent":
				options.userAgent ??
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	});

	session.interceptors.request.use((config: InternalAxiosRequestConfig) => {
		const proxy = proxySession.next();
		if (!proxy) return config;
		if (proxy.url.startsWith("socks")) {
			config.httpAgent = new SocksProxyAgent(proxy.url);
			config.httpsAgent = new SocksProxyAgent(proxy.url);
		} else {
			config.httpAgent = new HttpsProxyAgent(proxy.url);
			config.httpsAgent = new HttpsProxyAgent(proxy.url);
		}
		config.proxy = false;
		return config;
	});

	if (options.hasRetry) {
		axiosRetry(session, {
			retries: 3,
			retryDelay: (count) => count * (options.retryDelaySeconds ?? 2) * 1000,
			retryCondition: (error) =>
				axiosRetry.isNetworkOrIdempotentRequestError(error) ||
				[429, 500, 502, 503, 504].includes(error.response?.status ?? 0),
		});
	}
	return session;
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

export function descriptionToFormat(
	html: string,
	format: "markdown" | "html" | "plain",
): string {
	if (format === "html") return html;
	if (format === "plain")
		return cheerio.load(html).text().replace(/\s+/g, " ").trim();
	return turndown.turndown(html).trim();
}

export function extractEmails(text?: string): string[] | undefined {
	if (!text) return undefined;
	return (
		text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? undefined
	);
}
