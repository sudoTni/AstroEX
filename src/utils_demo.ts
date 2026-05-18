// Demo for rainbow/gradient/banner/logging utilities in utils.ts

import { applyGradientText, applyRainbowText, log, printBanner } from "./utils";

// Print the vivid banner
printBanner(true);

console.log("\n--- Rainbow Text Demo ---");
console.log(applyRainbowText("This is a vivid rainbow string! 🌈", 0.05, true));

import { paletteError, paletteInfo, paletteWarn } from "./utils";

console.log("\n--- Gradient Text Demo (Info palette) ---");
console.log(
	applyGradientText("This is a blue/teal gradient string!", paletteInfo, true),
);

console.log("\n--- Gradient Text Demo (Warn palette) ---");
console.log(
	applyGradientText(
		"This is a gold/orange gradient string!",
		paletteWarn,
		true,
	),
);

console.log("\n--- Gradient Text Demo (Error palette) ---");
console.log(
	applyGradientText(
		"This is a red/crimson gradient string!",
		paletteError,
		true,
	),
);

console.log("\n--- log() Function Demo ---");
log("Demo", "This is a regular log message (rainbow).", "log");
log("Demo", "This is an info message (teal/blue gradient).", "info");
log("Demo", "This is a warning message (gold/orange gradient).", "warn");
log("Demo", "This is an error message (red/crimson gradient).", "error");
