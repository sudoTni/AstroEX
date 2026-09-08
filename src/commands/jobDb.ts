import * as path from "node:path";
import type { Argv } from "yargs";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobRepository, type JobRepositoryHealth } from "../jobRepository";
import { getDataDirectory } from "../runtimePaths";
import type { GlobalArgs } from "../types";

export function addJobDbCommand(yargs: Argv<GlobalArgs>): Argv<GlobalArgs> {
	return yargs.command(
		"jobdb <action>",
		"Inspect, verify, back up, or rotate SQLite repository backups.",
		(command) =>
			command
				.positional("action", {
					choices: ["status", "verify", "backup", "rotate-backups"] as const,
				})
				.option("keep", { type: "number", default: 10 }),
		async (argv) => {
			const repository = new JobRepository({
				dbFilePath: path.join(getDataDirectory(), "jobDB.sqlite"),
				defaultExpirationMs: JOB_DB_RETENTION_MS,
				enableJobDB: true,
			});
			await repository.initialize();
			try {
				if (argv.action === "backup") await repository.createBackup();
				if (argv.action === "rotate-backups") {
					const removed = await repository.rotateBackups(Number(argv.keep));
					console.log(JSON.stringify({ removed, keep: argv.keep }, null, 2));
					return;
				}
				const result =
					argv.action === "status"
						? repository.getStats()
						: repository.verifyIntegrity();
				console.log(JSON.stringify(result, null, 2));
				if (
					argv.action === "verify" &&
					(result as JobRepositoryHealth).integrity !== "ok"
				)
					process.exitCode = 1;
			} finally {
				await repository.close();
			}
		},
	);
}
