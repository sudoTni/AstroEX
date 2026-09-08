import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function writeArtifactManifest(
	artifactPath: string,
	command: string,
	metadata: Record<string, unknown>,
): Promise<string> {
	const content = await fs.readFile(artifactPath);
	const manifestPath = `${artifactPath}.manifest.json`;
	const manifest = {
		schemaVersion: 1,
		command,
		createdAt: new Date().toISOString(),
		artifact: path.basename(artifactPath),
		sha256: crypto.createHash("sha256").update(content).digest("hex"),
		...metadata,
	};
	const temporary = `${manifestPath}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporary, manifestPath);
	} catch (error) {
		try {
			await fs.unlink(temporary);
		} catch {
			// ignore cleanup error
		}
		throw error;
	}
	return manifestPath;
}

export async function verifyArtifactManifest(artifactPath: string): Promise<{
	ok: boolean;
	details: string;
}> {
	const manifestPath = `${artifactPath}.manifest.json`;
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
		schemaVersion?: unknown;
		artifact?: unknown;
		sha256?: unknown;
	};
	if (
		manifest.schemaVersion !== 1 ||
		manifest.artifact !== path.basename(artifactPath) ||
		typeof manifest.sha256 !== "string"
	) {
		return { ok: false, details: "invalid manifest schema or artifact name" };
	}
	const content = await fs.readFile(artifactPath);
	const hash = crypto.createHash("sha256").update(content).digest("hex");
	return {
		ok: hash === manifest.sha256,
		details: hash === manifest.sha256 ? "ok" : "artifact hash mismatch",
	};
}
