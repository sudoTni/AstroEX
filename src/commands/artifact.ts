import type { Argv } from "yargs";
import { verifyArtifactManifest } from "../artifactManifest";
import { writeMachineJson } from "../logging";
import type { GlobalArgs } from "../types";

export function addArtifactCommand(yargs: Argv<GlobalArgs>): Argv<GlobalArgs> {
	return yargs.command(
		"artifact verify <file>",
		"Verify an artifact against its companion manifest.",
		(command) =>
			command.positional("file", { type: "string", demandOption: true }),
		async (argv) => {
			const result = await verifyArtifactManifest(String(argv.file));
			writeMachineJson(result);
			if (!result.ok) process.exitCode = 1;
		},
	);
}
