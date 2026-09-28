//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/trap.ts
var re = /(\d+\)\s)?([\w-+]+)/g;
var availableSignalsGenerator = (suggestOptions) => ({
	script: [
		"command",
		"kill",
		"-l"
	],
	postProcess: (output) => [...output.matchAll(re)].map((signal) => ({ name: signal[2] }))
});
var completionSpec = {
	name: "trap",
	description: "Automatically execute commands after receiving signals by processes or the operating system",
	options: [{
		name: ["--print", "-p"],
		description: "Prints all defined signal handlers"
	}, {
		name: ["--help", "-h"],
		description: "Displays help about using this command"
	}],
	args: [{
		name: "function name",
		isOptional: true
	}, {
		name: "reason",
		generators: availableSignalsGenerator()
	}]
};
//#endregion
export { completionSpec as default };
